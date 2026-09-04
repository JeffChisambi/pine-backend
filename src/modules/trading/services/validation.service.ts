import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { MarketService } from './market.service';
import { calculateTradingFees } from '../domain/trading-fee.calculator';
import { FeePolicyService } from '../../brokers/services/fee-policy.service';
import { RiskPolicyService } from '../../brokers/services/risk-policy.service';

/**
 * Validation Service — Pre-trade gate checks.
 *
 * Sequential validation — fails fast at the first violation.
 * Every check returns void on success or throws BadRequestException.
 *
 * NOTE: Market-hours check is intentionally NOT part of validation.
 * Orders are always accepted and queued. When the market is closed
 * the pipeline parks the order at SUBMITTED so the broker can
 * execute it from the Kusata dashboard when the market opens.
 *
 * Gate order:
 * 1. Stock active?
 * 2. User KYC approved?
 * 3. Account not frozen?
 * 4. Sufficient funds (BUY) or sufficient shares (SELL)?
 * 5. Minimum order size?
 * 6. Order price valid? (LIMIT orders)
 */
@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  private readonly MIN_ORDER_QUANTITY = new Decimal(1);
  private readonly MAX_ORDER_VALUE_MWK = new Decimal('50000000'); // 50M MWK

  constructor(
    private readonly repo: TradingRepository,
    private readonly marketService: MarketService,
    private readonly feePolicy: FeePolicyService,
    private readonly riskPolicy: RiskPolicyService,
  ) {}

  /**
   * Run all pre-trade validations. Throws BadRequestException with
   * a descriptive message on the first failed check.
   */
  /**
   * Returns whether the market is currently open.
   * Callers use this to decide between immediate execution and queuing.
   */
  async checkIsMarketOpen(): Promise<boolean> {
    return this.marketService.isMarketOpen();
  }

  async validate(order: {
    userId: string;
    stockId: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    quantity: Decimal;
    limitPrice?: Decimal | null;
    userKycStatus: string;
    /**
     * The order being validated. It already exists in PENDING_VALIDATION by
     * the time this runs, so the share-availability check must leave it out —
     * otherwise an order is counted against itself and a sell of everything
     * the user owns is refused with "0 available".
     */
    orderId?: string;
  }): Promise<{ estimatedPrice: Decimal; fees: ReturnType<typeof calculateTradingFees> }> {
    // 1. Stock active?
    const stock = await this.checkStockActive(order.stockId);

    // 2. User KYC approved?
    this.checkKycStatus(order.userKycStatus);

    // 3. Account not frozen?
    await this.checkAccountNotFrozen(order.userId);

    // 4. Minimum order size
    this.checkMinimumQuantity(order.quantity);

    // 5. Get estimated price
    const price = this.getOrderPrice(order.type, order.limitPrice, stock.latestPrice);

    // 6. Calculate fees and total cost under the OWNING BROKER's configured
    // commission schedule (Fees & Charges) — the single fee authority.
    const fees = await this.feePolicy.tradingFeesForUser(
      order.userId,
      price,
      order.quantity,
      order.side,
    );

    // 7. Check max order value
    this.checkMaxOrderValue(fees.grossValue);

    // 8. Sufficient funds (BUY) or sufficient shares (SELL)?
    if (order.side === 'BUY') {
      await this.checkSufficientFunds(order.userId, fees.totalCost);
      // 9. Broker risk constraints — portfolio concentration (BUY only;
      // selling always remains possible). Server-side enforcement of the
      // OWNING BROKER's configured limit on post-order exposure.
      const concentration = await this.riskPolicy.checkBuyConcentration(
        order.userId,
        order.stockId,
        fees.grossValue,
      );
      if (concentration.status === 'BLOCKED') {
        throw new BadRequestException(
          concentration.reason ?? "Order exceeds your broker's portfolio concentration limit.",
        );
      }
    } else {
      await this.checkSufficientShares(order.userId, order.stockId, order.quantity, order.orderId);
    }

    this.logger.log(
      { stockId: order.stockId, side: order.side, quantity: order.quantity.toString() },
      'Order validated successfully',
    );

    return { estimatedPrice: price, fees };
  }



  private async checkStockActive(stockId: string): Promise<{ latestPrice: Decimal }> {
    const stock = await this.repo.findStockById(stockId);
    if (!stock || !stock.isActive) {
      throw new BadRequestException('This stock is not available for trading');
    }

    const latestPrice = stock.prices[0]?.closePrice;
    if (!latestPrice) {
      throw new BadRequestException('No price data available for this stock');
    }

    return { latestPrice };
  }

  private checkKycStatus(kycStatus: string): void {
    if (kycStatus !== 'APPROVED') {
      throw new BadRequestException(
        'Your account must be verified (KYC approved) before you can trade. ' +
        'Please complete identity verification in Settings.',
      );
    }
  }

  private async checkAccountNotFrozen(userId: string): Promise<void> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new BadRequestException('No wallet found. Please contact support.');
    }
    if (wallet.isFrozen) {
      throw new BadRequestException(
        `Your account is frozen: ${wallet.frozenReason ?? 'Contact support for details.'}`,
      );
    }
  }

  private checkMinimumQuantity(quantity: Decimal): void {
    if (quantity.lt(this.MIN_ORDER_QUANTITY)) {
      throw new BadRequestException(
        `Minimum order quantity is ${this.MIN_ORDER_QUANTITY.toString()} share(s)`,
      );
    }
  }

  private checkMaxOrderValue(grossValue: Decimal): void {
    if (grossValue.gt(this.MAX_ORDER_VALUE_MWK)) {
      throw new BadRequestException(
        `Order value exceeds maximum of MWK ${this.MAX_ORDER_VALUE_MWK.toNumber().toLocaleString()}`,
      );
    }
  }

  private getOrderPrice(
    orderType: 'MARKET' | 'LIMIT',
    limitPrice: Decimal | null | undefined,
    latestMarketPrice: Decimal,
  ): Decimal {
    if (orderType === 'LIMIT') {
      if (!limitPrice || limitPrice.lte(new Decimal(0))) {
        throw new BadRequestException('Limit orders must specify a valid price');
      }
      return limitPrice;
    }
    // MARKET order uses latest price
    return latestMarketPrice;
  }

  private async checkSufficientFunds(userId: string, totalCost: Decimal): Promise<void> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new BadRequestException('Wallet not found');
    }
    // AVAILABLE = balance − active order reservations − PENDING withdrawals.
    // All three commitments must be excluded: omitting pending withdrawals
    // let a user reserve the same money for a buy order and a withdrawal
    // simultaneously (double-spend window).
    const [reserved, pendingWithdrawals] = await Promise.all([
      this.repo.db.walletReservation.aggregate({
        where: { walletId: wallet.id, status: 'ACTIVE' },
        _sum: { amount: true },
      }),
      this.repo.db.transaction.aggregate({
        where: {
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'PROCESSING'] },
        },
        _sum: { amount: true },
      }),
    ]);
    const available = wallet.balance
      .sub(reserved._sum.amount ?? new Decimal(0))
      .sub(pendingWithdrawals._sum.amount ?? new Decimal(0));
    if (available.lt(totalCost)) {
      throw new BadRequestException(
        `Insufficient available funds. Required: MWK ${totalCost.toNumber().toLocaleString()}, ` +
        `Available: MWK ${available.toNumber().toLocaleString()} ` +
        `(funds reserved for pending orders and withdrawals are excluded).`,
      );
    }
  }

  private async checkSufficientShares(
    userId: string,
    stockId: string,
    quantity: Decimal,
    excludeOrderId?: string,
  ): Promise<void> {
    const holding = await this.repo.findUserHolding(userId, stockId);
    const held = holding?.quantity ?? new Decimal(0);

    // AVAILABLE shares = held − quantities already committed to OTHER open
    // sell orders. Without this, two queued sells of the same shares both
    // pass and the user is paid twice for shares they own once.
    //
    // The order under validation is excluded by id. It was created (and
    // moved to PENDING_VALIDATION) before this check runs, so counting it
    // made every exact-quantity sell fail: own 10, sell 10 → 10 committed →
    // 0 available.
    const openSells = await this.repo.db.order.aggregate({
      where: {
        userId,
        stockId,
        side: 'SELL',
        status: { in: ['PENDING_VALIDATION', 'VALIDATED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'] },
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
      _sum: { quantity: true },
    });
    const committed = openSells._sum.quantity ?? new Decimal(0);
    const availableShares = Decimal.max(held.sub(committed), 0);

    if (availableShares.gte(quantity)) return;

    // Say what the person can act on. "0 available" alone reads as "you own
    // nothing" to someone who can see the shares in their portfolio.
    if (held.lte(0)) {
      throw new BadRequestException(
        'You do not hold any shares of this stock to sell.',
      );
    }
    if (committed.gt(0)) {
      throw new BadRequestException(
        `You do not have enough shares available to complete this sell order. ` +
        `You hold ${held.toFixed(0)}, but ${committed.toFixed(0)} are reserved for ` +
        `${committed.eq(held) ? 'a' : 'another'} pending sell order, leaving ${availableShares.toFixed(0)} available. ` +
        `Cancel the pending order or sell fewer shares.`,
      );
    }
    throw new BadRequestException(
      `You do not have enough shares to complete this sell order. ` +
      `You hold ${held.toFixed(0)} and tried to sell ${quantity.toFixed(0)}.`,
    );
  }
}
