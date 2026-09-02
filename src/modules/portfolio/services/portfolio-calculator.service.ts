import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Portfolio Calculator — the heart of the portfolio module.
 *
 * Pure computation. No side effects. No database writes.
 *
 * Inputs:  Ledger data + Market prices + Corporate actions
 * Outputs: Portfolio summary, holdings table, performance metrics
 *
 * Every other service in the portfolio module calls this calculator
 * rather than doing scattered calculations.
 */

export interface PortfolioSummary {
  cashBalance: number;
  totalInvested: number;
  totalMarketValue: number;
  totalUnrealizedPnl: number;
  totalPnlPercent: number;
  portfolioValue: number;
  dailyChange: number;
  dailyChangePct: number;
  holdingsCount: number;
}

export interface HoldingDetail {
  stockId: string;
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  averageCost: number;
  currentPrice: number;
  previousClose: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  pnlPercent: number;
  dailyChange: number;
  dailyChangePct: number;
  /** Percentage of total portfolio this holding represents */
  weight: number;
}

export interface AllocationEntry {
  assetType: string;
  sector?: string;
  symbol?: string;
  value: number;
  percentage: number;
}

export interface PerformanceMetrics {
  dailyReturn: number;
  dailyReturnPct: number;
  weeklyReturn: number;
  weeklyReturnPct: number;
  monthlyReturn: number;
  monthlyReturnPct: number;
  yearlyReturn: number;
  yearlyReturnPct: number;
  lifetimeReturn: number;
  lifetimeReturnPct: number;
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

@Injectable()
export class PortfolioCalculator {
  private readonly logger = new Logger(PortfolioCalculator.name);

  /**
   * Calculate the full portfolio summary from raw holdings + wallet data.
   */
  calculateSummary(
    holdings: Array<{
      quantity: Decimal;
      averageCost: Decimal;
      stock: {
        prices: Array<{ closePrice: Decimal }>;
      };
    }>,
    cashBalance: Decimal,
  ): { totalInvested: Decimal; totalMarketValue: Decimal; totalUnrealizedPnl: Decimal; dailyChange: Decimal } {
    let totalInvested = new Decimal(0);
    let totalMarketValue = new Decimal(0);
    let dailyChange = new Decimal(0);

    for (const h of holdings) {
      const currentPrice = h.stock.prices[0]?.closePrice ?? h.averageCost;
      const previousClose = h.stock.prices[1]?.closePrice ?? currentPrice;

      const costBasis = h.quantity.mul(h.averageCost);
      const marketValue = h.quantity.mul(currentPrice);
      const holdingDailyChange = h.quantity.mul(currentPrice.sub(previousClose));

      totalInvested = totalInvested.add(costBasis);
      totalMarketValue = totalMarketValue.add(marketValue);
      dailyChange = dailyChange.add(holdingDailyChange);
    }

    const totalUnrealizedPnl = totalMarketValue.sub(totalInvested);

    return { totalInvested, totalMarketValue, totalUnrealizedPnl, dailyChange };
  }

  /**
   * Calculate detailed holding entries.
   */
  calculateHoldings(
    holdings: Array<{
      stockId: string;
      quantity: Decimal;
      averageCost: Decimal;
      stock: {
        symbol: string;
        name: string;
        sector: string;
        prices: Array<{ closePrice: Decimal }>;
      };
    }>,
    totalPortfolioValue: Decimal,
  ): HoldingDetail[] {
    return holdings.map((h) => {
      const currentPrice = h.stock.prices[0]?.closePrice ?? h.averageCost;
      const previousClose = h.stock.prices[1]?.closePrice ?? currentPrice;

      const marketValue = h.quantity.mul(currentPrice);
      const costBasis = h.quantity.mul(h.averageCost);
      const unrealizedPnl = marketValue.sub(costBasis);
      const pnlPercent = costBasis.gt(0)
        ? unrealizedPnl.div(costBasis).mul(100).toNumber()
        : 0;

      const dailyChange = currentPrice.sub(previousClose).mul(h.quantity);
      const dailyChangePct = previousClose.gt(0)
        ? currentPrice.sub(previousClose).div(previousClose).mul(100).toNumber()
        : 0;

      const weight = totalPortfolioValue.gt(0)
        ? marketValue.div(totalPortfolioValue).mul(100).toNumber()
        : 0;

      return {
        stockId: h.stockId,
        symbol: h.stock.symbol,
        name: h.stock.name,
        sector: h.stock.sector,
        quantity: h.quantity.toNumber(),
        averageCost: h.averageCost.toNumber(),
        currentPrice: currentPrice.toNumber(),
        previousClose: previousClose.toNumber(),
        marketValue: marketValue.toNumber(),
        costBasis: costBasis.toNumber(),
        unrealizedPnl: unrealizedPnl.toNumber(),
        pnlPercent: round2(pnlPercent),
        dailyChange: dailyChange.toNumber(),
        dailyChangePct: round2(dailyChangePct),
        weight: round2(weight),
      };
    });
  }

  /**
   * Calculate asset allocation breakdown.
   */
  calculateAllocation(
    holdingDetails: HoldingDetail[],
    cashBalance: number,
    totalPortfolioValue: number,
  ): AllocationEntry[] {
    const allocations: AllocationEntry[] = [];

    // Cash allocation
    if (cashBalance > 0 && totalPortfolioValue > 0) {
      allocations.push({
        assetType: 'CASH',
        value: cashBalance,
        percentage: round2((cashBalance / totalPortfolioValue) * 100),
      });
    }

    // Per-stock allocations
    for (const h of holdingDetails) {
      allocations.push({
        assetType: 'STOCK',
        sector: h.sector,
        symbol: h.symbol,
        value: h.marketValue,
        percentage: round2(h.weight),
      });
    }

    // Sort by percentage descending
    allocations.sort((a, b) => b.percentage - a.percentage);
    return allocations;
  }

  /**
   * Calculate sector allocation (aggregated by sector).
   */
  calculateSectorAllocation(holdingDetails: HoldingDetail[]): Array<{ sector: string; percentage: number }> {
    const sectorMap = new Map<string, number>();
    for (const h of holdingDetails) {
      const current = sectorMap.get(h.sector) ?? 0;
      sectorMap.set(h.sector, current + h.weight);
    }

    return Array.from(sectorMap.entries())
      .map(([sector, percentage]) => ({ sector, percentage: round2(percentage) }))
      .sort((a, b) => b.percentage - a.percentage);
  }

  /**
   * Calculate performance metrics by comparing current value to historical snapshots.
   */
  calculatePerformance(
    currentValue: Decimal,
    currentCost: Decimal,
    snapshots: Array<{
      snapshotDate: Date;
      /** Stocks only — the basis for every return below. */
      holdingsValue: Decimal;
      totalCost: Decimal;
    }>,
  ): PerformanceMetrics {
    const now = new Date();
    const oneDay = 24 * 60 * 60 * 1000;

    const findSnapshot = (daysAgo: number) => {
      const target = new Date(now.getTime() - daysAgo * oneDay);
      // Find nearest snapshot
      return snapshots.find((s) => {
        const diff = Math.abs(s.snapshotDate.getTime() - target.getTime());
        return diff < 2 * oneDay; // within 2 days
      });
    };

    const calcReturn = (pastValue: Decimal | undefined) => {
      if (!pastValue || pastValue.eq(0)) return { abs: new Decimal(0), pct: new Decimal(0) };
      const ret = currentValue.sub(pastValue);
      const pct = ret.div(pastValue).mul(100);
      return { abs: ret, pct };
    };

    const daily = calcReturn(findSnapshot(1)?.holdingsValue);
    const weekly = calcReturn(findSnapshot(7)?.holdingsValue);
    const monthly = calcReturn(findSnapshot(30)?.holdingsValue);
    const yearly = calcReturn(findSnapshot(365)?.holdingsValue);

    // Lifetime = current value vs total cost (all-time P&L)
    const lifetimeReturn = currentValue.sub(currentCost);
    const lifetimeReturnPct = currentCost.gt(0)
      ? lifetimeReturn.div(currentCost).mul(100)
      : new Decimal(0);

    return {
      dailyReturn: daily.abs.toNumber(),
      dailyReturnPct: round2(daily.pct.toNumber()),
      weeklyReturn: weekly.abs.toNumber(),
      weeklyReturnPct: round2(weekly.pct.toNumber()),
      monthlyReturn: monthly.abs.toNumber(),
      monthlyReturnPct: round2(monthly.pct.toNumber()),
      yearlyReturn: yearly.abs.toNumber(),
      yearlyReturnPct: round2(yearly.pct.toNumber()),
      lifetimeReturn: lifetimeReturn.toNumber(),
      lifetimeReturnPct: round2(lifetimeReturnPct.toNumber()),
    };
  }

  /**
   * Calculate analytics data from holdings.
   */
  calculateAnalytics(holdingDetails: HoldingDetail[]): AnalyticsData {
    if (holdingDetails.length === 0) {
      return {
        topPerformer: null,
        worstPerformer: null,
        largestPosition: null,
        sectorAllocation: [],
        totalDividendsEarned: 0,
        numberOfTrades: 0,
        averageHoldingSize: 0,
      };
    }

    const sorted = [...holdingDetails].sort((a, b) => b.pnlPercent - a.pnlPercent);
    const topPerformer = sorted[0];
    const worstPerformer = sorted[sorted.length - 1];

    const byWeight = [...holdingDetails].sort((a, b) => b.weight - a.weight);
    const largestPosition = byWeight[0];

    const sectorAllocation = this.calculateSectorAllocation(holdingDetails);
    const avgSize = holdingDetails.reduce((s, h) => s + h.marketValue, 0) / holdingDetails.length;

    return {
      topPerformer: topPerformer
        ? { symbol: topPerformer.symbol, name: topPerformer.name, pnlPercent: topPerformer.pnlPercent }
        : null,
      worstPerformer: worstPerformer
        ? { symbol: worstPerformer.symbol, name: worstPerformer.name, pnlPercent: worstPerformer.pnlPercent }
        : null,
      largestPosition: largestPosition
        ? { symbol: largestPosition.symbol, name: largestPosition.name, weight: largestPosition.weight }
        : null,
      sectorAllocation,
      totalDividendsEarned: 0, // TODO: sum from DividendDistribution
      numberOfTrades: 0, // Set by caller
      averageHoldingSize: round2(avgSize),
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
