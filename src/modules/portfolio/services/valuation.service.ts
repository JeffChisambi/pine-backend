import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { PortfolioCalculator, HoldingDetail } from './portfolio-calculator.service';

/**
 * Valuation Service — calculates current market value of holdings.
 *
 * Uses live market prices. Calculates:
 * - Current value per holding
 * - Gain/loss per holding
 * - Daily change
 * - Percentage return
 *
 * Never stores prices. Always reads from market data.
 */
@Injectable()
export class ValuationService {
  private readonly logger = new Logger(ValuationService.name);

  constructor(
    private readonly repo: PortfolioRepository,
    private readonly calculator: PortfolioCalculator,
  ) {}

  /**
   * Get current valuations for all holdings.
   */
  async getValuations(userId: string): Promise<HoldingDetail[]> {
    const [holdings, cash] = await Promise.all([
      this.repo.findUserHoldings(userId),
      this.repo.getAvailableCash(userId),
    ]);

    const cashBalance = cash.available;
    const summary = this.calculator.calculateSummary(holdings, cashBalance);
    const totalPortfolioValue = cashBalance.add(summary.totalMarketValue);

    return this.calculator.calculateHoldings(holdings as any, totalPortfolioValue);
  }

  /**
   * Get valuation for a single holding.
   */
  async getHoldingValuation(userId: string, stockId: string): Promise<HoldingDetail | null> {
    const holding = await this.repo.findUserHolding(userId, stockId);
    if (!holding || holding.quantity.lte(0)) return null;

    const [holdings, cash] = await Promise.all([
      this.repo.findUserHoldings(userId),
      this.repo.getAvailableCash(userId),
    ]);
    const cashBalance = cash.available;
    const summary = this.calculator.calculateSummary(holdings, cashBalance);
    const totalPortfolioValue = cashBalance.add(summary.totalMarketValue);

    const details = this.calculator.calculateHoldings([holding] as any, totalPortfolioValue);
    return details[0] ?? null;
  }
}
