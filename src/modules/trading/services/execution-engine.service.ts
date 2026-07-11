import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { BrokerGateway } from './broker-gateway.service';
import { OrderLifecycleStatus, assertTransition } from '../domain/order-lifecycle';
import { calculateTradingFees, serializeFees } from '../domain/trading-fee.calculator';
import { OrderExecutedEvent } from '../events/trading.events';

/**
 * Execution Engine — the heart of the trading system.
 *
 * Receives a validated, risk-checked order and:
 * 1. Gets current market price
 * 2. Submits to broker gateway
 * 3. Records Trade + OrderExecution
 * 4. Updates order status to FILLED / PARTIALLY_FILLED
 * 5. Publishes OrderExecutedEvent
 *
 * Only job: execute an order correctly.
 * Does NOT touch portfolio, ledger, or notifications.
 */
@Injectable()
export class ExecutionEngineService {
  private readonly logger = new Logger(ExecutionEngineService.name);

  constructor(
    private readonly repo: TradingRepository,
    private readonly brokerGateway: BrokerGateway,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Execute an order that has already passed validation and risk checks.
   *
   * @param orderId - The order to execute
   * @param estimatedPrice - Price from validation step
   * @returns The executed order with trade details
   */
  async execute(
    orderId: string,
    estimatedPrice: Decimal,
  ) {
    const order = await this.repo.findOrderById(orderId);
    if (!order) {
      throw new InternalServerErrorException('Order not found during execution');
    }

    const currentStatus = order.status as OrderLifecycleStatus;

    // Transition: VALIDATED → SUBMITTED
    assertTransition(currentStatus, OrderLifecycleStatus.SUBMITTED);
    await this.repo.updateOrderStatus(orderId, OrderLifecycleStatus.SUBMITTED, {
      submittedAt: new Date(),
    });

    await this.repo.createTradeAudit({
      orderId,
      userId: order.userId,
      action: 'ORDER_SUBMITTED_TO_BROKER',
      fromStatus: currentStatus,
      toStatus: OrderLifecycleStatus.SUBMITTED,
      metadata: { broker: this.brokerGateway.adapterName },
    });

    // Submit to broker
    const fillResult = await this.brokerGateway.submitOrder({
      orderId: order.id,
      stockSymbol: order.stock.symbol,
      side: order.side as 'BUY' | 'SELL',
      type: order.type as 'MARKET' | 'LIMIT',
      quantity: order.quantity.toNumber(),
      limitPrice: order.limitPrice?.toNumber(),
      estimatedPrice: estimatedPrice.toNumber(),
    });

    // Update broker reference
    await this.repo.updateOrderStatus(orderId, OrderLifecycleStatus.ACCEPTED, {
      brokerRef: fillResult.brokerRef,
      acceptedAt: new Date(),
    });

    if (fillResult.status === 'REJECTED') {
      await this.repo.updateOrderStatus(orderId, OrderLifecycleStatus.REJECTED, {
        rejectionReason: fillResult.rejectionReason ?? 'Rejected by broker',
      });

      await this.repo.createTradeAudit({
        orderId,
        userId: order.userId,
        action: 'ORDER_REJECTED_BY_BROKER',
        fromStatus: OrderLifecycleStatus.ACCEPTED,
        toStatus: OrderLifecycleStatus.REJECTED,
        metadata: { reason: fillResult.rejectionReason, brokerRef: fillResult.brokerRef },
      });

      return { order, status: 'REJECTED' as const };
    }

    // Calculate actual fees based on fill price
    const fillPrice = new Decimal(fillResult.fillPrice);
    const filledQty = new Decimal(fillResult.filledQuantity);
    const fees = calculateTradingFees(fillPrice, filledQty, order.side as 'BUY' | 'SELL');

    // Create trade record
    const trade = await this.repo.createTrade({
      orderId,
      quantity: filledQty,
      price: fillPrice,
      fee: fees.totalFees,
    });

    // Create execution record
    await this.repo.createOrderExecution({
      orderId,
      quantity: filledQty,
      price: fillPrice,
      fee: fees.totalFees,
      brokerRef: fillResult.brokerRef,
    });

    // Determine fill status
    const isFull = filledQty.gte(order.quantity);
    const newStatus = isFull
      ? OrderLifecycleStatus.FILLED
      : OrderLifecycleStatus.PARTIALLY_FILLED;

    // Update order with fill data
    await this.repo.updateOrderStatus(orderId, newStatus, {
      filledQuantity: filledQty,
      averageFillPrice: fillPrice,
      totalFees: fees.totalFees,
      totalCost: fees.totalCost,
      filledAt: isFull ? new Date() : undefined,
    });

    // Audit
    await this.repo.createTradeAudit({
      orderId,
      userId: order.userId,
      action: isFull ? 'ORDER_FILLED' : 'ORDER_PARTIALLY_FILLED',
      fromStatus: OrderLifecycleStatus.ACCEPTED,
      toStatus: newStatus,
      metadata: {
        fillPrice: fillPrice.toNumber(),
        filledQuantity: filledQty.toNumber(),
        brokerRef: fillResult.brokerRef,
        fees: serializeFees(fees),
      },
    });

    // Publish event for downstream consumers (ledger, settlement, notifications)
    this.eventEmitter.emit(
      OrderExecutedEvent.event,
      new OrderExecutedEvent(
        orderId,
        order.userId,
        order.stockId,
        order.stock.symbol,
        order.side as 'BUY' | 'SELL',
        filledQty.toNumber(),
        fillPrice.toNumber(),
        fees.totalFees.toNumber(),
        fees.totalCost.toNumber(),
        trade.id,
      ),
    );

    this.logger.log(
      {
        orderId,
        status: newStatus,
        fillPrice: fillPrice.toString(),
        filledQty: filledQty.toString(),
        tradeId: trade.id,
      },
      'Order executed',
    );

    return {
      order: await this.repo.findOrderById(orderId),
      trade,
      fees: serializeFees(fees),
      status: newStatus,
    };
  }
}
