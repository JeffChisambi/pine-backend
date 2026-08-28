import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';

/**
 * Risk Service — post-validation risk checks.
 *
 * These checks go beyond basic validation (sufficient funds, KYC)
 * and look at patterns and limits that banks require:
 *
 * Platform-wide abuse guards only (broker-configurable investment limits
 * live in RiskPolicyService):
 * - Daily trading volume limit
 * - Maximum single order value
 * - Velocity check (too many orders in short time)
 */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  /** Maximum MWK a single user can trade in one day */
  private readonly DAILY_TRADE_LIMIT_MWK = new Decimal('10000000'); // 10M MWK

  /** Maximum single order value */
  private readonly MAX_SINGLE_ORDER_MWK = new Decimal('5000000'); // 5M MWK

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

    // 3. Portfolio concentration is a BROKER-CONFIGURED constraint —
    // enforced by RiskPolicyService in ValidationService under the owning
    // broker's own limit. The hardcoded 30% cap that used to live here
    // silently overrode whatever the broker configured, so it is gone:
    // brokers own investment limits; this service keeps only
    // platform-wide abuse guards (order size, daily volume, velocity).

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
      // Queued orders may not have totalCost yet — treat as 0, never crash.
      (sum, o) => sum.add(o.totalCost ?? new Decimal(0)),
      new Decimal(0),
    );

    if (todayVolume.add(orderValue).gt(this.DAILY_TRADE_LIMIT_MWK)) {
      throw new BadRequestException(
        `This order would exceed your daily trading limit of MWK ${this.DAILY_TRADE_LIMIT_MWK.toNumber().toLocaleString()}. ` +
        `Today's volume: MWK ${todayVolume.toNumber().toLocaleString()}.`,
      );
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
