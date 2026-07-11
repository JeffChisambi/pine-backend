import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { OrderLifecycleStatus, CANCELLABLE_STATES, assertTransition } from '../domain/order-lifecycle';

/**
 * Order Service — CRUD operations for orders.
 *
 * Responsible for:
 * - Creating draft orders
 * - Cancelling orders (only if in a cancellable state)
 * - Retrieving order history and details
 *
 * Never executes trades. Never touches the ledger.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(private readonly repo: TradingRepository) {}

  async createOrder(data: {
    userId: string;
    stockSymbol: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    quantity: number;
    limitPrice?: number;
    idempotencyKey?: string;
  }) {
    // Idempotency check
    if (data.idempotencyKey) {
      const existing = await this.repo.findOrderByIdempotencyKey(
        data.userId,
        data.idempotencyKey,
      );
      if (existing) {
        this.logger.log({ orderId: existing.id }, 'Idempotent order — returning existing');
        return existing;
      }
    }

    // Resolve stock
    const stock = await this.repo.findStockBySymbol(data.stockSymbol);
    if (!stock) {
      throw new NotFoundException(`Stock ${data.stockSymbol} not found`);
    }

    const order = await this.repo.createOrder({
      userId: data.userId,
      stockId: stock.id,
      side: data.side,
      type: data.type,
      quantity: new Decimal(data.quantity),
      limitPrice: data.limitPrice ? new Decimal(data.limitPrice) : undefined,
      idempotencyKey: data.idempotencyKey,
    });

    // Audit the creation
    await this.repo.createTradeAudit({
      orderId: order.id,
      userId: data.userId,
      action: 'ORDER_CREATED',
      toStatus: OrderLifecycleStatus.DRAFT,
      metadata: {
        stockSymbol: data.stockSymbol,
        side: data.side,
        type: data.type,
        quantity: data.quantity,
        limitPrice: data.limitPrice,
      },
    });

    this.logger.log(
      { orderId: order.id, stock: data.stockSymbol, side: data.side },
      'Order created',
    );

    return order;
  }

  async cancelOrder(userId: string, orderId: string): Promise<void> {
    const order = await this.repo.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }

    const currentStatus = order.status as OrderLifecycleStatus;
    if (!CANCELLABLE_STATES.has(currentStatus)) {
      throw new ConflictException(
        `Order cannot be cancelled in ${currentStatus} state`,
      );
    }

    assertTransition(currentStatus, OrderLifecycleStatus.CANCELLED);

    await this.repo.updateOrderStatus(orderId, OrderLifecycleStatus.CANCELLED, {
      cancelledAt: new Date(),
    });

    await this.repo.createTradeAudit({
      orderId,
      userId,
      action: 'ORDER_CANCELLED',
      fromStatus: currentStatus,
      toStatus: OrderLifecycleStatus.CANCELLED,
      metadata: { reason: 'User requested cancellation' },
    });

    this.logger.log({ orderId }, 'Order cancelled');
  }

  async getOrderHistory(
    userId: string,
    filters: { status?: string; side?: string; limit?: number; offset?: number },
  ) {
    return this.repo.findUserOrders(userId, filters);
  }

  async getOrderDetail(userId: string, orderId: string) {
    const order = await this.repo.findOrderById(orderId);
    if (!order || order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }
}
