-- Broker staff: users a broker administrator lets into the dashboard with
-- access to chosen sections only. Sections live on the user and are enforced
-- by StaffSectionGuard on every admin request.

ALTER TABLE "users"
  ADD COLUMN "isBrokerStaff"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "staffSections"      TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "users_brokerId_isBrokerStaff_idx" ON "users"("brokerId", "isBrokerStaff");
