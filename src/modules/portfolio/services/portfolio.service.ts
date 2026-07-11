import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator, PortfolioSummary } from './portfolio-calculator.service';
import { HoldingsService } from './holdings.service';
import { ValuationService } from './valuation.service';
import { PerformanceService } from './performance.service';
import { AllocationService } from './allocation.service';
import { AnalyticsService } from './analytics.service';
import { SnapshotService } from './snapshot.service';

/**
 * Portfolio Service — the orchestrator.
 *
 * Portfolio never:
 *  - Executes trades
 *  - Handles payments
 *  - Calculates market prices
 *  - Creates ledger entries
 *
 * Instead, it reads data from other modules and presents the
 * investor's position. It is the "truth" about holdings.
 *
 * Event-driven: subscribes to TradeSettled, DividendPaid, etc.
 * Every event updates the portfolio.
 */

// Import trading events (cross-module dependency via events only)
const TRADE_SETTLED_EVENT = 'trading.trade.settled';
const PORTFOLIO_UPDATED_EVENT = 'portfolio.updated';

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
    private readonly holdingsService: HoldingsService,
    private readonly valuationService: ValuationService,
    private readonly performanceService: PerformanceService,
    private readonly allocationService: AllocationService,
    private readonly analyticsService: AnalyticsService,
    private readonly snapshotService: SnapshotService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Event Handlers ──────────────────────────────────────────

  /**
   * React to trade settlement — update holdings and generate snapshot.
   */
  @OnEvent(TRADE_SETTLED_EVENT)
  async handleTradeSettled(event: {
    tradeId: string;
    orderId: string;
    userId: string;
    stockId: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
  }): Promise<void> {
    this.logger.log(
      { tradeId: event.tradeId, userId: event.userId, side: event.side },
      'Portfolio: handling settled trade',
    );

    // 1. Update holdings
    const holding = await this.holdingsService.updateHoldingFromTrade({
      userId: event.userId,
      stockId: event.stockId,
      side: event.side,
      quantity: event.quantity,
      price: event.price,
    });

    // 2. Generate fresh snapshot
    await this.snapshotService.generateSnapshot(event.userId);

    // 3. Publish portfolio updated event
    this.eventEmitter.emit(PORTFOLIO_UPDATED_EVENT, {
      userId: event.userId,
      stockId: event.stockId,
      newQuantity: holding.quantity.toNumber(),
      averageCost: holding.averageCost.toNumber(),
    });

    this.logger.log(
      { userId: event.userId, tradeId: event.tradeId },
      'Portfolio updated after trade settlement',
    );
  }

  // ── API Methods ─────────────────────────────────────────────

  /**
   * GET /portfolio — full portfolio overview.
   */
  async getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
    const holdings = await this.repo.findUserHoldings(userId);
    const wallet = await this.repo.findWalletByUserId(userId);
    const cashBalance = wallet?.balance ?? new Decimal(0);

    const summary = this.calculator.calculateSummary(holdings, cashBalance);
    const totalMarketValue = summary.totalMarketValue;
    const portfolioValue = cashBalance.add(totalMarketValue);

    const pnlPercent = summary.totalInvested.gt(0)
      ? summary.totalUnrealizedPnl.div(summary.totalInvested).mul(100).toNumber()
      : 0;

    const dailyChangePct = portfolioValue.gt(0) && !summary.dailyChange.eq(0)
      ? summary.dailyChange.div(portfolioValue.sub(summary.dailyChange)).mul(100).toNumber()
      : 0;

    return {
      cashBalance: cashBalance.toNumber(),
      totalInvested: summary.totalInvested.toNumber(),
      totalMarketValue: totalMarketValue.toNumber(),
      totalUnrealizedPnl: summary.totalUnrealizedPnl.toNumber(),
      totalPnlPercent: Math.round(pnlPercent * 100) / 100,
      portfolioValue: portfolioValue.toNumber(),
      dailyChange: summary.dailyChange.toNumber(),
      dailyChangePct: Math.round(dailyChangePct * 100) / 100,
      holdingsCount: holdings.length,
    };
  }

  /**
   * GET /portfolio/holdings — all stock positions with valuations.
   */
  async getHoldings(userId: string) {
    return this.valuationService.getValuations(userId);
  }

  /**
   * GET /portfolio/holdings/:stockId — single holding detail.
   */
  async getHoldingDetail(userId: string, stockId: string) {
    return this.valuationService.getHoldingValuation(userId, stockId);
  }

  /**
   * GET /portfolio/performance — returns over time.
   */
  async getPerformance(userId: string) {
    return this.performanceService.getPerformance(userId);
  }

  /**
   * GET /portfolio/allocation — asset/sector allocation.
   */
  async getAllocation(userId: string) {
    return this.allocationService.getAllocation(userId);
  }

  /**
   * GET /portfolio/analytics — insights and analytics.
   */
  async getAnalytics(userId: string) {
    return this.analyticsService.getAnalytics(userId);
  }

  /**
   * GET /portfolio/history — snapshot history for charts.
   */
  async getHistory(userId: string, limit = 90) {
    return this.snapshotService.getSnapshotHistory(userId, limit);
  }

  /**
   * GET /portfolio/snapshots — raw snapshot data.
   */
  async getSnapshots(userId: string, limit = 90) {
    const snapshots = await this.repo.findSnapshots(userId, limit);
    return snapshots.map((s) => ({
      date: s.snapshotDate,
      totalValue: s.totalValue.toNumber(),
      totalCost: s.totalCost.toNumber(),
      unrealizedPnl: s.unrealizedPnl.toNumber(),
    }));
  }
}
