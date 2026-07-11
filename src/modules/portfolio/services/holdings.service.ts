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
  async updateHoldingFromTrade(params: {
    userId: string;
    stockId: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
  }) {
    const quantityDecimal = new Decimal(params.quantity);
    const priceDecimal = new Decimal(params.price);

    const existing = await this.repo.findUserHolding(params.userId, params.stockId);

    let newAverageCost: Decimal;
    let quantityDelta: Decimal;

    if (params.side === 'BUY') {
      quantityDelta = quantityDecimal;
      if (existing && existing.quantity.gt(0)) {
        // Weighted average cost
        const existingTotal = existing.quantity.mul(existing.averageCost);
        const newTotal = quantityDecimal.mul(priceDecimal);
        const combinedQty = existing.quantity.add(quantityDecimal);
        newAverageCost = existingTotal.add(newTotal).div(combinedQty);
      } else {
        newAverageCost = priceDecimal;
      }
    } else {
      // SELL: reduce quantity, keep average cost
      quantityDelta = quantityDecimal.neg();
      newAverageCost = existing?.averageCost ?? priceDecimal;
    }

    const holding = await this.repo.upsertHolding(
      params.userId,
      params.stockId,
      quantityDelta,
      newAverageCost,
    );

    this.logger.log(
      {
        userId: params.userId,
        stockId: params.stockId,
        side: params.side,
        newQty: holding.quantity.toString(),
        avgCost: newAverageCost.toString(),
      },
      'Holding updated',
    );

    return holding;
  }

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
