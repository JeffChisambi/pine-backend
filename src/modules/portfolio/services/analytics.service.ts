import { Injectable, Logger } from '@nestjs/common';
import { PortfolioCalculator, AnalyticsData } from './portfolio-calculator.service';
import { ValuationService } from './valuation.service';
import { PortfolioRepository } from '../repositories/portfolio.repository';

/**
 * Analytics Service — produces portfolio analytics and insights.
 *
 * Computes:
 * - Top/worst performers
 * - Largest position
 * - Sector allocation
 * - Dividend yield
 * - Number of trades
 * - Average holding size
 *
 * Future-proof — designed for expansion even if not all
 * metrics are used initially.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly calculator: PortfolioCalculator,
    private readonly valuationService: ValuationService,
    private readonly repo: PortfolioRepository,
  ) {}

  async getAnalytics(userId: string): Promise<AnalyticsData> {
    const holdings = await this.valuationService.getValuations(userId);
    const trades = await this.repo.findUserTrades(userId);

    const analytics = this.calculator.calculateAnalytics(holdings);
    analytics.numberOfTrades = trades.length;

    return analytics;
  }
}
