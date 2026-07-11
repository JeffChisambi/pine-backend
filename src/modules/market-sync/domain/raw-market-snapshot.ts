/**
 * Raw market data types as scraped from the MSE website, before any
 * validation or transformation. These types represent the exact shape
 * of data extracted from the DOM — string-typed throughout because the
 * scraper should never silently coerce malformed data into numbers.
 *
 * The validation layer (`MarketDataValidator`) is responsible for
 * parsing these strings into typed, validated `ValidatedStockPrice`
 * objects that are safe to persist.
 */

export interface RawStockRow {
  /** Ticker symbol as displayed on MSE, e.g. "NBM", "AIRTEL" */
  symbol: string;

  /** ISIN code extracted from the company link href, e.g. "MW0000000012" */
  isin: string;

  /** Raw open price string, comma-formatted, e.g. "2,150.00" */
  openPrice: string;

  /** Raw close/last price string, comma-formatted, e.g. "2,181.25" */
  closePrice: string;

  /** Raw percentage change string, e.g. "+1.45", "-0.32", "0.00" */
  changePct: string;

  /** Raw volume string, comma-formatted, e.g. "6,727,987" */
  volume: string;

  /** Raw turnover string in MWK, comma-formatted, e.g. "14,472,961,225.00" */
  turnover: string;
}

export interface RawMarketSnapshot {
  /** When the scraper captured this snapshot */
  scrapedAt: Date;

  /** Market status as displayed on the page header */
  marketStatus: string;

  /** Raw "Updated on" timestamp string from the page, e.g. "02/07/26 02:00pm" */
  lastUpdatedRaw: string;

  /** The individual stock rows extracted from the main table */
  rows: RawStockRow[];

  /** URL that was actually scraped (for audit) */
  sourceUrl: string;
}
