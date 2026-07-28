import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { OrderService } from './order.service';
import { ValidationService } from './validation.service';
import { RiskService } from './risk.service';
import { ExecutionEngineService } from './execution-engine.service';
import { TradingRepository } from '../repositories/trading.repository';
import { OrderLifecycleStatus, assertTransition } from '../domain/order-lifecycle';
import { OrderCreatedEvent, OrderCancelledEvent } from '../events/trading.events';

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
  ) {}

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
        userKycStatus,
      });

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

      // ── Market-hours check ──────────────────────────────────
      // Unlike validation errors (wrong KYC, frozen wallet etc.), a closed
      // market is NOT a reason to reject the order. We queue it at SUBMITTED
      // so the broker can see and execute it from Kusata when the market opens.
      const marketOpen = await this.validationService.checkIsMarketOpen();
      if (!marketOpen) {
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
          action: 'ORDER_QUEUED_MARKET_CLOSED',
          fromStatus: OrderLifecycleStatus.VALIDATED,
          toStatus: OrderLifecycleStatus.SUBMITTED,
          metadata: {
            reason: 'Market closed — order queued for broker execution during next session',
            estimatedPrice: estimatedPrice.toNumber(),
          },
        });

        const durationMs = Date.now() - startTime;
        this.logger.log(
          { orderId: order.id, durationMs },
          'Order queued — market is closed, pending broker execution',
        );

        return {
          orderId: order.id,
          status: OrderLifecycleStatus.SUBMITTED,
          queued: true,
          message: 'Your order has been queued and will be executed when the market opens (MSE: 10:00 AM — 2:00 PM CAT, Mon–Fri).',
          order: await this.repo.findOrderById(order.id).then((o) => this.formatOrderResponse(o)),
          fees: {
            totalFees: fees.totalFees.toNumber(),
            totalCost: fees.totalCost.toNumber(),
          },
          pipelineDurationMs: durationMs,
        };
      }

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

      // ── Step 4: Execution ───────────────────────────────────
      const result = await this.executionEngine.execute(order.id, estimatedPrice);

      const durationMs = Date.now() - startTime;
      this.logger.log(
        {
          orderId: order.id,
          status: result.status,
          durationMs,
        },
        'Trading pipeline completed',
      );

      return {
        orderId: order.id,
        status: result.status,
        order: this.formatOrderResponse(result.order),
        fees: result.fees,
        pipelineDurationMs: durationMs,
      };
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
      }

      throw error;
    }
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

    return { orderId, status: 'CANCELLED' };
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
   * Get trade history.
   */
  async getTradeHistory(userId: string, limit = 20, offset = 0) {
    const trades = await this.repo.findUserTrades(userId, limit, offset);
    return trades.map((t) => ({
      tradeId: t.id,
      orderId: t.orderId,
      stockSymbol: t.order.stock.symbol,
      stockName: t.order.stock.name,
      side: t.order.side,
      quantity: t.quantity.toNumber(),
      price: t.price.toNumber(),
      fee: t.fee.toNumber(),
      total: t.quantity.mul(t.price).toNumber(),
      settledAt: t.settledAt,
      createdAt: t.createdAt,
    }));
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
