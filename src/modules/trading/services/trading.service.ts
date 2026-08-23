import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { OrderService } from './order.service';
import { ValidationService } from './validation.service';
import { RiskService } from './risk.service';
import { ExecutionEngineService } from './execution-engine.service';
import { TradingRepository } from '../repositories/trading.repository';
import { ReservationService } from '../../wallet/services/reservation.service';
import { FeePolicyService } from '../../brokers/services/fee-policy.service';
import { OrderLifecycleStatus, assertTransition } from '../domain/order-lifecycle';
import { OrderCreatedEvent, OrderCancelledEvent, OrderRejectedEvent } from '../events/trading.events';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';

/**
 * Trading Service — the main orchestrator.
 *
 * Coordinates the full trading pipeline but does NOT implement
 * any business logic itself. Each step delegates to a specialized
 * service:
 *
 *   1. OrderService.createOrder()         → DRAFT
 *   2. ValidationService.validate()       → VALIDATED
 *   3. RiskService.check()                → RISK_PASSED
 *   4. ExecutionEngine.execute()           → FILLED
 *   // Steps 5-7 happen via events:
 *   5. [event] → LedgerService            → ledger entries
 *   6. [event] → SettlementService         → settled
 *   7. [event] → PortfolioService          → holdings updated
 */
@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly validationService: ValidationService,
    private readonly riskService: RiskService,
    private readonly executionEngine: ExecutionEngineService,
    private readonly repo: TradingRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly reservationService: ReservationService,
    private readonly feePolicy: FeePolicyService,
  ) {}

  /**
   * Quote an order BEFORE submission — the transparent breakdown the
   * Review Order screen renders. Uses the exact same fee authority
   * (FeePolicyService) and availability formulas as validation, so the
   * preview always matches what execution will charge.
   */
  async quoteOrder(
    userId: string,
    params: { stockSymbol: string; quantity: number; side: 'BUY' | 'SELL' },
  ) {
    const stock = await this.repo.findStockBySymbol(params.stockSymbol);
    if (!stock || !stock.isActive) {
      throw new ResourceNotFoundException('Stock', params.stockSymbol);
    }
    const price = stock.prices[0]?.closePrice;
    if (!price) {
      throw new ValidationException('No price data available for this stock');
    }

    const quantity = new Decimal(params.quantity);
    if (quantity.lte(0)) {
      throw new ValidationException('Quantity must be positive');
    }

    const fees = await this.feePolicy.tradingFeesForUser(
      userId,
      price,
      quantity,
      params.side,
    );

    // Cash availability — same formula as validation and the wallet summary:
    // balance − active reservations − pending withdrawals.
    const wallet = await this.repo.findWalletByUserId(userId);
    let cashAvailable = new Decimal(0);
    if (wallet) {
      const [reserved, pendingWd] = await Promise.all([
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
      cashAvailable = Decimal.max(
        wallet.balance
          .sub(reserved._sum.amount ?? new Decimal(0))
          .sub(pendingWd._sum.amount ?? new Decimal(0)),
        new Decimal(0),
      );
    }

    const base = {
      symbol: stock.symbol,
      stockName: stock.name,
      side: params.side,
      quantity: quantity.toNumber(),
      pricePerShare: price.toNumber(),
      grossValue: fees.grossValue.toNumber(),
      commission: fees.brokerCommission.toNumber(),
      secLevy: fees.secLevy.toNumber(),
      mseLevy: fees.mseLevy.toNumber(),
      withholdingTax: fees.withholdingTax.toNumber(),
      totalFees: fees.totalFees.toNumber(),
      cashAvailable: cashAvailable.toNumber(),
    };

    if (params.side === 'BUY') {
      const totalCost = fees.totalCost;
      return {
        ...base,
        totalCost: totalCost.toNumber(),
        remainingAfter: cashAvailable.sub(totalCost).toNumber(),
        sufficientFunds: cashAvailable.gte(totalCost),
      };
    }

    // SELL — net proceeds after fees, and available (uncommitted) shares.
    const [holding, openSells] = await Promise.all([
      this.repo.findUserHolding(userId, stock.id),
      this.repo.db.order.aggregate({
        where: {
          userId,
          stockId: stock.id,
          side: 'SELL',
          status: {
            in: ['PENDING_VALIDATION', 'VALIDATED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'],
          },
        },
        _sum: { quantity: true },
      }),
    ]);
    const availableShares = Decimal.max(
      (holding?.quantity ?? new Decimal(0)).sub(openSells._sum.quantity ?? new Decimal(0)),
      new Decimal(0),
    );
    return {
      ...base,
      netProceeds: fees.totalCost.toNumber(),
      sharesHeld: (holding?.quantity ?? new Decimal(0)).toNumber(),
      sharesAvailable: availableShares.toNumber(),
      sufficientShares: availableShares.gte(quantity),
    };
  }

  /**
   * Submit a BUY order — the full pipeline.
   */
  async submitBuyOrder(
    userId: string,
    dto: {
      stockSymbol: string;
      quantity: number;
      orderType: 'MARKET' | 'LIMIT';
      limitPrice?: number;
      idempotencyKey?: string;
    },
    userKycStatus: string,
  ) {
    return this.submitOrder(userId, { ...dto, side: 'BUY' }, userKycStatus);
  }

  /**
   * Submit a SELL order — the full pipeline.
   */
  async submitSellOrder(
    userId: string,
    dto: {
      stockSymbol: string;
      quantity: number;
      orderType: 'MARKET' | 'LIMIT';
      limitPrice?: number;
      idempotencyKey?: string;
    },
    userKycStatus: string,
  ) {
    return this.submitOrder(userId, { ...dto, side: 'SELL' }, userKycStatus);
  }

  /**
   * Core order submission pipeline.
   */
  private async submitOrder(
    userId: string,
    dto: {
      stockSymbol: string;
      side: 'BUY' | 'SELL';
      quantity: number;
      orderType: 'MARKET' | 'LIMIT';
      limitPrice?: number;
      idempotencyKey?: string;
    },
    userKycStatus: string,
  ) {
    const startTime = Date.now();

    // The JWT's kyc claim is a login-time snapshot; a user approved mid-session
    // would still carry a stale "not approved" token. Read the LIVE status so
    // verified users can trade without having to log out and back in.
    const liveKycStatus = (await this.repo.getCurrentKycStatus(userId)) ?? userKycStatus;

    // A valid broker relationship is required before any trade: orders are
    // routed to (and executed by) the investor's selected broker. Derived
    // from the persisted user record — never from client input.
    const trader = await this.repo.prismaClient.user.findUnique({
      where: { id: userId },
      select: { role: true, brokerId: true, broker: { select: { isActive: true } } },
    });
    if (trader?.role === 'CUSTOMER') {
      if (!trader.brokerId) {
        throw new ValidationException(
          'Select a broker in your profile before placing an order. (BROKER_REQUIRED)',
        );
      }
      if (trader.broker && !trader.broker.isActive) {
        throw new ValidationException(
          'Your broker is currently unavailable. Contact support.',
        );
      }
    }

    // ── Step 1: Create draft order ──────────────────────────
    this.logger.log(
      { userId, symbol: dto.stockSymbol, side: dto.side },
      'Trading pipeline started',
    );

    const order = await this.orderService.createOrder({
      userId,
      stockSymbol: dto.stockSymbol,
      side: dto.side,
      type: dto.orderType,
      quantity: dto.quantity,
      limitPrice: dto.limitPrice,
      idempotencyKey: dto.idempotencyKey,
    });

    // Emit creation event
    this.eventEmitter.emit(
      OrderCreatedEvent.event,
      new OrderCreatedEvent(
        order.id,
        userId,
        dto.stockSymbol,
        dto.side,
        dto.quantity,
        dto.orderType,
      ),
    );

    try {
      // ── Step 2: Validation ──────────────────────────────────
      assertTransition(
        order.status as OrderLifecycleStatus,
        OrderLifecycleStatus.PENDING_VALIDATION,
      );
      await this.repo.updateOrderStatus(order.id, OrderLifecycleStatus.PENDING_VALIDATION);

      const { estimatedPrice, fees } = await this.validationService.validate({
        userId,
        stockId: order.stockId,
        side: dto.side,
        type: dto.orderType,
        quantity: new Decimal(dto.quantity),
        limitPrice: dto.limitPrice ? new Decimal(dto.limitPrice) : null,
        userKycStatus: liveKycStatus,
      });

      // A sell whose fees exceed the proceeds would net the user a NEGATIVE
      // amount (minimum broker commission on a tiny order). Reject it with a
      // clear reason instead of settling a loss-making trade.
      if (dto.side === 'SELL' && fees.totalCost.lte(0)) {
        throw new BadRequestException(
          `Order value is too small: trading fees (MK ${fees.totalFees.toFixed(2)}) exceed the sale proceeds (MK ${fees.grossValue.toFixed(2)}). Increase the quantity to sell.`,
        );
      }

      // Mark validated
      assertTransition(
        OrderLifecycleStatus.PENDING_VALIDATION,
        OrderLifecycleStatus.VALIDATED,
      );
      await this.repo.updateOrderStatus(order.id, OrderLifecycleStatus.VALIDATED, {
        validatedAt: new Date(),
        totalFees: fees.totalFees,
        totalCost: fees.totalCost,
      });

      await this.repo.createTradeAudit({
        orderId: order.id,
        userId,
        action: 'ORDER_VALIDATED',
        fromStatus: OrderLifecycleStatus.PENDING_VALIDATION,
        toStatus: OrderLifecycleStatus.VALIDATED,
        metadata: {
          estimatedPrice: estimatedPrice.toNumber(),
          totalFees: fees.totalFees.toNumber(),
          totalCost: fees.totalCost.toNumber(),
        },
      });

      // ── Step 3: Risk checks ─────────────────────────────────
      await this.riskService.check({
        userId,
        stockId: order.stockId,
        side: dto.side,
        grossValue: fees.grossValue,
        totalCost: fees.totalCost,
      });

      await this.repo.createTradeAudit({
        orderId: order.id,
        userId,
        action: 'RISK_CHECK_PASSED',
        metadata: { checks: ['daily_limit', 'single_order', 'concentration', 'velocity'] },
      });

      // ── Step 4: Reserve funds (BUY) ─────────────────────────
      // The full cost is held against the wallet the moment the order is
      // accepted: available balance drops immediately and the money cannot
      // be spent on other orders. The hold is consumed atomically at
      // settlement, or refunded automatically on cancel/reject/expiry.
      if (dto.side === 'BUY') {
        await this.reservationService.reserveFunds({
          userId,
          orderId: order.id,
          amount: fees.totalCost.toNumber(),
          expiresInMinutes: 7 * 24 * 60, // matches the queued-order lifetime
        });

        await this.repo.createTradeAudit({
          orderId: order.id,
          userId,
          action: 'FUNDS_RESERVED',
          metadata: { amount: fees.totalCost.toNumber(), currency: 'MWK' },
        });
      }

      // ── Step 5: Queue for broker execution ──────────────────
      // Orders are NEVER executed automatically. Every validated order parks
      // at SUBMITTED and waits for the broker to execute it from the Kusata
      // dashboard — the broker is the exchange member who actually places
      // the trade on the MSE. Execution, settlement, cash and holdings only
      // move when the broker confirms (executeQueuedOrder).
      assertTransition(
        OrderLifecycleStatus.VALIDATED,
        OrderLifecycleStatus.SUBMITTED,
      );
      await this.repo.updateOrderStatus(order.id, OrderLifecycleStatus.SUBMITTED, {
        submittedAt: new Date(),
      });

      await this.repo.createTradeAudit({
        orderId: order.id,
        userId,
        action: 'ORDER_QUEUED_FOR_BROKER',
        fromStatus: OrderLifecycleStatus.VALIDATED,
        toStatus: OrderLifecycleStatus.SUBMITTED,
        metadata: {
          reason: 'Awaiting broker execution',
          estimatedPrice: estimatedPrice.toNumber(),
        },
      });

      const durationMs = Date.now() - startTime;
      this.logger.log(
        { orderId: order.id, durationMs },
        'Order queued — awaiting broker execution',
      );

      const queuedOrder = await this.repo.findOrderById(order.id);
      // Same broker-gated flow either way — only the message/visuals differ so
      // the user isn't told "waiting for market open" while the market IS open.
      const marketOpen = await this.validationService.checkIsMarketOpen();
      const queuedMessage = marketOpen
        ? 'Your order has been submitted and is being processed by the broker.'
        : 'Your order has been submitted and will be executed when the market opens (MSE: 10:00 AM — 2:00 PM CAT, Mon–Fri).';
      return this.buildContractResponse(queuedOrder, fees.totalCost, true, queuedMessage, estimatedPrice, marketOpen);
    } catch (error) {
      // If any step fails, reject the order
      this.logger.error(
        { err: error, orderId: order.id },
        'Trading pipeline failed — rejecting order',
      );

      const currentOrder = await this.repo.findOrderById(order.id);
      const currentStatus = currentOrder?.status as OrderLifecycleStatus;

      // Only reject if not already in a terminal state
      if (
        currentStatus &&
        !['REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED'].includes(currentStatus)
      ) {
        await this.repo.updateOrderStatus(order.id, OrderLifecycleStatus.REJECTED, {
          rejectionReason: (error as Error).message,
        });

        await this.repo.createTradeAudit({
          orderId: order.id,
          userId,
          action: 'ORDER_REJECTED',
          fromStatus: currentStatus,
          toStatus: OrderLifecycleStatus.REJECTED,
          metadata: { reason: (error as Error).message },
        });

        // Notify the user their order failed (the listener for this event
        // existed but nothing ever emitted it).
        this.eventEmitter.emit(
          OrderRejectedEvent.event,
          new OrderRejectedEvent(order.id, userId, (error as Error).message),
        );
      }

      throw error;
    }
  }

  /**
   * Broker-confirmed execution of a QUEUED order.
   *
   * Orders placed while the market is closed are parked at SUBMITTED (the
   * response surfaces them as "queued"). This runs the remaining pipeline —
   * broker gateway → trade → fees → FILLED — which cascades through the
   * event listeners (ledger, settlement, portfolio, notifications).
   *
   * Idempotent: only a SUBMITTED order can be executed. A second call finds
   * the order in ACCEPTED/FILLED/... and is rejected with a conflict.
   */
  async executeQueuedOrder(
    orderId: string,
    executedBy: { adminId: string; role: string },
  ) {
    const order = await this.repo.findOrderById(orderId);
    if (!order) throw new ResourceNotFoundException('Order', orderId);

    if (order.status !== OrderLifecycleStatus.SUBMITTED) {
      throw new ConflictException(
        `Order is ${order.status} — only queued (SUBMITTED) orders can be executed.`,
      );
    }

    // Price: LIMIT orders execute at their limit; MARKET orders at the
    // latest close available for the stock.
    const latestClose = await this.repo.getLatestClosePrice(order.stockId);
    const price =
      order.type === 'LIMIT' && order.limitPrice
        ? new Decimal(order.limitPrice.toString())
        : latestClose;
    if (!price) {
      throw new ValidationException(
        'No market price available for this stock — cannot execute.',
      );
    }

    await this.repo.createTradeAudit({
      orderId,
      userId: order.userId,
      action: 'ORDER_EXECUTED_BY_BROKER',
      fromStatus: OrderLifecycleStatus.SUBMITTED,
      toStatus: OrderLifecycleStatus.SUBMITTED,
      metadata: { adminId: executedBy.adminId, adminRole: executedBy.role, price: price.toString() },
    });

    // Execution emits OrderExecutedEvent / OrderRejectedEvent itself, which
    // cascades to ledger, settlement, portfolio and user notifications.
    const result = await this.executionEngine.execute(orderId, price);

    this.logger.log(
      { orderId, adminId: executedBy.adminId, status: result.status },
      'Queued order executed by broker',
    );

    return result;
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(userId: string, orderId: string) {
    await this.orderService.cancelOrder(userId, orderId);

    this.eventEmitter.emit(
      OrderCancelledEvent.event,
      new OrderCancelledEvent(orderId, userId, 'User requested cancellation'),
    );

    return { message: 'Order cancelled.' };
  }

  /**
   * Get order history for a user.
   */
  async getOrders(
    userId: string,
    filters: { status?: string; side?: string; limit?: number; offset?: number },
  ) {
    const { orders, total } = await this.orderService.getOrderHistory(userId, filters);
    return {
      orders: orders.map((o) => this.formatOrderResponse(o)),
      count: total,
      total,
      limit: filters.limit ?? 20,
      offset: filters.offset ?? 0,
    };
  }

  /**
   * Get single order detail.
   */
  async getOrderDetail(userId: string, orderId: string) {
    const order = await this.orderService.getOrderDetail(userId, orderId);
    return this.formatOrderResponse(order);
  }



  /**
   * Get trade history — ORDER-based, one row per order regardless of status.
   *
   * This intentionally reads the Order table, NOT the Trade table. A queued
   * order (status SUBMITTED — e.g. placed while the market is closed) has no
   * Trade rows until the broker executes it, so a Trade-based query silently
   * dropped every pending order from the user's history. Order-based rows
   * also can't duplicate on execution: the same order row simply transitions
   * SUBMITTED → FILLED/SETTLED in place.
   *
   * DRAFT / PENDING_VALIDATION are excluded: they are transient in-flight
   * states (or abandoned validation attempts) that were never accepted, and
   * showing them would render phantom "Pending" rows forever.
   */
  async getTradeHistory(userId: string, limit = 20, offset = 0) {
    const { orders: rows } = await this.repo.findUserOrders(userId, {
      limit,
      offset,
      excludeStatuses: ['DRAFT', 'PENDING_VALIDATION'],
    });

    const orders = rows.map((o: any) => {
      const executed = (o.trades?.length ?? 0) > 0;
      // Executed orders report the actual fill price; queued orders fall back
      // to the limit price (what the user agreed to pay) so the row still
      // shows meaningful amounts while pending.
      const price: Decimal =
        o.averageFillPrice ?? o.limitPrice ?? new Decimal(0);
      const grossValue = o.quantity.mul(price);
      const fees = o.totalFees ?? new Decimal(0);
      // totalCost is persisted at validation time (gross + fees); prefer it,
      // reconstruct only if absent.
      const totalCost: Decimal =
        o.totalCost && o.totalCost.gt(0) ? o.totalCost : grossValue.add(fees);

      return {
        id: o.id,
        stockId: o.stockId,
        symbol: o.stock.symbol,
        side: o.side,
        type: o.type,
        quantity: o.quantity.toFixed(0),
        price: price.toFixed(2),
        totalAmount: totalCost.sub(fees).toFixed(2),
        status: o.status,
        queued: o.status === OrderLifecycleStatus.SUBMITTED,
        fees: { totalCost: totalCost.toFixed(2) },
        createdAt: o.createdAt,
        executedAt: o.filledAt ?? o.settledAt ?? (executed ? o.updatedAt : null),
      };
    });

    return { orders, count: orders.length };
  }

  /**
   * Build the flat API contract response for buy/sell operations.
   * The mobile app reads: response.queued, response.fees.totalCost (string).
   */
  private buildContractResponse(
    order: any,
    totalCost: Decimal | null,
    queued: boolean,
    message: string,
    estimatedPrice?: Decimal,
    marketOpen = false,
  ) {
    const qty = order?.quantity instanceof Decimal
      ? order.quantity
      : new Decimal(order?.quantity ?? 0);
    const fillPrice = order?.averageFillPrice instanceof Decimal
      ? order.averageFillPrice
      : (order?.averageFillPrice != null ? new Decimal(order.averageFillPrice) : estimatedPrice ?? new Decimal(0));
    const grossValue = qty.mul(fillPrice);
    const totalCostStr = totalCost instanceof Decimal
      ? totalCost.toFixed(2)
      : (typeof totalCost === 'number' ? (totalCost as number).toFixed(2) : grossValue.toFixed(2));

    return {
      id: order?.id,
      stockId: order?.stockId,
      symbol: order?.stock?.symbol,
      side: order?.side,
      type: order?.type,
      quantity: qty.toFixed(0),
      price: fillPrice.toFixed(2),
      totalAmount: grossValue.toFixed(2),
      status: queued ? 'QUEUED' : order?.status,
      queued,
      marketOpen,
      message,
      fees: { totalCost: totalCostStr },
      createdAt: order?.createdAt,
      executedAt: order?.filledAt ?? null,
    };
  }

  /**
   * Format order for API response.
   */
  private formatOrderResponse(order: any) {
    if (!order) return null;
    return {
      id: order.id,
      stockSymbol: order.stock?.symbol,
      stockName: order.stock?.name,
      side: order.side,
      type: order.type,
      status: order.status,
      quantity: order.quantity?.toNumber?.() ?? order.quantity,
      filledQuantity: order.filledQuantity?.toNumber?.() ?? order.filledQuantity,
      limitPrice: order.limitPrice?.toNumber?.() ?? order.limitPrice,
      averageFillPrice: order.averageFillPrice?.toNumber?.() ?? order.averageFillPrice,
      totalFees: order.totalFees?.toNumber?.() ?? order.totalFees,
      totalCost: order.totalCost?.toNumber?.() ?? order.totalCost,
      brokerRef: order.brokerRef,
      rejectionReason: order.rejectionReason,
      validatedAt: order.validatedAt,
      submittedAt: order.submittedAt,
      filledAt: order.filledAt,
      settledAt: order.settledAt,
      cancelledAt: order.cancelledAt,
      createdAt: order.createdAt,
      trades: order.trades?.map((t: any) => ({
        id: t.id,
        quantity: t.quantity?.toNumber?.() ?? t.quantity,
        price: t.price?.toNumber?.() ?? t.price,
        fee: t.fee?.toNumber?.() ?? t.fee,
        createdAt: t.createdAt,
      })),
    };
  }
}
