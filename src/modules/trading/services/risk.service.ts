import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';

/**
 * Risk Service — post-validation risk checks.
 *
 * These checks go beyond basic validation (sufficient funds, KYC)
 * and look at patterns and limits that banks require:
 *
 * - Daily trading volume limit
 * - Maximum single order value
 * - Portfolio concentration limit (single stock ≤ 30%)
 * - Velocity check (too many orders in short time)
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  /** Maximum MWK a single user can trade in one day */
  private readonly DAILY_TRADE_LIMIT_MWK = new Decimal('10000000'); // 10M MWK

  /** Maximum single order value */
  private readonly MAX_SINGLE_ORDER_MWK = new Decimal('5000000'); // 5M MWK

  /** Maximum portfolio concentration in a single stock (30%) */
  private readonly MAX_CONCENTRATION_PCT = 0.30;

  /** Maximum orders per user per hour (velocity check) */
  private readonly MAX_ORDERS_PER_HOUR = 20;

  constructor(private readonly repo: TradingRepository) {}

  /**
   * Run all risk checks. Throws BadRequestException on violation.
   */
  async check(params: {
    userId: string;
    stockId: string;
    side: 'BUY' | 'SELL';
    grossValue: Decimal;
    totalCost: Decimal;
  }): Promise<void> {
    // 1. Single order value check
    this.checkSingleOrderLimit(params.grossValue);

    // 2. Daily trading limit
    await this.checkDailyTradingLimit(params.userId, params.grossValue);

    // 3. Portfolio concentration (only for BUY orders)
    if (params.side === 'BUY') {
      await this.checkConcentrationLimit(
        params.userId,
        params.stockId,
        params.totalCost,
      );
    }

    // 4. Velocity check
    await this.checkOrderVelocity(params.userId);

    this.logger.log(
      { userId: params.userId, grossValue: params.grossValue.toString() },
      'Risk checks passed',
    );
  }

  private checkSingleOrderLimit(grossValue: Decimal): void {
    if (grossValue.gt(this.MAX_SINGLE_ORDER_MWK)) {
      throw new BadRequestException(
        `Single order value exceeds the maximum of MWK ${this.MAX_SINGLE_ORDER_MWK.toNumber().toLocaleString()}. ` +
        `Please reduce the order size or contact support for higher limits.`,
      );
    }
  }

  private async checkDailyTradingLimit(
    userId: string,
    orderValue: Decimal,
  ): Promise<void> {
    // Sum all today's filled/pending order values
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { orders } = await this.repo.findUserOrders(userId, { limit: 100 });
    const todayOrders = orders.filter(
      (o) => o.createdAt >= today && !['CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.status),
    );

    const todayVolume = todayOrders.reduce(
      (sum, o) => sum.add(o.totalCost),
      new Decimal(0),
    );

    if (todayVolume.add(orderValue).gt(this.DAILY_TRADE_LIMIT_MWK)) {
      throw new BadRequestException(
        `This order would exceed your daily trading limit of MWK ${this.DAILY_TRADE_LIMIT_MWK.toNumber().toLocaleString()}. ` +
        `Today's volume: MWK ${todayVolume.toNumber().toLocaleString()}.`,
      );
    }
  }

  private async checkConcentrationLimit(
    userId: string,
    stockId: string,
    additionalCost: Decimal,
  ): Promise<void> {
    const holdings = await this.repo.findUserHoldings(userId);
    const wallet = await this.repo.findWalletByUserId(userId);

    if (!wallet) return; // No wallet = no portfolio to check

    // Calculate total portfolio value (cash + holdings market value)
    let totalPortfolioValue = wallet.balance;
    let currentStockValue = new Decimal(0);

    for (const h of holdings) {
      const marketPrice = h.stock.prices[0]?.closePrice ?? h.averageCost;
      const holdingValue = h.quantity.mul(marketPrice);
      totalPortfolioValue = totalPortfolioValue.add(holdingValue);

      if (h.stockId === stockId) {
        currentStockValue = holdingValue;
      }
    }

    // After this order, what % would this stock represent?
    const newStockValue = currentStockValue.add(additionalCost);
    const newTotalValue = totalPortfolioValue.add(additionalCost);

    if (newTotalValue.gt(0)) {
      const concentration = newStockValue.div(newTotalValue).toNumber();
      if (concentration > this.MAX_CONCENTRATION_PCT) {
        throw new BadRequestException(
          `This order would give you ${Math.round(concentration * 100)}% concentration in this stock. ` +
          `Maximum allowed is ${this.MAX_CONCENTRATION_PCT * 100}%. Diversify your portfolio.`,
        );
      }
    }
  }

  private async checkOrderVelocity(userId: string): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const { orders } = await this.repo.findUserOrders(userId, { limit: this.MAX_ORDERS_PER_HOUR + 1 });
    const recentOrders = orders.filter((o) => o.createdAt >= oneHourAgo);

    if (recentOrders.length >= this.MAX_ORDERS_PER_HOUR) {
      throw new BadRequestException(
        `Too many orders. You've placed ${recentOrders.length} orders in the last hour. ` +
        `Maximum is ${this.MAX_ORDERS_PER_HOUR}. Please wait before placing more orders.`,
      );
    }
  }
}
