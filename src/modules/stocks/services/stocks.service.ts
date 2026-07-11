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
  priceHistory: Array<{
    date: string;          // "2026-07-04"
    close: number;
    open: number;
    high: number;
    low: number;
    volume: number;
  }>;
}

function toListItem(row: StockRow): StockListItem {
  const priceRaw = parseFloat(row.latestPrice?.closePrice ?? '0');

  // Prefer the MSE-provided changePct (stored in DB) over recalculating
  const storedChangePct = row.latestPrice?.changePct != null
    ? parseFloat(row.latestPrice.changePct)
    : null;
  const calculatedChangePct = calcChangePct(
    row.latestPrice?.closePrice ?? null,
    row.prevClosePrice,
  ) ?? 0;
  const changePct = storedChangePct ?? calculatedChangePct;
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

  async getStockDetail(symbol: string): Promise<StockDetailItem> {
    const row = await this.repo.findBySymbol(symbol);
    if (!row) throw new NotFoundException(`Stock "${symbol}" not found`);

    const history = await this.repo.findPriceHistory(row.id, 30);

    const base = toListItem(row);

    return {
      ...base,
      description: row.description,
      openPrice: fmtPrice(row.latestPrice?.openPrice ?? null),
      highPrice: fmtPrice(row.latestPrice?.highPrice ?? null),
      lowPrice: fmtPrice(row.latestPrice?.lowPrice ?? null),
      listedShares: row.listedShares
        ? Number(row.listedShares).toLocaleString('en')
        : null,
      priceHistory: history.map((h) => ({
        date: h.tradedAt.toISOString().slice(0, 10),
        close: parseFloat(h.closePrice.toString()),
        open: parseFloat(h.openPrice.toString()),
        high: parseFloat(h.highPrice.toString()),
        low: parseFloat(h.lowPrice.toString()),
        volume: Number(h.volume),
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
