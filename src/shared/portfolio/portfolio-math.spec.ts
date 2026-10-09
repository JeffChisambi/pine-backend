import { describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import { applyTrade, emptyPosition, replayPosition, type TradeFill } from './position';
import { quoteFrom, type PriceRow } from './market-reference';
import { aggregate, valueHolding, type HoldingInput } from './valuation';
import { timeWeightedSeries } from './performance';

const D = (n: number | string) => new Decimal(n);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-10-09T12:00:00Z');

const buy = (qty: number, price: number, fees = 0): TradeFill => ({ side: 'BUY', quantity: D(qty), price: D(price), fees: D(fees) });
const sell = (qty: number, price: number, fees = 0): TradeFill => ({ side: 'SELL', quantity: D(qty), price: D(price), fees: D(fees) });

/** A stock priced today, with yesterday's close. */
const quote = (price: number, previous?: number, opts: { publishedPct?: number; date?: string } = {}) => {
  const latest: PriceRow = {
    closePrice: D(price),
    changePct: opts.publishedPct !== undefined ? D(opts.publishedPct) : null,
    tradedAt: day(opts.date ?? '2026-10-09'),
  };
  const prev: PriceRow | undefined = previous !== undefined ? { closePrice: D(previous), tradedAt: day('2026-10-08') } : undefined;
  return quoteFrom(latest, prev, NOW);
};

const holding = (fills: TradeFill[], q: ReturnType<typeof quote>, boughtToday?: { qty: number; gross: number }): HoldingInput => {
  const p = replayPosition(fills);
  return {
    quantity: p.quantity,
    averagePrice: p.averagePrice,
    averageCost: p.averageCost,
    quote: q,
    buysSinceSession: boughtToday ? { quantity: D(boughtToday.qty), gross: D(boughtToday.gross) } : undefined,
  };
};

const n = (d: Decimal | null) => (d === null ? null : d.toNumber());

describe('Scenario A — first purchase', () => {
  it('shows the value, and no gain or loss, when the price has not moved', () => {
    const v = valueHolding(holding([buy(1000, 100)], quote(100, 100), { qty: 1000, gross: 100_000 }));
    expect(n(v.marketValue)).toBe(100_000);
    expect(n(v.unrealizedPnl)).toBe(0);
    expect(v.unrealizedPnlPct).toBe(0);
    expect(n(v.dailyChange)).toBe(0);
  });

  it('does not report the buying fees as the stock falling — the old -2.63%', () => {
    // MK 100,000 of stock with MK 2,630 of fees: the cost-inclusive basis
    // alone produced exactly the -2.6% that appeared on every purchase.
    const v = valueHolding(holding([buy(1000, 100, 2630)], quote(100, 100), { qty: 1000, gross: 100_000 }));
    expect(n(v.unrealizedPnl)).toBe(0);
    expect(v.unrealizedPnlPct).toBe(0);
    expect(n(v.fees)).toBe(2630);
    expect(n(v.totalInvested)).toBe(102_630);
    // The cost is still reported honestly, as a cost.
    expect(n(v.netUnrealizedPnl)).toBe(-2630);
  });

  it('does not count the purchase as investment growth', () => {
    const series = timeWeightedSeries(
      [{ date: day('2026-10-09'), value: D(100_000) }],
      [{ date: day('2026-10-09'), amount: D(100_000) }],
    );
    expect(series.returnPct).toBeCloseTo(0, 10);
    expect(series.gain).toBe(0);
  });
});

describe('Scenario B — price rises after purchase', () => {
  it('gains 10% when MK 100,000 of shares become MK 110,000', () => {
    const v = valueHolding(holding([buy(1000, 100)], quote(110, 100)));
    expect(n(v.marketValue)).toBe(110_000);
    expect(n(v.unrealizedPnl)).toBe(10_000);
    expect(v.unrealizedPnlPct).toBeCloseTo(10, 10);
  });
});

describe('Scenario C — price falls after purchase', () => {
  it('loses 10% when MK 100,000 of shares become MK 90,000', () => {
    const v = valueHolding(holding([buy(1000, 100)], quote(90, 100)));
    expect(n(v.unrealizedPnl)).toBe(-10_000);
    expect(v.unrealizedPnlPct).toBeCloseTo(-10, 10);
  });
});

describe('Scenario D — stock was already falling before purchase', () => {
  it('measures the investor from their purchase price, not from yesterday', () => {
    // Closed at 100 yesterday, fell to 90 this morning, bought at 90, still 90.
    const q = quote(90, 100);
    expect(q.changePct).toBeCloseTo(-10, 10); // the stock's move, as the Market tab shows
    const v = valueHolding(holding([buy(1000, 90)], q, { qty: 1000, gross: 90_000 }));
    expect(v.stockChangePct).toBeCloseTo(-10, 10);
    expect(n(v.unrealizedPnl)).toBe(0);
    expect(n(v.dailyChange)).toBe(0);
    expect(v.dailyChangePct).toBe(0);
  });

  it('counts only the move after purchase when the price keeps going', () => {
    // Bought at 90 after a fall from 100; it now trades at 85.
    const v = valueHolding(holding([buy(1000, 90)], quote(85, 100), { qty: 1000, gross: 90_000 }));
    expect(n(v.dailyChange)).toBe(-5000);
    expect(v.dailyChangePct).toBeCloseTo(-5.5556, 3);
  });
});

describe('Scenario E — multiple stocks, different allocations', () => {
  it('weights by money, not by stock: +10% on 100k and -5% on 300k is -1.25%', () => {
    const a = valueHolding(holding([buy(1000, 100)], quote(110, 110)));
    const b = valueHolding(holding([buy(3000, 100)], quote(95, 95)));
    const t = aggregate([a, b]);
    expect(n(t.costBasis)).toBe(400_000);
    expect(n(t.unrealizedPnl)).toBe(-5000);
    expect(t.unrealizedPnlPct).toBeCloseTo(-1.25, 10);
    // An unweighted average of the two percentages would say +2.5%.
    expect(((a.unrealizedPnlPct ?? 0) + (b.unrealizedPnlPct ?? 0)) / 2).toBeCloseTo(2.5, 10);
  });
});

describe('Scenario F — additional purchase', () => {
  it('averages the cost and creates no profit from buying more', () => {
    const p = replayPosition([buy(1000, 100), buy(1000, 120)]);
    expect(n(p.quantity)).toBe(2000);
    expect(n(p.averagePrice)).toBe(110);
    const v = valueHolding({ ...p, quote: quote(120, 120), buysSinceSession: { quantity: D(1000), gross: D(120_000) } });
    // The first 1,000 shares gained 20; the new ones nothing.
    expect(n(v.unrealizedPnl)).toBe(20_000);
    expect(n(v.dailyChange)).toBe(0);
  });

  it('does not inflate the performance chart with the new money', () => {
    const s = timeWeightedSeries(
      [
        { date: day('2026-10-05'), value: D(100_000) },
        { date: day('2026-10-06'), value: D(110_000) }, // +10% on price
        { date: day('2026-10-07'), value: D(210_000) }, // bought 100k more, no move
      ],
      [
        { date: day('2026-10-05'), amount: D(100_000) },
        { date: day('2026-10-07'), amount: D(100_000) },
      ],
    );
    expect(s.returnPct).toBeCloseTo(10, 8);
    expect(s.gain).toBe(10_000);
  });
});

describe('Scenario G — partial sale', () => {
  it('keeps the average, reduces the quantity and realises the difference', () => {
    const p = replayPosition([buy(1000, 100, 1000), sell(400, 120, 480)]);
    expect(n(p.quantity)).toBe(600);
    expect(n(p.averagePrice)).toBe(100);
    expect(n(p.averageCost)).toBe(101);
    // Price result on the 400 sold: (120 − 100) × 400.
    expect(n(p.realizedPricePnl)).toBe(8000);
    // After costs: 48,000 − 480 proceeds less 400 × 101.
    expect(n(p.realizedPnl)).toBe(7120);
    const v = valueHolding({ ...p, quote: quote(120, 120) });
    expect(n(v.unrealizedPnl)).toBe(12_000); // the 600 still held
  });

  it('starts afresh after selling out completely', () => {
    const p = replayPosition([buy(100, 50), sell(100, 60), buy(10, 200)]);
    expect(n(p.averagePrice)).toBe(200);
    expect(n(p.realizedPricePnl)).toBe(1000);
  });

  it('refuses to sell more than is held', () => {
    expect(() => applyTrade(emptyPosition(), sell(1, 10))).toThrow();
  });
});

describe('Scenario H — several stocks, independent price moves', () => {
  it('reconciles holding figures with the portfolio total and the market moves', () => {
    const a = valueHolding(holding([buy(100, 50)], quote(55, 52)));
    const b = valueHolding(holding([buy(200, 20)], quote(18, 19)));
    const c = valueHolding(holding([buy(10, 1000)], quote(1000, 1000)));
    const t = aggregate([a, b, c]);
    const sum = (k: 'marketValue' | 'unrealizedPnl' | 'dailyChange') =>
      [a, b, c].reduce((s, h) => s + (h[k]?.toNumber() ?? 0), 0);
    expect(n(t.marketValue)).toBe(sum('marketValue'));
    expect(n(t.unrealizedPnl)).toBe(sum('unrealizedPnl'));
    expect(n(t.dailyChange)).toBe(sum('dailyChange'));
    // Today: 100 × (55 − 52) + 200 × (18 − 19) + 0 = 100.
    expect(n(t.dailyChange)).toBe(100);
    // The stock moves are the market's, not the investor's.
    expect(a.stockChangePct).toBeCloseTo(5.7692, 3);
  });
});

describe('Scenario I — missing or stale prices', () => {
  it('does not invent a value or a percentage for a stock with no price', () => {
    const none = quoteFrom(undefined, undefined, NOW);
    expect(none.status).toBe('unavailable');
    const v = valueHolding(holding([buy(100, 50)], none));
    expect(v.marketValue).toBeNull();
    expect(v.unrealizedPnlPct).toBeNull();
    expect(v.dailyChange).toBeNull();
  });

  it('leaves an unpriced stock out of the totals and says so', () => {
    const priced = valueHolding(holding([buy(100, 50)], quote(55, 50)));
    const unpriced = valueHolding(holding([buy(100, 50)], quoteFrom(undefined, undefined, NOW)));
    const t = aggregate([priced, unpriced]);
    expect(n(t.marketValue)).toBe(5500);
    expect(t.unrealizedPnlPct).toBeCloseTo(10, 10);
    expect(t.unpricedHoldings).toBe(1);
  });

  it('reports no daily move when there is no earlier price, rather than 0% or a guess', () => {
    const q = quoteFrom({ closePrice: D(100), tradedAt: day('2026-10-09') }, undefined, NOW);
    expect(q.changePct).toBeNull();
    const v = valueHolding(holding([buy(10, 100)], q));
    expect(v.dailyChange).toBeNull();
  });

  it('flags a price that has not updated for over a week', () => {
    expect(quote(100, 100, { date: '2026-09-20' }).status).toBe('stale');
    expect(quote(100, 100).status).toBe('live');
  });

  it("uses the exchange's published move when there is one", () => {
    const q = quote(110, 999, { publishedPct: 10 });
    expect(q.changePct).toBeCloseTo(10, 10);
    expect(q.reference?.toNumber()).toBeCloseTo(100, 8);
  });
});

describe('Scenario J — performance chart integrity', () => {
  it('stays flat at 0% when nothing moves after the purchase', () => {
    const s = timeWeightedSeries(
      [
        { date: day('2026-10-05'), value: D(50_000) },
        { date: day('2026-10-06'), value: D(50_000) },
        { date: day('2026-10-07'), value: D(50_000) },
      ],
      [{ date: day('2026-10-05'), amount: D(50_000) }],
    );
    for (const p of s.points) expect(p.returnPct).toBeCloseTo(0, 10);
  });

  it('starts at the first purchase — nothing is backdated before it', () => {
    const s = timeWeightedSeries(
      [{ date: day('2026-10-05'), value: D(50_000) }, { date: day('2026-10-06'), value: D(55_000) }],
      [{ date: day('2026-10-05'), amount: D(50_000) }],
    );
    expect(s.points[0].value).toBe(0);
    expect(s.points[0].date.toISOString().slice(0, 10)).toBe('2026-10-04');
    expect(s.returnPct).toBeCloseTo(10, 8);
  });

  it('measures a window from its own start', () => {
    const s = timeWeightedSeries(
      [
        { date: day('2026-10-01'), value: D(100) },
        { date: day('2026-10-02'), value: D(120) },
        { date: day('2026-10-03'), value: D(132) },
      ],
      [{ date: day('2026-10-01'), amount: D(100) }],
      day('2026-10-02'),
    );
    expect(s.returnPct).toBeCloseTo(10, 8);
    expect(s.gain).toBe(12);
  });

  it('handles selling everything without blowing up the return', () => {
    const s = timeWeightedSeries(
      [{ date: day('2026-10-01'), value: D(100) }, { date: day('2026-10-02'), value: D(0) }],
      [{ date: day('2026-10-01'), amount: D(100) }, { date: day('2026-10-02'), amount: D(-110) }],
    );
    expect(s.returnPct).toBeCloseTo(10, 8);
    expect(s.gain).toBe(10);
  });

  it('has no series with a single day of history', () => {
    const s = timeWeightedSeries([{ date: day('2026-10-05'), value: D(10) }], []);
    expect(s.returnPct).toBeNull();
  });
});

describe('edge cases', () => {
  it('gives no percentage on a zero cost basis', () => {
    const v = valueHolding({ quantity: D(0), averagePrice: D(0), averageCost: D(0), quote: quote(10, 10) });
    expect(v.unrealizedPnlPct).toBeNull();
    expect(aggregate([]).unrealizedPnlPct).toBeNull();
  });

  it('keeps full precision until display', () => {
    const p = replayPosition([buy(3, 10), buy(3, 10.01), buy(3, 10.02)]);
    expect(p.averagePrice.toString()).toBe('10.01');
    const v = valueHolding({ ...p, quote: quote(10.0133, 10.0133) });
    expect(v.unrealizedPnl?.toNumber()).toBeCloseTo(0.0297, 10);
  });
});
