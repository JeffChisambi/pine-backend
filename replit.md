# Pine Backend

Enterprise backend for the **Pine** stock investment platform (Malawi Stock Exchange).

## Stack
- **Runtime**: Node.js 24, TypeScript, NestJS 11
- **Database**: PostgreSQL 16 + Prisma ORM
- **Cache/Queues**: Redis + BullMQ
- **Storage**: S3-compatible (AWS S3 / Cloudflare R2 / MinIO)
- **Auth**: JWT access + rotating refresh tokens, Argon2id
- **Docs**: Swagger at `/docs` (non-prod only)

## Status
Phase 1 of 7 complete — project setup, architecture, DB schema, infrastructure wiring. The app boots and serves `/v1/health` and `/docs`.

## How to run (development)

1. Copy `.env.example` → `.env` and fill in all required values (see below).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run migrations + seed:
   ```bash
   npm run prisma:migrate:dev
   npm run db:apply-triggers
   ```
4. Start the dev server:
   ```bash
   npm run start:dev
   ```

Swagger UI: http://localhost:3000/docs  
Health: http://localhost:3000/v1/health

## Required external services

The app validates all env vars at boot (via Zod) and **refuses to start** if any are missing:

| Service | Variables |
|---------|-----------|
| PostgreSQL | `DATABASE_URL` |
| Redis | `REDIS_HOST`, `REDIS_PORT` |
| S3-compatible storage | `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` |
| JWT secrets | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` |
| PIN encryption | `PIN_ENCRYPTION_KEY` |
| Cookie secret | `COOKIE_SECRET` |

See `.env.example` for the full list.

## Tests

```bash
npm test                  # unit tests (no external deps)
npm run test:integration  # requires Postgres + Redis
npm run test:e2e          # requires Postgres + Redis
npm run test:cov          # unit tests with coverage
```

## User preferences
