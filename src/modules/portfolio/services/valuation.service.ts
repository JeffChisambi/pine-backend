import { Injectable } from '@nestjs/common';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { HoldingDetail, PortfolioCalculator, Valued } from './portfolio-calculator.service';

/**
 * The one place holdings are valued.
 *
 * The summary, the holdings list, allocation, analytics, the daily snapshot
 * and the performance series all read through valuePortfolio(), so they are
 * computed from the same rows and the same prices in the same request and
 * cannot disagree with one another.
 */
@Injectable()
export class ValuationService {
  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
  ) {}

  async valuePortfolio(userId: string, now: Date = new Date()): Promise<Valued> {
    const holdings = await this.repo.findUserHoldings(userId);

    // Shares bought since a stock's latest price session are measured from
    // their purchase price. The oldest session among the holdings bounds
    // how far back those buys need fetching.
    const sessions = holdings
      .map((h) => h.stock.prices[0]?.tradedAt)
      .filter((d): d is Date => d instanceof Date);
    const since = sessions.length
      ? new Date(Math.min(...sessions.map((d) => d.getTime())))
      : now;
    const recentBuys = holdings.length ? await this.repo.findBuysSince(userId, since) : [];

    return this.calculator.value(holdings, recentBuys, now);
  }

  async getValuations(userId: string): Promise<HoldingDetail[]> {
    return (await this.valuePortfolio(userId)).details;
  }

  async getHoldingValuation(userId: string, stockId: string): Promise<HoldingDetail | null> {
    const { details } = await this.valuePortfolio(userId);
    return details.find((d) => d.stockId === stockId) ?? null;
  }
}
