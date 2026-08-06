import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Decimal } from '@prisma/client/runtime/library';
import { TradingRepository } from '../repositories/trading.repository';
import { OrderExecutedEvent, TradeSettledEvent } from '../events/trading.events';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../../../infrastructure/database/prisma.service';

/**
 * Ledger Service — double-entry bookkeeping for all trades.
 *
 * Never does: wallet.balance += amount
 * Instead:    creates balanced LedgerEntry rows within a DB transaction,
 *             then updates the wallet balance in the same transaction.
 *
 * BUY order ledger entries:
 *   DEBIT   USER_WALLET          -K19,500  (cash leaves user)
 *   CREDIT  EXCHANGE_SETTLEMENT  +K19,500  (goes to exchange/broker)
 *   DEBIT   PLATFORM_FEE_REVENUE +K370     (our commission)
 *
 * SELL order ledger entries:
 *   CREDIT  USER_WALLET          +K19,130  (cash to user, net of fees)
 *   DEBIT   EXCHANGE_SETTLEMENT  -K19,500  (comes from exchange/broker)
 *   DEBIT   PLATFORM_FEE_REVENUE +K370     (our commission)
 *
 * Balance is ALWAYS derivable from the sum of ledger entries.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly repo: TradingRepository) {}

  /**
   * Listens to OrderExecutedEvent and records the financial transaction
   * with double-entry ledger entries.
   */
  @OnEvent(OrderExecutedEvent.event)
  async handleOrderExecuted(event: OrderExecutedEvent): Promise<void> {
    this.logger.log(
      { orderId: event.orderId, tradeId: event.tradeId },
      'Recording ledger entries for executed order',
    );

    try {
      const grossValue = new Decimal(event.price).mul(new Decimal(event.quantity));
      const totalFees = new Decimal(event.totalFees);
      const totalCost = new Decimal(event.totalCost);

      await this.runWithRetry(event.orderId, async () =>
      this.repo.db.$transaction(async (tx) => {
        // Read the wallet INSIDE the transaction. The previous outside-read
        // meant a stale `version` made the guarded update match zero rows and
        // throw — the cash leg silently never happened while the holdings
        // listener succeeded, leaving assets updated but the balance not.
        const wallet = await tx.wallet.findFirst({ where: { userId: event.userId } });
        if (!wallet) {
          this.logger.error({ userId: event.userId }, 'Wallet not found for ledger entry');
          return;
        }

        // Idempotency: if this order's cash transaction already exists, a
        // replayed/duplicate event must not move money twice.
        const existing = await tx.transaction.findFirst({
          where: {
            walletId: wallet.id,
            relatedOrderId: event.orderId,
            type: event.side === 'BUY' ? 'TRADE_BUY' : 'TRADE_SELL',
          },
          select: { id: true },
        });
        if (existing) {
          this.logger.warn(
            { orderId: event.orderId },
            'Ledger entries already recorded for this order — skipping duplicate event',
          );
          return;
        }

        if (event.side === 'BUY') {
          // BUY: debit user wallet (cash out)
          const newBalance = wallet.balance.sub(totalCost);

          // Atomic decrement; version read inside this same transaction.
          await tx.wallet.update({
            where: { id: wallet.id, version: wallet.version },
            data: {
              balance: { decrement: totalCost },
              version: { increment: 1 },
            },
          });

          // Create transaction + ledger entries
          await this.repo.createTransactionWithLedger(tx, {
            walletId: wallet.id,
            type: 'TRADE_BUY',
            amount: totalCost,
            relatedOrderId: event.orderId,
            description: `Buy ${event.quantity} ${event.stockSymbol} @ MWK ${event.price}`,
            entries: [
              {
                walletId: wallet.id,
                accountType: 'USER_WALLET',
                direction: 'DEBIT',
                amount: totalCost,
                balanceAfter: newBalance,
              },
              {
                accountType: 'EXCHANGE_SETTLEMENT',
                direction: 'CREDIT',
                amount: grossValue,
                balanceAfter: new Decimal(0), // Platform account — not tracked per-user
              },
              {
                accountType: 'PLATFORM_FEE_REVENUE',
                direction: 'CREDIT',
                amount: totalFees,
                balanceAfter: new Decimal(0),
              },
            ],
          });
        } else {
          // SELL: credit user wallet (cash in, net of fees)
          const netProceeds = grossValue.sub(totalFees);
          const newBalance = wallet.balance.add(netProceeds);

          // Atomic increment with optimistic locking (never a replacement).
          await tx.wallet.update({
            where: { id: wallet.id, version: wallet.version },
            data: {
              balance: { increment: netProceeds },
              version: { increment: 1 },
            },
          });

          await this.repo.createTransactionWithLedger(tx, {
            walletId: wallet.id,
            type: 'TRADE_SELL',
            amount: netProceeds,
            relatedOrderId: event.orderId,
            description: `Sell ${event.quantity} ${event.stockSymbol} @ MWK ${event.price}`,
            entries: [
              {
                walletId: wallet.id,
                accountType: 'USER_WALLET',
                direction: 'CREDIT',
                amount: netProceeds,
                balanceAfter: newBalance,
              },
              {
                accountType: 'EXCHANGE_SETTLEMENT',
                direction: 'DEBIT',
                amount: grossValue,
                balanceAfter: new Decimal(0),
              },
              {
                accountType: 'PLATFORM_FEE_REVENUE',
                direction: 'CREDIT',
                amount: totalFees,
                balanceAfter: new Decimal(0),
              },
            ],
          });
        }
      }, FINANCIAL_TRANSACTION_OPTIONS));

      this.logger.log(
        { orderId: event.orderId, side: event.side },
        'Ledger entries recorded successfully',
      );
    } catch (error) {
      this.logger.error(
        { err: error, orderId: event.orderId },
        'Failed to record ledger entries — CRITICAL: financial inconsistency possible',
      );
      throw error; // Re-throw — ledger failures must not be silently swallowed
    }
  }

  /**
   * Serializable transactions abort on write-write conflict (P2034), and the
   * version guard aborts if a concurrent writer bumped the wallet (P2025).
   * Both are transient — re-running the transaction re-reads the wallet and
   * succeeds. The in-transaction idempotency check makes retries safe.
   */
  private async runWithRetry(orderId: string, fn: () => Promise<unknown>): Promise<void> {
    const RETRYABLE = new Set(['P2034', 'P2025']);
    for (let attempt = 1; ; attempt++) {
      try {
        await fn();
        return;
      } catch (error: any) {
        const code = error?.code as string | undefined;
        if (attempt < 4 && code && RETRYABLE.has(code)) {
          this.logger.warn(
            { orderId, attempt, code },
            'Ledger transaction conflict — retrying',
          );
          await new Promise((r) => setTimeout(r, 100 * attempt));
          continue;
        }
        throw error;
      }
    }
  }
}
