# KYC Module Audit Report

> **Scope:** Full audit of `src/modules/kyc/`, `src/modules/admin/controllers/admin-kyc.controller.ts`, `src/infrastructure/storage/storage.service.ts`, and all domain types, DTOs, and Prisma schema records used by the KYC pipeline.
>
> **Date:** 2026-07-31
>
> Issues are grouped by severity. Each entry includes the exact file and line range, the root cause, and a concrete fix.

---

## Critical — Security or Correctness Blockers

---

### C-1 · `retry` endpoint accepts `userId` from request body — authorization bypass
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 232–247

**Problem:** The `/kyc/retry` endpoint reads `userId` directly from `@Body('userId')` instead of from the authenticated session:

```typescript
async retry(
  @Body('applicationId') applicationId: string,
  @Body('userId') userId: string,   // ← any caller can set this to any userId
): Promise<{ decision: string; confidenceScore: number }> {
```

Any authenticated user can pass another user's `userId` and trigger full AI pipeline re-processing of their application, including overwriting their OCR data and face embeddings, and potentially flipping their KYC decision.

**Fix:**
```typescript
async retry(
  @Body('applicationId') applicationId: string,
  @CurrentUser() user: AuthenticatedUser,   // take userId from the JWT, never from body
): Promise<{ decision: string; confidenceScore: number }> {
  const result = await this.workflowService.processVerification(applicationId, user.id);
```

---

### C-2 · `getResult` endpoint has no ownership check — IDOR
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 197–230

**Problem:** `GET /kyc/result/:applicationId` fetches and returns the full application record — including extracted name, national ID number, facial match score, fraud flags, and OCR confidence — for _any_ `applicationId` with no check that the requesting user owns it:

```typescript
async getResult(@Param('applicationId') applicationId: string): Promise<KycResultResponseDto> {
  const app = await this.repository.getApplicationById(applicationId);   // no userId filter
  if (!app) throw new Error('Application not found');
  return { applicationId: app.id, ... extractedIdNumber: app.nationalIdNumber, ... };
}
```

**Fix:** Retrieve `@CurrentUser()` and verify `app.userId === user.id` before returning:
```typescript
async getResult(
  @Param('applicationId') applicationId: string,
  @CurrentUser() user: AuthenticatedUser,
): Promise<KycResultResponseDto> {
  const app = await this.repository.getApplicationById(applicationId);
  if (!app || app.userId !== user.id) throw new NotFoundException('Application not found');
```

---

### C-3 · All mobile KYC endpoints lack a JWT authentication guard
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 29–34 (comment)

**Problem:** The controller comment explicitly states that `@UseGuards(JwtAuthGuard)` is deferred to "Phase 2". The only global guard registered in `AppModule` is the throttler (`ThrottlerBehindProxyGuard`). `@CurrentUser()` extracts the user from the request — if no JWT guard populates that user, the decorator returns `undefined`, causing a runtime crash or, worse, null user being passed to the workflow service.

All of the following endpoints are currently reachable without authentication:
- `POST /v1/kyc/start`
- `POST /v1/kyc/upload-id`, `upload-id-back`, `upload-selfie`, `upload-proof-of-residency`
- `POST /v1/kyc/process`
- `GET /v1/kyc/status`
- `GET /v1/kyc/result/:id`
- `POST /v1/kyc/retry`

**Fix:** Add `@UseGuards(JwtAuthGuard)` at the `KycController` class level (or apply it globally for all authenticated routes when Phase 2 auth lands, which it must before this module goes to production).

---

### C-4 · `KycAdminController` (kyc module) is unregistered, unauthenticated, and uses invalid FK values
**File:** `src/modules/kyc/controllers/kyc-admin.controller.ts` · entire file

**Problem:** This controller is never registered in `KycModule.controllers` (only `KycController` is). It is dead code. However, it has three independent problems that would each cause production incidents if it were ever wired in:

1. **No authentication or RBAC** — no `@UseGuards`, no `@RequirePermissions`. Any HTTP request would succeed.
2. **`reviewerId: 'admin'`** — not a valid UUID. `KycApplication.reviewedById` is a UUID FK column; writing `'admin'` would cause a Postgres constraint violation. The repository works around this by forcing `reviewedById: null`, losing all reviewer attribution.
3. **`reviewerName: 'Compliance Officer'`** — hardcoded string, not the actual reviewer.

**Fix:** Delete this file entirely. All admin KYC review functionality is correctly implemented in `src/modules/admin/controllers/admin-kyc.controller.ts` with proper guards, real reviewer identity, and atomic transactions.

---

### C-5 · `normalizeNrc` replaces the digit `1` with `/`, corrupting valid NRC numbers
**File:** `src/modules/kyc/ocr/malawi-id.parser.ts` · lines 436–438

**Problem:** The function that normalises OCR noise in NRC numbers applies a global character replacement including the digit `1`:

```typescript
private normalizeNrc(raw: string): string {
  return raw.replace(/[|\\lI1]/g, '/').replace(/\s+/g, '');
}
```

A valid NRC number such as `123456/78/1` (where `1` is the legitimate final check digit) becomes `123456/78//`, which then fails every downstream validation. Any NRC ending in `1` is silently corrupted. This also fires inside the 6-digit prefix — `123456` → `/23456` if the leading `1` were present.

**Fix:** Only replace `1` in separator positions (between digit groups), not globally. The separator-position correction already happens in `correctOcrNoise()`. `normalizeNrc` should only convert the unambiguous noise characters:

```typescript
private normalizeNrc(raw: string): string {
  // Replace only the unambiguous non-digit noise chars; '1' is a valid digit
  return raw.replace(/[|\\lI]/g, '/').replace(/\s+/g, '');
}
```

---

## High — Functional Bugs That Break Key Workflows

---

### H-1 · New KYC applications are created with `status: 'PENDING'`, polluting the broker queue
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · line 47

**Problem:**
```typescript
const app = await this.prisma.kycApplication.create({
  data: { userId, status: 'PENDING', ocrExtractedData: { _stage: 'CREATED' } },
});
```

The moment `startApplication()` is called — before any documents are uploaded — the application appears in the Kusata broker queue (which filters on `status = PENDING`). Brokers see dozens of empty applications with no documents and no data.

**Fix:** Create applications with `status: 'NOT_SUBMITTED'` and promote to `PENDING` only when `processVerification` is called (which already does this via `updateApplicationStatus(applicationId, 'PENDING')`):

```typescript
data: { userId, status: 'NOT_SUBMITTED', ocrExtractedData: { _stage: 'CREATED' } }
```

Also update `startApplication()` to check `'NOT_SUBMITTED'` as the resumable-application status, which it currently does (the `'NOT_SUBMITTED'` check was correct in intent, just wrong in execution).

---

### H-2 · Document upload can regress the pipeline stage
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · lines 153–162

**Problem:** The `stageMap` unconditionally overwrites the current stage on every document upload:

```typescript
const stageMap = {
  NATIONAL_ID: KycVerificationStage.ID_UPLOADED,
  NATIONAL_ID_BACK: KycVerificationStage.ID_UPLOADED,   // also ID_UPLOADED, not a selfie-related stage
  SELFIE: KycVerificationStage.SELFIE_UPLOADED,
  PROOF_OF_RESIDENCE: KycVerificationStage.ID_UPLOADED,  // semantically wrong
};
await this.repository.updateApplicationStage(applicationId, newStage);
```

Two concrete regressions:
1. **Stage regression:** If the user uploads selfie first (`SELFIE_UPLOADED`) then uploads the ID, the stage is overwritten back to `ID_UPLOADED`.
2. **Semantic mismatch:** `PROOF_OF_RESIDENCE` maps to `ID_UPLOADED`, implying it is an identity document. It is not; it is a supplementary document.

**Fix:** Only advance the stage (never regress), and map `PROOF_OF_RESIDENCE` to its own stage or leave the current stage unchanged:

```typescript
const stageAdvancement: Record<string, KycVerificationStage> = {
  NATIONAL_ID: KycVerificationStage.ID_UPLOADED,
  NATIONAL_ID_BACK: KycVerificationStage.ID_UPLOADED,
  SELFIE: KycVerificationStage.SELFIE_UPLOADED,
  // PROOF_OF_RESIDENCE does not advance the primary upload stages
};
const newStage = stageAdvancement[documentType];
if (newStage) {
  const current = await this.repository.getApplicationById(applicationId);
  const stageOrder = Object.values(KycVerificationStage);
  if (stageOrder.indexOf(newStage) > stageOrder.indexOf(current.verificationStage as any)) {
    await this.repository.updateApplicationStage(applicationId, newStage);
  }
}
```

---

### H-3 · `processVerification` runs the full AI pipeline synchronously, causing HTTP timeouts
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 139–158  
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · line 189+

**Problem:** The `POST /kyc/process` endpoint returns `@HttpCode(HttpStatus.ACCEPTED)` (202), correctly implying asynchronous processing. However, `processVerification()` is `await`-ed directly in the request handler. The pipeline includes:
- Two S3 signed URL fetches + buffer downloads
- Sharp image enhancement (CPU-bound)
- Tesseract OCR (WASM, multi-second)
- ONNX face detection + recognition (CPU-bound, can be 10–30 s)
- Fraud checks (DB queries)

This will routinely exceed the default 60-second reverse proxy timeout. The `202 Accepted` response never arrives until processing finishes, defeating its purpose.

**Fix:** Enqueue the verification job using BullMQ (the `QueueName.KYC` queue is already registered in the infrastructure). The controller should enqueue and return `202` immediately:

```typescript
// controller
await this.kycQueue.add('process', { applicationId, userId: user.id });
return { queued: true, applicationId };

// processor (separate @Processor class)
@Process('process')
async handle(job: Job<{ applicationId: string; userId: string }>) {
  await this.workflowService.processVerification(job.data.applicationId, job.data.userId);
}
```

The mobile app must then poll `GET /kyc/status` for the result (already implemented).

---

### H-4 · `requestAdditionalDocuments` does not update `user.kycStatus`
**File:** `src/modules/admin/controllers/admin-kyc.controller.ts` · lines 573–578  
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · lines 575–592

**Problem:** After the broker requests additional documents, `KycApplication.status` is correctly set to `ADDITIONAL_DOCS`, but `User.kycStatus` is never updated. The mobile app reads `user.kycStatus` (not the application status) to display the current state to the user. The user will continue to see "Under Review" (`PENDING`) and will never be notified that action is required from them.

**Fix:** Add `user.kycStatus` sync after the application status update in `requestAdditionalDocuments`:

```typescript
// In AdminKycController.requestDocs, after kycRepo.requestAdditionalDocuments():
await this.prisma.user.update({
  where: { id: app.userId },
  data: { kycStatus: 'ADDITIONAL_DOCS' },
});
```

Also, when a user resubmits documents (calls `uploadDocument` after ADDITIONAL_DOCS), `user.kycStatus` should be reset to `PENDING`.

---

### H-5 · Enhanced images and thumbnails are uploaded to S3 but storage keys are never saved
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · lines 269–296  
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · lines 228–234

**Problem:** The pipeline uploads four files to S3 (`id-enhanced.jpg`, `selfie-enhanced.jpg`, `id-thumb.jpg`, `selfie-thumb.jpg`) but the storage keys returned by `storageService.upload()` are never persisted. `updateDocument()` is explicitly a **no-op**:

```typescript
async updateDocument(id: string, data: Partial<KycDocumentRecord>): Promise<void> {
  this.logger.debug({ documentId: id }, 'Document metadata updated (no-op until migration)');
}
```

Broker dashboard endpoints serve signed URLs for documents from the DB record, which only has the original upload key. The enhanced images — which are the ones brokers should be reviewing — are orphaned in S3 with no retrievable path.

**Fix (two parts):**
1. Add `enhancedStorageKey` and `thumbnailStorageKey` columns to the `KycDocument` Prisma schema.
2. Implement `updateDocument()` to write those keys, and call it from `processVerification()` after the S3 uploads succeed.

---

### H-6 · `parseDate` maps 2-digit birth years to 2000+, corrupting historical dates
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · lines 599–611

**Problem:**
```typescript
const fullYear = year < 100 ? 2000 + year : year;
return new Date(fullYear, month, day);
```

A Malawian born in 1979 whose NRC shows `DOB: 15/03/79` gets stored as `dateOfBirth: 2079-03-15`. Every submission with a 2-digit year (which is common on older NRCs) stores a future date ~100 years wrong.

Additionally, `new Date(fullYear, month, day)` creates a **local-time** date. If the server runs in UTC and `APP_TIMEZONE=Africa/Blantyre` (UTC+2), dates near midnight shift by 2 hours and can change the stored day.

**Fix:**
```typescript
// Use 1900 pivot for dates of birth; use Date.UTC to avoid timezone shifts
const fullYear = year < 100 ? (year >= 0 && year <= 30 ? 2000 + year : 1900 + year) : year;
return new Date(Date.UTC(fullYear, month, day));
```

Adjust the pivot year (30 here) to fit your minimum-age business rule.

---

### H-7 · No concurrency protection on `processVerification` — parallel calls corrupt pipeline state
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · line 189+

**Problem:** If two HTTP requests call `processVerification` for the same `applicationId` concurrently, both will:
- Start the pipeline with `status = PENDING`
- Run OCR independently, each doing a `readExistingJson` → merge → write cycle on `ocrExtractedData`
- Save two sets of embeddings, each overwriting the other
- Run fraud checks twice against the (possibly incomplete) embedding set
- Both write a final decision, with the last write winning arbitrarily

**Fix (short-term):** An application-level lock using Redis (already in the stack):
```typescript
const lockKey = `kyc:process:${applicationId}`;
const acquired = await this.redis.set(lockKey, '1', 'NX', 'EX', 300);
if (!acquired) throw new ConflictException('Verification already in progress');
try { ... } finally { await this.redis.del(lockKey); }
```

The BullMQ fix from H-3 also eliminates this by design, since BullMQ jobs are processed sequentially per key by default.

---

### H-8 · `getResult` returns hardcoded zeros for fraud flag count and processing time
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 224–226

**Problem:**
```typescript
fraudFlagCount: 0, // TODO: query fraud flags
...
totalProcessingTimeMs: 0,
```

These fields are part of the API contract the mobile app reads. The mobile app can never display real fraud flag counts or timing information.

**Fix:**
- Query `riskFlags` from the application record: `fraudFlagCount: (app.riskFlags as string[] | null)?.length ?? 0`
- Store `totalProcessingTimeMs` on the application record (add a column) or omit from the response if not worth storing.

---

### H-9 · `startApplication` uses incorrect status check to detect existing applications
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · lines 76–79

**Problem:**
```typescript
if (existing && (existing.status === 'PENDING' || existing.status === 'NOT_SUBMITTED')) {
  return { applicationId: existing.id };
}
```

`KycApplication.status` is never `'NOT_SUBMITTED'` — that is a `User.kycStatus` value. `KycApplication` starts as `'PENDING'` (or `'NOT_SUBMITTED'` once H-1 is fixed). The condition is logically correct only for the `PENDING` branch today. This is a dead branch that does nothing and, once H-1 is fixed, the logic would be broken again.

Furthermore, this check does not prevent creating a new application when an existing one is in `APPROVED` status, meaning an approved user can re-apply and risk having their approval reversed by the AI pipeline.

**Fix:**
```typescript
const RESUMABLE_STATUSES = new Set(['NOT_SUBMITTED', 'PENDING', 'ADDITIONAL_DOCS']);
if (existing && RESUMABLE_STATUSES.has(existing.status)) {
  return { applicationId: existing.id };
}
if (existing?.status === 'APPROVED') {
  throw new ConflictException('KYC already approved. Contact support to update your information.');
}
```

---

## Medium — Logic Issues and Edge Cases

---

### M-1 · `getStatus` returns an unparseable empty string for `submittedAt` when no application exists
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · lines 169–179

**Problem:**
```typescript
return {
  submittedAt: '',   // not an ISO date string — any client Date.parse('') returns NaN
  ...
};
```

**Fix:** Return `null` for nullable date fields:
```typescript
submittedAt: null,
```
Update the response DTO type accordingly: `submittedAt: string | null`.

---

### M-2 · `canProcess` flag allows re-triggering verification on REJECTED applications
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · line 193

**Problem:**
```typescript
canProcess: hasId && hasSelfie && app.status !== 'APPROVED',
```

This returns `true` for `REJECTED`, `ADDITIONAL_DOCS`, and `MANUAL_REVIEW` statuses. A rejected user can call `/kyc/process` again on the same application. Depending on the pipeline outcome, this could silently change a human-reviewed rejection back to PENDING or even re-approve it.

**Fix:**
```typescript
canProcess: hasId && hasSelfie && app.status === 'NOT_SUBMITTED',
// or: allow ADDITIONAL_DOCS but not REJECTED/MANUAL_REVIEW
```

---

### M-3 · `requestDocs` handler is missing a KYC-level audit entry
**File:** `src/modules/admin/controllers/admin-kyc.controller.ts` · line 573+

**Problem:** `requestDocs` writes to the main `AuditLog` table via `auditLogService.log()` but does not write to the KYC application's own audit trail via `kycRepo.recordAuditEntry()`. The KYC audit history returned by `getDetail` is therefore missing the "Additional Documents Requested" event.

**Fix:** Add a `kycRepo.recordAuditEntry()` call after `requestAdditionalDocuments()`:
```typescript
await this.kycRepo.recordAuditEntry({
  kycApplicationId: applicationId,
  action: 'DOCS_REQUESTED',
  actorId: admin.id,
  details: { requiredDocuments: body.requiredDocuments, message: body.message },
});
```

---

### M-4 · `getAllApprovedEmbeddings` and `findApplicationByDocumentHash` perform full table scans
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · lines 327–413

**Problem:** Both methods load every approved application's full `ocrExtractedData` JSON from Postgres to scan in application code. At scale (e.g., 50,000 approved users with ~2 KB of JSON each = 100 MB per fraud check), this will be extremely slow and memory-hungry. Every new KYC submission triggers both.

**Fix (short-term):** Add a dedicated `FaceEmbedding` table (one row per application per source type, with a `VECTOR` column for pgvector or a `BYTEA` column for the raw float data) and a `DocumentHash` table with a unique index. Both enable indexed lookups instead of full scans.

**Fix (medium-term):** Use the `pgvector` Postgres extension for approximate nearest-neighbour embedding search.

---

### M-5 · JPEG compression applied before Tesseract OCR reduces accuracy
**File:** `src/modules/kyc/image/sharp.provider.ts` · line 88  
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · lines 249–251

**Problem:** `enhance()` always outputs JPEG (lossy). The compressed buffer is then passed directly to Tesseract. JPEG compression introduces blocking artifacts (8×8 pixel blocks) that interfere with character recognition, particularly on small NRC numbers, dates, and fine printed text.

**Fix:** Add a `format` option to `EnhanceImageOptions` and use PNG (lossless) for OCR inputs:
```typescript
const enhancedIdForOcr = await this.imageProcessor.enhance(idBuffer, { format: 'png' });
const enhancedIdForStorage = await this.imageProcessor.enhance(idBuffer); // JPEG for storage
ocrResult = await this.ocrProvider.extractFields(enhancedIdForOcr, { documentType: 'national_id' });
```

---

### M-6 · SCRFD channel order (RGB vs BGR) is explicitly unresolved
**File:** `src/modules/kyc/face/insightface.provider.ts` · lines 300–306

**Problem:** The comment in `bufferToDetectionFloat32` states:
> "InsightFace ONNX models exported via the standard pipeline expect BGR; however, many community exports include a BGR→RGB conversion layer. If detection recall remains poor after testing, swap R and B channels here."

The current code uses RGB (Sharp's native output). If the deployed ONNX model expects BGR, detection will be silently degraded for all submissions. There is no test or assertion to catch this.

**Fix:** Determine definitively whether `det_10g.onnx` includes an internal BGR→RGB layer (inspect with Netron or check the buffalo_l model card). Then either:
- Keep RGB if the model handles it
- Swap channels in the preprocessing loop: `pixels[i] = (data[i*3+2] - 127.5) / 128.0` (R←B)

Document the resolution in a comment next to `bufferToDetectionFloat32`.

---

### M-7 · Confidence engine weights are not validated at startup
**File:** `src/modules/kyc/fraud/confidence-engine.ts` · lines 49–55

**Problem:** Weights are read from `process.env` at construction time with no assertion that they sum to 1.0. If an operator sets `KYC_WEIGHT_OCR=0.5` without adjusting others, the composite score range shifts silently. Auto-approve and auto-reject thresholds become meaningless.

**Fix:** Add a startup validation:
```typescript
const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
if (Math.abs(total - 1.0) > 0.001) {
  throw new Error(`KYC confidence weights must sum to 1.0, got ${total.toFixed(4)}`);
}
```

---

### M-8 · `parseDate` (workflow service) creates local-time dates
**File:** `src/modules/kyc/services/kyc-workflow.service.ts` · line 608 (also see H-6)

Distinct from the year-pivot issue: `new Date(fullYear, month, day)` is timezone-aware. If `APP_TIMEZONE=Africa/Blantyre` (UTC+2), a DOB of `01/01/1990` stored as midnight local time becomes `1989-12-31T22:00:00.000Z` in UTC — the wrong day. Use `Date.UTC()`.

---

### M-9 · `Tesseract PSM.SPARSE_TEXT_OSD` mode is slower and noisier than needed
**File:** `src/modules/kyc/ocr/tesseract.provider.ts` · line 68

**Problem:** `SPARSE_TEXT_OSD` adds orientation and script detection (OSD) on top of sparse text recognition. For fixed-orientation, known-language ID cards this adds 200–500 ms per image and can misfire on bi-lingual (English/Chichewa) cards, causing the engine to change its text segmentation assumptions mid-card.

**Fix:** Use `PSM.SPARSE_TEXT` (without OSD). If auto-rotation via Sharp's `EXIF.rotate()` is always applied before OCR (it is — `autoRotate: true` is the default in `enhance()`), orientation detection adds no value.

---

### M-10 · Missing `@UsePipes(new ValidationPipe(...))` on `KycController`
**File:** `src/modules/kyc/controllers/kyc.controller.ts` · line 37

**Problem:** `AdminKycController` declares `@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))` at the class level. `KycController` does not. Body parameters like `applicationId` (extracted via `@Body('applicationId')`) are not validated — any string including SQL injection payloads or path traversal sequences reaches the service and repository.

**Fix:** Add `@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))` to `KycController`. Also add `@IsUUID()` to any DTO field carrying an application or document ID.

---

## Low — Code Quality and Design Debt

---

### L-1 · Document content hash stored in JSON instead of a dedicated column
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · lines 185–197

The comment acknowledges this: _"KycDocument table doesn't have a contentHash column yet."_ Because the hash is stored in `ocrExtractedData._documentHashes`, `findApplicationByDocumentHash()` must load every application's JSON blob and scan it in Node.js — no index is possible.

**Fix:** Add `contentHash String?` to the `KycDocument` schema with a unique partial index for non-null values. Remove the JSON workaround.

---

### L-2 · `updateDocument` is permanently a no-op
**File:** `src/modules/kyc/repositories/kyc.repository.ts` · lines 228–234

No code path can update document metadata (enhanced key, thumbnail key, status). This silently discards all calls. Remove the method or implement it.

---

### L-3 · Model integrity check is disabled by default
**File:** `src/modules/kyc/face/insightface.provider.ts` · line 23; `MODEL_CONFIG.checksums: {}`

The `verifyChecksums()` method is only active if a `checksums.json` file exists. With no file present (the default), tampered or corrupted ONNX models load silently. Provide a pre-computed `checksums.json` for the expected buffalo_l model versions and fail-fast at startup if there is a mismatch.

---

### L-4 · Single Tesseract worker is a concurrency bottleneck
**File:** `src/modules/kyc/ocr/tesseract.provider.ts` · line 36

One `Tesseract.Worker` handles one image at a time. Concurrent KYC submissions will queue behind it. Once the async queue (H-3) is implemented, consider a worker pool (`Tesseract.createWorker()` ×N or use `Tesseract.recognize()` with a scheduler).

---

### L-5 · Dead file `kyc-admin.controller.ts` (kyc module) creates confusion
**File:** `src/modules/kyc/controllers/kyc-admin.controller.ts`

This file mirrors routes from `src/modules/admin/controllers/admin-kyc.controller.ts`. Both declare `@Controller('admin/kyc')`. If accidentally registered it would create route conflicts. It should be deleted (see C-4).

---

### L-6 · `isPlausibleDob` minimum-age pivot is hardcoded to 10 years
**File:** `src/modules/kyc/ocr/malawi-id.parser.ts` · line 473

The minimum age for a KYC applicant on a financial platform should be 18 (or the legal age in Malawi). The 10-year pivot is too permissive and would accept dates of birth for children. Make this a named constant and set it to the actual regulatory minimum:

```typescript
const KYC_MIN_AGE_YEARS = 18;
if (year < 1900 || year > currentYear - KYC_MIN_AGE_YEARS) return false;
```

---

## Summary Table

| ID  | Severity | Area                  | One-line description                                         |
|-----|----------|-----------------------|--------------------------------------------------------------|
| C-1 | Critical | Security              | `retry` endpoint uses body `userId` — impersonation vector   |
| C-2 | Critical | Security              | `getResult` has no ownership check — IDOR                    |
| C-3 | Critical | Security              | Mobile KYC endpoints have no JWT auth guard                  |
| C-4 | Critical | Security/Correctness  | Dead admin controller is unauthenticated, uses invalid FK    |
| C-5 | Critical | OCR/NRC parsing       | `normalizeNrc` corrupts NRC numbers ending in digit `1`      |
| H-1 | High     | Broker dashboard      | New applications start as PENDING, polluting broker queue    |
| H-2 | High     | State machine         | Document upload can regress pipeline stage                   |
| H-3 | High     | Performance           | `processVerification` blocks HTTP request thread             |
| H-4 | High     | Mobile UX             | `requestAdditionalDocuments` doesn't update `user.kycStatus` |
| H-5 | High     | Admin review          | Enhanced/thumbnail S3 keys never saved to DB                 |
| H-6 | High     | Data integrity        | 2-digit DOB years mapped to 2000+ (off by ~100 years)        |
| H-7 | High     | Concurrency           | No lock on `processVerification` — parallel calls corrupt data |
| H-8 | High     | API contract          | `getResult` hardcodes `fraudFlagCount: 0` and processing time 0 |
| H-9 | High     | State machine         | `startApplication` uses wrong status for resume check        |
| M-1 | Medium   | API contract          | `submittedAt: ''` when no application (unparseable)          |
| M-2 | Medium   | State machine         | `canProcess: true` for REJECTED apps                         |
| M-3 | Medium   | Audit trail           | `requestDocs` missing KYC audit entry                        |
| M-4 | Medium   | Scalability           | Full-table scans for embeddings and document hashes          |
| M-5 | Medium   | OCR accuracy          | JPEG compression before Tesseract hurts text recognition     |
| M-6 | Medium   | Face detection        | SCRFD RGB/BGR channel order unresolved                       |
| M-7 | Medium   | Configuration         | Confidence weights not validated to sum to 1.0               |
| M-8 | Medium   | Data integrity        | `parseDate` creates local-time dates (timezone shift)        |
| M-9 | Medium   | OCR performance       | `PSM.SPARSE_TEXT_OSD` slower than needed for fixed-layout IDs |
| M-10| Medium   | Validation            | No `ValidationPipe` on `KycController`                       |
| L-1 | Low      | Design debt           | Document hash in JSON — no index, full table scan            |
| L-2 | Low      | Design debt           | `updateDocument()` is a permanent no-op                      |
| L-3 | Low      | Security (ops)        | Model integrity check disabled by default                    |
| L-4 | Low      | Performance           | Single Tesseract worker is a concurrency bottleneck          |
| L-5 | Low      | Code clarity          | Dead admin controller file should be deleted                 |
| L-6 | Low      | Compliance            | `isPlausibleDob` minimum age is 10, should be 18             |

---

## Recommended Fix Order

**Ship-blocker (fix before any production traffic):**
C-1, C-2, C-3, C-4, C-5, H-3, H-4, H-6, H-9

**Fix before KYC volume scales:**
H-1, H-2, H-5, H-7, H-8, M-2, M-4, M-7, M-10

**Fix in next sprint:**
M-1, M-3, M-5, M-6, M-8, M-9, L-1, L-2, L-3, L-6

**Cleanup (low risk, do opportunistically):**
L-4, L-5
