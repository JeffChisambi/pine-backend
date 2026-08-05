import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WalletRepository } from '../repositories/wallet.repository';

/**
 * Statement Service — produces transaction history and statements.
 *
 * Deposits, Withdrawals, Trading Debits/Credits, Dividends,
 * Fees, Reversals, Adjustments.
 *
 * Future: downloadable PDF/CSV statements.
 */

export interface StatementEntry {
  id: string;
  type: string;
  amount: number;
  currency: string;
  /** Real transaction status (PENDING / COMPLETED / FAILED / …). */
  status: string;
  direction: string;
  description: string | null;
  reference: string;
  relatedOrderId: string | null;
  createdAt: Date;
}

@Injectable()
export class StatementService {
  private readonly logger = new Logger(StatementService.name);

  constructor(private readonly repo: WalletRepository) {}

  /**
   * GET /wallet/statement — paginated transaction history.
   */
  async getStatement(
    userId: string,
    limit = 30,
    offset = 0,
  ): Promise<{
    entries: StatementEntry[];
    total: number;
  }> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const { transactions, total } = await this.repo.findUserTransactions(
      wallet.id,
      limit,
      offset,
    );

    return {
      entries: transactions.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amount: tx.amount.toNumber(),
        currency: tx.currency,
        status: tx.status,
        direction: this.getDirection(tx.type),
        description: tx.description,
        reference: tx.reference,
        relatedOrderId: tx.relatedOrderId,
        createdAt: tx.createdAt,
      })),
      total,
    };
  }

  /**
   * GET /wallet/history — detailed ledger view.
   */
  async getLedgerHistory(userId: string, limit = 50) {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const entries = await this.repo.findLedgerEntriesForWallet(wallet.id, limit);

    return entries.map((e) => ({
      id: e.id,
      transactionId: e.transactionId,
      type: e.transaction.type,
      direction: e.direction,
      amount: e.amount.toNumber(),
      balanceAfter: e.balanceAfter.toNumber(),
      currency: e.currency,
      description: e.transaction.description,
      createdAt: e.createdAt,
    }));
  }

  /**
   * GET /wallet/snapshots — balance history for charts.
   */
  async getBalanceHistory(userId: string, limit = 90) {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const snapshots = await this.repo.findSnapshots(wallet.id, limit);
    return snapshots
      .map((s) => ({
        date: s.snapshotDate,
        balance: s.balance.toNumber(),
        reserved: s.reservedAmount.toNumber(),
        available: s.availableAmount.toNumber(),
      }))
      .reverse(); // Chronological
  }

  // ── Helpers ─────────────────────────────────────────────────

  private getDirection(type: string): string {
    switch (type) {
      case 'DEPOSIT':
      case 'TRADE_SELL':
      case 'DIVIDEND_CREDIT':
      case 'REVERSAL':
        return 'IN';
      case 'WITHDRAWAL':
      case 'TRADE_BUY':
      case 'FEE':
        return 'OUT';
      default:
        return 'OTHER';
    }
  }
}
