require('dotenv').config();

const express          = require('express');
const cors             = require('cors');
const axios            = require('axios');
const nodemailer       = require('nodemailer');
const { PrismaClient } = require('@prisma/client');
const { google }       = require('googleapis');
const { GoogleGenAI }  = require('@google/genai');

const app    = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(cors());

// —————————————————————————
// OAuth2 Client (shared)
// —————————————————————————
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// —————————————————————————
// Google Calendar Helpers
// —————————————————————————
async function createCalendarEvent(task) {
  const user = await prisma.user.findUnique({ where: { googleId: task.userGoogleId } });
  if (!user || !user.googleRefreshToken) {
    throw new Error('No Google refresh token found for user');
  }

  oauth2Client.setCredentials({ refresh_token: user.googleRefreshToken });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const start = task.dueDate
    ? new Date(task.dueDate).toISOString()
    : new Date().toISOString();
  const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();

  const event = {
    summary:     task.title,
    description: task.description || '',
    start:       { dateTime: start, timeZone: 'UTC' },
    end:         { dateTime: end,   timeZone: 'UTC' }
  };

  const resp = await calendar.events.insert({
    calendarId: 'primary',
    resource:   event
  });
  return resp.data;
}

async function getTodaysEvents() {
  const user = await prisma.user.findFirst();
  if (!user || !user.googleRefreshToken) {
    throw new Error('No Google refresh token found');
  }

  oauth2Client.setCredentials({ refresh_token: user.googleRefreshToken });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const today    = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const resp = await calendar.events.list({
    calendarId:    'primary',
    timeMin:       today.toISOString(),
    timeMax:       tomorrow.toISOString(),
    singleEvents:  true,
    orderBy:       'startTime'
  });
  return resp.data.items || [];
}

// —————————————————————————
// AI Helper Functions
// —————————————————————————
async function planAndScheduleTask(task) {
  try {
    const ai    = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: 'gemini-2.5-pro' });

    let prompt = `You are an AI scheduling assistant. I have a task: "${task.title}".`;
    if (task.description) prompt += ` Details: ${task.description}.`;
    if (task.tags)        prompt += ` Tags: [${task.tags}].`;
    if (task.dueDate)     prompt += ` It is due by ${new Date(task.dueDate).toDateString()}.`;
    prompt += ` Divide into actionable steps and suggest a date/time schedule for each before the deadline. Return a concise list.`;

    const response = await model.generateContent(prompt);
    console.log('AI Plan for task:', response.text.trim());

    return await createCalendarEvent(task);
  } catch (err) {
    console.error('AI scheduling failed:', err);
    return null;
  }
}

async function generateDailySummary() {
  try {
    const ai    = new GoogleGenAI(process.env.GEMINI_API_KEY);
    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const events = await getTodaysEvents();
    let summaryPrompt;
    if (events.length === 0) {
      summaryPrompt = 'There are no scheduled events or tasks for today.';
    } else {
      summaryPrompt = 'Today’s schedule:\n';
      for (const ev of events) {
        const start = ev.start.dateTime || ev.start.date;
        const time  = start
          ? new Date(start).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
          : '';
        summaryPrompt += `- ${time} ${ev.summary}\n`;
      }
      summaryPrompt += '\nProvide a brief summary in a friendly tone.';
    }

    const resp = await model.generateContent(summaryPrompt);
    console.log('Daily Summary:', resp.text.trim());
    return resp.text.trim();
  } catch (err) {
    console.error('AI summary failed:', err);
    return 'Unable to generate summary.';
  }
}

// —————————————————————————
// OAuth Routes
// —————————————————————————
app.get('/auth/google', (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  });
  res.send(`<a href="${url}">Authenticate with Google</a>`);
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2            = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    await prisma.user.upsert({
      where:  { googleId: profile.id },
      update: {
        googleRefreshToken: tokens.refresh_token,
        email:              profile.email,
        name:               profile.name
      },
      create: {
        googleId:           profile.id,
        googleRefreshToken: tokens.refresh_token,
        email:              profile.email,
        name:               profile.name
      }
    });

    res.send('✅ Authentication complete. You can close this window.');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed');
  }
});

// —————————————————————————
// Task Routes
// —————————————————————————
app.post('/api/tasks', async (req, res) => {
  const { title, description, tags, dueDate } = req.body;

  // Dev‑mode fallback: header if provided, otherwise first user
  const headerId = req.header('x-google-id');
  let user = null;
  if (headerId) {
    user = await prisma.user.findUnique({ where: { googleId: headerId } });
  } else {
    user = await prisma.user.findFirst();
  }

  if (!user) {
    return res
      .status(401)
      .json({ error: 'No Google‑authenticated user found. Please /auth/google first.' });
  }

  try {
    const newTask = await prisma.task.create({
      data: {
        title,
        description: description || '',
        tags:        typeof tags === 'object'
                        ? JSON.stringify(tags)
                        : tags || '',
        dueDate:     dueDate ? new Date(dueDate) : null,
        user:        { connect: { googleId: user.googleId } }
      }
    });

    const event = await planAndScheduleTask(newTask);
    if (event?.id) {
      await prisma.task.update({
        where: { id: newTask.id },
        data:  { calendarEventId: event.id }
      });
      newTask.calendarEventId = event.id;
    }

    res.status(201).json(newTask);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/tasks', async (_req, res) => {
  try {
    const tasks = await prisma.task.findMany({ orderBy: { createdAt: 'asc' } });
    res.json(tasks);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// —————————————————————————
// Summary & Notifications
// —————————————————————————
app.get('/api/summary', async (_req, res) => {
  try {
    const summary = await generateDailySummary();

    if (process.env.SLACK_WEBHOOK_URL) {
      await axios.post(process.env.SLACK_WEBHOOK_URL, { text: summary });
    }
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });
      await transporter.sendMail({
        from:    `"AI Scheduler" <${process.env.EMAIL_USER}>`,
        to:      process.env.EMAIL_TO || process.env.EMAIL_USER,
        subject: 'Daily Schedule Summary',
        text:    summary
      });
    }

    res.json({ summary });
  } catch (err) {
    console.error('Error in /api/summary:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// —————————————————————————
// Healthcheck & Start
// —————————————————————————
app.get('/', (_req, res) => res.send('API is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
