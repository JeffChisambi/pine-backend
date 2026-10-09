import { describe, expect, it } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';
import { PortfolioCalculator, type HoldingRow, type RecentBuy } from './portfolio-calculator.service';

const D = (n: number) => new Decimal(n);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-10-09T12:00:00Z');
const calc = new PortfolioCalculator();

function row(
  stockId: string,
  qty: number,
  avgPrice: number,
  avgCost: number,
  prices: Array<[number, string]>,
): HoldingRow {
  return {
    stockId,
    quantity: D(qty),
    averagePrice: D(avgPrice),
    averageCost: D(avgCost),
    stock: {
      symbol: stockId.toUpperCase(),
      name: stockId,
      sector: 'Banking',
      prices: prices.map(([close, date]) => ({ closePrice: D(close), changePct: null, tradedAt: day(date) })),
    },
  };
}

describe('PortfolioCalculator — rows to figures', () => {
  it('reproduces the reported defect and shows it fixed: two fresh buys, neither falling', () => {
    // Two stocks bought today at today's price, each with ~2.6% fees on top.
    const holdings = [
      row('nbm', 2, 9129.02, 9375.5035, [[9129.02, '2026-10-09'], [9135, '2026-10-08']]),
      row('tnm', 100, 25.45, 26.14, [[25.45, '2026-10-09'], [25.47, '2026-10-08']]),
    ];
    const buys: RecentBuy[] = [
      { stockId: 'nbm', quantity: D(2), price: D(9129.02), executedAt: new Date('2026-10-09T09:30:00Z') },
      { stockId: 'tnm', quantity: D(100), price: D(25.45), executedAt: new Date('2026-10-09T09:31:00Z') },
    ];
    const { details, totals } = calc.value(holdings, buys, NOW);

    for (const h of details) {
      expect(h.unrealizedPnl).toBe(0);
      expect(h.pnlPercent).toBe(0);
      // Today's fall happened before they bought, so it is not theirs...
      expect(h.dailyChange).toBe(0);
      // ...although the stock itself did fall, as the Market tab shows.
      expect(h.stockChangePct).toBeLessThan(0);
      expect(h.fees).toBeGreaterThan(0);
    }
    expect(totals.unrealizedPnl.toNumber()).toBe(0);
    expect(totals.unrealizedPnlPct).toBe(0);
    expect(totals.dailyChange?.toNumber()).toBe(0);
  });

  it('only counts buys from the current price session as "bought today"', () => {
    const holdings = [row('nbm', 20, 100, 100, [[110, '2026-10-09'], [105, '2026-10-08']])];
    const buys: RecentBuy[] = [
      // Bought yesterday at 104: carried into today, so it moves from yesterday's close.
      { stockId: 'nbm', quantity: D(10), price: D(104), executedAt: new Date('2026-10-08T10:00:00Z') },
      // Bought today at 108: moves from 108.
      { stockId: 'nbm', quantity: D(10), price: D(108), executedAt: new Date('2026-10-09T10:00:00Z') },
    ];
    const [h] = calc.value(holdings, buys, NOW).details;
    // 10 carried × (110 − 105) + 10 new × (110 − 108)
    expect(h.dailyChange).toBe(70);
  });

  it('leaves an unpriced stock out of the totals rather than valuing it at cost', () => {
    const holdings = [row('nbm', 10, 100, 100, [[120, '2026-10-09'], [120, '2026-10-08']]), row('xyz', 10, 50, 50, [])];
    const { details, totals } = calc.value(holdings, [], NOW);
    const s = calc.summarize({ details, totals, asOf: null }, D(0), { realizedPnl: D(0), realizedPricePnl: D(0) });
    expect(details[1].marketValue).toBeNull();
    expect(details[1].pnlPercent).toBeNull();
    expect(s.totalMarketValue).toBe(1200);
    expect(s.totalPnlPercent).toBe(20);
    expect(s.unpricedHoldings).toBe(1);
  });

  it('falls back to the cost average for a holding not yet backfilled', () => {
    const [h] = calc.value([row('nbm', 10, 0, 102, [[100, '2026-10-09'], [100, '2026-10-08']])], [], NOW).details;
    // Not a 100% "gain" from a zero basis.
    expect(h.unrealizedPnl).toBe(-20);
  });

  it('makes allocation percentages share one denominator and sum to 100', () => {
    const { details } = calc.value(
      [row('a', 10, 100, 100, [[100, '2026-10-09']]), row('b', 30, 100, 100, [[100, '2026-10-09']])],
      [],
      NOW,
    );
    const alloc = calc.calculateAllocation(details, 4000);
    expect(alloc.reduce((s, a) => s + a.percentage, 0)).toBeCloseTo(100, 6);
    expect(alloc.find((a) => a.assetType === 'CASH')?.percentage).toBe(50);
  });
});
