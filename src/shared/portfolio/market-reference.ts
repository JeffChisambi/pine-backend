import { Decimal } from '@prisma/client/runtime/library';

/**
 * The single definition of "today's move" for a stock.
 *
 * The Market tab and the portfolio used to disagree. The Market tab took the
 * exchange's own % change, or failing that the move from the day's open to
 * its close; the portfolio compared against the previous day's close. Open is
 * not a previous close, so the same stock could show two different moves on
 * two screens. Both now read the reference price from here.
 *
 * Order of preference for the price the move is measured from:
 *   1. the exchange's published % change, when genuinely non-zero, which is
 *      the official move against the previous close;
 *   2. the previous trading session's close;
 *   3. nothing — with no earlier price there is no daily move to report, and
 *      inventing one (from the open, or as zero) is how fabricated moves appear.
 */
export interface PriceRow {
  closePrice: Decimal;
  changePct?: Decimal | null;
  tradedAt: Date;
}

export type PriceStatus = 'live' | 'stale' | 'unavailable';

/** A price older than this is shown, but flagged rather than trusted as current. */
export const STALE_AFTER_DAYS = 7;

export interface MarketQuote {
  /** Latest close, or null when the stock has never had a price. */
  price: Decimal | null;
  /** What today's move is measured from, or null when there is nothing. */
  reference: Decimal | null;
  /** The move in %, or null when it cannot be known. */
  changePct: number | null;
  /** The session the price belongs to. */
  priceDate: Date | null;
  status: PriceStatus;
}

/**
 * @param latest   the stock's newest price row
 * @param previous the row before it, if any
 */
export function quoteFrom(
  latest: PriceRow | undefined,
  previous: PriceRow | undefined,
  now: Date = new Date(),
): MarketQuote {
  if (!latest || latest.closePrice.lte(0)) {
    return { price: null, reference: null, changePct: null, priceDate: null, status: 'unavailable' };
  }

  const published = latest.changePct != null ? Number(latest.changePct) : null;
  let reference: Decimal | null = null;
  if (published !== null && Number.isFinite(published) && Math.abs(published) > 0.001) {
    reference = latest.closePrice.div(1 + published / 100);
  } else if (previous && previous.closePrice.gt(0)) {
    reference = previous.closePrice;
  }

  const changePct = reference
    ? latest.closePrice.sub(reference).div(reference).mul(100).toNumber()
    : null;

  const ageDays = (now.getTime() - latest.tradedAt.getTime()) / 86_400_000;
  return {
    price: latest.closePrice,
    reference,
    changePct,
    priceDate: latest.tradedAt,
    status: ageDays > STALE_AFTER_DAYS ? 'stale' : 'live',
  };
}
