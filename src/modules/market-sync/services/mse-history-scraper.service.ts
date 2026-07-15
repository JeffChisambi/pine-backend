import { Injectable, Logger } from '@nestjs/common';
import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';

export interface MsePricePoint {
  date: string;   // "YYYY-MM-DD"
  close: number;
}

/**
 * Maps MSE ticker symbol → ISIN code.
 * Source: https://mse.co.mw/market/mainboard (company href attributes)
 */
const SYMBOL_TO_ISIN: Record<string, string> = {
  AIRTEL:   'MWAIRT001156',
  BHL:      'MWBHL0010029',
  FDHB:     'MWFDHB001166',
  FMBCH:    'MWFMB0010138',
  ICON:     'MWICON001146',
  ILLOVO:   'MWILLV010032',
  MPICO:    'MWMPI0010116',
  NBM:      'MWNBM0010074',
  NBS:      'MWNBS0010105',
  NICO:     'MWNICO010014',
  NITL:     'MWNITL010091',
  OMU:      'ZAE000255360',
  PCL:      'MWPCL0010053',
  STANDARD: 'MWSTD0010041',
  SUNBIRD:  'MWSTL0010085',
  TNM:      'MWTNM0010126',
};

/**
 * Maps period label → months parameter used by MSE AJAX endpoint.
 * POST /company/company/{ISIN}/{months}
 */
export const MSE_PERIOD_MONTHS: Record<string, number> = {
  '1M':  1,
  '3M':  2,   // MSE uses "2" for 3 months
  '6M':  6,
  '1Y':  12,
  '2Y':  24,
  '5Y':  60,
};

/**
 * Fetches historical price data from the MSE website's Chart.js AJAX
 * endpoint for each listed company.
 *
 * MSE uses jQuery $.post to hit /company/company/{ISIN}/{months}, which
 * returns an HTML fragment containing a Chart.js initialisation script.
 * We extract the labels (dates) and data (closing prices) arrays from
 * that script using regex.
 *
 * This service opens a SINGLE browser context per run, visits the MSE
 * mainboard to establish a session, then loops through each company to
 * fetch their history.  Closing the context after each run prevents
 * resource leaks.
 */
@Injectable()
export class MseHistoryScraperService {
  private readonly logger = new Logger(MseHistoryScraperService.name);

  getIsin(symbol: string): string | null {
    return SYMBOL_TO_ISIN[symbol.toUpperCase()] ?? null;
  }

  getAllSymbols(): string[] {
    return Object.keys(SYMBOL_TO_ISIN);
  }

  /**
   * Fetch the full price history for a single company using Playwright.
   *
   * @param symbol  Stock ticker (e.g. "FDHB")
   * @param months  MSE period months value (1, 2, 6, 12, 24, 60)
   */
  async fetchHistory(
    symbol: string,
    months: number,
    existingPage?: Page,
  ): Promise<MsePricePoint[]> {
    const isin = this.getIsin(symbol);
    if (!isin) {
      this.logger.warn(`No ISIN found for symbol ${symbol}`);
      return [];
    }

    const url = `https://mse.co.mw/company/company/${isin}/${months}`;
    this.logger.debug(`Fetching history for ${symbol} (${isin}) months=${months}`);

    try {
      if (existingPage) {
        return await this.fetchViaPage(existingPage, url, symbol);
      }
      // One-off fetch — spin up a browser, hit the company page first for
      // cookies/session, then POST to the chart endpoint
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      });
      try {
        const page = await context.newPage();
        // Establish session on company page first
        await page.goto(`https://mse.co.mw/company/${isin}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        return await this.fetchViaPage(page, url, symbol);
      } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      }
    } catch (err) {
      this.logger.error(
        { err, symbol, isin, months },
        `Failed to fetch history for ${symbol}`,
      );
      return [];
    }
  }

  /**
   * Bulk-fetch 1-year history for ALL MSE-listed companies using a single
   * browser session.  Returns a map of symbol → price points.
   */
  async fetchAllHistory(months = 12): Promise<Map<string, MsePricePoint[]>> {
    const result = new Map<string, MsePricePoint[]>();

    this.logger.log(`Starting bulk history fetch for all symbols (months=${months})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });

    try {
      const page = await context.newPage();

      // Visit mainboard first — establishes session cookies
      this.logger.log('Navigating to MSE mainboard to establish session…');
      await page.goto('https://mse.co.mw/market/mainboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });

      for (const symbol of Object.keys(SYMBOL_TO_ISIN)) {
        const isin = SYMBOL_TO_ISIN[symbol];
        const url = `https://mse.co.mw/company/company/${isin}/${months}`;

        // First visit the company page to prime session for this company
        await page.goto(`https://mse.co.mw/company/${isin}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        }).catch(() => {});

        const points = await this.fetchViaPage(page, url, symbol);
        result.set(symbol, points);

        this.logger.log(
          `${symbol}: fetched ${points.length} price points`,
        );

        // Respectful delay between companies
        await new Promise((r) => setTimeout(r, 800));
      }
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    this.logger.log(
      `Bulk history fetch complete — ${result.size} companies processed`,
    );
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Execute a POST to the MSE chart endpoint FROM WITHIN the browser
   * context (so session cookies are included), then parse the
   * Chart.js labels + data from the returned HTML fragment.
   */
  private async fetchViaPage(
    page: Page,
    url: string,
    symbol: string,
  ): Promise<MsePricePoint[]> {
    const html: string = await page.evaluate(async (chartUrl: string) => {
      try {
        const resp = await fetch(chartUrl, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html, */*; q=0.01',
          },
          credentials: 'include',
        });
        if (!resp.ok) return '';
        return resp.text();
      } catch {
        return '';
      }
    }, url);

    if (!html || html.trim().length < 50) {
      this.logger.warn(`Empty or short response for ${symbol} at ${url}`);
      return [];
    }

    return this.parseChartHtml(html, symbol);
  }

  /**
   * Parse the Chart.js initialisation script from the returned HTML fragment.
   *
   * The MSE endpoint returns HTML like:
   * ```html
   * <canvas id="myChart"></canvas>
   * <script>
   *   var ctx = document.getElementById('myChart').getContext('2d');
   *   var myChart = new Chart(ctx, {
   *     type: 'line',
   *     data: {
   *       labels: ["15 Jul 2025","16 Jul 2025",...],
   *       datasets: [{ data: [513.72, 514.00, ...] }]
   *     }
   *   });
   * </script>
   * ```
   *
   * We extract labels and data arrays using regex patterns.
   */
  parseChartHtml(html: string, symbol: string): MsePricePoint[] {
    try {
      // Extract labels array — quoted strings
      const labelsMatch = html.match(/labels\s*:\s*(\[[\s\S]*?\])/);
      // Extract data array — numbers only
      const dataMatch = html.match(
        /datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/,
      );

      if (!labelsMatch) {
        this.logger.warn(`Could not find labels in chart HTML for ${symbol}`);
        return [];
      }
      if (!dataMatch) {
        this.logger.warn(`Could not find data in chart HTML for ${symbol}`);
        return [];
      }

      // Parse labels — they may be in various date formats:
      // "15 Jul 2025", "Jul 15, 2025", "2025-07-15", etc.
      const rawLabels = JSON.parse(labelsMatch[1]) as string[];
      const rawData = JSON.parse(dataMatch[1]) as number[];

      if (rawLabels.length !== rawData.length) {
        this.logger.warn(
          `Label/data length mismatch for ${symbol}: ` +
          `${rawLabels.length} labels vs ${rawData.length} data points`,
        );
      }

      const count = Math.min(rawLabels.length, rawData.length);
      const points: MsePricePoint[] = [];

      for (let i = 0; i < count; i++) {
        const price = rawData[i];
        if (!price || isNaN(price) || price <= 0) continue;

        const date = this.normaliseDate(rawLabels[i]);
        if (!date) continue;

        points.push({ date, close: price });
      }

      return points;
    } catch (err) {
      this.logger.error(
        { err, symbol },
        `Failed to parse chart HTML for ${symbol}`,
      );
      return [];
    }
  }

  /**
   * Converts various MSE date label formats to "YYYY-MM-DD".
   *
   * Handles:
   *   "15 Jul 2025"  → "2025-07-15"
   *   "Jul 15, 2025" → "2025-07-15"
   *   "2025-07-15"   → "2025-07-15"  (already ISO)
   */
  private normaliseDate(raw: string): string | null {
    if (!raw) return null;

    const cleaned = raw.trim();

    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

    // Try native Date parse as fallback
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }

    return null;
  }
}
