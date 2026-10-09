import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { round2 } from '../../../shared/portfolio/valuation';
import {
  timeWeightedSeries,
  type PerformancePoint,
  type ValuePoint,
} from '../../../shared/portfolio/performance';
import { PortfolioRepository } from '../repositories/portfolio.repository';
import { ValuationService } from './valuation.service';

export type PerformancePeriod = '1W' | '1M' | '3M' | '1Y' | 'ALL';

const PERIOD_DAYS: Record<Exclude<PerformancePeriod, 'ALL'>, number> = {
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '1Y': 365,
};

/**
 * Investment performance — how the stocks did, with money put in or taken
 * out removed.
 *
 * This replaced comparing today's market value with an earlier snapshot's
 * market value. That counted every purchase as growth: a portfolio worth
 * MK 50,000 last week that bought MK 50,000 more showed +100% for the week.
 * Every return here is a time-weighted return over the daily snapshots,
 * with each trade netted out at its execution value (see
 * src/shared/portfolio/performance.ts). It measures price performance before
 * fees; fees are reported on the summary as a separate cost.
 *
 * "Today" is the exception: it comes from the live valuation, which already
 * counts shares bought today from their purchase price, so the Analytics
 * tile and the Portfolio screen show the same number.
 *
 * A return is null, not zero, when there is not enough history to measure it.
 */
export interface PerformanceMetrics {
  dailyReturn: number | null;
  dailyReturnPct: number | null;
  weeklyReturn: number | null;
  weeklyReturnPct: number | null;
  monthlyReturn: number | null;
  monthlyReturnPct: number | null;
  yearlyReturn: number | null;
  yearlyReturnPct: number | null;
  lifetimeReturn: number | null;
  lifetimeReturnPct: number | null;
}

export interface PerformanceResponse extends PerformanceMetrics {
  period: PerformancePeriod;
  /** Return over the requested period, in %. */
  periodReturnPct: number | null;
  /** Money gained or lost from price movement over the period. */
  periodGain: number | null;
  /** One point per day; returnPct is cumulative from the period's start. */
  series: Array<{
    date: string;
    value: number;
    netInvested: number;
    gain: number;
    returnPct: number;
  }>;
  methodology: string;
}

const METHODOLOGY =
  'Time-weighted return on the stocks held, daily. Purchases and sales are netted out at their ' +
  'execution value, so buying shares is not counted as growth. Price performance before fees.';

const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

@Injectable()
export class PerformanceService {
  constructor(
    private readonly repo: PortfolioRepository,
    private readonly valuation: ValuationService,
  ) {}

  async getPerformance(userId: string, period: PerformancePeriod = '1M'): Promise<PerformanceResponse> {
    const now = new Date();
    const [valued, snapshots, flows] = await Promise.all([
      this.valuation.valuePortfolio(userId, now),
      this.repo.findAllSnapshots(userId),
      this.repo.findTradeFlows(userId),
    ]);

    // Stored daily values, with today replaced by the live valuation —
    // today's snapshot was taken at the last trade or at the close.
    const points: ValuePoint[] = snapshots.map((s) => ({ date: s.snapshotDate, value: s.holdingsValue }));
    if (points.length || flows.length) {
      points.push({ date: utcMidnight(now), value: valued.totals.marketValue });
    }

    const window = (days?: number) =>
      timeWeightedSeries(points, flows, days ? new Date(now.getTime() - days * 86_400_000) : undefined);

    const weekly = window(7);
    const monthly = window(30);
    const yearly = window(365);
    const lifetime = window();
    const selected = period === 'ALL' ? lifetime : window(PERIOD_DAYS[period]);

    const t = valued.totals;
    return {
      period,
      dailyReturn: t.dailyChange ? t.dailyChange.toNumber() : null,
      dailyReturnPct: round2(t.dailyChangePct),
      weeklyReturn: weekly.gain,
      weeklyReturnPct: round2(weekly.returnPct),
      monthlyReturn: monthly.gain,
      monthlyReturnPct: round2(monthly.returnPct),
      yearlyReturn: yearly.gain,
      yearlyReturnPct: round2(yearly.returnPct),
      lifetimeReturn: lifetime.gain,
      lifetimeReturnPct: round2(lifetime.returnPct),
      periodReturnPct: round2(selected.returnPct),
      periodGain: selected.gain,
      series: selected.points.map((p: PerformancePoint) => ({
        date: p.date.toISOString(),
        value: p.value,
        netInvested: p.netInvested,
        gain: p.gain,
        returnPct: round2(p.returnPct) ?? 0,
      })),
      methodology: METHODOLOGY,
    };
  }

  async getPerformanceHistory(userId: string, limit = 30) {
    const history = await this.repo.findPerformanceHistory(userId, limit);
    return history.map((p) => ({
      date: p.date,
      dailyReturn: p.dailyReturn.toNumber(),
      dailyReturnPct: p.dailyReturnPct.toNumber(),
      weeklyReturn: p.weeklyReturn.toNumber(),
      weeklyReturnPct: p.weeklyReturnPct.toNumber(),
      monthlyReturn: p.monthlyReturn.toNumber(),
      monthlyReturnPct: p.monthlyReturnPct.toNumber(),
      lifetimeReturn: p.lifetimeReturn.toNumber(),
      lifetimeReturnPct: p.lifetimeReturnPct.toNumber(),
    }));
  }

  /** Stores today's metrics. A return that cannot be measured is stored as 0. */
  async savePerformanceSnapshot(userId: string): Promise<void> {
    const p = await this.getPerformance(userId, 'ALL');
    const d = (n: number | null) => new Decimal(n ?? 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await this.repo.upsertPerformance({
      userId,
      date: today,
      dailyReturn: d(p.dailyReturn),
      dailyReturnPct: d(p.dailyReturnPct),
      weeklyReturn: d(p.weeklyReturn),
      weeklyReturnPct: d(p.weeklyReturnPct),
      monthlyReturn: d(p.monthlyReturn),
      monthlyReturnPct: d(p.monthlyReturnPct),
      yearlyReturn: d(p.yearlyReturn),
      yearlyReturnPct: d(p.yearlyReturnPct),
      lifetimeReturn: d(p.lifetimeReturn),
      lifetimeReturnPct: d(p.lifetimeReturnPct),
    });
  }
}
