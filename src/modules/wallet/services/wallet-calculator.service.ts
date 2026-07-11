import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Wallet Calculator — pure computation. No side effects.
 *
 * Inputs:  Ledger balance + Active reservations + Pending deposits/withdrawals
 * Outputs: Wallet summary (available, reserved, pending, total)
 *
 * The Wallet never manually calculates balances inside controllers
 * or services. Everything flows through this calculator.
 */

export interface WalletSummary {
  walletId: string;
  currency: string;
  /** Total balance from ledger */
  totalBalance: number;
  /** Funds reserved for pending orders */
  reservedBalance: number;
  /** Funds available for new orders */
  availableBalance: number;
  /** Pending deposits not yet cleared */
  pendingDeposits: number;
  /** Pending withdrawals not yet processed */
  pendingWithdrawals: number;
  /** Is the wallet frozen? */
  isFrozen: boolean;
  frozenReason: string | null;
}

@Injectable()
export class WalletCalculator {
  /**
   * Calculate the full wallet summary.
   *
   * Available = Total Balance - Reserved - Pending Withdrawals
   * Total includes cleared funds only.
   */
  calculateSummary(params: {
    walletId: string;
    currency: string;
    ledgerBalance: Decimal;
    reservedAmount: Decimal;
    pendingDeposits: Decimal;
    pendingWithdrawals: Decimal;
    isFrozen: boolean;
    frozenReason: string | null;
  }): WalletSummary {
    const available = params.ledgerBalance
      .sub(params.reservedAmount)
      .sub(params.pendingWithdrawals);

    return {
      walletId: params.walletId,
      currency: params.currency,
      totalBalance: params.ledgerBalance.toNumber(),
      reservedBalance: params.reservedAmount.toNumber(),
      availableBalance: Math.max(available.toNumber(), 0),
      pendingDeposits: params.pendingDeposits.toNumber(),
      pendingWithdrawals: params.pendingWithdrawals.toNumber(),
      isFrozen: params.isFrozen,
      frozenReason: params.frozenReason,
    };
  }

  /**
   * Check if the wallet has sufficient available funds.
   */
  hasSufficientFunds(
    ledgerBalance: Decimal,
    reservedAmount: Decimal,
    requiredAmount: Decimal,
  ): boolean {
    const available = ledgerBalance.sub(reservedAmount);
    return available.gte(requiredAmount);
  }

  /**
   * Calculate the new average balance after a transaction.
   */
  calculateNewBalance(
    currentBalance: Decimal,
    amount: Decimal,
    direction: 'CREDIT' | 'DEBIT',
  ): Decimal {
    return direction === 'CREDIT'
      ? currentBalance.add(amount)
      : currentBalance.sub(amount);
  }
}
