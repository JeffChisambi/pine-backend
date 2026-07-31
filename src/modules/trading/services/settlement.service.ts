import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TradingRepository } from '../repositories/trading.repository';
import { OrderExecutedEvent, TradeSettledEvent } from '../events/trading.events';
import { OrderLifecycleStatus } from '../domain/order-lifecycle';

/**
 * Settlement Service — handles post-execution settlement.
 *
 * Trade execution and settlement are DIFFERENT things:
 *   Execute → money committed, order filled
 *   Settle  → ownership officially transferred
 *
 * Currently T+0 (instant settlement) since MSE volumes are low.
 * Architecture supports T+1/T+2 via the settlement queue when
 * regulations require it.
 *
 * Listens to: OrderExecutedEvent (after ledger has recorded entries)
 * Publishes:  TradeSettledEvent  (triggers portfolio update)
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly repo: TradingRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent(OrderExecutedEvent.event)
  async handleOrderExecuted(event: OrderExecutedEvent): Promise<void> {
    this.logger.log(
      { tradeId: event.tradeId, orderId: event.orderId },
      'Processing settlement for executed trade',
    );

    try {
      // Create settlement record
      const settlement = await this.repo.createSettlementRecord({
        tradeId: event.tradeId,
        settlementDate: new Date(), // T+0: settle immediately
      });

      // T+0: instant settlement
      await this.repo.settleRecord(settlement.id);

      // Update order status: FILLED → PENDING_SETTLEMENT → SETTLED
      const order = await this.repo.findOrderById(event.orderId);
      if (order && order.status === OrderLifecycleStatus.FILLED) {
        await this.repo.updateOrderStatus(
          event.orderId,
          OrderLifecycleStatus.PENDING_SETTLEMENT,
        );
        await this.repo.updateOrderStatus(
          event.orderId,
          OrderLifecycleStatus.SETTLED,
          { settledAt: new Date() },
        );
      }

      // Audit
      await this.repo.createTradeAudit({
        orderId: event.orderId,
        userId: event.userId,
        action: 'TRADE_SETTLED',
        fromStatus: OrderLifecycleStatus.FILLED,
        toStatus: OrderLifecycleStatus.SETTLED,
        metadata: {
          settlementId: settlement.id,
          settlementDate: new Date().toISOString(),
          settlementType: 'T+0',
        },
      });

      // Publish settlement event → triggers portfolio update
      this.eventEmitter.emit(
        TradeSettledEvent.event,
        new TradeSettledEvent(
          event.tradeId,
          event.orderId,
          event.userId,
          event.stockId,
          event.stockSymbol, // pass through so listeners don't need an extra DB lookup
          event.side,
          event.quantity,
          event.price,
          settlement.id,
        ),
      );

      this.logger.log(
        { tradeId: event.tradeId, settlementId: settlement.id },
        'Trade settled (T+0)',
      );
    } catch (error) {
      this.logger.error(
        { err: error, tradeId: event.tradeId },
        'Settlement failed',
      );
    }
  }
}
