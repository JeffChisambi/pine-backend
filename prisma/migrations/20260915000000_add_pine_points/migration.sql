-- Pine Points: the practice app's leaderboard competition.
--
-- Purely additive — no existing table is touched — so this is safe to deploy
-- to a real-money instance too, where the feature stays switched off and the
-- tables simply sit empty. Shipping it everywhere is what keeps `main` and
-- `virtual-trading` free of migration drift.

CREATE TABLE "competition_seasons" (
    "id"        UUID         NOT NULL,
    "name"      TEXT         NOT NULL,
    "slug"      TEXT         NOT NULL,
    "startsAt"  TIMESTAMP(3) NOT NULL,
    "endsAt"    TIMESTAMP(3) NOT NULL,
    "closedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_seasons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "competition_seasons_slug_key" ON "competition_seasons"("slug");
CREATE INDEX "competition_seasons_startsAt_endsAt_idx" ON "competition_seasons"("startsAt", "endsAt");

-- The append-only ledger. "dedupeKey" is the single idempotency guarantee in
-- the whole engine: every award builds a deterministic key, so a replayed
-- event, a retried request or a re-run backfill all collide here and insert
-- nothing.
CREATE TABLE "point_events" (
    "id"        UUID         NOT NULL,
    "userId"    UUID         NOT NULL,
    "seasonId"  UUID         NOT NULL,
    "ruleKey"   TEXT         NOT NULL,
    "points"    INTEGER      NOT NULL,
    "awardedOn" DATE         NOT NULL,
    "dedupeKey" TEXT         NOT NULL,
    "metadata"  JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "point_events_dedupeKey_key" ON "point_events"("dedupeKey");
CREATE INDEX "point_events_userId_createdAt_idx" ON "point_events"("userId", "createdAt" DESC);
-- The hottest read in the engine: the daily-cap check runs before every award.
CREATE INDEX "point_events_userId_ruleKey_awardedOn_idx" ON "point_events"("userId", "ruleKey", "awardedOn");
CREATE INDEX "point_events_seasonId_ruleKey_idx" ON "point_events"("seasonId", "ruleKey");

CREATE TABLE "point_balances" (
    "id"           UUID         NOT NULL,
    "userId"       UUID         NOT NULL,
    "seasonId"     UUID         NOT NULL,
    "totalPoints"  INTEGER      NOT NULL DEFAULT 0,
    "lastAwardAt"  TIMESTAMP(3),
    "cachedRank"   INTEGER,
    "previousRank" INTEGER,
    "cachedAt"     TIMESTAMP(3),
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "point_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "point_balances_userId_seasonId_key" ON "point_balances"("userId", "seasonId");
-- Column order matches the board's ORDER BY and the my-rank predicate exactly,
-- so both are index scans and neither needs a sort.
CREATE INDEX "point_balances_seasonId_totalPoints_lastAwardAt_idx" ON "point_balances"("seasonId", "totalPoints" DESC, "lastAwardAt");

CREATE TABLE "point_streaks" (
    "id"            UUID         NOT NULL,
    "userId"        UUID         NOT NULL,
    "seasonId"      UUID         NOT NULL,
    "lastCheckInOn" DATE         NOT NULL,
    "currentStreak" INTEGER      NOT NULL DEFAULT 1,
    "longestStreak" INTEGER      NOT NULL DEFAULT 1,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "point_streaks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "point_streaks_userId_seasonId_key" ON "point_streaks"("userId", "seasonId");

-- Lesson progress moves to the server. It used to live only in the device's
-- storage, so clearing that storage re-earned every lesson, and a new phone
-- lost the course entirely.
CREATE TABLE "lesson_completions" (
    "id"          UUID         NOT NULL,
    "userId"      UUID         NOT NULL,
    "lessonId"    TEXT         NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_completions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lesson_completions_userId_lessonId_key" ON "lesson_completions"("userId", "lessonId");
CREATE INDEX "lesson_completions_userId_idx" ON "lesson_completions"("userId");

-- One notification can be claimed for points exactly once, ever. The unique
-- is on the notification alone, not the pair, so it also blocks claiming
-- someone else's notification id.
CREATE TABLE "notification_opens" (
    "id"             UUID         NOT NULL,
    "userId"         UUID         NOT NULL,
    "notificationId" UUID         NOT NULL,
    "latencyMs"      INTEGER      NOT NULL,
    "awarded"        BOOLEAN      NOT NULL,
    "rejectedReason" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_opens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_opens_notificationId_key" ON "notification_opens"("notificationId");
CREATE INDEX "notification_opens_userId_createdAt_idx" ON "notification_opens"("userId", "createdAt");

ALTER TABLE "point_events" ADD CONSTRAINT "point_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_events" ADD CONSTRAINT "point_events_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "competition_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_balances" ADD CONSTRAINT "point_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_balances" ADD CONSTRAINT "point_balances_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "competition_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_streaks" ADD CONSTRAINT "point_streaks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "point_streaks" ADD CONSTRAINT "point_streaks_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "competition_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lesson_completions" ADD CONSTRAINT "lesson_completions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_opens" ADD CONSTRAINT "notification_opens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_opens" ADD CONSTRAINT "notification_opens_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
