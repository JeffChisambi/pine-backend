-- Migration: Add content hash and image keys to KycDocument

ALTER TABLE "kyc_documents"
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
  ADD COLUMN IF NOT EXISTS "enhancedStorageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "thumbnailStorageKey" TEXT;

CREATE INDEX IF NOT EXISTS "kyc_documents_contentHash_idx" ON "kyc_documents"("contentHash");
