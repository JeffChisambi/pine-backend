# Pine Backend

Enterprise backend for **Pine** — a stock investment platform for the Malawi Stock Exchange (MSE).

## Project overview

NestJS 11 / TypeScript backend in Phase 1 of 7. The app boots and serves:
- `GET /v1/health` — health check
- `GET /docs` — Swagger/OpenAPI UI (non-prod only)

No business-logic endpoints exist yet. See the [Roadmap](#roadmap) in `README.md`.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 LTS, TypeScript, NestJS 11 |
| Database | PostgreSQL 16, Prisma ORM |
| Cache | Redis (OTP, sessions, rate limiting, market cache) |
| Object storage | S3-compatible (AWS S3 / Cloudflare R2 / MinIO) |
| Queues | BullMQ on Redis |
| Auth | JWT access + rotating refresh tokens, Argon2id |
| Testing | Vitest (unit / integration / e2e) |

## How to run (locally with Docker)

```bash
cp .env.example .env   # fill in secrets

# Start Postgres, Redis, MinIO, Mailhog
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml \
  up postgres redis minio minio-init mailhog -d

npm install
npm run prisma:migrate:dev   # creates schema + seeds
npm run db:apply-triggers    # ledger/audit immutability triggers
npm run start:dev
```

## How to run on Replit

Docker is not available on Replit. To run here you need:

1. **PostgreSQL** — use Replit's built-in PostgreSQL integration (`DATABASE_URL`)
2. **Redis** — use an external hosted Redis (e.g. Upstash) and set `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`
3. **Object storage** — use Cloudflare R2 or AWS S3 (MinIO won't run on Replit)
4. **Environment variables** — copy `.env.example`, fill in real values, and add them as Replit Secrets

Run command: `npm run start:dev`

## Key environment variables

See `.env.example` for the full list. Required to boot:

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_HOST`, `REDIS_PORT` — Redis connection
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — min 32 chars each
- `PIN_ENCRYPTION_KEY` — 32-byte hex key
- `COOKIE_SECRET` — min 32 chars
- Storage: `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`

## Useful scripts

```bash
npm run start:dev           # dev server with watch
npm run build               # compile to dist/
npm run test                # unit tests (no external deps)
npm run test:integration    # needs Postgres + Redis
npm run prisma:migrate:dev  # run migrations + seed
npm run typecheck           # TypeScript type check only
```

## Architecture

Clean Architecture + DDD. Modules: `auth`, `users`, `kyc`, `wallet`, `payments`, `stocks`, `market-sync`, `trading`, `portfolio`, `dividends`, `notifications`, `admin`, `audit`, `analytics`.

See `README.md` for the full architecture notes.

## User preferences

<!-- Add remembered preferences here -->
