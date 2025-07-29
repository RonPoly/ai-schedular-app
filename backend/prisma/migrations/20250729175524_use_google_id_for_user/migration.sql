/*
  Warnings:

  - You are about to drop the column `userId` on the `Task` table. All the data in the column will be lost.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `User` table. All the data in the column will be lost.
  - Added the required column `userGoogleId` to the `Task` table without a default value. This is not possible if the table is not empty.
  - Added the required column `googleId` to the `User` table without a default value. This is not possible if the table is not empty.
  - Made the column `googleRefreshToken` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT,
    "dueDate" DATETIME,
    "calendarEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userGoogleId" TEXT NOT NULL,
    CONSTRAINT "Task_userGoogleId_fkey" FOREIGN KEY ("userGoogleId") REFERENCES "User" ("googleId") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("calendarEventId", "createdAt", "description", "dueDate", "id", "tags", "title") SELECT "calendarEventId", "createdAt", "description", "dueDate", "id", "tags", "title" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE TABLE "new_User" (
    "googleId" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT,
    "name" TEXT,
    "googleRefreshToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "googleRefreshToken", "updatedAt") SELECT "createdAt", "googleRefreshToken", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
