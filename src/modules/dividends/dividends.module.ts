import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';

// Repository
import { CorporateActionsRepository } from './repositories/corporate-actions.repository';

// Services
import { DividendService } from './services/dividend.service';
import { DistributionEngine } from './services/distribution-engine.service';
import { CorporateActionsService } from './services/corporate-actions.service';

// Controller
import { CorporateActionsController } from './controllers/corporate-actions.controller';

/**
 * CorporateActionsModule (formerly DividendsModule) — the single authority
 * for everything that happens because a company changes the characteristics
 * or benefits of its shares.
 *
 * Types supported:
 *   Dividends       → Cash to wallet via Ledger
 *   Stock Splits    → Holdings quantity × multiplier, avg cost ÷ multiplier
 *   Bonus Shares    → Holdings + bonus, avg cost adjusted
 *   Rights Issues   → Schema ready, processing future
 *   Mergers         → Schema ready, processing future
 *   Delistings      → Schema ready, processing future
 *
 * Architecture:
 *   Market Sync / Admin → Corporate Actions Module
 *     → DividendService        (declare, manage dividends)
 *     → DistributionEngine     (THE HEART — distributes to all shareholders)
 *     → CorporateActionsService (orchestrator + API facade)
 *
 * The Distribution Engine:
 *   1. Finds all shareholders (from Holdings)
 *   2. Calculates payment per investor
 *   3. Creates ledger entries (double-entry)
 *   4. Credits wallets
 *   5. Publishes events → Notifications
 *
 * Cron: Auto-processes due dividends daily at 14:00 UTC
 *
 * Events published:
 *   corporate-actions.dividend.paid
 *   corporate-actions.bonus.issued
 *   corporate-actions.split.applied
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
  ],
  controllers: [CorporateActionsController],
  providers: [
    CorporateActionsRepository,
    DividendService,
    DistributionEngine,
    CorporateActionsService,
  ],
  exports: [
    CorporateActionsService,
    DividendService,
    DistributionEngine,
  ],
})
export class DividendsModule {}
