import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Portfolio Repository — all Prisma queries for the portfolio read-model.
 *
 * Portfolio is a materialized projection. This repository reads from
 * holdings, snapshots, performance, allocations, and market data.
 */
@Injectable()
export class PortfolioRepository {
  private readonly logger = new Logger(PortfolioRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Holdings ────────────────────────────────────────────────

  async findUserHoldings(userId: string) {
    return this.prisma.holding.findMany({
      where: { userId, quantity: { gt: 0 } },
      include: {
        stock: {
          include: {
            prices: { orderBy: { tradedAt: 'desc' }, take: 2 },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findUserHolding(userId: string, stockId: string) {
    return this.prisma.holding.findUnique({
      where: { userId_stockId: { userId, stockId } },
      include: {
        stock: {
          include: {
            prices: { orderBy: { tradedAt: 'desc' }, take: 30 },
          },
        },
      },
    });
  }

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
        include: { stock: true },
      });
    }

    return this.prisma.holding.create({
      data: {
        userId,
        stockId,
        quantity: quantityDelta,
        averageCost: newAverageCost,
      },
      include: { stock: true },
    });
  }

  // ── Wallet ──────────────────────────────────────────────────

  async findWalletByUserId(userId: string) {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  /**
   * Available cash = wallet balance − active reservations − pending
   * withdrawals. This is the cash component of the portfolio valuation:
   * money already committed to open orders or outbound transfers is not
   * part of the investor's spendable wealth.
   */
  async getAvailableCash(userId: string): Promise<{ total: Decimal; available: Decimal }> {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) return { total: new Decimal(0), available: new Decimal(0) };

    const [reservedAgg, pendingWithdrawalAgg] = await Promise.all([
      this.prisma.walletReservation.aggregate({
        where: { walletId: wallet.id, status: 'ACTIVE' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          walletId: wallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'PROCESSING'] },
        },
        _sum: { amount: true },
      }),
    ]);

    const reserved = reservedAgg._sum.amount ?? new Decimal(0);
    const pendingOut = pendingWithdrawalAgg._sum.amount ?? new Decimal(0);
    const available = Decimal.max(wallet.balance.sub(reserved).sub(pendingOut), new Decimal(0));
    return { total: wallet.balance, available };
  }

  // ── Snapshots ───────────────────────────────────────────────

  async upsertSnapshot(data: {
    userId: string;
    snapshotDate: Date;
    totalValue: Decimal;
    totalCost: Decimal;
    unrealizedPnl: Decimal;
  }) {
    return this.prisma.portfolioSnapshot.upsert({
      where: {
        userId_snapshotDate: {
          userId: data.userId,
          snapshotDate: data.snapshotDate,
        },
      },
      update: {
        totalValue: data.totalValue,
        totalCost: data.totalCost,
        unrealizedPnl: data.unrealizedPnl,
      },
      create: {
        userId: data.userId,
        snapshotDate: data.snapshotDate,
        totalValue: data.totalValue,
        totalCost: data.totalCost,
        unrealizedPnl: data.unrealizedPnl,
      },
    });
  }

  async findSnapshots(userId: string, limit = 90) {
    return this.prisma.portfolioSnapshot.findMany({
      where: { userId },
      orderBy: { snapshotDate: 'desc' },
      take: limit,
    });
  }

  async findSnapshotByDate(userId: string, date: Date) {
    return this.prisma.portfolioSnapshot.findUnique({
      where: { userId_snapshotDate: { userId, snapshotDate: date } },
    });
  }

  // ── Performance ─────────────────────────────────────────────

  async upsertPerformance(data: {
    userId: string;
    date: Date;
    dailyReturn: Decimal;
    dailyReturnPct: Decimal;
    weeklyReturn: Decimal;
    weeklyReturnPct: Decimal;
    monthlyReturn: Decimal;
    monthlyReturnPct: Decimal;
    yearlyReturn: Decimal;
    yearlyReturnPct: Decimal;
    lifetimeReturn: Decimal;
    lifetimeReturnPct: Decimal;
  }) {
    return this.prisma.portfolioPerformance.upsert({
      where: { userId_date: { userId: data.userId, date: data.date } },
      update: {
        dailyReturn: data.dailyReturn,
        dailyReturnPct: data.dailyReturnPct,
        weeklyReturn: data.weeklyReturn,
        weeklyReturnPct: data.weeklyReturnPct,
        monthlyReturn: data.monthlyReturn,
        monthlyReturnPct: data.monthlyReturnPct,
        yearlyReturn: data.yearlyReturn,
        yearlyReturnPct: data.yearlyReturnPct,
        lifetimeReturn: data.lifetimeReturn,
        lifetimeReturnPct: data.lifetimeReturnPct,
      },
      create: data,
    });
  }

  async findLatestPerformance(userId: string) {
    return this.prisma.portfolioPerformance.findFirst({
      where: { userId },
      orderBy: { date: 'desc' },
    });
  }

  async findPerformanceHistory(userId: string, limit = 30) {
    return this.prisma.portfolioPerformance.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: limit,
    });
  }

  // ── Allocations ─────────────────────────────────────────────

  async saveAllocations(userId: string, date: Date, allocations: Array<{
    assetType: string;
    sector?: string;
    symbol?: string;
    value: Decimal;
    percentage: Decimal;
  }>) {
    // Delete old allocations for this date, then create new
    await this.prisma.portfolioAllocation.deleteMany({
      where: { userId, date },
    });

    if (allocations.length > 0) {
      await this.prisma.portfolioAllocation.createMany({
        data: allocations.map((a) => ({
          userId,
          date,
          assetType: a.assetType,
          sector: a.sector,
          symbol: a.symbol,
          value: a.value,
          percentage: a.percentage,
        })),
      });
    }
  }

  async findLatestAllocations(userId: string) {
    // Find the most recent date
    const latest = await this.prisma.portfolioAllocation.findFirst({
      where: { userId },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    if (!latest) return [];

    return this.prisma.portfolioAllocation.findMany({
      where: { userId, date: latest.date },
      orderBy: { percentage: 'desc' },
    });
  }

  // ── Trade History (for performance calculation) ─────────────

  async findUserTrades(userId: string) {
    return this.prisma.trade.findMany({
      where: { order: { userId } },
      include: { order: { include: { stock: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Stock lookup ────────────────────────────────────────────

  async findStockById(stockId: string) {
    return this.prisma.stock.findUnique({
      where: { id: stockId },
      include: {
        prices: { orderBy: { tradedAt: 'desc' }, take: 2 },
      },
    });
  }

  // ── Dividends ───────────────────────────────────────────────

  /**
   * Total dividends the user has received (credited or reinvested), plus the
   * most recent dividend transactions for display.
   */
  async getDividendsSummary(userId: string, recentLimit = 10) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!wallet) return { totalDividends: 0, count: 0, recent: [] };

    const where = {
      walletId: wallet.id,
      type: { in: ['DIVIDEND_CREDIT', 'DIVIDEND_REINVESTMENT'] as any },
      status: 'COMPLETED' as any,
    };

    const [agg, recent] = await Promise.all([
      this.prisma.transaction.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: recentLimit,
        select: {
          id: true,
          type: true,
          amount: true,
          description: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      totalDividends: agg._sum.amount?.toNumber() ?? 0,
      count: agg._count,
      recent: recent.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount.toNumber(),
        description: t.description,
        createdAt: t.createdAt,
      })),
    };
  }
}
