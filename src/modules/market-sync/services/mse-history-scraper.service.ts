import { Injectable, Logger } from '@nestjs/common';
import type { Response, Page } from 'playwright';
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
 */
export const MSE_PERIOD_MONTHS: Record<string, number> = {
  '1M':  1,
  '3M':  2,
  '6M':  6,
  '1Y':  12,
  '2Y':  24,
  '5Y':  60,
};

/**
 * Fetches historical price data from MSE company pages using Playwright.
 *
 * KEY INSIGHT (discovered from logs):
 *   The chart data is NOT embedded in the page HTML. The MSE company page
 *   fires an automatic AJAX POST to /company/company/{ISIN}/1 when it
 *   initialises, and the chart data is in that response.
 *
 * Strategy for each company:
 *   1. Register a response interceptor BEFORE navigating (so we don't miss
 *      the automatic 1M AJAX call that fires on page init).
 *   2. Navigate to the company page and wait 5s for all AJAX to complete.
 *   3. Parse any captured AJAX responses for chart data.
 *   4. For periods > 1M, also issue a browser-side fetch() POST to the
 *      desired period endpoint using the CSRF token from cookies.
 *   5. Fall back to Chart.js window object inspection.
 *   6. Remove the response listener (page.off) after each company.
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
   * Fetch history for a single company (opens its own browser session).
   * Used by syncSingleCompany for on-demand per-stock refreshes.
   */
  async fetchHistory(symbol: string, months = 12): Promise<MsePricePoint[]> {
    const isin = this.getIsin(symbol);
    if (!isin) {
      this.logger.warn(`No ISIN for symbol ${symbol}`);
      return [];
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    try {
      // Establish session on the mainboard first
      const page = await context.newPage();
      await page.goto('https://mse.co.mw/market/mainboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {});
      return await this.fetchCompanyHistory(page, isin, symbol, months);
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  /**
   * Bulk-fetch history for ALL MSE-listed companies in a single browser
   * session.  Returns a map of symbol → price points.
   *
   * @param months  MSE months value: 1=1M, 2=3M, 6=6M, 12=1Y, 24=2Y, 60=5Y
   */
  async fetchAllHistory(months = 12): Promise<Map<string, MsePricePoint[]>> {
    const result = new Map<string, MsePricePoint[]>();

    this.logger.log(`Starting bulk history fetch for all symbols (months=${months})`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    try {
      const page = await context.newPage();

      // Prime the session on the mainboard before individual company pages
      this.logger.log('Establishing MSE session via mainboard…');
      await page.goto('https://mse.co.mw/market/mainboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {
        this.logger.warn('Mainboard navigation failed — continuing anyway');
      });
      // Allow cookies to settle
      await page.waitForTimeout(2000);

      for (const symbol of Object.keys(SYMBOL_TO_ISIN)) {
        const isin = SYMBOL_TO_ISIN[symbol];

        try {
          const points = await this.fetchCompanyHistory(page, isin, symbol, months);
          result.set(symbol, points);
          this.logger.log(`${symbol}: fetched ${points.length} price points`);
        } catch (err) {
          this.logger.error({ err, symbol }, `Failed to fetch history for ${symbol}`);
          result.set(symbol, []);
        }

        // Polite delay between companies to avoid rate limiting
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    this.logger.log(`Bulk history fetch complete — ${result.size} companies processed`);
    return result;
  }

  /**
   * Fetch history for a single company using an existing Playwright page.
   *
   * IMPORTANT: The MSE site fires an AJAX POST to /company/company/{ISIN}/1
   * when the company page first loads (for the default 1M view). We must
   * register the response listener BEFORE navigating so we don't miss it.
   */
  private async fetchCompanyHistory(
    page: Page,
    isin: string,
    symbol: string,
    months: number,
  ): Promise<MsePricePoint[]> {
    const companyUrl = `https://mse.co.mw/company/${isin}`;
    const ajaxUrlFragment = `/company/company/${isin}/`;

    // ── Step 1: Register response interceptor BEFORE navigating ──────────
    // The company page fires an automatic AJAX POST for 1M data on load.
    // We capture ALL responses matching the chart AJAX URL pattern.
    const capturedBodies: string[] = [];

    const responseHandler = async (response: Response) => {
      try {
        if (
          response.url().includes(ajaxUrlFragment) &&
          response.status() >= 200 &&
          response.status() < 300
        ) {
          const body = await response.text();
          if (body.trim().length > 50) {
            capturedBodies.push(body);
            this.logger.debug(
              `${symbol}: captured AJAX response from ${response.url()} (${body.length} chars)`,
            );
          }
        }
      } catch {
        // Response body read failures are non-critical
      }
    };

    page.on('response', responseHandler);

    try {
      // ── Step 2: Navigate to company page ─────────────────────────────
      await page.goto(companyUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });

      // Wait generously for the automatic 1M AJAX call + any slow network
      await page.waitForTimeout(5000);

      // ── Step 3: Check captured AJAX responses ─────────────────────────
      for (const body of capturedBodies) {
        const points = this.parseChartHtml(body, symbol);
        if (points.length > 0) {
          if (months === 1) {
            this.logger.debug(`${symbol}: returning ${points.length} points from captured 1M AJAX`);
            return points;
          }
          // For > 1M, keep these as a fallback and continue to the period request
          this.logger.debug(`${symbol}: cached 1M AJAX data (${points.length} points) as fallback`);
        }
      }

      // ── Step 4: For periods > 1M, POST to the desired period endpoint ─
      if (months !== 1) {
        const ajaxUrl = `https://mse.co.mw/company/company/${isin}/${months}`;

        try {
          const html = await page.evaluate(async (url: string) => {
            // Laravel stores the CSRF token in a meta tag
            const csrfMeta = document.querySelector(
              'meta[name="csrf-token"]',
            ) as HTMLMetaElement | null;
            const csrfToken = csrfMeta?.content ?? '';

            const res = await fetch(url, {
              method: 'POST',
              headers: {
                'X-CSRF-TOKEN': csrfToken,
                'X-Requested-With': 'XMLHttpRequest',
                Accept: 'text/html, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              credentials: 'include',
            });

            if (!res.ok) {
              return `__HTTP_ERROR__:${res.status}`;
            }
            return res.text();
          }, ajaxUrl);

          if (html && !html.startsWith('__HTTP_ERROR__') && html.trim().length > 50) {
            this.logger.debug(`${symbol} period AJAX fetch: ${html.length} chars`);
            const points = this.parseChartHtml(html, symbol);
            if (points.length > 0) return points;
            this.logger.warn(`${symbol}: period AJAX parsed 0 points`);
          } else {
            this.logger.warn(`${symbol}: period AJAX returned: ${html?.slice(0, 80)}`);
          }
        } catch (err) {
          this.logger.warn({ err, symbol }, `Period AJAX POST failed for ${symbol}`);
        }

        // Fall back to the captured 1M data
        for (const body of capturedBodies) {
          const points = this.parseChartHtml(body, symbol);
          if (points.length > 0) {
            this.logger.warn(`${symbol}: using 1M fallback data (${points.length} points)`);
            return points;
          }
        }
      }

      // ── Step 5: Try to extract from Chart.js window object ────────────
      return this.tryExtractFromPageJs(page, symbol);

    } finally {
      // CRITICAL: always remove the listener to prevent memory leaks / interference
      page.off('response', responseHandler);
    }
  }

  /**
   * Fallback: read Chart.js data directly from the JavaScript window object
   * after the chart has been rendered on the page.
   *
   * Tries multiple Chart.js storage patterns (v2, v3, custom globals).
   */
  private async tryExtractFromPageJs(
    page: Page,
    symbol: string,
  ): Promise<MsePricePoint[]> {
    try {
      await page.waitForTimeout(2000); // let any pending JS finish

      const chartData = await page.evaluate(() => {
        // ── Chart.js v3+: global registry ──────────────────────────────
        const ChartJs = (window as any).Chart;
        if (ChartJs?.instances) {
          const instances = Object.values(ChartJs.instances) as any[];
          for (const chart of instances) {
            if (chart?.data?.labels?.length && chart?.data?.datasets?.[0]?.data?.length) {
              return {
                labels: chart.data.labels as string[],
                data: chart.data.datasets[0].data as number[],
              };
            }
          }
        }

        // ── Chart.js v2: canvas._chart ──────────────────────────────────
        const canvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas of canvases) {
          const chart =
            (canvas as any)._chart ||            // Chart.js v2
            (canvas as any).__chartjs_chart__ || // Chart.js v3 alt
            (window as any).Chart?.getChart?.(canvas); // Chart.js v3+

          if (chart?.data?.labels?.length && chart?.data?.datasets?.[0]?.data?.length) {
            return {
              labels: chart.data.labels as string[],
              data: chart.data.datasets[0].data as number[],
            };
          }
        }

        // ── Common globals ──────────────────────────────────────────────
        for (const key of ['myChart', 'chart', 'priceChart', 'stockChart', 'lineChart']) {
          const c = (window as any)[key];
          if (c?.data?.labels?.length && c?.data?.datasets?.[0]?.data?.length) {
            return {
              labels: c.data.labels as string[],
              data: c.data.datasets[0].data as number[],
            };
          }
        }

        return null;
      });

      if (!chartData) {
        this.logger.warn(`No chart data found in page JS for ${symbol}`);
        return [];
      }

      const count = Math.min(chartData.labels.length, chartData.data.length);
      const points: MsePricePoint[] = [];
      for (let i = 0; i < count; i++) {
        const price = Number(chartData.data[i]);
        if (!price || isNaN(price) || price <= 0) continue;
        const date = this.normaliseDate(chartData.labels[i]);
        if (date) points.push({ date, close: price });
      }
      return points;
    } catch (err) {
      this.logger.error({ err, symbol }, 'Failed to extract chart data from page JS');
      return [];
    }
  }

  /**
   * Parse Chart.js init script from an HTML fragment returned by the MSE
   * AJAX endpoint. The fragment contains a Chart.js initialisation call
   * with labels (dates) and datasets (prices).
   *
   * Tries multiple patterns to handle MSE page variations.
   */
  parseChartHtml(html: string, symbol: string): MsePricePoint[] {
    try {
      // ── Strategy 1: Standard Chart.js – double-quoted labels ──────────
      const s1Labels = html.match(/labels\s*:\s*(\["[\s\S]*?"\])/);
      const s1Data   = html.match(/datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/);
      if (s1Labels && s1Data) {
        return this.parseLabelsAndData(s1Labels[1], s1Data[1], symbol);
      }

      // ── Strategy 2: Single-quoted labels ─────────────────────────────
      const s2Labels = html.match(/labels\s*:\s*(\['[\s\S]*?'\])/);
      const s2Data   = html.match(/datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/);
      if (s2Labels && s2Data) {
        return this.parseLabelsAndData(s2Labels[1], s2Data[1], symbol);
      }

      // ── Strategy 3: Loose labels (any quote style) + key-quoted data ──
      const s3Labels = html.match(/labels\s*:\s*(\[[\s\S]*?\](?=\s*[,}]))/);
      const s3Data   = html.match(/["']\s*data\s*["']\s*:\s*(\[[\d.,\s]+\])/);
      if (s3Labels && s3Data) {
        return this.parseLabelsAndData(s3Labels[1], s3Data[1], symbol);
      }

      // ── Strategy 4: JSON response {"dates":[...],"prices":[...]} ──────
      const s4Dates  = html.match(/"dates"\s*:\s*(\[[\s\S]*?\])/);
      const s4Values = html.match(/"(?:prices|values|data)"\s*:\s*(\[[\d.,\s]+\])/);
      if (s4Dates && s4Values) {
        return this.parseLabelsAndData(s4Dates[1], s4Values[1], symbol);
      }

      // ── Strategy 5: var labels=[...]; var data=[...]; ─────────────────
      const s5Labels = html.match(/var\s+labels\s*=\s*(\[[\s\S]*?\]);/);
      const s5Data   = html.match(/var\s+data\s*=\s*(\[[\d.,\s]+\]);/);
      if (s5Labels && s5Data) {
        return this.parseLabelsAndData(s5Labels[1], s5Data[1], symbol);
      }

      this.logger.debug(
        `No Chart.js pattern found in HTML for ${symbol} (${html.length} chars) — ` +
        `html snippet: ${html.slice(0, 300)}`,
      );
      return [];
    } catch (err) {
      this.logger.error({ err, symbol }, 'Failed to parse chart HTML');
      return [];
    }
  }

  private parseLabelsAndData(
    labelsJson: string,
    dataJson: string,
    symbol: string,
  ): MsePricePoint[] {
    try {
      // Normalize: replace single quotes with double quotes for JSON.parse
      const labelsNorm = labelsJson.replace(/'/g, '"');
      const dataNorm   = dataJson.replace(/'/g, '"');

      const rawLabels = JSON.parse(labelsNorm) as string[];
      const rawData   = JSON.parse(dataNorm) as number[];
      const count = Math.min(rawLabels.length, rawData.length);
      const points: MsePricePoint[] = [];

      for (let i = 0; i < count; i++) {
        const price = Number(rawData[i]);
        if (!price || isNaN(price) || price <= 0) continue;
        const date = this.normaliseDate(rawLabels[i]);
        if (date) points.push({ date, close: price });
      }

      this.logger.debug(`Parsed ${points.length} price points for ${symbol}`);
      return points;
    } catch (err) {
      this.logger.warn({ err, symbol }, 'Failed to JSON.parse chart labels/data');
      return [];
    }
  }

  /**
   * Normalise various MSE date label formats to "YYYY-MM-DD".
   * Handles: "15 Jul 2025", "Jul 15, 2025", "2025-07-15", "Jul 2025"
   */
  private normaliseDate(raw: string): string | null {
    if (!raw) return null;
    const cleaned = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
}
