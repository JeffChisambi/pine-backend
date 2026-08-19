-- System error monitoring (admin System Errors console)

CREATE TYPE "ErrorSource" AS ENUM ('MOBILE_APP', 'BROKER_DASHBOARD', 'ADMIN_DASHBOARD', 'BACKEND');
CREATE TYPE "ErrorSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "ErrorStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "system_error_events" (
    "id" UUID NOT NULL,
    "source" "ErrorSource" NOT NULL,
    "severity" "ErrorSeverity" NOT NULL,
    "status" "ErrorStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "location" TEXT,
    "context" JSONB,
    "userId" UUID,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,

    CONSTRAINT "system_error_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "system_error_events_source_idx" ON "system_error_events"("source");
CREATE INDEX "system_error_events_severity_idx" ON "system_error_events"("severity");
CREATE INDEX "system_error_events_status_idx" ON "system_error_events"("status");
CREATE INDEX "system_error_events_lastSeenAt_idx" ON "system_error_events"("lastSeenAt");
