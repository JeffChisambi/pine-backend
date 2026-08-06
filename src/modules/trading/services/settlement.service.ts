import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { OrderExecutedEvent, TradeSettledEvent } from '../events/trading.events';
import { OrderLifecycleStatus } from '../domain/order-lifecycle';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../../../infrastructure/database/prisma.service';

/**
 * Settlement Service — settles an executed trade ATOMICALLY.
 *
 * One serializable database transaction commits, together:
 *   1. Cash leg      — wallet debit (BUY) / credit (SELL), atomic increment
 *   2. Bookkeeping   — Transaction row + double-entry ledger entries
 *   3. Holdings      — position upsert with weighted-average cost
 *   4. Settlement    — settlement record + order status → SETTLED + audit
 *
 * Either everything commits or nothing does — holdings can never move
 * without the cash balance moving with them (the previous design ran cash
 * and holdings in separate async listeners and could diverge).
 *
 * Idempotent: the cash Transaction row for an order is checked inside the
 * transaction, so a duplicated/replayed event is a no-op.
 *
 * Portfolio value itself is NEVER stored — it is always derived as
 * available cash + Σ(quantity × latest price) at read time.
 *
 * Listens to: OrderExecutedEvent
 * Publishes:  TradeSettledEvent (read-only reactions: snapshots, notifications)
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
      'Settling executed trade atomically (cash + ledger + holdings)',
    );

    try {
      const settlementId = await this.runWithRetry(event.orderId, () =>
        this.settleAtomically(event),
      );

      if (!settlementId) return; // duplicate event — already settled

      // Post-commit reactions only (snapshot, notifications). Nothing that
      // moves money or positions listens to this event any more.
      this.eventEmitter.emit(
        TradeSettledEvent.event,
        new TradeSettledEvent(
          event.tradeId,
          event.orderId,
          event.userId,
          event.stockId,
          event.stockSymbol,
          event.side,
          event.quantity,
          event.price,
          settlementId,
        ),
      );

      this.logger.log(
        { tradeId: event.tradeId, settlementId },
        'Trade settled atomically (T+0)',
      );
    } catch (error) {
      this.logger.error(
        { err: error, orderId: event.orderId },
        'Atomic settlement failed — CRITICAL: order executed but not settled',
      );
      throw error;
    }
  }

  /**
   * The single transaction. Returns the settlement id, or null when the
   * order was already settled (idempotent no-op).
   */
  private async settleAtomically(event: OrderExecutedEvent): Promise<string | null> {
    const grossValue = new Decimal(event.price).mul(new Decimal(event.quantity));
    const totalFees = new Decimal(event.totalFees);
    const totalCost = new Decimal(event.totalCost);

    return this.repo.db.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId: event.userId } });
      if (!wallet) {
        throw new Error(`Wallet not found for user ${event.userId}`);
      }

      // ── Idempotency ───────────────────────────────────────────
      const cashType = event.side === 'BUY' ? 'TRADE_BUY' : 'TRADE_SELL';
      const existing = await tx.transaction.findFirst({
        where: { walletId: wallet.id, relatedOrderId: event.orderId, type: cashType },
        select: { id: true },
      });
      if (existing) {
        this.logger.warn(
          { orderId: event.orderId },
          'Order already settled — skipping duplicate event',
        );
        return null;
      }

      // ── 1. Cash leg (atomic increment/decrement) ──────────────
      const cashDelta = event.side === 'BUY' ? totalCost : grossValue.sub(totalFees);
      const newBalance =
        event.side === 'BUY'
          ? wallet.balance.sub(cashDelta)
          : wallet.balance.add(cashDelta);

      if (event.side === 'BUY' && newBalance.lt(0)) {
        throw new Error(
          `Insufficient funds settling order ${event.orderId}: balance ${wallet.balance}, cost ${totalCost}`,
        );
      }

      await tx.wallet.update({
        where: { id: wallet.id, version: wallet.version },
        data: {
          balance:
            event.side === 'BUY'
              ? { decrement: cashDelta }
              : { increment: cashDelta },
          version: { increment: 1 },
        },
      });

      // ── 2. Transaction + double-entry ledger ──────────────────
      await this.repo.createTransactionWithLedger(tx, {
        walletId: wallet.id,
        type: cashType,
        amount: cashDelta,
        relatedOrderId: event.orderId,
        description:
          event.side === 'BUY'
            ? `Buy ${event.quantity} ${event.stockSymbol} @ MWK ${event.price}`
            : `Sell ${event.quantity} ${event.stockSymbol} @ MWK ${event.price}`,
        entries:
          event.side === 'BUY'
            ? [
                { walletId: wallet.id, accountType: 'USER_WALLET', direction: 'DEBIT', amount: cashDelta, balanceAfter: newBalance },
                { accountType: 'EXCHANGE_SETTLEMENT', direction: 'CREDIT', amount: grossValue, balanceAfter: new Decimal(0) },
                { accountType: 'PLATFORM_FEE_REVENUE', direction: 'CREDIT', amount: totalFees, balanceAfter: new Decimal(0) },
              ]
            : [
                { walletId: wallet.id, accountType: 'USER_WALLET', direction: 'CREDIT', amount: cashDelta, balanceAfter: newBalance },
                { accountType: 'EXCHANGE_SETTLEMENT', direction: 'DEBIT', amount: grossValue, balanceAfter: new Decimal(0) },
                { accountType: 'PLATFORM_FEE_REVENUE', direction: 'CREDIT', amount: totalFees, balanceAfter: new Decimal(0) },
              ],
      });

      // ── 3. Holdings (weighted-average cost) ───────────────────
      const qty = new Decimal(event.quantity);
      const price = new Decimal(event.price);
      const holding = await tx.holding.findUnique({
        where: { userId_stockId: { userId: event.userId, stockId: event.stockId } },
      });

      if (event.side === 'BUY') {
        const prevQty = holding?.quantity ?? new Decimal(0);
        const prevAvg = holding?.averageCost ?? new Decimal(0);
        const newQty = prevQty.add(qty);
        const newAvg = prevQty.gt(0)
          ? prevQty.mul(prevAvg).add(qty.mul(price)).div(newQty)
          : price;
        await tx.holding.upsert({
          where: { userId_stockId: { userId: event.userId, stockId: event.stockId } },
          create: { userId: event.userId, stockId: event.stockId, quantity: newQty, averageCost: newAvg },
          update: { quantity: newQty, averageCost: newAvg },
        });
      } else {
        const prevQty = holding?.quantity ?? new Decimal(0);
        const newQty = Decimal.max(prevQty.sub(qty), new Decimal(0));
        if (!holding || prevQty.lt(qty)) {
          this.logger.error(
            { orderId: event.orderId, prevQty: prevQty.toString(), sellQty: qty.toString() },
            'Sell settles more shares than held — clamping to zero',
          );
        }
        await tx.holding.upsert({
          where: { userId_stockId: { userId: event.userId, stockId: event.stockId } },
          create: { userId: event.userId, stockId: event.stockId, quantity: newQty, averageCost: price },
          update: { quantity: newQty },
        });
      }

      // ── 4. Settlement record + order status + audit ───────────
      const settlement = await tx.settlementRecord.create({
        data: { tradeId: event.tradeId, settlementDate: new Date(), status: 'SETTLED', settledAt: new Date() },
      });

      const order = await tx.order.findUnique({ where: { id: event.orderId } });
      if (order && order.status === OrderLifecycleStatus.FILLED) {
        await tx.order.update({
          where: { id: event.orderId },
          data: { status: OrderLifecycleStatus.SETTLED, settledAt: new Date() },
        });
      }

      await tx.tradeAudit.create({
        data: {
          orderId: event.orderId,
          userId: event.userId,
          action: 'TRADE_SETTLED',
          fromStatus: OrderLifecycleStatus.FILLED,
          toStatus: OrderLifecycleStatus.SETTLED,
          metadata: {
            settlementId: settlement.id,
            settlementDate: new Date().toISOString(),
            settlementType: 'T+0',
            atomic: true,
          },
        },
      });

      return settlement.id;
    }, FINANCIAL_TRANSACTION_OPTIONS);
  }

  /**
   * Serializable transactions abort on write conflicts (P2034) and the
   * wallet version guard aborts when a concurrent writer bumped it (P2025).
   * Both are transient; the idempotency check makes retries safe.
   */
  private async runWithRetry(
    orderId: string,
    fn: () => Promise<string | null>,
  ): Promise<string | null> {
    const RETRYABLE = new Set(['P2034', 'P2025']);
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const code = error?.code as string | undefined;
        if (attempt < 4 && code && RETRYABLE.has(code)) {
          this.logger.warn({ orderId, attempt, code }, 'Settlement conflict — retrying');
          await new Promise((r) => setTimeout(r, 100 * attempt));
          continue;
        }
        throw error;
      }
    }
  }
}
