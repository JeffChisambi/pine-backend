import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
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
 * Maps months param → the text of the tab link on the MSE company page.
 * The months value is used in the POST URL: /company/company/{ISIN}/{months}
 */
const MONTHS_TO_TAB_TEXT: Partial<Record<number, string>> = {
  2:  '3 Months',
  6:  '6 Months',
  12: '1 Year',
  24: '2 Years',
  60: '5 Years',
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
 * Strategy (avoids CSRF issues with raw fetch() POSTs):
 *   1. Navigate to the MSE company page (loads 1M chart by default)
 *   2. Set up a Playwright response interceptor on the chart AJAX endpoint
 *   3. Click the desired period tab — jQuery fires the POST with proper
 *      CSRF headers automatically
 *   4. Capture the intercepted HTML response
 *   5. Parse Chart.js labels (dates) + data (prices) from the HTML fragment
 *
 * Fallback: For 1-month data, extract directly from the initial page HTML
 * (no tab click needed).
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
        '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      // Accept all cookies including the Laravel XSRF-TOKEN
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
        await new Promise((r) => setTimeout(r, 1200));
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
   */
  private async fetchCompanyHistory(
    page: Page,
    isin: string,
    symbol: string,
    months: number,
  ): Promise<MsePricePoint[]> {
    const companyUrl = `https://mse.co.mw/company/${isin}`;

    if (months === 1) {
      // 1-month data is embedded in the initial page HTML — no tab click needed
      await page.goto(companyUrl, { waitUntil: 'networkidle', timeout: 25_000 });
      const html = await page.content();
      return this.parseChartHtml(html, symbol);
    }

    const tabText = MONTHS_TO_TAB_TEXT[months];
    if (!tabText) {
      this.logger.warn(`Unknown months value ${months} for ${symbol}`);
      return [];
    }

    // Navigate to the company page (this sets session cookies and loads 1M chart)
    await page.goto(companyUrl, { waitUntil: 'networkidle', timeout: 25_000 });

    // Set up interceptor BEFORE clicking the tab, so we don't miss the response
    const chartUrlPattern = `/company/company/${isin}/`;
    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.url().includes(chartUrlPattern) &&
        resp.request().method() === 'POST' &&
        resp.status() < 400,
      { timeout: 20_000 },
    );

    // Find and click the period tab — jQuery fires the POST with CSRF token
    const tabLocator = page.locator(`a:has-text("${tabText}")`).first();
    const tabVisible = await tabLocator.isVisible().catch(() => false);

    if (!tabVisible) {
      // Try alt selector formats (some MSE pages may differ slightly)
      this.logger.warn(`Tab "${tabText}" not visible for ${symbol} — trying href pattern`);
      const hrefTab = page.locator(`a[href*="/${months}"]`).first();
      const hrefVisible = await hrefTab.isVisible().catch(() => false);
      if (!hrefVisible) {
        this.logger.warn(`No tab found for ${symbol} months=${months}`);
        return this.tryExtractFromPageJs(page, symbol);
      }
      await hrefTab.click();
    } else {
      await tabLocator.click();
    }

    // Wait for and capture the AJAX response
    let html: string;
    try {
      const response = await responsePromise;
      html = await response.text();
      this.logger.debug(`${symbol} AJAX response: ${html.length} chars`);
    } catch (timeoutErr) {
      this.logger.warn(
        `AJAX response timed out for ${symbol} months=${months} — falling back to page JS`,
      );
      return this.tryExtractFromPageJs(page, symbol);
    }

    if (!html || html.trim().length < 50) {
      this.logger.warn(`Short AJAX response for ${symbol} (${html?.length ?? 0} chars) — falling back`);
      return this.tryExtractFromPageJs(page, symbol);
    }

    return this.parseChartHtml(html, symbol);
  }

  /**
   * Fallback: read Chart.js data directly from the JavaScript window object
   * after the chart has been rendered on the page.
   */
  private async tryExtractFromPageJs(
    page: Page,
    symbol: string,
  ): Promise<MsePricePoint[]> {
    try {
      await page.waitForTimeout(2000); // let any pending JS finish

      const chartData = await page.evaluate(() => {
        // Chart.js v2/v3 stores the chart on the canvas element
        const canvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas of canvases) {
          const chart =
            (canvas as any)._chart || // Chart.js v2
            (canvas as any).__chartjs_chart__ || // Chart.js v3+
            (window as any).myChart; // common global

          if (chart?.data?.labels && chart?.data?.datasets?.[0]?.data) {
            return {
              labels: chart.data.labels as string[],
              data: chart.data.datasets[0].data as number[],
            };
          }
        }
        // Also try common globals
        if ((window as any).myChart?.data) {
          const c = (window as any).myChart;
          return {
            labels: c.data.labels as string[],
            data: c.data.datasets[0].data as number[],
          };
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
   * AJAX endpoint or the full company page.
   *
   * Handles formats like:
   *   labels: ["15 Jul 2025","16 Jul 2025", ...]
   *   data: [513.72, 514.00, ...]
   */
  parseChartHtml(html: string, symbol: string): MsePricePoint[] {
    try {
      // Extract labels array (quoted date strings)
      const labelsMatch = html.match(/labels\s*:\s*(\[[\s\S]*?\])/);
      // Extract data array from first dataset (numbers only)
      const dataMatch = html.match(
        /datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/,
      );

      if (!labelsMatch || !dataMatch) {
        this.logger.debug(
          `No Chart.js pattern found in HTML for ${symbol} ` +
          `(labelsMatch=${!!labelsMatch}, dataMatch=${!!dataMatch})`,
        );
        return [];
      }

      const rawLabels = JSON.parse(labelsMatch[1]) as string[];
      const rawData = JSON.parse(dataMatch[1]) as number[];
      const count = Math.min(rawLabels.length, rawData.length);
      const points: MsePricePoint[] = [];

      for (let i = 0; i < count; i++) {
        const price = Number(rawData[i]);
        if (!price || isNaN(price) || price <= 0) continue;
        const date = this.normaliseDate(rawLabels[i]);
        if (date) points.push({ date, close: price });
      }

      return points;
    } catch (err) {
      this.logger.error({ err, symbol }, 'Failed to parse chart HTML');
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
