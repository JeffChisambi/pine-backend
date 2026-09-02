import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { SystemErrorService } from '../../system-errors/services/system-error.service';
import { PlatformFeeService } from '../../brokers/services/platform-fee.service';

/**
 * AdminFinanceService — the single aggregation authority for every
 * financial figure the broker dashboard displays.
 *
 * Definitions (kept strictly separate — never summed into one number):
 *
 *   CLIENT CASH            Σ wallet.balance of the broker's investors.
 *                          Uninvested money the broker holds on behalf of
 *                          clients. This is a LIABILITY, not revenue.
 *
 *   PORTFOLIO VALUE        Σ holding.quantity × latest market price.
 *                          The market value of client stock positions —
 *                          the same valuation the mobile app shows
 *                          (portfolio module uses the identical formula).
 *
 *   TOTAL INVESTOR ASSETS  Client Cash + Portfolio Value. Assets under
 *                          administration; still client money.
 *
 *   TRADING COMMISSIONS    Σ trade.commission — the broker's own revenue,
 *                          recorded per-trade at execution time under the
 *                          broker's configured tier schedule.
 *
 *   PROCESSING FEES        Σ deposit metadata.processingFee — payment
 *                          costs collected on deposits under the broker's
 *                          Fees & Charges settings. Reported separately
 *                          from commissions.
 *
 * All values derive from the same transactional rows the mobile app is
 * served from. Nothing here is stored or cached — recomputed at read time.
 */
@Injectable()
export class AdminFinanceService {
  private readonly logger = new Logger(AdminFinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemErrors: SystemErrorService,
    private readonly platformFee: PlatformFeeService,
  ) {}

  /** Latest close price per stock (MSE lists ~20 symbols — one small query). */
  async latestPrices(): Promise<Map<string, Decimal>> {
    const rows = await this.prisma.stockPrice.findMany({
      orderBy: { tradedAt: 'desc' },
      distinct: ['stockId'],
      select: { stockId: true, closePrice: true },
    });
    return new Map(rows.map((r) => [r.stockId, r.closePrice]));
  }

  /**
   * Market value of holdings, grouped per user. Pass userIds to restrict,
   * or a broker scope to value one broker's whole book.
   */
  async portfolioValues(params: {
    userIds?: string[];
    scopeBrokerId?: string;
  }): Promise<Map<string, Decimal>> {
    const holdings = await this.prisma.holding.findMany({
      where: {
        quantity: { gt: 0 },
        ...(params.userIds ? { userId: { in: params.userIds } } : {}),
        ...(params.scopeBrokerId ? { user: { brokerId: params.scopeBrokerId } } : {}),
      },
      select: { userId: true, stockId: true, quantity: true },
    });
    const prices = await this.latestPrices();
    const byUser = new Map<string, Decimal>();
    for (const h of holdings) {
      const price = prices.get(h.stockId);
      if (!price) continue; // no price data → cannot value; excluded, not guessed
      const value = h.quantity.mul(price);
      byUser.set(h.userId, (byUser.get(h.userId) ?? new Decimal(0)).add(value));
    }
    return byUser;
  }

  /**
   * Broker-wide financial overview: Client Assets / Broker Revenue /
   * Payment Costs, each derived independently so nothing double-counts.
   */
  async brokerFinancials(scopeBrokerId?: string) {
    const walletScope = scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {};
    const orderScope = scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {};

    const [cashAgg, portfolioByUser, commissionAgg, leviesAgg, feeRows, pendingWithdrawals] =
      await Promise.all([
        this.prisma.wallet.aggregate({
          where: walletScope,
          _sum: { balance: true },
        }),
        this.portfolioValues({ scopeBrokerId }),
        this.prisma.trade.aggregate({
          where: { order: orderScope },
          _sum: { commission: true },
        }),
        this.prisma.trade.aggregate({
          where: { order: orderScope },
          _sum: { levies: true },
        }),
        // Processing fees live in deposit metadata (Transaction.amount is
        // the NET credit) — JSON extraction needs raw SQL.
        scopeBrokerId
          ? this.prisma.$queryRaw<Array<{ total: string | null }>>`
              SELECT COALESCE(SUM((t."metadata"->>'processingFee')::numeric), 0)::text AS total
              FROM "transactions" t
              JOIN "wallets" w ON w."id" = t."walletId"
              JOIN "users" u ON u."id" = w."userId"
              WHERE t."type" = 'DEPOSIT' AND t."status" = 'COMPLETED'
                AND t."metadata" ? 'processingFee'
                AND u."brokerId" = ${scopeBrokerId}::uuid`
          : this.prisma.$queryRaw<Array<{ total: string | null }>>`
              SELECT COALESCE(SUM((t."metadata"->>'processingFee')::numeric), 0)::text AS total
              FROM "transactions" t
              WHERE t."type" = 'DEPOSIT' AND t."status" = 'COMPLETED'
                AND t."metadata" ? 'processingFee'`,
        this.prisma.transaction.aggregate({
          where: {
            type: 'WITHDRAWAL',
            status: { in: ['PENDING', 'PROCESSING'] },
            wallet: walletScope,
          },
          _sum: { amount: true },
          _count: { id: true },
        }),
      ]);

    const clientCash = cashAgg._sum.balance ?? new Decimal(0);
    let portfolioValue = new Decimal(0);
    for (const v of portfolioByUser.values()) portfolioValue = portfolioValue.add(v);

    // Pine platform commission owed by the broker — this month / last month /
    // lifetime — from the per-trade platformFee frozen at execution.
    const platformFees = await this.platformFeeSummary(scopeBrokerId);

    return {
      clientAssets: {
        clientCash: clientCash.toNumber(),
        portfolioValue: portfolioValue.toNumber(),
        totalInvestorAssets: clientCash.add(portfolioValue).toNumber(),
      },
      brokerRevenue: {
        tradingCommissions: (commissionAgg._sum.commission ?? new Decimal(0)).toNumber(),
        commissionsThisMonth: platformFees.commissionsThisMonth,
      },
      platformFees,
      statutory: {
        leviesCollected: (leviesAgg._sum.levies ?? new Decimal(0)).toNumber(),
      },
      paymentCosts: {
        processingFees: Number(feeRows[0]?.total ?? 0),
      },
      pendingWithdrawals: {
        count: pendingWithdrawals._count.id,
        amount: (pendingWithdrawals._sum.amount ?? new Decimal(0)).toNumber(),
      },
    };
  }

  /**
   * Per-investor financial summary — the same numbers the investor sees
   * on mobile (identical formulas over identical rows).
   */
  async investorSummary(userId: string) {
    const [wallet, reservedAgg, pendingWd, portfolioByUser, commissionAgg, feeRows] =
      await Promise.all([
        this.prisma.wallet.findUnique({ where: { userId } }),
        this.prisma.walletReservation.aggregate({
          where: { wallet: { userId }, status: 'ACTIVE' },
          _sum: { amount: true },
        }),
        this.prisma.transaction.aggregate({
          where: {
            wallet: { userId },
            type: 'WITHDRAWAL',
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          _sum: { amount: true },
        }),
        this.portfolioValues({ userIds: [userId] }),
        this.prisma.trade.aggregate({
          where: { order: { userId } },
          _sum: { commission: true, levies: true, fee: true },
        }),
        this.prisma.$queryRaw<Array<{ total: string | null }>>`
          SELECT COALESCE(SUM((t."metadata"->>'processingFee')::numeric), 0)::text AS total
          FROM "transactions" t
          JOIN "wallets" w ON w."id" = t."walletId"
          WHERE t."type" = 'DEPOSIT' AND t."status" = 'COMPLETED'
            AND t."metadata" ? 'processingFee'
            AND w."userId" = ${userId}::uuid`,
      ]);

    const cashTotal = wallet?.balance ?? new Decimal(0);
    const cashReserved = reservedAgg._sum.amount ?? new Decimal(0);
    const pendingWithdrawals = pendingWd._sum.amount ?? new Decimal(0);
    const cashAvailable = Decimal.max(
      cashTotal.sub(cashReserved).sub(pendingWithdrawals),
      new Decimal(0),
    );
    const portfolioValue = portfolioByUser.get(userId) ?? new Decimal(0);

    return {
      cash: {
        total: cashTotal.toNumber(),
        reserved: cashReserved.toNumber(),
        pendingWithdrawals: pendingWithdrawals.toNumber(),
        available: cashAvailable.toNumber(),
      },
      portfolioValue: portfolioValue.toNumber(),
      totalAssets: cashTotal.add(portfolioValue).toNumber(),
      lifetimeFees: {
        commissionsPaid: (commissionAgg._sum.commission ?? new Decimal(0)).toNumber(),
        leviesPaid: (commissionAgg._sum.levies ?? new Decimal(0)).toNumber(),
        totalTradingFees: (commissionAgg._sum.fee ?? new Decimal(0)).toNumber(),
        depositFeesPaid: Number(feeRows[0]?.total ?? 0),
      },
    };
  }

  // ── Platform commission (Pine's cut of broker commissions) ──

  private monthBounds(offset = 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    return { start, end };
  }

  /**
   * What a broker owes Pine: Σ trade.platformFee for the broker's trades,
   * bucketed this month / last month / lifetime, alongside the commissions
   * those fees were computed from.
   */
  async platformFeeSummary(scopeBrokerId?: string) {
    const orderScope = scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {};
    const cur = this.monthBounds(0);
    const prev = this.monthBounds(-1);
    const sum = async (range?: { start: Date; end: Date }) =>
      this.prisma.trade.aggregate({
        where: {
          order: orderScope,
          ...(range ? { createdAt: { gte: range.start, lt: range.end } } : {}),
        },
        _sum: { platformFee: true, commission: true },
        _count: { id: true },
      });
    const [thisMonth, lastMonth, lifetime, ratePct] = await Promise.all([
      sum(cur), sum(prev), sum(), this.platformFee.ratePct(),
    ]);
    const n = (d: Decimal | null | undefined) => (d ?? new Decimal(0)).toNumber();
    return {
      ratePct: ratePct.toNumber(),
      owedThisMonth: n(thisMonth._sum.platformFee),
      owedLastMonth: n(lastMonth._sum.platformFee),
      owedLifetime: n(lifetime._sum.platformFee),
      commissionsThisMonth: n(thisMonth._sum.commission),
      commissionsLastMonth: n(lastMonth._sum.commission),
      tradesThisMonth: thisMonth._count.id,
      periodStart: cur.start.toISOString(),
      periodEnd: cur.end.toISOString(),
    };
  }

  /**
   * Super Admin: every broker's earnings and what each owes Pine.
   */
  async brokerEarningsReport() {
    const brokers = await this.prisma.broker.findMany({
      select: { id: true, name: true, code: true, isActive: true, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
    const cur = this.monthBounds(0);
    const prev = this.monthBounds(-1);
    const rows = await Promise.all(
      brokers.map(async (b) => {
        const scope = { order: { user: { brokerId: b.id } } };
        const [month, last, life] = await Promise.all([
          this.prisma.trade.aggregate({
            where: { ...scope, createdAt: { gte: cur.start, lt: cur.end } },
            _sum: { commission: true, platformFee: true, levies: true }, _count: { id: true },
          }),
          this.prisma.trade.aggregate({
            where: { ...scope, createdAt: { gte: prev.start, lt: prev.end } },
            _sum: { commission: true, platformFee: true },
          }),
          this.prisma.trade.aggregate({
            where: scope, _sum: { commission: true, platformFee: true }, _count: { id: true },
          }),
        ]);
        const n = (d: Decimal | null | undefined) => (d ?? new Decimal(0)).toNumber();
        return {
          brokerId: b.id,
          name: b.name,
          code: b.code,
          isActive: b.isActive,
          investors: b._count.users,
          thisMonth: {
            trades: month._count.id,
            commissions: n(month._sum.commission),
            leviesCollected: n(month._sum.levies),
            owedToPlatform: n(month._sum.platformFee),
          },
          lastMonth: {
            commissions: n(last._sum.commission),
            owedToPlatform: n(last._sum.platformFee),
          },
          lifetime: {
            trades: life._count.id,
            commissions: n(life._sum.commission),
            owedToPlatform: n(life._sum.platformFee),
          },
        };
      }),
    );
    const totals = rows.reduce(
      (t, r) => ({
        commissionsThisMonth: t.commissionsThisMonth + r.thisMonth.commissions,
        owedThisMonth: t.owedThisMonth + r.thisMonth.owedToPlatform,
        owedLifetime: t.owedLifetime + r.lifetime.owedToPlatform,
      }),
      { commissionsThisMonth: 0, owedThisMonth: 0, owedLifetime: 0 },
    );
    return {
      ratePct: (await this.platformFee.ratePct()).toNumber(),
      periodStart: cur.start.toISOString(),
      periodEnd: cur.end.toISOString(),
      brokers: rows,
      totals,
    };
  }

  // ── Reconciliation ─────────────────────────────────────────

  /**
   * Compare every wallet's denormalized balance against its ledger sum.
   * Discrepancies are returned AND surfaced into the System Errors console.
   */
  async reconcile(scopeBrokerId?: string) {
    const wallets = await this.prisma.wallet.findMany({
      where: scopeBrokerId ? { user: { brokerId: scopeBrokerId } } : {},
      select: {
        id: true,
        balance: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const ledgerSums = await this.prisma.ledgerEntry.groupBy({
      by: ['walletId', 'direction'],
      where: {
        accountType: 'USER_WALLET',
        walletId: { in: wallets.map((w) => w.id) },
      },
      _sum: { amount: true },
    });
    const ledgerByWallet = new Map<string, Decimal>();
    for (const row of ledgerSums) {
      if (!row.walletId) continue;
      const prev = ledgerByWallet.get(row.walletId) ?? new Decimal(0);
      const amt = row._sum.amount ?? new Decimal(0);
      ledgerByWallet.set(
        row.walletId,
        row.direction === 'CREDIT' ? prev.add(amt) : prev.sub(amt),
      );
    }

    const discrepancies: Array<{
      walletId: string;
      userId: string;
      userName: string;
      email: string | null;
      walletBalance: number;
      ledgerBalance: number;
      discrepancy: number;
    }> = [];

    for (const w of wallets) {
      const ledger = ledgerByWallet.get(w.id) ?? new Decimal(0);
      const drift = w.balance.sub(ledger);
      if (!drift.eq(0)) {
        discrepancies.push({
          walletId: w.id,
          userId: w.user.id,
          userName: `${w.user.firstName} ${w.user.lastName}`,
          email: w.user.email,
          walletBalance: w.balance.toNumber(),
          ledgerBalance: ledger.toNumber(),
          discrepancy: drift.toNumber(),
        });
      }
    }

    if (discrepancies.length > 0) {
      this.logger.error(
        { count: discrepancies.length },
        'RECONCILIATION: wallet balances diverge from ledger',
      );
      await this.systemErrors.capture({
        source: 'BACKEND',
        severity: 'CRITICAL',
        message: `Wallet reconciliation found ${discrepancies.length} wallet(s) diverging from the ledger`,
        location: 'AdminFinanceService.reconcile',
        context: { discrepancies: discrepancies.slice(0, 20) },
      });
    }

    return {
      checkedWallets: wallets.length,
      discrepancies,
      inBalance: discrepancies.length === 0,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Nightly reconciliation — drift surfaces in System Errors by morning. */
  @Cron('30 22 * * *', { name: 'wallet-ledger-reconciliation' })
  async nightlyReconciliation(): Promise<void> {
    try {
      const result = await this.reconcile();
      this.logger.log(
        { checked: result.checkedWallets, discrepancies: result.discrepancies.length },
        'Nightly wallet↔ledger reconciliation complete',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Nightly reconciliation failed');
    }
  }
}
