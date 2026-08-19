import type { ValidatedStockRow } from '../domain/market-data.schema';
import type { SyncRunLog } from '../domain/sync-run-log';

/**
 * Repository port for market-sync persistence operations.
 * Implemented by `MarketSyncRepository` (Prisma-backed) and
 * mockable in unit tests.
 */
export const MARKET_SYNC_REPOSITORY = Symbol('MARKET_SYNC_REPOSITORY');

export interface StockRecord {
  id: string;
  symbol: string;
  name: string;
  sector: string;
}

export interface IMarketSyncRepository {
  /**
   * Returns all active stock symbols from the catalogue.
   * Used to validate scraped symbols against known stocks.
   */
  getAllActiveStocks(): Promise<StockRecord[]>;

  /** Latest stored close per stock (pre-upsert snapshot for move detection). */
  getLatestCloses(stockIds: string[]): Promise<Array<{ stockId: string; closePrice: string }>>;

  /**
   * Batch upserts stock prices for a given trading date.
   * Uses the `(stockId, tradedAt)` unique constraint for
   * idempotent writes — safe to re-run the same sync multiple times.
   *
   * @returns Number of rows actually upserted
   */
  upsertStockPrices(
    prices: Array<{
      stockId: string;
      openPrice: string;
      closePrice: string;
      highPrice: string;
      lowPrice: string;
      volume: string;
      changePct?: string;
      tradedAt: Date;
    }>,
  ): Promise<number>;

  /**
   * Checks the market calendar for the given date.
   * Returns the market status or null if no entry exists.
   */
  getMarketStatus(date: Date): Promise<string | null>;

  /**
   * Persists a sync run log for operational audit.
   */
  recordSyncRun(log: SyncRunLog): Promise<void>;

  /**
   * Retrieves recent sync run history for admin dashboard.
   * @param limit Max number of runs to return (default 20)
   */
  getRecentSyncRuns(limit?: number): Promise<SyncRunLog[]>;
}
