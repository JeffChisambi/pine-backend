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
      // Keyed on the EXECUTION (tradeId), not the order: an order may have
      // several partial executions, each settling exactly once, while a
      // duplicated execution event can never double-post the cash leg.
      const cashType = event.side === 'BUY' ? 'TRADE_BUY' : 'TRADE_SELL';
      const settleKey = `settle-${event.tradeId}`;
      const existing = await tx.transaction.findFirst({
        where: { walletId: wallet.id, idempotencyKey: settleKey },
        select: { id: true },
      });
      if (existing) {
        this.logger.warn(
          { orderId: event.orderId, tradeId: event.tradeId },
          'Execution already settled — skipping duplicate event',
        );
        return null;
      }

      // ── 1a. Consume/reduce the fund reservation (BUY) ─────────
      // The hold placed at order submission moves in the SAME commit as the
      // cash debit: reserved → spent is one atomic step, so available balance
      // never double-counts and never briefly frees the money.
      //
      // Partial executions: only the EXECUTED portion of the hold is
      // consumed — the remainder stays reserved until the order is fully
      // filled, cancelled, or otherwise resolved.
      if (event.side === 'BUY') {
        const orderFill = await tx.order.findUnique({
          where: { id: event.orderId },
          select: { quantity: true, filledQuantity: true },
        });
        const fullyFilled =
          !orderFill || new Decimal(orderFill.filledQuantity).gte(new Decimal(orderFill.quantity));

        if (fullyFilled) {
          await tx.walletReservation.updateMany({
            where: { orderId: event.orderId, status: 'ACTIVE' },
            data: { status: 'CONSUMED', consumedAt: new Date() },
          });
        } else {
          const activeRes = await tx.walletReservation.findFirst({
            where: { orderId: event.orderId, status: 'ACTIVE' },
          });
          if (activeRes) {
            const remaining = activeRes.amount.sub(totalCost);
            if (remaining.lte(0)) {
              await tx.walletReservation.update({
                where: { id: activeRes.id },
                data: { status: 'CONSUMED', consumedAt: new Date() },
              });
            } else {
              await tx.walletReservation.update({
                where: { id: activeRes.id },
                data: { amount: remaining },
              });
            }
          }
        }
      }

      // ── 1b. Cash leg (atomic increment/decrement) ─────────────
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
        idempotencyKey: settleKey,
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
        // Cost basis includes fees: what the buyer ACTUALLY paid per share
        // (gross + commission + levies) — so P&L on the position reflects
        // true cost, not just the exchange price.
        const newAvg = prevQty.mul(prevAvg).add(totalCost).div(newQty);
        const buyOrderBroker = await tx.order.findUnique({
          where: { id: event.orderId },
          select: { brokerId: true },
        });
        await tx.holding.upsert({
          where: { userId_stockId: { userId: event.userId, stockId: event.stockId } },
          create: {
            userId: event.userId,
            stockId: event.stockId,
            quantity: newQty,
            averageCost: newAvg,
            brokerId: buyOrderBroker?.brokerId ?? null,
          },
          update: {
            quantity: newQty,
            averageCost: newAvg,
            // Backfill broker ownership on legacy holdings created before
            // the multi-broker migration.
            brokerId: buyOrderBroker?.brokerId ?? undefined,
          },
        });
      } else {
        const prevQty = holding?.quantity ?? new Decimal(0);
        // INTEGRITY: never settle a sell of more shares than the user holds.
        // Aborting the transaction rolls back the cash credit too — a
        // phantom sell must not pay out. (Validation blocks this upstream;
        // this is the last line of defense.)
        if (!holding || prevQty.lt(qty)) {
          throw new Error(
            `Sell settlement aborted for order ${event.orderId}: ` +
            `selling ${qty.toString()} but holding ${prevQty.toString()} shares`,
          );
        }
        const newQty = prevQty.sub(qty);
        const sellOrderBroker = await tx.order.findUnique({
          where: { id: event.orderId },
          select: { brokerId: true },
        });
        await tx.holding.update({
          where: { userId_stockId: { userId: event.userId, stockId: event.stockId } },
          data: {
            quantity: newQty,
            brokerId: sellOrderBroker?.brokerId ?? undefined,
          },
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
