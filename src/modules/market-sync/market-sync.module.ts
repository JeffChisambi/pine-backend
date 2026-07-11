import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { QueueName } from '../../core/constants/queue-names.constant';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';

// Domain
import { MarketDataValidator } from './domain/market-data.validator';

// Interfaces — injection tokens
import { MARKET_DATA_SOURCE } from './interfaces/market-data-source.interface';
import { MARKET_SYNC_REPOSITORY } from './interfaces/market-sync-repository.interface';

// Services
import { MseScraperService } from './services/mse-scraper.service';
import { MarketSyncService } from './services/market-sync.service';
import { MarketSyncCronService } from './services/market-sync-cron.service';
import { MarketSyncProcessor } from './services/market-sync.processor';

// Repository
import { MarketSyncRepository } from './repositories/market-sync.repository';

// Controller
import { MarketSyncController } from './controllers/market-sync.controller';

/**
 * MarketSyncModule — Production-grade MSE market data collection platform.
 *
 * Architecture:
 *   Cron → BullMQ → Orchestrator → Scraper → Validator → Repository → Cache
 *
 * Key design decisions:
 *
 * 1. **Strategy pattern for data sources**: The `MARKET_DATA_SOURCE`
 *    token binds to `MseScraperService` (Playwright) today. To switch
 *    to a direct API or CSV import, replace the `useClass` binding —
 *    no other file changes needed.
 *
 * 2. **Repository abstraction**: The `MARKET_SYNC_REPOSITORY` token
 *    binds to `MarketSyncRepository` (Prisma + Redis). For
 *    microservice extraction, swap in an HTTP-backed implementation
 *    that calls the extracted service's API.
 *
 * 3. **BullMQ for resilience**: The cron scheduler enqueues jobs
 *    instead of running sync inline. The processor handles retries,
 *    backoff, and dead-letter automatically.
 *
 * 4. **Validator is a standalone injectable**: Pure logic, no I/O,
 *    fully unit-testable without mocking infrastructure.
 *
 * 5. **Module is self-contained**: All imports are from `../../`
 *    (infrastructure) or internal — no circular deps with other
 *    feature modules. Other modules subscribe to events, never
 *    import this module's services directly.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    // BullMQ queue is already registered globally in QueueModule,
    // but we need to import it here for @InjectQueue to work
    BullModule.registerQueue({ name: QueueName.MARKET_SYNC }),
  ],
  controllers: [MarketSyncController],
  providers: [
    // ── Domain ───────────────────────────────────────────────────
    MarketDataValidator,

    // ── Data source (Strategy pattern) ──────────────────────────
    // Swap this binding to switch from Playwright scraper to
    // API client or CSV importer — zero changes elsewhere.
    {
      provide: MARKET_DATA_SOURCE,
      useClass: MseScraperService,
    },

    // ── Repository (Persistence abstraction) ────────────────────
    {
      provide: MARKET_SYNC_REPOSITORY,
      useClass: MarketSyncRepository,
    },

    // ── Services ────────────────────────────────────────────────
    MarketSyncService,
    MarketSyncCronService,

    // ── BullMQ processor ────────────────────────────────────────
    MarketSyncProcessor,
  ],
  // Export the service for potential use by other modules
  // (e.g., a stocks controller that wants to trigger a sync)
  exports: [MarketSyncService],
})
export class MarketSyncModule {}
