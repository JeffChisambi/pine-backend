---
name: KYC ocrExtractedData JSON schema
description: The ocrExtractedData Prisma JSON column is the single source of truth for all KYC pipeline state. Every write must read the existing value first and merge.
---

The `KycApplication.ocrExtractedData` JSON column stores everything that doesn't have a dedicated schema column yet. Structure:

**Top-level keys** (from OcrExtractionResult): `fullName`, `nationalIdNumber`, `dateOfBirth`, `gender`, `address`, `documentNumber`, `expiryDate`, etc.

**Private keys (underscore prefix)**:
- `_stage` — `KycVerificationStage` enum value; written by `updateApplicationStage()`
- `_embeddings` — `StoredEmbedding[]`; each entry has `sourceType`, `embeddingData` (base64 Float32Array), `detectionConfidence`, `qualityScore`
- `_fraudFlags` — `FraudFlag[]`
- `_documentHashes` — `Record<documentId, sha256hex>`
- `_confidenceScore`, `_ocrConfidence`, `_faceMatchConfidence`, `_imageQualityScore`, `_documentQualityScore`, `_fraudScore`, `_reviewerNotes`

**Why:** No dedicated columns exist in the schema yet for scores, stage, or embeddings. Everything lives in this one JSON field as a workaround until migration adds proper columns.

**How to apply:** Any method that writes to `ocrExtractedData` MUST call `readExistingJson(id)` first, spread the result, and only override the keys it intends to change. Never do `ocrExtractedData: someObject` without the spread. The `readExistingJson()` helper in `KycRepository` is the canonical way to do this.
