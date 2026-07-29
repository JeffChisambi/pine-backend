-- Migration: KYC broker dashboard support
-- Adds ADDITIONAL_DOCS and MANUAL_REVIEW statuses, plus new columns
-- required by the Kusata broker dashboard API contract (v1.0).

-- ── 1. Extend the KycStatus enum ──────────────────────────────────────────────
-- PostgreSQL ALTER TYPE ADD VALUE is safe and non-reversible.
ALTER TYPE "KycStatus" ADD VALUE IF NOT EXISTS 'ADDITIONAL_DOCS';
ALTER TYPE "KycStatus" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW';

-- ── 2. New columns on kyc_applications ────────────────────────────────────────

-- KYC tier requested by the applicant (TIER_1 / TIER_2)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "tier" TEXT;

-- Anti-spoofing / liveness score from the face pipeline (0–1)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "livenessScore" DECIMAL(5,4);

-- Machine-readable risk flag codes (JSON string array)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "riskFlags" JSONB;

-- Display name of the reviewing admin (denormalised for fast reads)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "reviewerName" TEXT;

-- Internal reviewer notes (not shown to the applicant)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "reviewNotes" TEXT;

-- Document slot codes the applicant must resubmit (JSON string array)
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "requiredDocuments" JSONB;

-- Optional message shown to the applicant when documents are requested
ALTER TABLE "kyc_applications"
  ADD COLUMN IF NOT EXISTS "requestDocsMessage" TEXT;
