-- Investors carried over from a broker's previous system.
-- Held separately from "users": these people have no password, no consent and
-- no Pine KYC yet. The row only pre-fills their registration once they accept.

CREATE TYPE "MigratedInvestorStatus" AS ENUM ('PENDING', 'INVITED', 'CLAIMED', 'CANCELLED');

CREATE TABLE "migrated_investors" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "brokerId"       UUID NOT NULL,
  "firstName"      TEXT NOT NULL,
  "lastName"       TEXT NOT NULL,
  "phone"          TEXT NOT NULL,
  "email"          TEXT,
  "dateOfBirth"    TIMESTAMP(3),
  "gender"         TEXT,
  "extra"          JSONB,
  "status"         "MigratedInvestorStatus" NOT NULL DEFAULT 'PENDING',
  "tokenHash"      TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "invitedAt"      TIMESTAMP(3),
  "inviteCount"    INTEGER NOT NULL DEFAULT 0,
  "claimedAt"      TIMESTAMP(3),
  "userId"         UUID,
  "batchId"        UUID,
  "importedById"   UUID,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "migrated_investors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "migrated_investors_tokenHash_key" ON "migrated_investors"("tokenHash");
CREATE UNIQUE INDEX "migrated_investors_userId_key" ON "migrated_investors"("userId");
-- Re-importing the same sheet updates the person rather than duplicating them.
CREATE UNIQUE INDEX "migrated_investors_brokerId_phone_key" ON "migrated_investors"("brokerId", "phone");
CREATE INDEX "migrated_investors_brokerId_status_idx" ON "migrated_investors"("brokerId", "status");
CREATE INDEX "migrated_investors_batchId_idx" ON "migrated_investors"("batchId");

ALTER TABLE "migrated_investors"
  ADD CONSTRAINT "migrated_investors_brokerId_fkey"
  FOREIGN KEY ("brokerId") REFERENCES "brokers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "migrated_investors"
  ADD CONSTRAINT "migrated_investors_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
