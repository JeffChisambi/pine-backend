import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * AdminRepository — admin-surface aggregation queries.
 *
 * Broker isolation: every method accepts an optional `scopeBrokerId`.
 * When present (the caller is a Broker Admin), EVERY query is filtered
 * to that broker via the authoritative `user.brokerId` relationship —
 * the scope is resolved server-side by BrokerScopeService from the
 * authenticated identity, never from client input. `undefined` means
 * the caller is platform staff (Super Admin et al.) and is unscoped.
 */
@Injectable()
export class AdminRepository {
  private readonly logger = new Logger(AdminRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Dashboard ────────────────────────────────────────────────

  async getDashboardStats(scopeBrokerId?: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const userScope: Prisma.UserWhereInput = scopeBrokerId
      ? { brokerId: scopeBrokerId }
      : {};
    const byUserBroker = scopeBrokerId
      ? { user: { brokerId: scopeBrokerId } }
      : {};

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
      this.prisma.user.count({ where: { ...userScope, role: 'CUSTOMER' } }),
      this.prisma.user.count({ where: { ...userScope, role: 'CUSTOMER', isActive: true } }),
      this.prisma.kycApplication.count({ where: { status: 'PENDING', ...byUserBroker } }),
      this.prisma.order.count({ where: { createdAt: { gte: today }, ...byUserBroker } }),
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: today },
          // Executed orders settle FILLED → SETTLED within seconds (T+0), so
          // counting only FILLED made today's volume read 0 the moment a
          // trade settled. Include every executed terminal state.
          status: { in: ['FILLED', 'PARTIALLY_FILLED', 'SETTLED', 'COMPLETED'] },
          ...byUserBroker,
        },
        _sum: { totalCost: true },
      }),
      this.prisma.payment.count({ where: { status: 'PENDING', ...byUserBroker } }),
      this.prisma.session.count({
        where: {
          isRevoked: false,
          expiresAt: { gt: new Date() },
          ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
        },
      }),
      this.prisma.wallet.aggregate({
        where: scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {},
        _sum: { balance: true },
      }),
      this.prisma.user.count({
        where: { ...userScope, role: 'CUSTOMER', createdAt: { gte: today } },
      }),
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

  /**
   * Daily time-series for the dashboard charts — one contract for platform
   * staff (unscoped) and broker admins (scoped), computed with SQL GROUP BY
   * over the real transactional tables. Exactly `days` buckets ending today,
   * zero-filled. `revenue` is the viewer's OWN revenue: a broker's trading
   * commissions, or Pine's platform fees for platform staff.
   */
  async getChartData(days = 14, scopeBrokerId?: string) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));

    const scope = scopeBrokerId
      ? Prisma.sql`AND u."brokerId" = ${scopeBrokerId}::uuid`
      : Prisma.empty;

    type Row = { d: Date; a: string | null; b: string | null };
    const [orders, txns, trades, signups, active] = await Promise.all([
      this.prisma.$queryRaw<Row[]>`
        SELECT date_trunc('day', o."createdAt") AS d,
               COUNT(*)::text AS a,
               COALESCE(SUM(CASE WHEN o.status::text IN ('FILLED','PARTIALLY_FILLED','SETTLED','COMPLETED') THEN o."totalCost" END), 0)::text AS b
        FROM "orders" o JOIN "users" u ON u.id = o."userId"
        WHERE o."createdAt" >= ${since} ${scope}
        GROUP BY 1`,
      this.prisma.$queryRaw<Row[]>`
        SELECT date_trunc('day', t."createdAt") AS d,
               COALESCE(SUM(CASE WHEN t.type::text = 'DEPOSIT' THEN t.amount END), 0)::text AS a,
               COALESCE(SUM(CASE WHEN t.type::text = 'WITHDRAWAL' THEN t.amount END), 0)::text AS b
        FROM "transactions" t
        JOIN "wallets" w ON w.id = t."walletId"
        JOIN "users" u ON u.id = w."userId"
        WHERE t.status::text = 'COMPLETED' AND t.type::text IN ('DEPOSIT','WITHDRAWAL')
          AND t."createdAt" >= ${since} ${scope}
        GROUP BY 1`,
      this.prisma.$queryRaw<Row[]>`
        SELECT date_trunc('day', tr."createdAt") AS d,
               COALESCE(SUM(tr.commission), 0)::text AS a,
               COALESCE(SUM(tr."platformFee"), 0)::text AS b
        FROM "trades" tr
        JOIN "orders" o ON o.id = tr."orderId"
        JOIN "users" u ON u.id = o."userId"
        WHERE tr."createdAt" >= ${since} ${scope}
        GROUP BY 1`,
      this.prisma.$queryRaw<Row[]>`
        SELECT date_trunc('day', u."createdAt") AS d, COUNT(*)::text AS a, NULL AS b
        FROM "users" u
        WHERE u.role::text = 'CUSTOMER' AND u."createdAt" >= ${since} ${scope}
        GROUP BY 1`,
      this.prisma.$queryRaw<Row[]>`
        SELECT date_trunc('day', s."lastUsedAt") AS d, COUNT(DISTINCT s."userId")::text AS a, NULL AS b
        FROM "sessions" s JOIN "users" u ON u.id = s."userId"
        WHERE u.role::text = 'CUSTOMER' AND s."lastUsedAt" >= ${since} ${scope}
        GROUP BY 1`,
    ]);

    const key = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const index = (rows: Row[]) => new Map(rows.map((r) => [key(r.d), r]));
    const [oi, ti, ri, si, ai] = [orders, txns, trades, signups, active].map(index);

    const out: Array<{
      date: string; trades: number; volume: string; deposits: string; withdrawals: string;
      revenue: string; newUsers: number; activeUsers: number;
    }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      const k = key(d);
      const o = oi.get(k), t = ti.get(k), r = ri.get(k), sg = si.get(k), ac = ai.get(k);
      out.push({
        date: k,
        trades: Number(o?.a ?? 0),
        volume: o?.b ?? '0',
        deposits: t?.a ?? '0',
        withdrawals: t?.b ?? '0',
        // Broker: their commissions. Platform staff: Pine's platform fees.
        revenue: scopeBrokerId ? (r?.a ?? '0') : (r?.b ?? '0'),
        newUsers: Number(sg?.a ?? 0),
        activeUsers: Number(ac?.a ?? 0),
      });
    }
    return out;
  }

  // ── Users ────────────────────────────────────────────────────

  async listUsers(
    filters: {
      search?: string;
      status?: string;
      kycStatus?: string;
      role?: string;
      page?: number;
      limit?: number;
    },
    scopeBrokerId?: string,
  ) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.UserWhereInput = {};

    if (scopeBrokerId) {
      // Broker admins see ONLY their own broker's investors.
      where.brokerId = scopeBrokerId;
      where.role = 'CUSTOMER';
    }

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

    if (filters.role && !scopeBrokerId) {
      where.role = filters.role as Prisma.EnumRoleFilter;
    } else if (!scopeBrokerId) {
      // The users screen manages INVESTORS. Admin/broker/staff accounts are
      // not customers — they have no wallet, AUM, or risk profile — and must
      // never be listed (or acted on) as if they were. An explicit role
      // filter above can still target them deliberately.
      where.role = 'CUSTOMER';
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
          brokerId: true,
          broker: { select: { name: true, code: true } },
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
        brokerId: u.brokerId,
        brokerName: u.broker?.name ?? null,
        brokerCode: u.broker?.code ?? null,
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

  async getUserWorkspace(userId: string, scopeBrokerId?: string) {
    const user = await this.prisma.user.findFirst({
      // findFirst + broker filter: a broker admin fetching another
      // broker's user gets the same "not found" as a nonexistent id.
      where: {
        id: userId,
        ...(scopeBrokerId ? { brokerId: scopeBrokerId } : {}),
      },
      include: {
        broker: { select: { id: true, name: true, code: true } },
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

  async listOrders(
    filters: {
      status?: string;
      side?: string;
      userId?: string;
      stockId?: string;
      dateFrom?: string;
      dateTo?: string;
      page?: number;
      limit?: number;
    },
    scopeBrokerId?: string,
  ) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.OrderWhereInput = {};

    if (scopeBrokerId) {
      where.user = { brokerId: scopeBrokerId };
    }

    if (filters.status) where.status = filters.status as Prisma.EnumOrderStatusFilter;
    if (filters.side) where.side = filters.side as Prisma.EnumOrderSideFilter;
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
          // broker.name shows platform admins WHO OWNS each order — admins
          // observe cross-broker but never act on another broker's book.
          user: {
            select: {
              id: true, firstName: true, lastName: true,
              broker: { select: { id: true, name: true } },
            },
          },
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

  async getOrderDetail(orderId: string, scopeBrokerId?: string) {
    return this.prisma.order.findFirst({
      where: {
        id: orderId,
        ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
      },
      include: {
        user: {
          select: {
            id: true, firstName: true, lastName: true, phone: true,
            broker: { select: { id: true, name: true } },
          },
        },
        stock: { select: { symbol: true, name: true, sector: true } },
        trades: { include: { settlement: true } },
        executions: { orderBy: { executedAt: 'asc' } },
        audits: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  // ── Wallets ──────────────────────────────────────────────────

  async listWallets(
    filters: { page?: number; limit?: number; frozen?: boolean },
    scopeBrokerId?: string,
  ) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.WalletWhereInput = {};
    if (filters.frozen !== undefined) where.isFrozen = filters.frozen;
    if (scopeBrokerId) where.user = { brokerId: scopeBrokerId };

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

  async getWalletDetail(userId: string, scopeBrokerId?: string) {
    return this.prisma.wallet.findFirst({
      where: {
        userId,
        ...(scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {}),
      },
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

  async listNotifications(
    filters: {
      status?: string;
      channel?: string;
      category?: string;
      page?: number;
      limit?: number;
    },
    scopeBrokerId?: string,
  ) {
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = ((filters.page ?? 1) - 1) * limit;

    const where: Prisma.NotificationWhereInput = {};
    if (filters.status) where.status = filters.status as Prisma.EnumNotificationStatusFilter;
    if (filters.channel) where.channel = filters.channel as Prisma.EnumNotificationChannelFilter;
    if (filters.category) where.category = filters.category;
    if (scopeBrokerId) where.user = { brokerId: scopeBrokerId };

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

  async getNotificationStats(scopeBrokerId?: string) {
    const where: Prisma.NotificationWhereInput = scopeBrokerId
      ? { user: { brokerId: scopeBrokerId } }
      : {};

    const [byStatus, byChannel] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['status'],
        where,
        _count: { id: true },
      }),
      this.prisma.notification.groupBy({
        by: ['channel'],
        where,
        _count: { id: true },
      }),
    ]);

    return {
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.id })),
      byChannel: byChannel.map((c) => ({ channel: c.channel, count: c._count.id })),
    };
  }
}
