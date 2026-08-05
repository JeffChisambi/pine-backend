import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Trading Repository — all Prisma queries for the trading pipeline.
 *
 * Every other service in the trading module reads/writes through this
 * repository, never touching Prisma directly. This keeps the data
 * access layer testable and swappable.
 */
@Injectable()
export class TradingRepository {
  private readonly logger = new Logger(TradingRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the user's CURRENT KYC status straight from the database.
   * The JWT carries a `kyc` claim, but it is a snapshot from login time —
   * a user approved mid-session would still hold a stale "not approved"
   * token, so trade gating must read the live value here.
   */
  async getCurrentKycStatus(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true },
    });
    return user?.kycStatus ?? null;
  }

  // ── Orders ──────────────────────────────────────────────────

  async createOrder(data: {
    userId: string;
    stockId: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    quantity: Decimal;
    limitPrice?: Decimal;
    idempotencyKey?: string;
    expiresAt?: Date;
  }) {
    return this.prisma.order.create({
      data: {
        userId: data.userId,
        stockId: data.stockId,
        side: data.side,
        type: data.type,
        status: 'DRAFT',
        quantity: data.quantity,
        limitPrice: data.limitPrice,
        idempotencyKey: data.idempotencyKey,
        expiresAt: data.expiresAt,
      },
      include: { stock: true },
    });
  }

  async findOrderById(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        stock: true,
        trades: true,
        executions: { orderBy: { executedAt: 'desc' } },
      },
    });
  }

  async findOrderByIdempotencyKey(userId: string, key: string) {
    return this.prisma.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
  }

  async updateOrderStatus(
    orderId: string,
    status: string,
    extra: Record<string, any> = {},
  ) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: status as any, ...extra },
      include: { stock: true },
    });
  }

  async findUserOrders(
    userId: string,
    filters: {
      status?: string;
      side?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const where: any = { userId };
    if (filters.status) where.status = filters.status;
    if (filters.side) where.side = filters.side;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: { stock: true, trades: true },
        orderBy: { createdAt: 'desc' },
        take: filters.limit ?? 20,
        skip: filters.offset ?? 0,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { orders, total };
  }

  /**
   * Find orders submitted to broker that are pending acceptance.
   * Used by the broker dashboard API.
   */
  async findPendingBrokerOrders(limit = 50) {
    return this.prisma.order.findMany({
      where: { status: 'SUBMITTED' },
      include: { stock: true, user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { submittedAt: 'asc' },
      take: limit,
    });
  }

  // ── Trades & Executions ─────────────────────────────────────

  async createTrade(data: {
    orderId: string;
    quantity: Decimal;
    price: Decimal;
    fee: Decimal;
  }) {
    return this.prisma.trade.create({
      data: {
        orderId: data.orderId,
        quantity: data.quantity,
        price: data.price,
        fee: data.fee,
      },
    });
  }

  async createOrderExecution(data: {
    orderId: string;
    quantity: Decimal;
    price: Decimal;
    fee: Decimal;
    brokerRef?: string;
  }) {
    return this.prisma.orderExecution.create({
      data: {
        orderId: data.orderId,
        quantity: data.quantity,
        price: data.price,
        fee: data.fee,
        brokerRef: data.brokerRef,
      },
    });
  }

  async findUserTrades(
    userId: string,
    limit = 20,
    offset = 0,
  ) {
    return this.prisma.trade.findMany({
      where: { order: { userId } },
      include: {
        order: { include: { stock: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  // ── Holdings ────────────────────────────────────────────────

  async upsertHolding(
    userId: string,
    stockId: string,
    quantityDelta: Decimal,
    newAverageCost: Decimal,
  ) {
    const existing = await this.prisma.holding.findUnique({
      where: { userId_stockId: { userId, stockId } },
    });

    if (existing) {
      const newQuantity = existing.quantity.add(quantityDelta);
      return this.prisma.holding.update({
        where: { id: existing.id },
        data: {
          quantity: newQuantity.lt(new Decimal(0)) ? new Decimal(0) : newQuantity,
          averageCost: newAverageCost,
        },
      });
    }

    return this.prisma.holding.create({
      data: {
        userId,
        stockId,
        quantity: quantityDelta,
        averageCost: newAverageCost,
      },
    });
  }

  async findUserHoldings(userId: string) {
    return this.prisma.holding.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: {
        stock: {
          include: {
            prices: { orderBy: { tradedAt: 'desc' }, take: 1 },
          },
        },
      },
    });
  }

  async findUserHolding(userId: string, stockId: string) {
    return this.prisma.holding.findUnique({
      where: { userId_stockId: { userId, stockId } },
    });
  }

  // ── Settlement ──────────────────────────────────────────────

  async createSettlementRecord(data: {
    tradeId: string;
    settlementDate: Date;
  }) {
    return this.prisma.settlementRecord.create({
      data: {
        tradeId: data.tradeId,
        settlementDate: data.settlementDate,
        status: 'PENDING',
      },
    });
  }

  async settleRecord(settlementId: string) {
    return this.prisma.settlementRecord.update({
      where: { id: settlementId },
      data: { status: 'SETTLED', settledAt: new Date() },
    });
  }

  // ── Ledger ──────────────────────────────────────────────────

  async findWalletByUserId(userId: string) {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async createTransactionWithLedger(
    tx: any, // Prisma transaction client
    data: {
      walletId: string;
      type: string;
      amount: Decimal;
      relatedOrderId: string;
      description: string;
      entries: Array<{
        walletId?: string;
        accountType: string;
        direction: string;
        amount: Decimal;
        balanceAfter: Decimal;
      }>;
    },
  ) {
    const transaction = await tx.transaction.create({
      data: {
        walletId: data.walletId,
        type: data.type,
        status: 'COMPLETED',
        amount: data.amount,
        relatedOrderId: data.relatedOrderId,
        description: data.description,
        processedAt: new Date(),
      },
    });

    for (const entry of data.entries) {
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          walletId: entry.walletId ?? null,
          accountType: entry.accountType as any,
          direction: entry.direction as any,
          amount: entry.amount,
          currency: 'MWK',
          balanceAfter: entry.balanceAfter,
        },
      });
    }

    return transaction;
  }

  // ── Trade Audit ─────────────────────────────────────────────

  async createTradeAudit(data: {
    orderId: string;
    userId: string;
    action: string;
    fromStatus?: string;
    toStatus?: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  }) {
    return this.prisma.tradeAudit.create({
      data: {
        orderId: data.orderId,
        userId: data.userId,
        action: data.action,
        fromStatus: data.fromStatus,
        toStatus: data.toStatus,
        metadata: data.metadata as any,
        ipAddress: data.ipAddress,
      },
    });
  }

  // ── Market Data ─────────────────────────────────────────────

  async findStockBySymbol(symbol: string) {
    return this.prisma.stock.findUnique({
      where: { symbol: symbol.toUpperCase() },
      include: {
        prices: { orderBy: { tradedAt: 'desc' }, take: 1 },
      },
    });
  }

  async findStockById(stockId: string) {
    return this.prisma.stock.findUnique({
      where: { id: stockId },
      include: {
        prices: { orderBy: { tradedAt: 'desc' }, take: 1 },
      },
    });
  }

  async findMarketCalendarToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.prisma.marketCalendar.findUnique({
      where: { date: today },
    });
  }

  /** Get PrismaService for raw transactions */
  get db() {
    return this.prisma;
  }
}
