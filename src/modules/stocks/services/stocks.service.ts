import { Injectable, NotFoundException } from '@nestjs/common';
import { StocksRepository, StockRow } from '../repositories/stocks.repository';

/** Formats a MWK price string for display: "2,150.00" → "MWK 2,150" */
function fmtPrice(raw: string | null): string {
  if (!raw) return '—';
  const n = parseFloat(raw);
  if (isNaN(n)) return '—';
  return `MWK ${n.toLocaleString('en-MW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Calculates percentage change between two price strings. */
function calcChangePct(current: string | null, previous: string | null): number | null {
  if (!current || !previous) return null;
  const cur = parseFloat(current);
  const prev = parseFloat(previous);
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

/**
 * Maps a period string to a number of calendar days.
 * Used for fetching price history for chart rendering.
 */
export type PeriodKey = '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y';

const PERIOD_TO_DAYS: Record<PeriodKey, number> = {
  '1M':  30,
  '3M':  90,
  '6M':  180,
  '1Y':  365,
  '2Y':  730,
  '5Y':  1825,
};

export function periodToDays(period?: string): number {
  if (!period) return 30;
  return PERIOD_TO_DAYS[period.toUpperCase() as PeriodKey] ?? 30;
}

export interface StockListItem {
  id: string;
  symbol: string;
  name: string;
  sector: string;
  price: string;         // "MWK 2,150.00"
  priceRaw: number;      // 2150 — for sorting / calculations
  change: string;        // "+1.45%" or "-0.32%"
  changePct: number;     // 1.45 (signed float)
  positive: boolean;
  volume: string;        // "6,727,987"
  lastUpdated: string | null;
}

export interface StockDetailItem extends StockListItem {
  description: string | null;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  listedShares: string | null;
  marketCap: string | null;    // formatted MWK string
  turnover: string | null;     // latest day turnover formatted
  period: string;
  priceHistory: Array<{
    date: string;          // "2026-07-04"
    close: number;
    open: number;
    high: number;
    low: number;
    volume: number;
    turnover: number | null;
    changePct: number | null;
  }>;
}

function toListItem(row: StockRow): StockListItem {
  const priceRaw = parseFloat(row.latestPrice?.closePrice ?? '0');
  const open = parseFloat(row.latestPrice?.openPrice ?? '0');
  const close = parseFloat(row.latestPrice?.closePrice ?? '0');

  // The MSE mainboard table's % Change column renders 0 in static HTML;
  // the true intraday value is computed from open vs close.
  // Priority:
  //   1. Stored MSE changePct if it is genuinely non-zero
  //   2. Calculated from (close - open) / open × 100
  //   3. Fall back to prevClose comparison
  //   4. Zero
  const storedChangePct = row.latestPrice?.changePct != null
    ? parseFloat(row.latestPrice.changePct)
    : null;

  const intradayPct = open > 0 ? ((close - open) / open) * 100 : 0;
  const prevClosePct = calcChangePct(
    row.latestPrice?.closePrice ?? null,
    row.prevClosePrice,
  ) ?? 0;

  // Use stored if genuinely non-zero; else intraday; else prev-close comparison
  const changePct = (storedChangePct !== null && Math.abs(storedChangePct) > 0.001)
    ? storedChangePct
    : (Math.abs(intradayPct) > 0.001 ? intradayPct : prevClosePct);

  const positive = changePct >= 0;

  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    price: fmtPrice(row.latestPrice?.closePrice ?? null),
    priceRaw,
    change: `${positive ? '+' : ''}${changePct.toFixed(2)}%`,
    changePct,
    positive,
    volume: row.latestPrice
      ? Number(row.latestPrice.volume).toLocaleString('en')
      : '0',
    lastUpdated: row.latestPrice?.tradedAt.toISOString() ?? null,
  };
}

@Injectable()
export class StocksService {
  constructor(private readonly repo: StocksRepository) {}

  async listStocks(sector?: string): Promise<StockListItem[]> {
    const rows = await this.repo.findAllWithLatestPrice(sector);
    return rows.map(toListItem);
  }

  async searchStocks(query: string): Promise<StockListItem[]> {
    if (!query || query.trim().length < 1) return [];
    const rows = await this.repo.search(query);
    return rows.map(toListItem);
  }

  async getStockDetail(symbol: string, period?: string): Promise<StockDetailItem> {
    const row = await this.repo.findBySymbol(symbol);
    if (!row) throw new NotFoundException(`Stock "${symbol}" not found`);

    const days = periodToDays(period);
    const history = await this.repo.findPriceHistory(row.id, days);

    const base = toListItem(row);

    // Market cap = listedShares × latestClosePrice
    const listedSharesNum = row.listedShares ? Number(row.listedShares) : null;
    const closePriceNum   = row.latestPrice ? parseFloat(row.latestPrice.closePrice) : null;
    const marketCapRaw    = listedSharesNum && closePriceNum ? listedSharesNum * closePriceNum : null;
    const marketCapFmt    = marketCapRaw != null
      ? `MWK ${(marketCapRaw / 1_000_000_000).toFixed(2)}B`
      : null;

    // Turnover from latest price record (scraper stores it per day)
    const turnoverRaw  = row.latestPrice?.turnover ?? null;
    const turnoverFmt  = turnoverRaw != null
      ? `MWK ${(parseFloat(turnoverRaw) / 1_000_000).toFixed(2)}M`
      : null;

    return {
      ...base,
      description: row.description,
      openPrice: fmtPrice(row.latestPrice?.openPrice ?? null),
      highPrice: fmtPrice(row.latestPrice?.highPrice ?? null),
      lowPrice: fmtPrice(row.latestPrice?.lowPrice ?? null),
      listedShares: row.listedShares
        ? Number(row.listedShares).toLocaleString('en')
        : null,
      marketCap: marketCapFmt,
      turnover: turnoverFmt,
      period: period?.toUpperCase() ?? '1M',
      priceHistory: history.map((h) => ({
        date: h.tradedAt.toISOString().slice(0, 10),
        close: parseFloat(h.closePrice.toString()),
        open: parseFloat(h.openPrice.toString()),
        high: parseFloat(h.highPrice.toString()),
        low: parseFloat(h.lowPrice.toString()),
        volume: Number(h.volume),
        turnover: h.turnover != null ? parseFloat(h.turnover.toString()) : null,
        changePct: h.changePct != null ? parseFloat(h.changePct.toString()) : null,
      })),
    };
  }

  /** Returns the list of unique sectors for filtering. */
  async getSectors(): Promise<string[]> {
    const rows = await this.repo.findAllWithLatestPrice();
    const sectors = [...new Set(rows.map((r) => r.sector))].sort();
    return sectors;
  }
}
