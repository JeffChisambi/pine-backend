---
name: KYC broker dashboard API contract
description: Design decisions and gaps fixed when implementing the Kusata broker dashboard API contract v1.0 against the Pine backend KYC module.
---

## Rule
When adding new fields to KycApplicationRow, add a proper Prisma column — do not rely on ocrExtractedData JSON for fields that the admin API must expose. JSON is for pipeline internals only.

**Why:** The ocrExtractedData column stores OcrFieldResult objects (`{ value, confidence }`), not flat strings. The admin API requires flat strings. Keeping admin-facing fields in dedicated columns avoids parsing OcrFieldResult in every response and allows DB-level filtering/sorting.

**How to apply:** Any new field the broker dashboard needs → Prisma column on `kyc_applications`. Map it in `KycRepository.mapApplication()`. Only pipeline state (`_stage`, `_embeddings`, `_fraudFlags`, `_*Score`) stays in JSON.

---

## Rule
`KycStatus` enum is shared between `KycApplication.status` and `User.kycStatus`. New application statuses (`ADDITIONAL_DOCS`, `MANUAL_REVIEW`) are valid on applications but should NOT be set on `User.kycStatus` — that field only tracks whether a user may trade (NOT_SUBMITTED, PENDING, APPROVED, REJECTED).

**Why:** Setting `User.kycStatus = MANUAL_REVIEW` would break the trade eligibility guard which only checks for APPROVED.

**How to apply:** In mutations, always update `User.kycStatus` separately and only ever set it to APPROVED or REJECTED (never to MANUAL_REVIEW or ADDITIONAL_DOCS).

---

## Rule
`StorageService.getSignedDownloadUrl` accepts an optional third `expiresIn` seconds parameter. KYC document review must pass 3600 (1 hour) — not the default 900 s — so images remain viewable after the admin opens the detail panel.

**Why:** Browser `<img>` tags cannot set Authorization headers; image access relies entirely on the signed URL staying valid. The Kusata API contract §7 requires ≥ 1 hour TTL.

---

## Rule
`BROKER` role must NOT have `KYC_APPROVE` permission. Removing it from `ROLE_PERMISSIONS[Role.BROKER]` in `permissions.constant.ts` is the only change needed — the `@RequirePermissions(Permission.KYC_APPROVE)` guard then returns 403 automatically.

**Why:** Per the Kusata API contract, brokers are read-only on KYC (view queue + detail only). Earlier implementation granted brokers full mutation access by mistake.

---

## Rule
`AuthenticatedUser` (core/types/request-context.types.ts) has no `firstName`/`lastName`. To get the reviewer display name inside a controller, do an async DB lookup via `PrismaService` at request time.

**Why:** The JWT payload only carries `id`, `phone`, `email`, `role`, `sessionId`, `deviceId`, `kycStatus`. Name is not in the token.
