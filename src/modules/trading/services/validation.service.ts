import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { MarketService } from './market.service';
import { calculateTradingFees } from '../domain/trading-fee.calculator';

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

    // 6. Calculate fees and total cost
    const fees = calculateTradingFees(price, order.quantity, order.side);

    // 7. Check max order value
    this.checkMaxOrderValue(fees.grossValue);

    // 8. Sufficient funds (BUY) or sufficient shares (SELL)?
    if (order.side === 'BUY') {
      await this.checkSufficientFunds(order.userId, fees.totalCost);
    } else {
      await this.checkSufficientShares(order.userId, order.stockId, order.quantity);
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
    // AVAILABLE balance = total minus funds already reserved for other pending
    // orders. Checking the raw balance let concurrent orders collectively
    // overdraw the wallet.
    const reserved = await this.repo.db.walletReservation.aggregate({
      where: { walletId: wallet.id, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    const available = wallet.balance.sub(reserved._sum.amount ?? new Decimal(0));
    if (available.lt(totalCost)) {
      throw new BadRequestException(
        `Insufficient available funds. Required: MWK ${totalCost.toNumber().toLocaleString()}, ` +
        `Available: MWK ${available.toNumber().toLocaleString()} ` +
        `(funds reserved for pending orders are excluded).`,
      );
    }
  }

  private async checkSufficientShares(
    userId: string,
    stockId: string,
    quantity: Decimal,
  ): Promise<void> {
    const holding = await this.repo.findUserHolding(userId, stockId);
    if (!holding || holding.quantity.lt(quantity)) {
      const held = holding?.quantity.toNumber() ?? 0;
      throw new BadRequestException(
        `Insufficient shares. Required: ${quantity.toString()}, ` +
        `Available: ${held}`,
      );
    }
  }
}
