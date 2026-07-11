# Pine Backend

Enterprise backend for **Pine** — a stock investment platform for the Malawi Stock Exchange (MSE).

> **Status: Phase 1 of 7 complete.** This delivers project setup, architecture, folder
> structure, environment configuration, core infrastructure, and the full database schema.
> No business-logic endpoints exist yet — see [Roadmap](#roadmap) below. The app boots,
> connects to Postgres/Redis/S3-compatible storage, and serves `/v1/health/*` and
> `/docs` (Swagger) today.

## Stack

| Concern         | Choice                                                             |
|-----------------|----------------------------------------------------------------------|
| Runtime         | Node.js 24 LTS, TypeScript, NestJS 11                                |
| Database        | PostgreSQL 16, Prisma ORM, UUID PKs, `NUMERIC(18,4)` money columns   |
| Cache           | Redis (OTP, sessions, rate limiting, market/portfolio cache)         |
| Object storage  | S3-compatible (AWS S3 / Cloudflare R2 / MinIO)                       |
| Queues          | BullMQ on Redis                                                      |
| Auth            | JWT access + rotating refresh tokens, Argon2id password hashing      |
| Validation      | class-validator (DTOs) + Zod (env, webhooks)                         |
| Logging         | Pino, structured JSON, request-ID correlated                         |
| API docs        | OpenAPI/Swagger, auto-generated, `/docs` (non-prod only)             |
| Testing         | Vitest (unit / integration / e2e)                                    |
| Money math      | decimal.js via a `Money` value object — **never** JS `number`        |

## Architecture

Clean Architecture + Domain-Driven Design, organized by module (bounded context), not by
technical layer:

```
src/
  config/           Zod-validated env, namespaced typed config (AppConfigService)
  core/             Cross-cutting: exceptions, filters, interceptors, guards, decorators
  infrastructure/   Prisma, Redis, BullMQ, S3 storage, Pino logger, health checks
  shared/           Money value object, cursor pagination, Entity/AggregateRoot/DomainEvent
  modules/
    auth/ users/ kyc/ wallet/ payments/ stocks/ market-sync/ trading/
    portfolio/ dividends/ notifications/ admin/ audit/ analytics/
      controllers/  services/  repositories/  domain/  dto/  events/  interfaces/  policies/  tests/
```

Each module owns its own controller → service → repository → domain stack. Controllers are
thin (no business logic). Application services depend on repository **interfaces**
(`shared/base/repository.interface.ts`), never on `PrismaService` directly, so the domain
layer stays persistence-ignorant and unit-testable without a database.

### Key architectural decisions

- **Double-entry, append-only ledger.** `LedgerEntry` rows are never updated or deleted —
  enforced both by convention (repositories never call `.update()`/`.delete()` on it) and by
  a Postgres trigger (`scripts/sql/immutable_triggers.sql`) so even a compromised credential
  can't rewrite financial history. `AuditLog` follows the same rule.
- **Serializable isolation + row locking for money.** Balance-mutating transactions use
  `FINANCIAL_TRANSACTION_OPTIONS` (`infrastructure/database/prisma.service.ts`) to prevent
  double-spend races.
- **Cursor pagination everywhere**, not `OFFSET` — stable under concurrent inserts and
  doesn't degrade at scale (`shared/pagination`).
- **Idempotency-Key required on every money-moving write** — enforced by `IdempotencyGuard`
  (`core/guards`); actual dedup logic (Redis-backed lock + cached result) lands in Phase 3.
- **Read replica ready.** `PrismaReadReplicaService` exists from Phase 1 so heavy market-data
  / analytics reads never contend with transaction-processing traffic; it safely falls back to
  the primary URL if no replica is configured.
- **RBAC roles are fixed at the domain level from day one**
  (`core/constants/roles.constant.ts`): `SUPER_ADMIN`, `COMPLIANCE_OFFICER`,
  `FINANCE_OFFICER`, `CUSTOMER_SUPPORT`, `MARKET_OPERATIONS`, `AUDITOR`, plus `CUSTOMER`.

## Getting started

```bash
cp .env.example .env               # fill in real secrets before anything but local dev
npm install

# Start Postgres, Redis, MinIO, Mailhog in Docker; run the API on the host for fast reload:
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  up postgres redis minio minio-init mailhog -d

npm run prisma:migrate:dev         # creates the schema, auto-runs prisma/seed.ts
npm run db:apply-triggers          # applies the ledger/audit immutability triggers
npm run start:dev
```

Swagger UI: http://localhost:3000/docs
Health: http://localhost:3000/v1/health

### Full stack in Docker (API included)

```bash
docker compose -f docker/docker-compose.yml up --build
```

### Tests

```bash
npm test                # unit — no external dependencies required
npm run test:integration  # requires Postgres + Redis running (see docker-compose)
npm run test:e2e          # requires Postgres + Redis running
npm run test:cov          # unit tests with coverage
```

## Roadmap

| Phase | Scope |
|-------|-------|
| **1** ✅ | Project setup, architecture, folder structure, env config, infrastructure, DB schema |
| 2 | Auth, Users, security (JWT rotation, device/session mgmt, OTP, PIN) |
| 3 | KYC, Wallet (ledger), Payments (PayChangu) |
| 4 | Stocks, Market Sync, Trading |
| 5 | Portfolio, Dividends |
| 6 | Notifications, Analytics, Admin, Audit |
| 7 | Full test coverage, Docker hardening, CI/CD deploy stage, production hardening |

Each phase must compile and pass CI (`.github/workflows/ci.yml`) before the next begins.

## Environment variables

See `.env.example` — every variable is validated at boot by `src/config/env.validation.ts`
(Zod). The process refuses to start if anything required is missing or malformed, rather than
failing later mid-request.

## Note on the mobile API contract

This build follows the technology, architecture, and module requirements as specified. The
Phase 1 deliverables (project setup, folder structure, infrastructure, database schema) don't
depend on exact endpoint shapes, but **Phase 2 onward needs the actual Expo app's API contract**
(request/response shapes, route names, status codes it expects) to implement matching
controllers and DTOs correctly rather than guessing. Please provide it before Phase 2 starts.
