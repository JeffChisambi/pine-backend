import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator } from './portfolio-calculator.service';
import { PerformanceService } from './performance.service';
import { AllocationService } from './allocation.service';

/**
 * Snapshot Service — stores daily portfolio snapshots.
 *
 * Never recalculate history. Store snapshots.
 * Charts become fast — read one row per day instead of
 * re-scanning all trades, holdings, and prices.
 *
 * Runs daily at market close (14:30 CAT) via cron.
 * Also triggered after every trade settlement.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
    private readonly performanceService: PerformanceService,
    private readonly allocationService: AllocationService,
  ) {}

  /**
   * Generate a portfolio snapshot for a specific user.
   * Called after trade settlement and by the daily cron.
   */
  async generateSnapshot(userId: string): Promise<void> {
    try {
      const holdings = await this.repo.findUserHoldings(userId);
      const wallet = await this.repo.findWalletByUserId(userId);
      const cashBalance = wallet?.balance ?? new Decimal(0);

      const summary = this.calculator.calculateSummary(holdings, cashBalance);
      const totalValue = cashBalance.add(summary.totalMarketValue);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Store snapshot
      await this.repo.upsertSnapshot({
        userId,
        snapshotDate: today,
        totalValue,
        // The series investors actually see: stocks only. Cash is recorded
        // beside it, never inside it — a deposit must not look like growth.
        holdingsValue: summary.totalMarketValue,
        cashBalance,
        totalCost: summary.totalInvested,
        unrealizedPnl: summary.totalUnrealizedPnl,
      });

      // Update performance metrics
      await this.performanceService.savePerformanceSnapshot(userId);

      // Update allocation snapshot
      await this.allocationService.saveAllocationSnapshot(userId);

      this.logger.log(
        { userId, totalValue: totalValue.toString() },
        'Portfolio snapshot generated',
      );
    } catch (error) {
      this.logger.error(
        { err: error, userId },
        'Failed to generate portfolio snapshot',
      );
    }
  }

  /**
   * Get snapshot history for charting.
   */
  async getSnapshotHistory(userId: string, limit = 90) {
    const snapshots = await this.repo.findSnapshots(userId, limit);
    return snapshots.map((s) => ({
      date: s.snapshotDate,
      totalValue: s.totalValue.toNumber(),
      totalCost: s.totalCost.toNumber(),
      unrealizedPnl: s.unrealizedPnl.toNumber(),
    })).reverse(); // Chronological order for charts
  }

  /**
   * Daily cron job — generate snapshots for all users with holdings.
   * Runs at 14:30 CAT (12:30 UTC) — right after MSE market close.
   */
  @Cron('30 12 * * 1-5', { name: 'portfolio-daily-snapshot' })
  async dailySnapshotJob(): Promise<void> {
    this.logger.log('Running daily portfolio snapshot job');

    try {
      // Find all users with active holdings
      const holdings = await this.repo['prisma'].holding.findMany({
        where: { quantity: { gt: 0 } },
        select: { userId: true },
        distinct: ['userId'],
      });

      const userIds = holdings.map((h: any) => h.userId);
      this.logger.log({ userCount: userIds.length }, 'Generating snapshots');

      for (const userId of userIds) {
        await this.generateSnapshot(userId);
      }

      this.logger.log(
        { userCount: userIds.length },
        'Daily portfolio snapshot job completed',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Daily snapshot job failed');
    }
  }
}
