import type { RawMarketSnapshot } from '../domain/raw-market-snapshot';

/**
 * Port interface for market data sources. The scraper implements this
 * today; a future direct API client or CSV importer would implement
 * the same interface, allowing the orchestrator to swap data sources
 * without any changes to the sync pipeline.
 *
 * This is the key abstraction that makes the module
 * microservice-extractable: the orchestrator depends on this
 * interface, never on `MseScraperService` directly.
 */
export const MARKET_DATA_SOURCE = Symbol('MARKET_DATA_SOURCE');

export interface IMarketDataSource {
  /**
   * Fetches the current market snapshot from the data source.
   *
   * @throws {MarketDataSourceError} if the source is unreachable,
   *         returns malformed HTML, or times out.
   */
  scrape(): Promise<RawMarketSnapshot>;

  /**
   * Returns `true` if the data source is available and ready to
   * serve data. Used by health checks and circuit breaker logic.
   */
  isHealthy(): Promise<boolean>;

  /**
   * Human-readable name for logging and admin UI.
   */
  readonly sourceName: string;
}

/**
 * Typed error for data-source-level failures (network, timeout,
 * DOM structure change). Distinct from validation errors, which
 * are downstream.
 */
export class MarketDataSourceError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MarketDataSourceError';
  }
}
