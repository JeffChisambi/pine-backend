-- Staff dashboard sessions end after a period with nobody at the keyboard.
--
-- Tracked separately from lastUsedAt: that records refresh-token rotation,
-- which the client does on a timer whether or not a person is there. Only a
-- heartbeat sent after real interaction moves lastActivityAt.
ALTER TABLE "sessions"
  ADD COLUMN "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing sessions start their idle clock now rather than at epoch, so
-- nobody is signed out mid-task by the deploy itself.
UPDATE "sessions" SET "lastActivityAt" = CURRENT_TIMESTAMP WHERE "isRevoked" = false;
