import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioRepository } from '../repositories/portfolio.repository';

/**
 * Holdings Service — manages the investor's stock positions.
 *
 * Responsible for:
 * - Current positions (quantity, average cost)
 * - Updating holdings when trades settle
 * - Querying single or all holdings
 *
 * Never executes trades. Reacts to settlement events.
 */
@Injectable()
export class HoldingsService {
  private readonly logger = new Logger(HoldingsService.name);

  constructor(private readonly repo: PortfolioRepository) {}

  /**
   * React to a settled trade and update the holding.
   *
   * BUY:  Weighted average cost = (existing × avgCost + new × price) / (existing + new)
   * SELL: Average cost stays the same, quantity decreases
   */
  // NOTE: holdings are mutated ONLY inside the trading module's atomic
  // settlement transaction (SettlementService) — this service is read-only.

  /**
   * Get all holdings for a user (with stock data for display).
   */
  async getHoldings(userId: string) {
    return this.repo.findUserHoldings(userId);
  }

  /**
   * Get a single holding with stock detail.
   */
  async getHolding(userId: string, stockId: string) {
    const holding = await this.repo.findUserHolding(userId, stockId);
    if (!holding) {
      throw new NotFoundException('Holding not found');
    }
    return holding;
  }
}
