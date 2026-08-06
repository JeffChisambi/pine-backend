import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletCalculator } from './wallet-calculator.service';
import { BalanceService } from './balance.service';
import { ReservationService } from './reservation.service';
import { StatementService } from './statement.service';
import { FINANCIAL_TRANSACTION_OPTIONS } from '../../../infrastructure/database/prisma.service';
import type { TradingService } from '../../trading/services/trading.service';

/**
 * Wallet Service — the orchestrator.
 *
 * The Wallet is a VIEW of the customer's cash position.
 * The Ledger is the source of truth.
 *
 * Money Flow (deposit):
 *   Payment completed → Ledger credit → Wallet updated → Notification
 *
 * Money Flow (buy order):
 *   Buy order → Reserve funds → Execute trade → Ledger debit
 *   → Release reservation → Wallet updated
 *
 * The Wallet coordinates cash visibility, but the Ledger records
 * the actual financial transaction.
 */

const DEPOSIT_COMPLETED_EVENT = 'payments.deposit.completed';
const WITHDRAWAL_COMPLETED_EVENT = 'payments.withdrawal.completed';
const WALLET_UPDATED_EVENT = 'wallet.updated';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  /**
   * Lazily resolved TradingService — set by PaymentsModule after bootstrap
   * to break the circular dependency (Wallet ↔ Trading).
   */
  private tradingService?: TradingService;

  constructor(
    private readonly repo: WalletRepository,
    private readonly calculator: WalletCalculator,
    private readonly balanceService: BalanceService,
    private readonly reservationService: ReservationService,
    private readonly statementService: StatementService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Called by PaymentsModule to wire the TradingService without circular DI. */
  setTradingService(tradingService: TradingService): void {
    this.tradingService = tradingService;
  }

  // ── API Methods ─────────────────────────────────────────────

  /** GET /wallet */
  async getWallet(userId: string) {
    return this.balanceService.getWalletSummary(userId);
  }

  /** GET /wallet/balance */
  async getBalance(userId: string) {
    return this.balanceService.getBalance(userId);
  }

  /** GET /wallet/statement */
  async getStatement(userId: string, limit = 30, offset = 0) {
    return this.statementService.getStatement(userId, limit, offset);
  }

  /** GET /wallet/reservations */
  async getReservations(userId: string) {
    return this.reservationService.getActiveReservations(userId);
  }

  /** GET /wallet/history */
  async getHistory(userId: string, limit = 50) {
    return this.statementService.getLedgerHistory(userId, limit);
  }

  /** GET /wallet/snapshots */
  async getBalanceHistory(userId: string, limit = 90) {
    return this.statementService.getBalanceHistory(userId, limit);
  }

  // ── Deposit ─────────────────────────────────────────────────

  /**
   * POST /wallet/deposit — initiate a deposit.
   *
   * This creates a PENDING transaction. The actual money movement
   * happens when the Payment provider confirms (via webhook).
   */
  async initiateDeposit(params: {
    userId: string;
    amount: number;
    idempotencyKey?: string;
    metadata?: Record<string, any>;
  }): Promise<{ transactionId: string; status: string }> {
    // Ensure wallet exists (auto-create on first deposit)
    const walletId = await this.balanceService.ensureWallet(params.userId);
    const wallet = await this.repo.findWalletById(walletId);
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.isFrozen) {
      throw new BadRequestException(`Wallet is frozen: ${wallet.frozenReason ?? 'Contact support'}`);
    }

    if (params.amount <= 0) {
      throw new BadRequestException('Deposit amount must be positive');
    }

    // Check daily deposit limit
    // TODO: Sum today's completed deposits and validate against dailyDepositLimit

    // Idempotency check
    if (params.idempotencyKey) {
      const existing = await this.repo.findTransactionByIdempotencyKey(
        wallet.id,
        params.idempotencyKey,
      );
      if (existing) {
        return { transactionId: existing.id, status: existing.status };
      }
    }

    const tx = await this.repo.createTransaction({
      walletId: wallet.id,
      type: 'DEPOSIT',
      amount: new Decimal(params.amount),
      idempotencyKey: params.idempotencyKey,
      description: `Deposit of MWK ${params.amount.toLocaleString()}`,
      metadata: params.metadata,
    });

    this.logger.log(
      { userId: params.userId, amount: params.amount, txId: tx.id, metadata: params.metadata },
      'Deposit initiated',
    );

    return { transactionId: tx.id, status: 'PENDING' };
  }

  // ── Withdrawal ──────────────────────────────────────────────

  /**
   * POST /wallet/withdraw — initiate a withdrawal.
   *
   * Validates sufficient available funds, creates a PENDING transaction.
   * Actual disbursement happens via the Payments module.
   */
  async initiateWithdrawal(params: {
    userId: string;
    amount: number;
    idempotencyKey?: string;
  }): Promise<{ transactionId: string; status: string }> {
    // Ensure wallet exists
    const walletId = await this.balanceService.ensureWallet(params.userId);
    const wallet = await this.repo.findWalletById(walletId);
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.isFrozen) {
      throw new BadRequestException(`Wallet is frozen: ${wallet.frozenReason ?? 'Contact support'}`);
    }

    if (params.amount <= 0) {
      throw new BadRequestException('Withdrawal amount must be positive');
    }

    const reserved = await this.repo.sumActiveReservations(wallet.id);
    const available = wallet.balance.sub(reserved);
    const amountDecimal = new Decimal(params.amount);

    if (available.lt(amountDecimal)) {
      throw new BadRequestException(
        `Insufficient funds. Available: MWK ${available.toNumber().toLocaleString()}`,
      );
    }

    // Idempotency check
    if (params.idempotencyKey) {
      const existing = await this.repo.findTransactionByIdempotencyKey(
        wallet.id,
        params.idempotencyKey,
      );
      if (existing) {
        return { transactionId: existing.id, status: existing.status };
      }
    }

    const tx = await this.repo.createTransaction({
      walletId: wallet.id,
      type: 'WITHDRAWAL',
      amount: amountDecimal,
      idempotencyKey: params.idempotencyKey,
      description: `Withdrawal of MWK ${params.amount.toLocaleString()}`,
    });

    this.logger.log(
      { userId: params.userId, amount: params.amount, txId: tx.id },
      'Withdrawal initiated',
    );

    return { transactionId: tx.id, status: 'PENDING' };
  }

  // ── Ledger Operations (double-entry) ────────────────────────

  /**
   * Process a completed deposit — creates ledger entries and updates wallet balance.
   *
   * Double-entry:
   *   DEBIT  PLATFORM_CASH    (money enters the platform)
   *   CREDIT USER_WALLET      (user's balance increases)
   */
  async processDeposit(transactionId: string): Promise<void> {
    const prisma = this.repo.prismaClient;

    await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { wallet: true },
      });

      if (transaction.status !== 'PENDING') {
        throw new BadRequestException('Transaction already processed');
      }

      const wallet = transaction.wallet;
      const newBalance = wallet.balance.add(transaction.amount);

      // Ledger entries (double-entry)
      await tx.ledgerEntry.create({
        data: {
          transactionId,
          walletId: wallet.id,
          accountType: 'USER_WALLET',
          direction: 'CREDIT',
          amount: transaction.amount,
          balanceAfter: newBalance,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId,
          accountType: 'PLATFORM_CASH',
          direction: 'DEBIT',
          amount: transaction.amount,
          balanceAfter: new Decimal(0), // Platform account — tracked separately
        },
      });

      // Update wallet balance (denormalized). Atomic increment: the DB adds
      // the deposit to the current balance — never a replacement — so the
      // credited amount can never overwrite the balance.
      await tx.wallet.update({
        where: { id: wallet.id, version: wallet.version },
        data: {
          balance: { increment: transaction.amount },
          version: { increment: 1 },
        },
      });

      // Mark transaction completed
      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);

    this.logger.log({ transactionId }, 'Deposit processed (ledger + wallet updated)');

    // Emit wallet updated event
    const tx = await this.repo.prismaClient.transaction.findUnique({
      where: { id: transactionId },
      include: { wallet: true },
    });
    if (tx) {
      this.eventEmitter.emit(WALLET_UPDATED_EVENT, {
        userId: tx.wallet.userId,
        type: 'DEPOSIT',
        amount: tx.amount.toNumber(),
        newBalance: tx.wallet.balance.toNumber(),
      });
    }
  }

  /**
   * Process a confirmed payment by txRef.
   *
   * Reads the transaction's `metadata.purpose` to decide what to do:
   *   - `BUY_SHARES` → credit wallet, then submit a buy order through the
   *     trading pipeline (the wallet now has funds to pass the balance check).
   *   - `DEPOSIT` (or no purpose) → credit wallet only.
   */
  async processPaymentByTxRef(txRef: string): Promise<void> {
    const prisma = this.repo.prismaClient;

    // Find the PENDING deposit whose idempotencyKey matches the txRef
    const transaction = await prisma.transaction.findFirst({
      where: { idempotencyKey: txRef, type: 'DEPOSIT', status: 'PENDING' },
      include: { wallet: true },
    });

    if (!transaction) {
      this.logger.warn({ txRef }, 'No PENDING deposit found for txRef — may already be processed');
      return;
    }

    // Always credit the wallet first (the payment has been confirmed by PayChangu)
    await this.processDeposit(transaction.id);

    // Check if this payment was for a stock purchase
    const meta = transaction.metadata as Record<string, any> | null;
    const purpose = meta?.purpose;

    if (purpose === 'BUY_SHARES') {
      const stockSymbol = meta?.stockSymbol as string | undefined;
      const quantity = meta?.quantity as number | undefined;
      const userId = transaction.wallet.userId;

      if (!stockSymbol || !quantity) {
        this.logger.error(
          { txRef, meta },
          'BUY_SHARES payment missing stockSymbol or quantity in metadata',
        );
        return;
      }

      if (!this.tradingService) {
        this.logger.error(
          { txRef },
          'TradingService not wired — cannot process BUY_SHARES. Deposit credited but trade not executed.',
        );
        return;
      }

      try {
        // Look up user KYC status for the trading pipeline
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { kycStatus: true },
        });

        this.logger.log(
          { txRef, userId, stockSymbol, quantity },
          'Processing BUY_SHARES — submitting buy order after deposit',
        );

        await this.tradingService.submitBuyOrder(
          userId,
          {
            stockSymbol,
            quantity,
            orderType: 'MARKET',
            idempotencyKey: `${txRef}-BUY`,
          },
          user?.kycStatus ?? 'APPROVED',
        );

        this.logger.log(
          { txRef, userId, stockSymbol, quantity },
          'BUY_SHARES order submitted successfully',
        );
      } catch (error) {
        // The deposit has already been processed — the user has the money.
        // Log the trade failure so it can be investigated / retried manually.
        this.logger.error(
          { err: error, txRef, userId, stockSymbol, quantity },
          'BUY_SHARES trade failed after deposit was credited. User wallet has been credited but shares were not purchased.',
        );
      }
    }
  }

  /**
   * @deprecated Use processPaymentByTxRef instead — it handles both DEPOSIT and BUY_SHARES.
   */
  async processDepositByTxRef(txRef: string): Promise<void> {
    return this.processPaymentByTxRef(txRef);
  }

  /**
   * Process a completed withdrawal — creates ledger entries and updates wallet balance.
   *
   * Double-entry:
   *   DEBIT  USER_WALLET      (user's balance decreases)
   *   CREDIT PLATFORM_CASH    (money leaves the platform)
   */
  async processWithdrawal(transactionId: string): Promise<void> {
    const prisma = this.repo.prismaClient;

    await prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { wallet: true },
      });

      if (transaction.status !== 'PENDING') {
        throw new BadRequestException('Transaction already processed');
      }

      const wallet = transaction.wallet;
      const newBalance = wallet.balance.sub(transaction.amount);

      if (newBalance.lt(0)) {
        throw new BadRequestException('Insufficient funds for withdrawal');
      }

      // Ledger entries (double-entry)
      await tx.ledgerEntry.create({
        data: {
          transactionId,
          walletId: wallet.id,
          accountType: 'USER_WALLET',
          direction: 'DEBIT',
          amount: transaction.amount,
          balanceAfter: newBalance,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId,
          accountType: 'PLATFORM_CASH',
          direction: 'CREDIT',
          amount: transaction.amount,
          balanceAfter: new Decimal(0),
        },
      });

      // Update wallet balance (denormalized). Atomic decrement mirrors the
      // deposit path; the negative-balance guard above ran inside the same
      // serializable transaction.
      await tx.wallet.update({
        where: { id: wallet.id, version: wallet.version },
        data: {
          balance: { decrement: transaction.amount },
          version: { increment: 1 },
        },
      });

      // Mark transaction completed
      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: 'COMPLETED', processedAt: new Date() },
      });
    }, FINANCIAL_TRANSACTION_OPTIONS);

    this.logger.log({ transactionId }, 'Withdrawal processed (ledger + wallet updated)');

    // Emit wallet updated — mirrors the deposit path so the notification
    // listener's WITHDRAWAL branch (previously unreachable) actually fires.
    const doneTx = await this.repo.prismaClient.transaction.findUnique({
      where: { id: transactionId },
      include: { wallet: true },
    });
    if (doneTx) {
      this.eventEmitter.emit(WALLET_UPDATED_EVENT, {
        userId: doneTx.wallet.userId,
        type: 'WITHDRAWAL',
        amount: doneTx.amount.toNumber(),
        newBalance: doneTx.wallet.balance.toNumber(),
      });
    }
  }

  // ── Event Handlers ──────────────────────────────────────────

  @OnEvent(DEPOSIT_COMPLETED_EVENT)
  async onDepositCompleted(event: { transactionId: string }) {
    await this.processDeposit(event.transactionId);
  }

  @OnEvent(WITHDRAWAL_COMPLETED_EVENT)
  async onWithdrawalCompleted(event: { transactionId: string }) {
    await this.processWithdrawal(event.transactionId);
  }

  // ── Daily Snapshot Cron ─────────────────────────────────────

  @Cron('0 13 * * 1-5', { name: 'wallet-daily-snapshot' })
  async dailySnapshot(): Promise<void> {
    this.logger.log('Running daily wallet snapshot job');

    try {
      const wallets = await this.repo.prismaClient.wallet.findMany({
        select: { id: true },
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const w of wallets) {
        const wallet = await this.repo.findWalletById(w.id);
        if (!wallet) continue;

        const reserved = await this.repo.sumActiveReservations(wallet.id);
        const available = wallet.balance.sub(reserved);

        await this.repo.upsertSnapshot({
          walletId: wallet.id,
          snapshotDate: today,
          balance: wallet.balance,
          reservedAmount: reserved,
          availableAmount: available.lt(0) ? new Decimal(0) : available,
        });
      }

      this.logger.log(
        { walletCount: wallets.length },
        'Daily wallet snapshots completed',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Daily wallet snapshot job failed');
    }
  }
}
