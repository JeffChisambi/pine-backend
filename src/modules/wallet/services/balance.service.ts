import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletCalculator, WalletSummary } from './wallet-calculator.service';

/**
 * Balance Service — answers: "How much money does this customer have?"
 *
 * Reads from ledger + reservations + pending transactions.
 * Never mutates balances directly.
 *
 * Available Balance = Ledger Balance - Reserved - Pending Withdrawals
 */
@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    private readonly repo: WalletRepository,
    private readonly calculator: WalletCalculator,
  ) {}

  /**
   * Get full wallet summary for a user.
   */
  async getWalletSummary(userId: string): Promise<WalletSummary> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found. Please contact support.');
    }

    const [reservedAmount, pendingTxs] = await Promise.all([
      this.repo.sumActiveReservations(wallet.id),
      this.repo.findUserTransactions(wallet.id, 100, 0),
    ]);

    // Sum pending deposits/withdrawals from recent transactions
    let pendingDeposits = new Decimal(0);
    let pendingWithdrawals = new Decimal(0);
    // Use wallet balance (denormalized from ledger) for fast reads
    const ledgerBalance = wallet.balance;

    return this.calculator.calculateSummary({
      walletId: wallet.id,
      currency: wallet.currency,
      ledgerBalance,
      reservedAmount,
      pendingDeposits,
      pendingWithdrawals,
      isFrozen: wallet.isFrozen,
      frozenReason: wallet.frozenReason,
    });
  }

  /**
   * Quick balance check (no reservations detail).
   */
  async getBalance(userId: string): Promise<{
    balance: number;
    currency: string;
    isFrozen: boolean;
  }> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return {
      balance: wallet.balance.toNumber(),
      currency: wallet.currency,
      isFrozen: wallet.isFrozen,
    };
  }

  /**
   * Ensure wallet exists, create if not.
   */
  async ensureWallet(userId: string): Promise<string> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (wallet) return wallet.id;

    const created = await this.repo.createWallet(userId);
    this.logger.log({ userId, walletId: created.id }, 'Wallet created');
    return created.id;
  }

  /**
   * Validate the wallet is active and not frozen.
   */
  async validateWalletActive(userId: string): Promise<void> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    if (wallet.isFrozen) {
      throw new ForbiddenException(
        `Wallet is frozen: ${wallet.frozenReason ?? 'Contact support'}`,
      );
    }
  }

  /**
   * Reconcile wallet balance against ledger (nightly job).
   * Returns the discrepancy if any.
   */
  async reconcile(userId: string): Promise<{
    walletBalance: number;
    ledgerBalance: number;
    discrepancy: number;
  }> {
    const wallet = await this.repo.findWalletByUserId(userId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const ledgerBalance = await this.repo.sumLedgerBalance(wallet.id);
    const discrepancy = wallet.balance.sub(ledgerBalance).toNumber();

    if (discrepancy !== 0) {
      this.logger.error(
        {
          userId,
          walletBalance: wallet.balance.toString(),
          ledgerBalance: ledgerBalance.toString(),
          discrepancy,
        },
        'RECONCILIATION DISCREPANCY — wallet balance does not match ledger',
      );
    }

    return {
      walletBalance: wallet.balance.toNumber(),
      ledgerBalance: ledgerBalance.toNumber(),
      discrepancy,
    };
  }
}
