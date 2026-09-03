import { Decimal } from '@prisma/client/runtime/library';

/**
 * MSE Trading Fee Calculator
 *
 * Fee structure for the Malawi Stock Exchange. Every rate is configurable per
 * broker (Settings → Fees & Charges); the values below are the defaults that
 * apply until a broker sets its own:
 * - Broker commission: 1.70% of trade value
 * - SEC levy:          0.10% of trade value
 * - MSE levy:          0.10% of trade value
 * - Withholding tax:   0%, applied to SELL orders only (capital gains)
 *
 * Total buy fee:  ~1.90% of trade value
 * Total sell fee: ~1.90% + withholding tax
 *
 * All fees are calculated on the gross trade value (price × quantity).
 */

export interface TradingFees {
  brokerCommission: Decimal;
  secLevy: Decimal;
  mseLevy: Decimal;
  withholdingTax: Decimal;
  totalFees: Decimal;
  /** Gross trade value before fees (price × quantity) */
  grossValue: Decimal;
  /** Total cost: gross value + fees (BUY) or gross value - fees (SELL) */
  totalCost: Decimal;
}

/**
 * Statutory levies, as PERCENTAGES of gross trade value.
 *
 * Set by the regulator rather than by the broker's own pricing, but they do
 * change and they differ by market — so they are configuration, not constants.
 * These are the MSE rates in force at launch and the fallback whenever a
 * broker has no schedule of its own.
 */
export interface StatutoryLevies {
  /** SEC levy, percent of gross (e.g. 0.1 = 0.10%). */
  secPct: number;
  /** MSE levy, percent of gross. */
  msePct: number;
  /** Withholding tax on SELL orders, percent of gross. */
  withholdingPct: number;
}

export const DEFAULT_STATUTORY_LEVIES: StatutoryLevies = {
  secPct: 0.1,
  msePct: 0.1,
  withholdingPct: 0,
};

const pctOf = (gross: Decimal, pct: number): Decimal =>
  gross.mul(new Decimal(pct).div(100));

/** One broker commission tier: rate applies when gross ∈ [minAmount, maxAmount]. */
export interface CommissionTier {
  minAmount: number;
  /** null/undefined = open-ended top tier */
  maxAmount?: number | null;
  /** percent, e.g. 1.7 = 1.7% */
  ratePct: number;
  /** optional minimum commission (MWK) within this tier */
  minFee?: number;
}

/** Platform default schedule — the historical flat 1.7% with an MWK 500 floor. */
export const DEFAULT_COMMISSION_TIERS: CommissionTier[] = [
  { minAmount: 0, maxAmount: null, ratePct: 1.7, minFee: 500 },
];

/** Resolve the commission for a gross value against a tier schedule. */
export function commissionForGross(
  grossValue: Decimal,
  tiers: CommissionTier[],
  enabled = true,
): Decimal {
  if (!enabled) return new Decimal(0);
  const schedule = tiers.length > 0 ? tiers : DEFAULT_COMMISSION_TIERS;
  const gross = grossValue.toNumber();
  // Ranges are half-open [min, max): a "0–100,000" tier followed by a
  // "100,000+" tier is contiguous — a gross of exactly 100,000 falls in
  // the SECOND tier. Matches how brokers naturally express schedules.
  const tier =
    schedule.find(
      (t) => gross >= t.minAmount && (t.maxAmount == null || gross < t.maxAmount),
    ) ?? schedule[schedule.length - 1];

  let commission = grossValue.mul(new Decimal(tier.ratePct).div(100));
  if (tier.minFee != null && commission.lt(tier.minFee)) {
    commission = new Decimal(tier.minFee);
  }
  return commission;
}

export function calculateTradingFees(
  price: Decimal,
  quantity: Decimal,
  side: 'BUY' | 'SELL',
  commissionSchedule: { tiers: CommissionTier[]; enabled: boolean } = {
    tiers: DEFAULT_COMMISSION_TIERS,
    enabled: true,
  },
  levies: StatutoryLevies = DEFAULT_STATUTORY_LEVIES,
): TradingFees {
  const grossValue = price.mul(quantity);

  const brokerCommission = commissionForGross(
    grossValue,
    commissionSchedule.tiers,
    commissionSchedule.enabled,
  );

  const secLevy = pctOf(grossValue, levies.secPct);
  const mseLevy = pctOf(grossValue, levies.msePct);

  // Withholding tax only on sells (capital gains)
  const withholdingTax = side === 'SELL'
    ? pctOf(grossValue, levies.withholdingPct)
    : new Decimal(0);

  const totalFees = brokerCommission
    .add(secLevy)
    .add(mseLevy)
    .add(withholdingTax);

  // BUY: user pays grossValue + fees
  // SELL: user receives grossValue - fees
  const totalCost = side === 'BUY'
    ? grossValue.add(totalFees)
    : grossValue.sub(totalFees);

  return {
    brokerCommission,
    secLevy,
    mseLevy,
    withholdingTax,
    totalFees,
    grossValue,
    totalCost,
  };
}

/**
 * Format fees for API response / audit logging.
 * Converts Decimal fields to number for JSON serialization.
 */
export function serializeFees(fees: TradingFees): Record<string, number> {
  return {
    brokerCommission: fees.brokerCommission.toNumber(),
    secLevy: fees.secLevy.toNumber(),
    mseLevy: fees.mseLevy.toNumber(),
    withholdingTax: fees.withholdingTax.toNumber(),
    totalFees: fees.totalFees.toNumber(),
    grossValue: fees.grossValue.toNumber(),
    totalCost: fees.totalCost.toNumber(),
  };
}
