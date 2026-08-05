import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { Prisma } from '@prisma/client';

@Injectable()
export class AdminRepository {
  private readonly logger = new Logger(AdminRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Dashboard ────────────────────────────────────────────────

  async getDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      activeUsers,
      pendingKyc,
      todayOrders,
      todayVolume,
      pendingPayments,
      activeSessions,
      totalWalletBalance,
      todayNewUsers,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.kycApplication.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { createdAt: { gte: today } } }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: today }, status: { in: ['FILLED', 'COMPLETED'] } },
        _sum: { totalCost: true },
      }),
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
      this.prisma.session.count({
        where: { isRevoked: false, expiresAt: { gt: new Date() } },
      }),
      this.prisma.wallet.aggregate({ _sum: { balance: true } }),
      this.prisma.user.count({ where: { createdAt: { gte: today } } }),
    ]);

    return {
      totalUsers,
      activeUsers,
      pendingKyc,
      todayOrders,
      todayVolume: todayVolume._sum.totalCost?.toString() ?? '0',
      pendingPayments,
      activeSessions,
      totalWalletBalance: totalWalletBalance._sum.balance?.toString() ?? '0',
      todayNewUsers,
    };
  }

  async getChartData(days = 14) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const dailyMetrics = await this.prisma.dailyMetric.findMany({
      where: { date: { gte: since } },
      orderBy: { date: 'asc' },
    });

    return dailyMetrics.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      trades: m.totalTrades,
      volume: m.totalTradeVolume.toString(),
      deposits: m.totalDeposits.toString(),
      withdrawals: m.totalWithdrawals.toString(),
      revenue: m.platformRevenue.toString(),
      newUsers: m.newRegistrations,
      activeUsers: m.dailyActiveUsers,
    }));
  }

  // ── Users ────────────────────────────────────────────────────

  async listUsers(filters: {
    search?: string;
    status?: string;
    kycStatus?: string;
    role?: string;
    page?: number;
    limit?: number;
  }) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.UserWhereInput = {};

    if (filters.search) {
      where.OR = [
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { phone: { contains: filters.search } },
      ];
    }

    if (filters.status === 'active') where.isActive = true;
    if (filters.status === 'frozen') {
      where.wallet = { isFrozen: true };
    }
    if (filters.status === 'deactivated') where.isActive = false;

    if (filters.kycStatus) {
      where.kycStatus = filters.kycStatus as Prisma.EnumKycStatusFilter;
    }

    if (filters.role) {
      where.role = filters.role as Prisma.EnumRoleFilter;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          kycStatus: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          wallet: {
            select: { balance: true, isFrozen: true },
          },
          _count: {
            select: {
              devices: true,
              orders: true,
              holdings: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((u) => ({
        id: u.id,
        phone: u.phone,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        kycStatus: u.kycStatus,
        isActive: u.isActive,
        walletBalance: u.wallet?.balance?.toString() ?? '0',
        walletFrozen: u.wallet?.isFrozen ?? false,
        deviceCount: u._count.devices,
        orderCount: u._count.orders,
        holdingCount: u._count.holdings,
        createdAt: u.createdAt.toISOString(),
        updatedAt: u.updatedAt.toISOString(),
      })),
      total,
      page: filters.page ?? 1,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserWorkspace(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 10,
            },
            reservations: {
              where: { status: 'ACTIVE' },
            },
          },
        },
        kycApplications: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { documents: true },
        },
        devices: {
          orderBy: { lastSeenAt: 'desc' },
        },
        sessions: {
          where: { isRevoked: false, expiresAt: { gt: new Date() } },
          orderBy: { lastUsedAt: 'desc' },
        },
        holdings: {
          where: { quantity: { gt: 0 } },
          include: {
            stock: { select: { symbol: true, name: true } },
          },
        },
        linkedBanks: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        preferences: true,
        mfaConfig: {
          select: {
            isEnabled: true,
            enabledAt: true,
            recoveryCodesUsedCount: true,
          },
        },
        _count: {
          select: {
            orders: true,
            notifications: true,
            payments: true,
          },
        },
      },
    });

    return user;
  }

  // ── Trading ──────────────────────────────────────────────────

  async listOrders(filters: {
    status?: string;
    userId?: string;
    stockId?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
  }) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.OrderWhereInput = {};

    if (filters.status) where.status = filters.status as Prisma.EnumOrderStatusFilter;
    if (filters.userId) where.userId = filters.userId;
    if (filters.stockId) where.stockId = filters.stockId;
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {};
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
          stock: { select: { symbol: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      orders,
      total,
      page: filters.page ?? 1,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getOrderDetail(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true } },
        stock: { select: { symbol: true, name: true, sector: true } },
        trades: { include: { settlement: true } },
        executions: { orderBy: { executedAt: 'asc' } },
        audits: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  // ── Wallets ──────────────────────────────────────────────────

  async listWallets(filters: { page?: number; limit?: number; frozen?: boolean }) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.WalletWhereInput = {};
    if (filters.frozen !== undefined) where.isFrozen = filters.frozen;

    const [wallets, total] = await Promise.all([
      this.prisma.wallet.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        },
        orderBy: { balance: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.wallet.count({ where }),
    ]);

    return {
      wallets,
      total,
      page: filters.page ?? 1,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getWalletDetail(userId: string) {
    return this.prisma.wallet.findUnique({
      where: { userId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        ledgerEntries: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        reservations: {
          where: { status: 'ACTIVE' },
        },
      },
    });
  }

  // ── Notifications ────────────────────────────────────────────

  async listNotifications(filters: {
    status?: string;
    channel?: string;
    page?: number;
    limit?: number;
  }) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.NotificationWhereInput = {};
    if (filters.status) where.status = filters.status as Prisma.EnumNotificationStatusFilter;
    if (filters.channel) where.channel = filters.channel as Prisma.EnumNotificationChannelFilter;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      notifications,
      total,
      page: filters.page ?? 1,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getNotificationStats() {
    const [byStatus, byChannel] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      this.prisma.notification.groupBy({
        by: ['channel'],
        _count: { id: true },
      }),
    ]);

    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      byChannel: byChannel.map((c) => ({ channel: c.channel, count: c._count.id })),
    };
  }
}
