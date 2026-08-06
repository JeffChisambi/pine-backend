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
    const holdings = await this.repo.findUserHoldings(userId);

    // Portfolio value = market value of holdings only (cash is separate
    // money); weights therefore sum to 100% across owned assets.
    const summary = this.calculator.calculateSummary(holdings, new Decimal(0));
    const totalPortfolioValue = summary.totalMarketValue;

    return this.calculator.calculateHoldings(holdings as any, totalPortfolioValue);
  }

  /**
   * Get valuation for a single holding.
   */
  async getHoldingValuation(userId: string, stockId: string): Promise<HoldingDetail | null> {
    const holding = await this.repo.findUserHolding(userId, stockId);
    if (!holding || holding.quantity.lte(0)) return null;

    const holdings = await this.repo.findUserHoldings(userId);
    const summary = this.calculator.calculateSummary(holdings, new Decimal(0));
    const totalPortfolioValue = summary.totalMarketValue;

    const details = this.calculator.calculateHoldings([holding] as any, totalPortfolioValue);
    return details[0] ?? null;
  }
}
