import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator, PerformanceMetrics } from './portfolio-calculator.service';

/**
 * Performance Service — calculates returns over time.
 *
 * Pure mathematics. Computes:
 * - Today's return
 * - Weekly / Monthly / Yearly return
 * - Lifetime return
 * - Annualized return
 *
 * Uses stored snapshots so we never recalculate years of history.
 */
@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);

  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
  ) {}

  /**
   * Get current performance metrics for a user.
   */
  async getPerformance(userId: string): Promise<PerformanceMetrics> {
    // Get current portfolio value
    const holdings = await this.repo.findUserHoldings(userId);
    const wallet = await this.repo.findWalletByUserId(userId);
    const cashBalance = wallet?.balance ?? new Decimal(0);

    const summary = this.calculator.calculateSummary(holdings, cashBalance);
    const currentValue = cashBalance.add(summary.totalMarketValue);

    // Get historical snapshots for comparison
    const snapshots = await this.repo.findSnapshots(userId, 400);

    return this.calculator.calculatePerformance(
      currentValue,
      summary.totalInvested,
      snapshots,
    );
  }

  /**
   * Get performance history (for charting).
   */
  async getPerformanceHistory(userId: string, limit = 30) {
    const history = await this.repo.findPerformanceHistory(userId, limit);
    return history.map((p) => ({
      date: p.date,
      dailyReturn: p.dailyReturn.toNumber(),
      dailyReturnPct: p.dailyReturnPct.toNumber(),
      weeklyReturn: p.weeklyReturn.toNumber(),
      weeklyReturnPct: p.weeklyReturnPct.toNumber(),
      monthlyReturn: p.monthlyReturn.toNumber(),
      monthlyReturnPct: p.monthlyReturnPct.toNumber(),
      lifetimeReturn: p.lifetimeReturn.toNumber(),
      lifetimeReturnPct: p.lifetimeReturnPct.toNumber(),
    }));
  }

  /**
   * Store a performance snapshot for today.
   * Called by the snapshot scheduler or after trades.
   */
  async savePerformanceSnapshot(userId: string): Promise<void> {
    const performance = await this.getPerformance(userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await this.repo.upsertPerformance({
      userId,
      date: today,
      dailyReturn: new Decimal(performance.dailyReturn),
      dailyReturnPct: new Decimal(performance.dailyReturnPct),
      weeklyReturn: new Decimal(performance.weeklyReturn),
      weeklyReturnPct: new Decimal(performance.weeklyReturnPct),
      monthlyReturn: new Decimal(performance.monthlyReturn),
      monthlyReturnPct: new Decimal(performance.monthlyReturnPct),
      yearlyReturn: new Decimal(performance.yearlyReturn),
      yearlyReturnPct: new Decimal(performance.yearlyReturnPct),
      lifetimeReturn: new Decimal(performance.lifetimeReturn),
      lifetimeReturnPct: new Decimal(performance.lifetimeReturnPct),
    });
  }
}
