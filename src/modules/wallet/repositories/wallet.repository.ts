import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, FINANCIAL_TRANSACTION_OPTIONS } from '../../../infrastructure/database/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Wallet Repository — all Prisma queries for the wallet module.
 *
 * The Wallet is a VIEW of the customer's cash position.
 * The Ledger is the source of truth.
 */
@Injectable()
export class WalletRepository {
  private readonly logger = new Logger(WalletRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Wallet ──────────────────────────────────────────────────

  async findWalletByUserId(userId: string) {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async findWalletById(walletId: string) {
    return this.prisma.wallet.findUnique({ where: { id: walletId } });
  }

  async createWallet(userId: string, currency = 'MWK') {
    return this.prisma.wallet.create({
      data: { userId, currency, balance: 0 },
    });
  }

  async updateWalletBalance(walletId: string, newBalance: Decimal, currentVersion: number) {
    return this.prisma.wallet.update({
      where: { id: walletId, version: currentVersion },
      data: { balance: newBalance, version: { increment: 1 } },
    });
  }

  async freezeWallet(walletId: string, reason: string) {
    return this.prisma.wallet.update({
      where: { id: walletId },
      data: { isFrozen: true, frozenReason: reason },
    });
  }

  async unfreezeWallet(walletId: string) {
    return this.prisma.wallet.update({
      where: { id: walletId },
      data: { isFrozen: false, frozenReason: null },
    });
  }

  // ── Transactions ────────────────────────────────────────────

  async createTransaction(data: {
    walletId: string;
    type: string;
    amount: Decimal;
    currency?: string;
    idempotencyKey?: string;
    relatedOrderId?: string;
    relatedPaymentId?: string;
    description?: string;
    metadata?: Record<string, any>;
  }) {
    return this.prisma.transaction.create({
      data: {
        walletId: data.walletId,
        type: data.type as any,
        amount: data.amount,
        currency: data.currency ?? 'MWK',
        idempotencyKey: data.idempotencyKey,
        relatedOrderId: data.relatedOrderId,
        relatedPaymentId: data.relatedPaymentId,
        description: data.description,
        metadata: data.metadata ?? undefined,
        status: 'PENDING',
      },
    });
  }

  async updateTransactionStatus(
    txId: string,
    status: string,
    extra: Record<string, any> = {},
  ) {
    return this.prisma.transaction.update({
      where: { id: txId },
      data: { status: status as any, ...extra },
    });
  }

  async findTransactionByIdempotencyKey(walletId: string, key: string) {
    return this.prisma.transaction.findUnique({
      where: { walletId_idempotencyKey: { walletId, idempotencyKey: key } },
    });
  }

  async findUserTransactions(walletId: string, limit = 30, offset = 0) {
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: { walletId, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.transaction.count({
        where: { walletId, status: 'COMPLETED' },
      }),
    ]);
    return { transactions, total };
  }

  // ── Ledger Entries ──────────────────────────────────────────

  async createLedgerEntry(data: {
    transactionId: string;
    walletId?: string;
    accountType: string;
    direction: string;
    amount: Decimal;
    balanceAfter: Decimal;
    currency?: string;
  }) {
    return this.prisma.ledgerEntry.create({
      data: {
        transactionId: data.transactionId,
        walletId: data.walletId,
        accountType: data.accountType as any,
        direction: data.direction as any,
        amount: data.amount,
        balanceAfter: data.balanceAfter,
        currency: data.currency ?? 'MWK',
      },
    });
  }

  async findLedgerEntriesForWallet(walletId: string, limit = 50, offset = 0) {
    return this.prisma.ledgerEntry.findMany({
      where: { walletId },
      include: { transaction: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Sum PENDING and PROCESSING deposit and withdrawal transactions for a wallet.
   * Used by BalanceService to populate the pendingDeposits / pendingWithdrawals
   * fields in the wallet summary (previously these were always zero because
   * findUserTransactions only returns COMPLETED transactions).
   */
  async sumPendingTransactions(walletId: string): Promise<{ deposits: Decimal; withdrawals: Decimal }> {
    const pendingStatuses = ['PENDING', 'PROCESSING'];
    const [depositsAgg, withdrawalsAgg] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: { walletId, type: 'DEPOSIT', status: { in: pendingStatuses } },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { walletId, type: 'WITHDRAWAL', status: { in: pendingStatuses } },
        _sum: { amount: true },
      }),
    ]);
    return {
      deposits: depositsAgg._sum.amount ?? new Decimal(0),
      withdrawals: withdrawalsAgg._sum.amount ?? new Decimal(0),
    };
  }

  async sumLedgerBalance(walletId: string): Promise<Decimal> {
    const credits = await this.prisma.ledgerEntry.aggregate({
      where: { walletId, accountType: 'USER_WALLET', direction: 'CREDIT' },
      _sum: { amount: true },
    });
    const debits = await this.prisma.ledgerEntry.aggregate({
      where: { walletId, accountType: 'USER_WALLET', direction: 'DEBIT' },
      _sum: { amount: true },
    });
    const totalCredits = credits._sum.amount ?? new Decimal(0);
    const totalDebits = debits._sum.amount ?? new Decimal(0);
    return totalCredits.sub(totalDebits);
  }

  // ── Reservations ────────────────────────────────────────────

  async createReservation(data: {
    walletId: string;
    orderId?: string;
    amount: Decimal;
    reason?: string;
    expiresAt?: Date;
  }) {
    return this.prisma.walletReservation.create({
      data: {
        walletId: data.walletId,
        orderId: data.orderId,
        amount: data.amount,
        reason: data.reason,
        expiresAt: data.expiresAt,
        status: 'ACTIVE',
      },
    });
  }

  async findActiveReservations(walletId: string) {
    return this.prisma.walletReservation.findMany({
      where: { walletId, status: 'ACTIVE' },
    });
  }

  async findReservationByOrderId(orderId: string) {
    return this.prisma.walletReservation.findFirst({
      where: { orderId, status: 'ACTIVE' },
    });
  }

  async sumActiveReservations(walletId: string): Promise<Decimal> {
    const result = await this.prisma.walletReservation.aggregate({
      where: { walletId, status: 'ACTIVE' },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Decimal(0);
  }

  async consumeReservation(reservationId: string) {
    return this.prisma.walletReservation.update({
      where: { id: reservationId },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
  }

  async releaseReservation(reservationId: string) {
    return this.prisma.walletReservation.update({
      where: { id: reservationId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
  }

  async expireReservations() {
    return this.prisma.walletReservation.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED', releasedAt: new Date() },
    });
  }

  // ── Snapshots ───────────────────────────────────────────────

  async upsertSnapshot(data: {
    walletId: string;
    snapshotDate: Date;
    balance: Decimal;
    reservedAmount: Decimal;
    availableAmount: Decimal;
  }) {
    return this.prisma.walletSnapshot.upsert({
      where: {
        walletId_snapshotDate: {
          walletId: data.walletId,
          snapshotDate: data.snapshotDate,
        },
      },
      update: {
        balance: data.balance,
        reservedAmount: data.reservedAmount,
        availableAmount: data.availableAmount,
      },
      create: data,
    });
  }

  async findSnapshots(walletId: string, limit = 90) {
    return this.prisma.walletSnapshot.findMany({
      where: { walletId },
      orderBy: { snapshotDate: 'desc' },
      take: limit,
    });
  }

  // ── Prisma instance (for transactions) ──────────────────────

  get prismaClient() {
    return this.prisma;
  }

  get financialTxOptions() {
    return FINANCIAL_TRANSACTION_OPTIONS;
  }
}
