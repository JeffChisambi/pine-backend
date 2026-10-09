import { Decimal } from '@prisma/client/runtime/library';
import { MarketQuote, PriceStatus } from './market-reference';
import { ZERO } from './position';

/**
 * Valuing positions, one at a time and then together.
 *
 * Definitions used everywhere a number reaches the investor:
 *
 *   market value      quantity × current price
 *   cost basis        quantity × average price — what the shares cost at the
 *                     exchange, before fees
 *   fees              quantity × (average cost − average price) — buying costs
 *                     still attached to the shares held
 *   total invested    cost basis + fees — what was actually paid
 *   unrealised P&L    market value − cost basis: the price gain or loss
 *   after fees        market value − total invested
 *
 * Portfolio figures are SUMS of money, and portfolio percentages are those
 * sums divided by the summed basis. Averaging each stock's percentage instead
 * would give a MK 1,000 position the same say as a MK 1,000,000 one.
 *
 * A holding with no price is left out of every value and percentage rather
 * than valued at cost or at zero — both would be a number made up to fill a
 * gap — and is counted in `unpricedHoldings` so the screen can say so.
 */

export interface HoldingInput {
  quantity: Decimal;
  averagePrice: Decimal;
  averageCost: Decimal;
  quote: MarketQuote;
  /**
   * Buys of this stock made during or after the session the current price
   * belongs to. Their move today is measured from what was paid for them,
   * not from the previous close: a fall that happened before the investor
   * bought is not the investor's loss.
   */
  buysSinceSession?: { quantity: Decimal; gross: Decimal };
}

export interface HoldingValuation {
  quantity: Decimal;
  averagePrice: Decimal;
  averageCost: Decimal;
  price: Decimal | null;
  priceStatus: PriceStatus;
  priceDate: Date | null;
  marketValue: Decimal | null;
  costBasis: Decimal;
  fees: Decimal;
  totalInvested: Decimal;
  unrealizedPnl: Decimal | null;
  unrealizedPnlPct: number | null;
  netUnrealizedPnl: Decimal | null;
  netUnrealizedPnlPct: number | null;
  /** The stock's own move today — the same number the Market tab shows. */
  stockChangePct: number | null;
  /** The investor's money move today, counting only what they owned. */
  dailyChange: Decimal | null;
  dailyChangePct: number | null;
  /** What `dailyChange` is a percentage of. */
  dailyReference: Decimal | null;
}

export function pct(numerator: Decimal | null, denominator: Decimal | null): number | null {
  if (numerator === null || denominator === null || denominator.lte(0)) return null;
  return numerator.div(denominator).mul(100).toNumber();
}

export function valueHolding(h: HoldingInput): HoldingValuation {
  const costBasis = h.quantity.mul(h.averagePrice);
  const totalInvested = h.quantity.mul(h.averageCost);
  const fees = totalInvested.sub(costBasis);
  const price = h.quote.price;

  if (!price) {
    return {
      quantity: h.quantity,
      averagePrice: h.averagePrice,
      averageCost: h.averageCost,
      price: null,
      priceStatus: 'unavailable',
      priceDate: null,
      marketValue: null,
      costBasis,
      fees,
      totalInvested,
      unrealizedPnl: null,
      unrealizedPnlPct: null,
      netUnrealizedPnl: null,
      netUnrealizedPnlPct: null,
      stockChangePct: null,
      dailyChange: null,
      dailyChangePct: null,
      dailyReference: null,
    };
  }

  const marketValue = h.quantity.mul(price);
  const unrealizedPnl = marketValue.sub(costBasis);
  const netUnrealizedPnl = marketValue.sub(totalInvested);

  // Today: shares carried into the session move from the reference price;
  // shares bought since move from what was paid for them.
  const recentQty = Decimal.min(h.buysSinceSession?.quantity ?? ZERO, h.quantity);
  const recentGross =
    recentQty.gt(0) && h.buysSinceSession && h.buysSinceSession.quantity.gt(0)
      ? h.buysSinceSession.gross.mul(recentQty).div(h.buysSinceSession.quantity)
      : ZERO;
  const carriedQty = h.quantity.sub(recentQty);

  let dailyChange: Decimal | null = recentQty.mul(price).sub(recentGross);
  let dailyReference: Decimal | null = recentGross;
  if (carriedQty.gt(0)) {
    if (h.quote.reference) {
      dailyChange = dailyChange.add(carriedQty.mul(price.sub(h.quote.reference)));
      dailyReference = dailyReference.add(carriedQty.mul(h.quote.reference));
    } else {
      // Owned shares, but no earlier price to measure today's move from.
      dailyChange = null;
      dailyReference = null;
    }
  }

  return {
    quantity: h.quantity,
    averagePrice: h.averagePrice,
    averageCost: h.averageCost,
    price,
    priceStatus: h.quote.status,
    priceDate: h.quote.priceDate,
    marketValue,
    costBasis,
    fees,
    totalInvested,
    unrealizedPnl,
    unrealizedPnlPct: pct(unrealizedPnl, costBasis),
    netUnrealizedPnl,
    netUnrealizedPnlPct: pct(netUnrealizedPnl, totalInvested),
    stockChangePct: h.quote.changePct,
    dailyChange,
    dailyChangePct: pct(dailyChange, dailyReference),
    dailyReference,
  };
}

export interface PortfolioTotals {
  marketValue: Decimal;
  costBasis: Decimal;
  fees: Decimal;
  totalInvested: Decimal;
  unrealizedPnl: Decimal;
  unrealizedPnlPct: number | null;
  netUnrealizedPnl: Decimal;
  netUnrealizedPnlPct: number | null;
  dailyChange: Decimal | null;
  dailyChangePct: number | null;
  pricedHoldings: number;
  unpricedHoldings: number;
  staleHoldings: number;
}

/** Money-weighted totals: sums of money, divided by the summed basis. */
export function aggregate(holdings: HoldingValuation[]): PortfolioTotals {
  let marketValue = ZERO;
  let costBasis = ZERO;
  let fees = ZERO;
  let totalInvested = ZERO;
  let dailyChange = ZERO;
  let dailyReference = ZERO;
  let dailyKnown = 0;
  let priced = 0;
  let unpriced = 0;
  let stale = 0;

  for (const h of holdings) {
    if (h.marketValue === null) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    if (h.priceStatus === 'stale') stale += 1;
    marketValue = marketValue.add(h.marketValue);
    costBasis = costBasis.add(h.costBasis);
    fees = fees.add(h.fees);
    totalInvested = totalInvested.add(h.totalInvested);
    if (h.dailyChange !== null && h.dailyReference !== null) {
      dailyChange = dailyChange.add(h.dailyChange);
      dailyReference = dailyReference.add(h.dailyReference);
      dailyKnown += 1;
    }
  }

  const unrealizedPnl = marketValue.sub(costBasis);
  const netUnrealizedPnl = marketValue.sub(totalInvested);
  return {
    marketValue,
    costBasis,
    fees,
    totalInvested,
    unrealizedPnl,
    unrealizedPnlPct: pct(unrealizedPnl, costBasis),
    netUnrealizedPnl,
    netUnrealizedPnlPct: pct(netUnrealizedPnl, totalInvested),
    dailyChange: dailyKnown > 0 ? dailyChange : null,
    dailyChangePct: dailyKnown > 0 ? pct(dailyChange, dailyReference) : null,
    pricedHoldings: priced,
    unpricedHoldings: unpriced,
    staleHoldings: stale,
  };
}

/** Rounds for display only; every calculation above stays in Decimal. */
export function round2(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}
