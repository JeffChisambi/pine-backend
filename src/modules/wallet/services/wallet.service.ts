import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { WalletRepository } from '../repositories/wallet.repository';
import { WalletCalculator } from './wallet-calculator.service';
import { BalanceService } from './balance.service';
import { ReservationService } from './reservation.service';
import { StatementService } from './statement.service';
import { FeePolicyService } from '../../brokers/services/fee-policy.service';
import { RiskPolicyService } from '../../brokers/services/risk-policy.service';
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
    private readonly feePolicy: FeePolicyService,
    private readonly riskPolicy: RiskPolicyService,
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
   * GET /wallet/deposit/preview — fee breakdown before paying.
   * Uses the same FeePolicyService the deposit itself will use.
   */
  async previewDeposit(userId: string, amount: number, method: string | null = 'CARD') {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Deposit amount must be positive');
    }
    const policy = await this.feePolicy.forUser(userId);
    const breakdown = this.feePolicy.depositBreakdown(policy, new Decimal(amount));
    // Broker deposit limits — the same engine that will enforce them at
    // submission, so the preview always matches the decision.
    const risk = await this.riskPolicy.checkDeposit(userId, new Decimal(amount), method);
    return {
      grossAmount: breakdown.grossAmount.toNumber(),
      processingFee: breakdown.processingFee.toNumber(),
      netAmount: breakdown.netAmount.toNumber(),
      feeDescription: breakdown.description ?? null,
      limits: {
        allowed: risk.allowed,
        reason: risk.reason,
        maxAllowedNow: risk.limits.maxAllowedNow,
        perTransactionMax: risk.limits.perTransactionMax,
        dailyLimit: risk.limits.dailyLimit,
        dailyUsed: risk.limits.dailyUsed,
        dailyRemaining: risk.limits.dailyRemaining,
        monthlyLimit: risk.limits.monthlyLimit,
        monthlyUsed: risk.limits.monthlyUsed,
        monthlyRemaining: risk.limits.monthlyRemaining,
      },
    };
  }

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
    /** Payment method for risk-rule matching (e.g. 'CARD'). */
    method?: string;
  }): Promise<{ transactionId: string; status: string }> {
    // A valid broker relationship is REQUIRED before any deposit: funds
    // always land in the investor's selected broker's account, so a
    // deposit without a broker has no destination. The broker is read
    // from the authenticated user's persisted relationship — never from
    // the request.
    const depositor = await this.repo.prismaClient.user.findUnique({
      where: { id: params.userId },
      select: { role: true, brokerId: true, broker: { select: { isActive: true } } },
    });
    if (depositor?.role === 'CUSTOMER') {
      if (!depositor.brokerId) {
        throw new BadRequestException(
          'Select a broker in your profile before making a deposit. (BROKER_REQUIRED)',
        );
      }
      if (depositor.broker && !depositor.broker.isActive) {
        throw new BadRequestException('Your broker is currently unavailable. Contact support.');
      }
    }

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

    // Broker risk constraints — per-transaction/daily/monthly/velocity
    // deposit limits (RiskPolicyService). The system-wide wallet daily
    // limit is evaluated inside the same check; where bounds overlap the
    // MOST RESTRICTIVE one wins. Server-side — the client is never trusted.
    const riskCheck = await this.riskPolicy.checkDeposit(
      params.userId,
      new Decimal(params.amount),
      params.method ?? null,
    );
    if (!riskCheck.allowed) {
      throw new BadRequestException(riskCheck.reason ?? 'Deposit exceeds your broker\'s limits.');
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

    // Deposit processing fee — the broker's configured schedule (Fees &
    // Charges). The payer is charged GROSS; the wallet is credited NET; the
    // fee is a PAYMENT COST recorded on the transaction for reconciliation.
    // Transaction.amount = NET (what moves into the wallet), the breakdown
    // lives in metadata + ledger legs.
    const policy = await this.feePolicy.forUser(params.userId);
    const breakdown = this.feePolicy.depositBreakdown(policy, new Decimal(params.amount));

    const tx = await this.repo.createTransaction({
      walletId: wallet.id,
      type: 'DEPOSIT',
      amount: breakdown.netAmount,
      idempotencyKey: params.idempotencyKey,
      description:
        breakdown.processingFee.gt(0)
          ? `Deposit of MWK ${breakdown.grossAmount.toNumber().toLocaleString()} ` +
            `(processing fee MWK ${breakdown.processingFee.toNumber().toLocaleString()})`
          : `Deposit of MWK ${params.amount.toLocaleString()}`,
      metadata: {
        ...(params.metadata ?? {}),
        grossAmount: breakdown.grossAmount.toString(),
        processingFee: breakdown.processingFee.toString(),
        netAmount: breakdown.netAmount.toString(),
        ...(breakdown.description ? { feeDescription: breakdown.description } : {}),
      },
    });

    this.logger.log(
      {
        userId: params.userId,
        gross: breakdown.grossAmount.toString(),
        fee: breakdown.processingFee.toString(),
        net: breakdown.netAmount.toString(),
        txId: tx.id,
      },
      'Deposit initiated',
    );

    return { transactionId: tx.id, status: 'PENDING' };
  }

  /**
   * Current state of a deposit by its gateway txRef — DB is the source of
   * truth for payment status polls (never the gateway's in-memory state).
   */
  async getDepositStatusByTxRef(userId: string, txRef: string) {
    const walletId = await this.balanceService.ensureWallet(userId);
    const tx = await this.repo.findTransactionByIdempotencyKey(walletId, txRef);
    if (!tx) throw new NotFoundException('Payment not found');
    return {
      status: tx.status,
      amount: Number(tx.amount),
      currency: 'MWK',
      updatedAt: (tx.processedAt ?? tx.createdAt).toISOString(),
    };
  }

  /**
   * Mark a PENDING deposit as FAILED (card declined, gateway error…).
   * Idempotent: only PENDING rows transition; a completed deposit is never
   * touched, so a late failure signal can not claw back credited funds.
   */
  async markDepositFailed(txRef: string, reason: string): Promise<void> {
    const result = await this.repo.prismaClient.transaction.updateMany({
      where: { idempotencyKey: txRef, type: 'DEPOSIT', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
    if (result.count > 0) {
      this.logger.warn({ txRef, reason }, 'Deposit marked FAILED');
    }
  }

  /**
   * Attach non-sensitive facts to a PENDING deposit — e.g. the gateway
   * payment session id. Deliberately cannot change the amount: the figure
   * charged is fixed when the deposit is created, so a client can never
   * influence it between session creation and capture.
   */
  async attachDepositMetadata(
    txRef: string,
    patch: Record<string, string | number | boolean>,
  ): Promise<void> {
    const tx = await this.repo.prismaClient.transaction.findFirst({
      where: { idempotencyKey: txRef, type: 'DEPOSIT', status: 'PENDING' },
      select: { id: true, metadata: true },
    });
    if (!tx) return;

    await this.repo.prismaClient.transaction.update({
      where: { id: tx.id },
      data: {
        metadata: {
          ...((tx.metadata as Record<string, any>) ?? {}),
          ...patch,
        },
      },
    });
  }

  /**
   * Read a deposit belonging to THIS user by its txRef. Used to complete a
   * hosted-session payment: the amount and session id come from here, never
   * from the request body.
   */
  async getDepositForUser(userId: string, txRef: string) {
    return this.repo.prismaClient.transaction.findFirst({
      where: {
        idempotencyKey: txRef,
        type: 'DEPOSIT',
        wallet: { userId },
      },
      select: { id: true, status: true, amount: true, metadata: true },
    });
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

    // AVAILABLE = balance − active order reservations − withdrawals already
    // in flight. Without the last term, two overlapping withdrawal requests
    // could each pass this check against the same balance.
    const [reserved, pendingWithdrawals] = await Promise.all([
      this.repo.sumActiveReservations(wallet.id),
      this.repo.prismaClient.transaction.aggregate({
        where: {
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'PROCESSING'] },
        },
        _sum: { amount: true },
      }),
    ]);
    const available = wallet.balance
      .sub(reserved)
      .sub(pendingWithdrawals._sum.amount ?? new Decimal(0));
    const amountDecimal = new Decimal(params.amount);

    if (available.lt(amountDecimal)) {
      throw new BadRequestException(
        `Insufficient available funds. Available: MWK ${available.toNumber().toLocaleString()} ` +
        `(funds reserved for pending orders and withdrawals are excluded).`,
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

  /**
   * Broker approval of a pending withdrawal — settles it through the
   * double-entry ledger (processWithdrawal). This is the ONLY path that
   * completes a withdrawal; nothing auto-settles.
   */
  async settleWithdrawal(transactionId: string): Promise<void> {
    await this.processWithdrawal(transactionId);
  }

  /**
   * Broker rejection of a pending withdrawal — the transaction is marked
   * FAILED, no money moves (the wallet was never debited; the pending
   * transaction only reduced AVAILABLE), and the investor is notified.
   */
  async rejectWithdrawal(transactionId: string, reason: string): Promise<void> {
    const prisma = this.repo.prismaClient;
    const transaction = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { wallet: true },
    });
    if (!transaction || transaction.type !== 'WITHDRAWAL') {
      throw new NotFoundException('Withdrawal not found');
    }
    if (transaction.status !== 'PENDING') {
      throw new BadRequestException('Withdrawal already processed');
    }

    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        status: 'FAILED',
        processedAt: new Date(),
        metadata: {
          ...((transaction.metadata as Record<string, any>) ?? {}),
          rejectionReason: reason,
        },
      },
    });

    this.logger.warn({ transactionId, reason }, 'Withdrawal rejected');

    this.eventEmitter.emit('wallet.withdrawal.rejected', {
      userId: transaction.wallet.userId,
      amount: transaction.amount.toNumber(),
      reason,
    });
  }

  // ── Ledger Operations (double-entry) ────────────────────────

  /**
   * Process a completed deposit — creates ledger entries and updates wallet balance.
   *
   * Double-entry (Transaction.amount is the NET wallet credit; the payer was
   * charged GROSS = net + processing fee, recorded in metadata):
   *   DEBIT  PLATFORM_CASH        gross  (money enters the platform)
   *   CREDIT USER_WALLET          net    (user's balance increases)
   *   CREDIT PLATFORM_FEE_REVENUE fee    (deposit processing fee, if any)
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

      // Processing fee from the breakdown stamped at initiation. Older
      // transactions (pre fee-schedule) have no metadata fee → zero.
      const meta = (transaction.metadata ?? {}) as Record<string, any>;
      const processingFee = new Decimal(meta.processingFee ?? 0);
      const grossAmount = transaction.amount.add(processingFee);

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
          amount: grossAmount,
          balanceAfter: new Decimal(0), // Platform account — tracked separately
        },
      });

      if (processingFee.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            transactionId,
            accountType: 'PLATFORM_FEE_REVENUE',
            direction: 'CREDIT',
            amount: processingFee,
            balanceAfter: new Decimal(0), // Platform account — tracked separately
          },
        });
      }

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
