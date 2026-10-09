import { Decimal } from '@prisma/client/runtime/library';
import { ZERO } from './position';

/**
 * Investment performance over time, separated from money put in or taken out.
 *
 * The old Analytics chart plotted market value and called the change growth,
 * so buying MK 100,000 of stock looked like a MK 100,000 gain — or, measured
 * from an earlier smaller balance, a huge percentage return. Money invested is
 * not money earned.
 *
 * This is a time-weighted return over the daily portfolio snapshots. Each
 * interval between two snapshots earns
 *
 *     r = (V_end − V_start − F) / (V_start + max(F, 0))
 *
 * where F is the net money traded into the stocks during the interval (buys
 * at their execution value, sales negative). A purchase therefore adds to
 * both the value and F and cancels out; only price movement since the
 * purchase remains. Buys count as invested from the start of the interval;
 * sales are treated as leaving at its end, which keeps the formula stable on
 * the day a position is sold off completely. Intervals are chained:
 *
 *     cumulative = Π(1 + r) − 1
 *
 * Flows are valued at execution prices, so this measures price performance
 * before fees; fees are reported separately as a cost.
 *
 * What it does not do: invent history. With fewer than two points there is
 * no series, and a gap between snapshots is one interval, not several
 * guessed ones.
 */

export interface ValuePoint {
  /** The day the value belongs to (end of day). */
  date: Date;
  value: Decimal;
}

export interface CashFlow {
  date: Date;
  /** Positive for a purchase, negative for a sale, at execution value. */
  amount: Decimal;
}

export interface PerformancePoint {
  date: Date;
  /** Market value of the stocks held, at the end of this day. */
  value: number;
  /** Net money traded in since the window began. */
  netInvested: number;
  /** Investment gain since the window began, contributions excluded. */
  gain: number;
  /** Time-weighted return since the window began, in %. */
  returnPct: number;
}

export interface PerformanceSeries {
  points: PerformancePoint[];
  /** Return over the window, in %; null when there is not enough history. */
  returnPct: number | null;
  /** Money gained or lost from price movement over the window. */
  gain: number | null;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * @param points  daily values, any order; one per day (the last wins)
 * @param flows   every trade's execution value, any order
 * @param from    start of the window; points before it still feed the chain
 */
export function timeWeightedSeries(
  points: ValuePoint[],
  flows: CashFlow[],
  from?: Date,
): PerformanceSeries {
  const byDay = new Map<string, ValuePoint>();
  for (const p of points) byDay.set(dayKey(p.date), p);
  const ordered = [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());

  if (ordered.length === 0) return { points: [], returnPct: null, gain: null };

  const flowByDay = new Map<string, Decimal>();
  for (const f of flows) {
    const k = dayKey(f.date);
    flowByDay.set(k, (flowByDay.get(k) ?? ZERO).add(f.amount));
  }

  // The day of the first purchase is a real interval: from what was paid to
  // that evening's value. Start the chain from nothing the day before.
  const firstKey = dayKey(ordered[0].date);
  const flowOnFirst = flowByDay.get(firstKey);
  if (flowOnFirst && !flowOnFirst.eq(0)) {
    ordered.unshift({ date: new Date(ordered[0].date.getTime() - 86_400_000), value: ZERO });
  }

  const flowBetween = (after: Date, upTo: Date): Decimal => {
    let sum = ZERO;
    const a = dayKey(after);
    const b = dayKey(upTo);
    for (const [k, v] of flowByDay) if (k > a && k <= b) sum = sum.add(v);
    return sum;
  };

  // Chain the whole history, then express the window relative to its start.
  const index: number[] = [1];
  const gains: Decimal[] = [ZERO];
  const flowsTo: Decimal[] = [ZERO];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const f = flowBetween(prev.date, cur.date);
    const gain = cur.value.sub(prev.value).sub(f);
    const base = prev.value.add(Decimal.max(f, ZERO));
    const r = base.gt(0) ? gain.div(base).toNumber() : 0;
    index.push(index[i - 1] * (1 + r));
    gains.push(gains[i - 1].add(gain));
    flowsTo.push(flowsTo[i - 1].add(f));
  }

  let start = 0;
  if (from) {
    const fromKey = dayKey(from);
    // The last point on or before the window start is the baseline.
    for (let i = 0; i < ordered.length; i++) if (dayKey(ordered[i].date) <= fromKey) start = i;
  }

  const out: PerformancePoint[] = [];
  for (let i = start; i < ordered.length; i++) {
    out.push({
      date: ordered[i].date,
      value: ordered[i].value.toNumber(),
      netInvested: flowsTo[i].sub(flowsTo[start]).toNumber(),
      gain: gains[i].sub(gains[start]).toNumber(),
      returnPct: (index[i] / index[start] - 1) * 100,
    });
  }

  if (out.length < 2) return { points: out, returnPct: null, gain: null };
  const last = out[out.length - 1];
  return { points: out, returnPct: last.returnPct, gain: last.gain };
}
