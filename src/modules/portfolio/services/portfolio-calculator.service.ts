import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { quoteFrom, type PriceStatus } from '../../../shared/portfolio/market-reference';
import { ZERO } from '../../../shared/portfolio/position';
import {
  aggregate,
  round2,
  valueHolding,
  type PortfolioTotals,
} from '../../../shared/portfolio/valuation';

/**
 * Portfolio Calculator — turns holdings and prices into what the investor sees.
 *
 * Pure computation, no I/O. The arithmetic itself lives in
 * src/shared/portfolio, where it is tested against worked scenarios; this
 * class only maps database rows onto it and shapes the response.
 *
 * Every figure here has one meaning, everywhere it appears:
 *
 *   marketValue      quantity × current price
 *   costBasis        quantity × average execution price, fees excluded
 *   fees             buying costs still attached to the shares held
 *   totalInvested    costBasis + fees: what the investor actually paid
 *   unrealizedPnl    marketValue − costBasis: the price gain or loss.
 *                    Zero right after a purchase at an unchanged price.
 *   netUnrealizedPnl marketValue − totalInvested: the result after fees
 *   pnlPercent       unrealizedPnl ÷ costBasis
 *   stockChangePct   the stock's own move today, as the Market tab shows it
 *   dailyChange      the investor's money move today, counting shares bought
 *                    today from their purchase price, not yesterday's close
 *
 * Portfolio totals are sums of money and their percentages divide by the
 * summed basis, never an average of per-stock percentages.
 */

export interface HoldingRow {
  stockId: string;
  quantity: Decimal;
  averageCost: Decimal;
  averagePrice: Decimal;
  stock: {
    symbol: string;
    name: string;
    sector: string;
    prices: Array<{ closePrice: Decimal; changePct: Decimal | null; tradedAt: Date }>;
  };
}

export interface RecentBuy {
  stockId: string;
  quantity: Decimal;
  price: Decimal;
  executedAt: Date;
}

export interface HoldingDetail {
  stockId: string;
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  /** Per share, fees included: what was paid. */
  averageCost: number;
  /** Per share, fees excluded: the exchange price paid. */
  averagePrice: number;
  /** Null when the stock has no price at all. */
  currentPrice: number | null;
  /** What today's move is measured from; null when there is no earlier price. */
  previousClose: number | null;
  priceStatus: PriceStatus;
  priceDate: string | null;
  marketValue: number | null;
  costBasis: number;
  fees: number;
  totalInvested: number;
  unrealizedPnl: number | null;
  pnlPercent: number | null;
  netUnrealizedPnl: number | null;
  netPnlPercent: number | null;
  /** The stock's own move today — matches the Market tab. */
  stockChangePct: number | null;
  /** The investor's move today on this holding. */
  dailyChange: number | null;
  dailyChangePct: number | null;
  /** Share of the priced stocks' market value. */
  weight: number;
}

export interface PortfolioSummary {
  cashBalance: number;
  /** What was paid for the shares held, fees included. */
  totalInvested: number;
  /** What the shares held cost at the exchange, fees excluded. */
  costBasis: number;
  /** Buying fees attached to the shares held. */
  fees: number;
  totalMarketValue: number;
  /** Price gain or loss on the shares held. */
  totalUnrealizedPnl: number;
  /** totalUnrealizedPnl ÷ costBasis; null when there is nothing invested. */
  totalPnlPercent: number | null;
  /** After fees: totalMarketValue − totalInvested. */
  netUnrealizedPnl: number;
  netPnlPercent: number | null;
  /** What sales have made, after all costs. */
  realizedPnl: number;
  realizedPricePnl: number;
  portfolioValue: number;
  dailyChange: number | null;
  dailyChangePct: number | null;
  holdingsCount: number;
  pricedHoldings: number;
  unpricedHoldings: number;
  staleHoldings: number;
  /** The newest price date used, so the screen can say "as of". */
  asOf: string | null;
}

export interface AllocationEntry {
  assetType: string;
  sector?: string;
  symbol?: string;
  value: number;
  percentage: number;
}

export interface AnalyticsData {
  topPerformer: { symbol: string; name: string; pnlPercent: number } | null;
  worstPerformer: { symbol: string; name: string; pnlPercent: number } | null;
  largestPosition: { symbol: string; name: string; weight: number } | null;
  sectorAllocation: Array<{ sector: string; percentage: number }>;
  totalDividendsEarned: number;
  numberOfTrades: number;
  averageHoldingSize: number;
}

export interface Valued {
  details: HoldingDetail[];
  totals: PortfolioTotals;
  asOf: Date | null;
}

const num = (d: Decimal | null): number | null => (d === null ? null : d.toNumber());

@Injectable()
export class PortfolioCalculator {
  /**
   * Values every holding and the portfolio as a whole, from one set of
   * prices, so the holdings list and the totals cannot disagree.
   *
   * @param recentBuys buys made recently (any stock); each holding uses those
   *                   on or after its own price's session date
   */
  value(holdings: HoldingRow[], recentBuys: RecentBuy[] = [], now: Date = new Date()): Valued {
    const valuations = holdings.map((h) => {
      const quote = quoteFrom(h.stock.prices[0], h.stock.prices[1], now);
      const since = quote.priceDate;
      let quantity = ZERO;
      let gross = ZERO;
      if (since) {
        for (const b of recentBuys) {
          if (b.stockId !== h.stockId || b.executedAt < since) continue;
          quantity = quantity.add(b.quantity);
          gross = gross.add(b.quantity.mul(b.price));
        }
      }
      return {
        row: h,
        quote,
        v: valueHolding({
          quantity: h.quantity,
          // A holding not yet backfilled has no fee-free average. Falling back
          // to the cost average is conservative (fees then read as a small
          // loss); leaving it at zero would report the whole value as profit.
          averagePrice: h.averagePrice.gt(0) ? h.averagePrice : h.averageCost,
          averageCost: h.averageCost,
          quote,
          buysSinceSession: quantity.gt(0) ? { quantity, gross } : undefined,
        }),
      };
    });

    const totals = aggregate(valuations.map((x) => x.v));
    const asOf = valuations.reduce<Date | null>(
      (latest, x) => (x.quote.priceDate && (!latest || x.quote.priceDate > latest) ? x.quote.priceDate : latest),
      null,
    );

    const details: HoldingDetail[] = valuations.map(({ row, quote, v }) => ({
      stockId: row.stockId,
      symbol: row.stock.symbol,
      name: row.stock.name,
      sector: row.stock.sector,
      quantity: v.quantity.toNumber(),
      averageCost: v.averageCost.toNumber(),
      averagePrice: v.averagePrice.toNumber(),
      currentPrice: num(v.price),
      previousClose: num(quote.reference),
      priceStatus: v.priceStatus,
      priceDate: v.priceDate ? v.priceDate.toISOString().slice(0, 10) : null,
      marketValue: num(v.marketValue),
      costBasis: v.costBasis.toNumber(),
      fees: v.fees.toNumber(),
      totalInvested: v.totalInvested.toNumber(),
      unrealizedPnl: num(v.unrealizedPnl),
      pnlPercent: round2(v.unrealizedPnlPct),
      netUnrealizedPnl: num(v.netUnrealizedPnl),
      netPnlPercent: round2(v.netUnrealizedPnlPct),
      stockChangePct: round2(v.stockChangePct),
      dailyChange: num(v.dailyChange),
      dailyChangePct: round2(v.dailyChangePct),
      weight:
        v.marketValue && totals.marketValue.gt(0)
          ? round2(v.marketValue.div(totals.marketValue).mul(100).toNumber()) ?? 0
          : 0,
    }));

    return { details, totals, asOf };
  }

  summarize(
    valued: Valued,
    cashBalance: Decimal,
    realized: { realizedPnl: Decimal; realizedPricePnl: Decimal },
  ): PortfolioSummary {
    const t = valued.totals;
    return {
      cashBalance: cashBalance.toNumber(),
      totalInvested: t.totalInvested.toNumber(),
      costBasis: t.costBasis.toNumber(),
      fees: t.fees.toNumber(),
      totalMarketValue: t.marketValue.toNumber(),
      totalUnrealizedPnl: t.unrealizedPnl.toNumber(),
      totalPnlPercent: round2(t.unrealizedPnlPct),
      netUnrealizedPnl: t.netUnrealizedPnl.toNumber(),
      netPnlPercent: round2(t.netUnrealizedPnlPct),
      realizedPnl: realized.realizedPnl.toNumber(),
      realizedPricePnl: realized.realizedPricePnl.toNumber(),
      // Stocks only. Wallet cash is separate money and never part of it.
      portfolioValue: t.marketValue.toNumber(),
      dailyChange: num(t.dailyChange),
      dailyChangePct: round2(t.dailyChangePct),
      holdingsCount: valued.details.length,
      pricedHoldings: t.pricedHoldings,
      unpricedHoldings: t.unpricedHoldings,
      staleHoldings: t.staleHoldings,
      asOf: valued.asOf ? valued.asOf.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * Allocation across cash and stocks. Every percentage is of the same total
   * (cash + stocks), so they sum to 100. Previously cash was a share of
   * cash + stocks while each stock was a share of stocks alone.
   */
  calculateAllocation(details: HoldingDetail[], cashBalance: number): AllocationEntry[] {
    const stocks = details.reduce((s, h) => s + (h.marketValue ?? 0), 0);
    const total = cashBalance + stocks;
    if (total <= 0) return [];

    const allocations: AllocationEntry[] = [];
    if (cashBalance > 0) {
      allocations.push({ assetType: 'CASH', value: cashBalance, percentage: round2((cashBalance / total) * 100) ?? 0 });
    }
    for (const h of details) {
      if (h.marketValue === null) continue;
      allocations.push({
        assetType: 'STOCK',
        sector: h.sector,
        symbol: h.symbol,
        value: h.marketValue,
        percentage: round2((h.marketValue / total) * 100) ?? 0,
      });
    }
    return allocations.sort((a, b) => b.percentage - a.percentage);
  }

  /** Sector shares of the stocks alone (cash has no sector). */
  calculateSectorAllocation(details: HoldingDetail[]): Array<{ sector: string; percentage: number }> {
    const bySector = new Map<string, number>();
    for (const h of details) bySector.set(h.sector, (bySector.get(h.sector) ?? 0) + h.weight);
    return [...bySector.entries()]
      .map(([sector, percentage]) => ({ sector, percentage: round2(percentage) ?? 0 }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  calculateAnalytics(details: HoldingDetail[]): AnalyticsData {
    // Only holdings with a known return can be ranked.
    const ranked = details
      .filter((h): h is HoldingDetail & { pnlPercent: number } => h.pnlPercent !== null)
      .sort((a, b) => b.pnlPercent - a.pnlPercent);
    const byWeight = [...details].sort((a, b) => b.weight - a.weight);
    const valued = details.filter((h) => h.marketValue !== null);
    const avgSize = valued.length
      ? valued.reduce((s, h) => s + (h.marketValue ?? 0), 0) / valued.length
      : 0;

    return {
      topPerformer: ranked[0]
        ? { symbol: ranked[0].symbol, name: ranked[0].name, pnlPercent: ranked[0].pnlPercent }
        : null,
      worstPerformer:
        ranked.length > 1
          ? { symbol: ranked[ranked.length - 1].symbol, name: ranked[ranked.length - 1].name, pnlPercent: ranked[ranked.length - 1].pnlPercent }
          : null,
      largestPosition: byWeight[0]
        ? { symbol: byWeight[0].symbol, name: byWeight[0].name, weight: byWeight[0].weight }
        : null,
      sectorAllocation: this.calculateSectorAllocation(details),
      totalDividendsEarned: 0,
      numberOfTrades: 0,
      averageHoldingSize: round2(avgSize) ?? 0,
    };
  }
}
