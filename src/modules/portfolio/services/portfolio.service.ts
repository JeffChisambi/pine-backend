import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator, PortfolioSummary } from './portfolio-calculator.service';
import { ValuationService } from './valuation.service';
import { PerformanceService, type PerformancePeriod } from './performance.service';
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

    // Holdings are updated ATOMICALLY with the cash leg inside the trading
    // module's settlement transaction — by the time this event fires, the
    // position already reflects the trade. This handler only reacts.
    const holding = await this.repo.findUserHolding(event.userId, event.stockId);

    // Generate fresh snapshot
    await this.snapshotService.generateSnapshot(event.userId);

    // Publish portfolio updated event
    this.eventEmitter.emit(PORTFOLIO_UPDATED_EVENT, {
      userId: event.userId,
      stockId: event.stockId,
      newQuantity: holding ? holding.quantity.toNumber() : 0,
      averageCost: holding ? holding.averageCost.toNumber() : 0,
    });

    this.logger.log(
      { userId: event.userId, tradeId: event.tradeId },
      'Portfolio updated after trade settlement',
    );
  }

  // ── API Methods ─────────────────────────────────────────────

  /**
   * GET /portfolio/dividends — total dividends received + recent payouts.
   */
  async getDividendsSummary(userId: string) {
    return this.repo.getDividendsSummary(userId);
  }

  /**
   * GET /portfolio — full portfolio overview.
   */
  async getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
    // Derived on every read, never stored, and from the same valuation as
    // the holdings list. Wallet cash is separate money: reported for
    // reference, never part of the portfolio value or its returns.
    const [valued, cash, realized] = await Promise.all([
      this.valuationService.valuePortfolio(userId),
      this.repo.getAvailableCash(userId),
      this.repo.sumRealized(userId),
    ]);
    return this.calculator.summarize(valued, cash.available, realized);
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
  async getPerformance(userId: string, period?: PerformancePeriod) {
    return this.performanceService.getPerformance(userId, period);
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
      /** Stocks only — chart THIS. */
      holdingsValue: s.holdingsValue.toNumber(),
      /** Uninvested cash on the day, for context only. */
      cashBalance: s.cashBalance.toNumber(),
      /** LEGACY: holdings + cash. Do not chart. */
      totalValue: s.totalValue.toNumber(),
      totalCost: s.totalCost.toNumber(),
      unrealizedPnl: s.unrealizedPnl.toNumber(),
    }));
  }
}
