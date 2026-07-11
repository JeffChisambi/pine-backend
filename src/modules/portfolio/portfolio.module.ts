import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ConfigModule } from '../../config/config.module';

// Repository
import { PortfolioRepository } from './repositories/portfolio.repository';

// Calculator
import { PortfolioCalculator } from './services/portfolio-calculator.service';

// Services
import { HoldingsService } from './services/holdings.service';
import { ValuationService } from './services/valuation.service';
import { PerformanceService } from './services/performance.service';
import { AllocationService } from './services/allocation.service';
import { AnalyticsService } from './services/analytics.service';
import { SnapshotService } from './services/snapshot.service';
import { PortfolioService } from './services/portfolio.service';

// Controller
import { PortfolioController } from './controllers/portfolio.controller';

/**
 * PortfolioModule — investment accounting system.
 *
 * The portfolio is a materialized projection (read model) built from:
 *   Ledger entries + Executed trades + Market prices
 *
 * Architecture:
 *   Controller → PortfolioService (orchestrator)
 *     → HoldingsService     (current positions)
 *     → ValuationService    (market value + P&L)
 *     → PerformanceService  (returns over time)
 *     → AllocationService   (asset/sector breakdown)
 *     → AnalyticsService    (insights + analytics)
 *     → SnapshotService     (daily snapshots for charts)
 *     → PortfolioCalculator (pure computation engine)
 *
 * Event-driven: subscribes to trading.trade.settled
 * Cron: daily snapshot at market close (14:30 CAT)
 */
@Module({
  imports: [
    DatabaseModule,
    ConfigModule,
  ],
  controllers: [PortfolioController],
  providers: [
    PortfolioRepository,
    PortfolioCalculator,
    HoldingsService,
    ValuationService,
    PerformanceService,
    AllocationService,
    AnalyticsService,
    SnapshotService,
    PortfolioService,
  ],
  exports: [
    PortfolioService,
    HoldingsService,
    ValuationService,
  ],
})
export class PortfolioModule {}
