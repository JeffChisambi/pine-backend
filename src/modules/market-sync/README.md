# market-sync module

**Status:** ✅ Implemented (Phase 4)

Production-grade MSE market data collection platform. Scrapes https://mse.co.mw/market/mainboard
using Playwright, validates data with Zod, persists to PostgreSQL via Prisma, and caches in Redis.

## Architecture

```
Cron → BullMQ → Orchestrator → Scraper(Playwright) → Validator(Zod) → Repository(Prisma) → Cache(Redis)
```

## Key Features

- **Playwright scraper** with GoDaddy firewall bypass (homepage-first cookie warming)
- **Zod validation** with 3 layers: structural, cross-field, anomaly detection
- **BullMQ job processing** with retry, backoff, dead-letter, and stalled-job detection
- **Redis distributed lock** to prevent concurrent syncs
- **Circuit breaker** (pauses sync for 30 min after 3 consecutive failures)
- **Domain events** (`market.data.synced`) for downstream modules
- **Admin API** for manual triggers, status monitoring, and history
- **Strategy pattern** — swap scraper for API/CSV by changing one DI binding

## Layout

- `controllers/` — Admin endpoints (`POST trigger`, `GET status`, `GET history`)
- `services/` — Orchestrator, Playwright scraper, cron scheduler, BullMQ processor
- `repositories/` — Prisma + Redis persistence (stock prices, sync run logs)
- `domain/` — Value objects, Zod schemas, validator (pure logic, no I/O)
- `dto/` — Request/response DTOs with class-validator + Swagger decorators
- `events/` — `MarketDataSyncedEvent` domain event
- `interfaces/` — `IMarketDataSource` and `IMarketSyncRepository` port interfaces

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/admin/market-sync/trigger` | Manually trigger a sync (returns job ID) |
| `GET`  | `/v1/admin/market-sync/status`  | Current sync state, circuit breaker, health |
| `GET`  | `/v1/admin/market-sync/history` | Paginated sync run history (last 100 runs) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MSE_DATA_SOURCE` | `scraper` | Data source type: `scraper`, `api`, `csv` |
| `MSE_BASE_URL` | `https://mse.co.mw` | Base URL for MSE website |
| `MARKET_SYNC_CRON` | `*/15 8-16 * * 1-5` | Cron schedule (every 15min, 8am-4pm, Mon-Fri) |
| `MARKET_TIMEZONE` | `Africa/Blantyre` | Timezone for market hours |
| `MARKET_OPEN_TIME` | `10:00` | MSE opening time |
| `MARKET_CLOSE_TIME` | `14:00` | MSE closing time |

## Dependencies

- `playwright` — headless Chromium for scraping
- All other deps are already in the Pine backend (Prisma, Redis, BullMQ, Zod, Pino)

## Microservice Extraction

To extract as a standalone service:
1. Copy this module to a new NestJS project
2. Replace `PrismaService` import with a local one
3. Replace `REDIS_CLIENT` import with a local Redis module
4. All domain logic, validation, and interfaces stay unchanged
