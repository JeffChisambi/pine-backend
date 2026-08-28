import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * RiskPolicyService — the single authority for broker-configured risk &
 * compliance constraints, mirroring FeePolicyService's architecture:
 * per-broker config with a short cache, resolved server-side from the
 * investor's persisted broker relationship — NEVER from client input.
 *
 * Constraint families (extensible — add a new checker + config fields):
 *
 *   CONCENTRATION   Max % of the investor's stock portfolio a single
 *                   position may reach, measured POST-ORDER. Enforced on
 *                   BUY only — selling always remains possible.
 *
 *   DEPOSIT LIMITS  Per-transaction / daily / monthly caps and velocity
 *                   (attempts per window), matchable by payment method and
 *                   KYC status. The system-wide wallet.dailyDepositLimit
 *                   still applies; where several bounds overlap the MOST
 *                   RESTRICTIVE one wins.
 *
 * Every check returns a structured result (limit, usage, remaining,
 * reason) so callers can both enforce AND explain — the mobile app shows
 * the same numbers the enforcement used, but enforcement is always here,
 * server-side.
 */

export interface DepositLimitRule {
  id: string;
  label?: string;
  enabled: boolean;
  /** Payment method this rule applies to; null/undefined = any method. */
  method?: 'CARD' | 'BANK' | 'MOBILE_MONEY' | null;
  /** KYC status this rule applies to; null/undefined = any status. */
  kycStatus?: 'APPROVED' | 'PENDING' | 'NOT_SUBMITTED' | 'REJECTED' | null;
  perTransactionMax?: number | null;
  dailyMax?: number | null;
  monthlyMax?: number | null;
  velocityMaxCount?: number | null;
  velocityWindowMinutes?: number | null;
}

export interface ResolvedRiskPolicy {
  brokerId: string | null;
  concentrationEnabled: boolean;
  maxPositionPct: Decimal;
  warnPositionPct: Decimal | null;
  depositRules: DepositLimitRule[];
}

export interface ConcentrationCheck {
  enabled: boolean;
  maxPct: number;
  warnPct: number | null;
  /** Position % of the stock portfolio BEFORE this order. */
  currentPct: number;
  /** Position % of the stock portfolio AFTER this order fills. */
  postOrderPct: number;
  /** Largest additional gross value of this stock the limit still allows. */
  maxAdditionalValue: number | null;
  status: 'OK' | 'WARNING' | 'BLOCKED';
  reason: string | null;
}

export interface DepositCheck {
  allowed: boolean;
  /** First violated constraint, phrased for the investor. */
  reason: string | null;
  limits: {
    perTransactionMax: number | null;
    dailyLimit: number | null;
    dailyUsed: number;
    dailyRemaining: number | null;
    monthlyLimit: number | null;
    monthlyUsed: number;
    monthlyRemaining: number | null;
    velocityMaxCount: number | null;
    velocityWindowMinutes: number | null;
    velocityUsed: number;
    /** The largest single deposit currently permitted (most restrictive bound). */
    maxAllowedNow: number | null;
  };
}

const DEFAULT_POLICY: Omit<ResolvedRiskPolicy, 'brokerId'> = {
  concentrationEnabled: false,
  maxPositionPct: new Decimal(100),
  warnPositionPct: null,
  depositRules: [],
};

const CACHE_TTL_MS = 60_000;

@Injectable()
export class RiskPolicyService {
  private readonly logger = new Logger(RiskPolicyService.name);
  private readonly cache = new Map<string, { policy: ResolvedRiskPolicy; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Drop the cached policy after a config change (call from the admin PUT). */
  invalidate(brokerId: string): void {
    this.cache.delete(brokerId);
  }

  async forBroker(brokerId: string | null): Promise<ResolvedRiskPolicy> {
    if (!brokerId) return { brokerId: null, ...DEFAULT_POLICY };
    const hit = this.cache.get(brokerId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;

    const row = await this.prisma.brokerRiskConfig.findUnique({ where: { brokerId } });
    const policy: ResolvedRiskPolicy = row
      ? {
          brokerId,
          concentrationEnabled: row.concentrationEnabled,
          maxPositionPct: row.maxPositionPct,
          warnPositionPct: row.warnPositionPct,
          depositRules: this.parseDepositRules(row.depositRules),
        }
      : { brokerId, ...DEFAULT_POLICY };
    this.cache.set(brokerId, { policy, at: Date.now() });
    return policy;
  }

  async forUser(userId: string): Promise<ResolvedRiskPolicy> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { brokerId: true },
    });
    return this.forBroker(user?.brokerId ?? null);
  }

  parseDepositRules(json: unknown): DepositLimitRule[] {
    if (!Array.isArray(json)) return [];
    const rules: DepositLimitRule[] = [];
    for (const raw of json) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, any>;
      const num = (v: any) => (v == null || v === '' ? null : Number(v));
      rules.push({
        id: String(r.id ?? `rule-${rules.length + 1}`),
        label: typeof r.label === 'string' ? r.label : undefined,
        enabled: r.enabled !== false,
        method: r.method ?? null,
        kycStatus: r.kycStatus ?? null,
        perTransactionMax: num(r.perTransactionMax),
        dailyMax: num(r.dailyMax),
        monthlyMax: num(r.monthlyMax),
        velocityMaxCount: num(r.velocityMaxCount),
        velocityWindowMinutes: num(r.velocityWindowMinutes),
      });
    }
    return rules;
  }

  // ── Portfolio concentration (BUY only) ─────────────────────

  /**
   * Post-order exposure check against TOTAL INVESTOR ASSETS (cash +
   * holdings at the latest market valuation — the same definition the
   * dashboard reports). A buy converts cash into stock 1:1, so total
   * assets are unchanged by the order and the exposure is simply
   * (position + order) / total assets.
   *
   * Denominating by total assets (not stock holdings alone) also means a
   * new investor's FIRST buy isn't automatically 100% "concentration" —
   * they are only limited once a single position dominates everything
   * they hold with the broker. `orderGross` is price × quantity.
   */
  async checkBuyConcentration(
    userId: string,
    stockId: string,
    orderGross: Decimal,
  ): Promise<ConcentrationCheck> {
    const policy = await this.forUser(userId);
    const none: ConcentrationCheck = {
      enabled: false, maxPct: 100, warnPct: null,
      currentPct: 0, postOrderPct: 0, maxAdditionalValue: null,
      status: 'OK', reason: null,
    };
    if (!policy.concentrationEnabled) return none;

    const [holdings, prices, wallet] = await Promise.all([
      this.prisma.holding.findMany({
        where: { userId, quantity: { gt: 0 } },
        select: { stockId: true, quantity: true },
      }),
      this.prisma.stockPrice.findMany({
        orderBy: { tradedAt: 'desc' },
        distinct: ['stockId'],
        select: { stockId: true, closePrice: true },
      }),
      this.prisma.wallet.findUnique({ where: { userId }, select: { balance: true } }),
    ]);
    const priceOf = new Map(prices.map((p) => [p.stockId, p.closePrice]));

    let holdingsValue = new Decimal(0);
    let positionValue = new Decimal(0);
    for (const h of holdings) {
      const price = priceOf.get(h.stockId);
      if (!price) continue;
      const value = h.quantity.mul(price);
      holdingsValue = holdingsValue.add(value);
      if (h.stockId === stockId) positionValue = positionValue.add(value);
    }
    const totalAssets = holdingsValue.add(wallet?.balance ?? new Decimal(0));

    const postPosition = positionValue.add(orderGross);
    const currentPct = totalAssets.gt(0)
      ? positionValue.div(totalAssets).mul(100).toNumber()
      : 0;
    const postPct = totalAssets.gt(0)
      ? postPosition.div(totalAssets).mul(100).toNumber()
      : 100;

    const maxPct = policy.maxPositionPct.toNumber();
    const warnPct = policy.warnPositionPct?.toNumber() ?? null;

    // Largest additional X with (P + X) / T <= L  →  X <= L·T − P
    const L = maxPct / 100;
    let maxAdditionalValue: number | null = null;
    if (L < 1) {
      const x = L * totalAssets.toNumber() - positionValue.toNumber();
      maxAdditionalValue = Math.max(0, Math.floor(x * 100) / 100);
    }

    let status: ConcentrationCheck['status'] = 'OK';
    let reason: string | null = null;
    if (postPct > maxPct + 1e-9) {
      status = 'BLOCKED';
      reason =
        `This order would put ${postPct.toFixed(1)}% of your total account in one stock — ` +
        `your broker's limit is ${maxPct}%.` +
        (maxAdditionalValue != null && maxAdditionalValue > 0
          ? ` You can buy up to about MWK ${maxAdditionalValue.toLocaleString()} more of this stock.`
          : '');
    } else if (warnPct != null && postPct > warnPct) {
      status = 'WARNING';
      reason =
        `After this order, ${postPct.toFixed(1)}% of your total account would be in one stock ` +
        `(your broker suggests staying under ${warnPct}%).`;
    }

    return {
      enabled: true, maxPct, warnPct,
      currentPct: Math.round(currentPct * 100) / 100,
      postOrderPct: Math.round(postPct * 100) / 100,
      maxAdditionalValue, status, reason,
    };
  }

  // ── Deposit limits ─────────────────────────────────────────

  /**
   * Evaluate every applicable constraint for a deposit of `amount` via
   * `method`. amount = 0 gives a pure limits/usage preview. All bounds —
   * broker rules AND the system wallet limit — are combined most-
   * restrictive-first.
   */
  async checkDeposit(
    userId: string,
    amount: Decimal,
    method: string | null,
  ): Promise<DepositCheck> {
    const [policy, user, wallet] = await Promise.all([
      this.forUser(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { kycStatus: true } }),
      this.prisma.wallet.findUnique({ where: { userId }, select: { id: true, dailyDepositLimit: true } }),
    ]);

    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Usage counts PENDING too — an in-flight deposit already consumes
    // allowance, otherwise parallel requests could each pass alone.
    // Sums are GROSS (net credit + processing fee): limits govern the money
    // the client PAYS IN, not what lands after fees.
    const usageWhere = wallet
      ? { walletId: wallet.id, type: 'DEPOSIT' as const, status: { in: ['PENDING', 'COMPLETED'] as any } }
      : null;
    const grossSum = async (since: Date): Promise<number> => {
      if (!wallet) return 0;
      const rows = await this.prisma.$queryRaw<Array<{ total: string | null }>>`
        SELECT COALESCE(SUM(t."amount" + COALESCE((t."metadata"->>'processingFee')::numeric, 0)), 0)::text AS total
        FROM "transactions" t
        WHERE t."walletId" = ${wallet.id}::uuid
          AND t."type" = 'DEPOSIT' AND t."status" IN ('PENDING', 'COMPLETED')
          AND t."createdAt" >= ${since}`;
      return Number(rows[0]?.total ?? 0);
    };
    const [dailyUsed, monthlyUsed] = await Promise.all([
      grossSum(dayStart),
      grossSum(monthStart),
    ]);

    // Applicable broker rules: enabled + method/KYC criteria match.
    const applicable = policy.depositRules.filter((r) => {
      if (!r.enabled) return false;
      if (r.method && method && r.method !== method) return false;
      if (r.method && !method) return false;
      if (r.kycStatus && r.kycStatus !== (user?.kycStatus ?? 'NOT_SUBMITTED')) return false;
      return true;
    });

    // Most restrictive bound per dimension (system wallet limit included).
    const minOf = (values: Array<number | null | undefined>): number | null => {
      const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
      return nums.length ? Math.min(...nums) : null;
    };
    const perTransactionMax = minOf(applicable.map((r) => r.perTransactionMax));
    const dailyLimit = minOf([
      ...applicable.map((r) => r.dailyMax),
      wallet?.dailyDepositLimit?.toNumber(),
    ]);
    const monthlyLimit = minOf(applicable.map((r) => r.monthlyMax));

    // Velocity: the tightest applicable count/window pair.
    const velocityRules = applicable.filter((r) => r.velocityMaxCount != null && r.velocityWindowMinutes != null);
    let velocityMaxCount: number | null = null;
    let velocityWindowMinutes: number | null = null;
    let velocityUsed = 0;
    let velocityViolated = false;
    for (const r of velocityRules) {
      const windowStart = new Date(now.getTime() - r.velocityWindowMinutes! * 60_000);
      const count = usageWhere
        ? await this.prisma.transaction.count({
            where: { ...usageWhere, createdAt: { gte: windowStart } },
          })
        : 0;
      if (velocityMaxCount == null || r.velocityMaxCount! - count < velocityMaxCount - velocityUsed) {
        velocityMaxCount = r.velocityMaxCount!;
        velocityWindowMinutes = r.velocityWindowMinutes!;
        velocityUsed = count;
      }
      if (count >= r.velocityMaxCount!) velocityViolated = true;
    }

    const dailyRemaining = dailyLimit != null ? Math.max(0, dailyLimit - dailyUsed) : null;
    const monthlyRemaining = monthlyLimit != null ? Math.max(0, monthlyLimit - monthlyUsed) : null;
    const maxAllowedNow = minOf([perTransactionMax, dailyRemaining, monthlyRemaining]);

    const amt = amount.toNumber();
    let reason: string | null = null;
    if (amt > 0) {
      if (velocityViolated) {
        reason =
          `Too many deposits in a short time — your broker allows ${velocityMaxCount} ` +
          `per ${velocityWindowMinutes} minutes. Please try again later.`;
      } else if (perTransactionMax != null && amt > perTransactionMax) {
        reason =
          `Maximum per deposit is MWK ${perTransactionMax.toLocaleString()} ` +
          `(you entered MWK ${amt.toLocaleString()}).`;
      } else if (dailyRemaining != null && amt > dailyRemaining) {
        reason =
          `Daily deposit limit is MWK ${dailyLimit!.toLocaleString()}; ` +
          `MWK ${dailyUsed.toLocaleString()} already used today — ` +
          `MWK ${dailyRemaining.toLocaleString()} remaining.`;
      } else if (monthlyRemaining != null && amt > monthlyRemaining) {
        reason =
          `Monthly deposit limit is MWK ${monthlyLimit!.toLocaleString()}; ` +
          `MWK ${monthlyUsed.toLocaleString()} already used this month — ` +
          `MWK ${monthlyRemaining.toLocaleString()} remaining.`;
      }
    }

    return {
      allowed: reason == null,
      reason,
      limits: {
        perTransactionMax,
        dailyLimit, dailyUsed, dailyRemaining,
        monthlyLimit, monthlyUsed, monthlyRemaining,
        velocityMaxCount, velocityWindowMinutes, velocityUsed,
        maxAllowedNow,
      },
    };
  }
}
