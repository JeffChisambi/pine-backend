import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import {
  CommissionTier,
  DEFAULT_COMMISSION_TIERS,
  TradingFees,
  calculateTradingFees,
} from '../../trading/domain/trading-fee.calculator';

export interface DepositFeeBreakdown {
  /** What the payer is charged. */
  grossAmount: Decimal;
  /** Processing fee (a PAYMENT COST owed to the bank/provider — not broker revenue). */
  processingFee: Decimal;
  /** What is credited to the investor's wallet. */
  netAmount: Decimal;
  description: string | null;
}

export interface ResolvedFeePolicy {
  brokerId: string | null;
  commissionEnabled: boolean;
  commissionTiers: CommissionTier[];
  depositFeeEnabled: boolean;
  depositFeeKind: 'FIXED' | 'PERCENT';
  depositFeeValue: Decimal;
  depositFeeDescription: string | null;
}

/**
 * FeePolicyService — the single authority for every fee in the system.
 *
 * Resolves the owning broker's configured fee schedule (Broker Dashboard →
 * Settings → Fees & Charges) with platform defaults as fallback:
 *   - deposit processing fee: disabled by default
 *   - trading commission: flat 1.7% with MWK 500 floor (the historical rule)
 * Statutory levies (SEC 0.1% + MSE 0.1%) are fixed and are never broker
 * revenue. Deposit fees never apply to trades; commissions never apply to
 * deposits.
 */
@Injectable()
export class FeePolicyService {
  private readonly logger = new Logger(FeePolicyService.name);
  /** brokerId|'' → { policy, at } — short cache to keep trade hot paths off the DB. */
  private readonly cache = new Map<string, { policy: ResolvedFeePolicy; at: number }>();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Drop the cached policy after a settings change so edits apply immediately. */
  invalidate(brokerId: string | null): void {
    this.cache.delete(brokerId ?? '');
  }

  async forBroker(brokerId: string | null): Promise<ResolvedFeePolicy> {
    const key = brokerId ?? '';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < FeePolicyService.CACHE_TTL_MS) return hit.policy;

    let policy: ResolvedFeePolicy = {
      brokerId,
      commissionEnabled: true,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
      depositFeeEnabled: false,
      depositFeeKind: 'PERCENT',
      depositFeeValue: new Decimal(0),
      depositFeeDescription: null,
    };

    if (brokerId) {
      const cfg = await this.prisma.brokerFeeConfig.findUnique({ where: { brokerId } });
      if (cfg) {
        const tiers = this.parseTiers(cfg.commissionTiers);
        policy = {
          brokerId,
          commissionEnabled: cfg.commissionEnabled,
          commissionTiers: tiers.length > 0 ? tiers : DEFAULT_COMMISSION_TIERS,
          depositFeeEnabled: cfg.depositFeeEnabled,
          depositFeeKind: cfg.depositFeeKind,
          depositFeeValue: new Decimal(cfg.depositFeeValue.toString()),
          depositFeeDescription: cfg.depositFeeDescription,
        };
      }
    }

    this.cache.set(key, { policy, at: Date.now() });
    return policy;
  }

  /** Resolve via the user's broker relationship. */
  async forUser(userId: string): Promise<ResolvedFeePolicy> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { brokerId: true },
    });
    return this.forBroker(user?.brokerId ?? null);
  }

  /** Trading fees for a user's order under their broker's schedule. */
  async tradingFeesForUser(
    userId: string,
    price: Decimal,
    quantity: Decimal,
    side: 'BUY' | 'SELL',
  ): Promise<TradingFees> {
    const policy = await this.forUser(userId);
    return calculateTradingFees(price, quantity, side, {
      tiers: policy.commissionTiers,
      enabled: policy.commissionEnabled,
    });
  }

  /** Deposit processing-fee breakdown: gross charged → fee → net credited. */
  depositBreakdown(policy: ResolvedFeePolicy, grossAmount: Decimal): DepositFeeBreakdown {
    if (!policy.depositFeeEnabled || policy.depositFeeValue.lte(0)) {
      return {
        grossAmount,
        processingFee: new Decimal(0),
        netAmount: grossAmount,
        description: null,
      };
    }
    const processingFee =
      policy.depositFeeKind === 'PERCENT'
        ? grossAmount.mul(policy.depositFeeValue.div(100))
        : Decimal.min(policy.depositFeeValue, grossAmount);
    return {
      grossAmount,
      processingFee,
      netAmount: grossAmount.sub(processingFee),
      description: policy.depositFeeDescription,
    };
  }

  private parseTiers(raw: unknown): CommissionTier[] {
    if (!Array.isArray(raw)) return [];
    const tiers = raw
      .filter(
        (t): t is CommissionTier =>
          t != null &&
          typeof t === 'object' &&
          typeof (t as any).minAmount === 'number' &&
          typeof (t as any).ratePct === 'number',
      )
      .sort((a, b) => a.minAmount - b.minAmount);
    return tiers;
  }
}
