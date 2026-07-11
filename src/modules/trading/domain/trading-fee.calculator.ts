import { Decimal } from '@prisma/client/runtime/library';

/**
 * MSE Trading Fee Calculator
 *
 * Fee structure for the Malawi Stock Exchange:
 * - Broker commission: 1.70% of trade value
 * - SEC levy:          0.10% of trade value
 * - MSE levy:          0.10% of trade value
 * - Withholding tax:   Applicable on SELL orders (capital gains)
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

const BROKER_COMMISSION_RATE = new Decimal('0.017');  // 1.70%
const SEC_LEVY_RATE = new Decimal('0.001');           // 0.10%
const MSE_LEVY_RATE = new Decimal('0.001');           // 0.10%
const WITHHOLDING_TAX_RATE = new Decimal('0.00');     // 0% for now — set by RBFM policy

/**
 * Minimum commission in MWK. Even if the calculated commission is
 * below this floor, the broker charges this minimum.
 */
const MIN_BROKER_COMMISSION = new Decimal('500');

export function calculateTradingFees(
  price: Decimal,
  quantity: Decimal,
  side: 'BUY' | 'SELL',
): TradingFees {
  const grossValue = price.mul(quantity);

  let brokerCommission = grossValue.mul(BROKER_COMMISSION_RATE);
  // Apply minimum commission floor
  if (brokerCommission.lt(MIN_BROKER_COMMISSION)) {
    brokerCommission = MIN_BROKER_COMMISSION;
  }

  const secLevy = grossValue.mul(SEC_LEVY_RATE);
  const mseLevy = grossValue.mul(MSE_LEVY_RATE);

  // Withholding tax only on sells (capital gains)
  const withholdingTax = side === 'SELL'
    ? grossValue.mul(WITHHOLDING_TAX_RATE)
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
