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
 * Maps period label → months parameter used by MSE AJAX endpoint.
 * POST /company/{ISIN}/{months} returns an HTML snippet with the chart canvas.
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
 * Fetches historical price data from MSE company chart AJAX endpoints.
 *
 * HOW THE MSE CHART WORKS (discovered via browser inspection):
 *   1. Company page: https://mse.co.mw/company/{ISIN}
 *   2. On load, jQuery fires: POST https://mse.co.mw/company/{ISIN}/1  (1M data)
 *   3. Clicking a period tab fires: POST https://mse.co.mw/company/{ISIN}/{months}
 *   4. The POST response is an HTML snippet:
 *        <canvas id="chart" data-bs-chart='{"type":"line","data":{"labels":[...],"datasets":[{"data":[...]}]}}'>
 *   5. bs-init.js reads `data-bs-chart` and calls `new Chart(canvas, config)`.
 *
 * WHY page.evaluate() / response interception DOESN'T WORK:
 *   - GoDaddy WAF blocks in-page XHR (jQuery $.ajax) from headless browsers.
 *   - The response interceptor (page.on('response')) never fires because the
 *     AJAX POST is blocked before it reaches the server.
 *
 * THE SOLUTION — page.request.post():
 *   - Playwright's APIRequestContext runs HTTP requests from Node.js (not the
 *     browser page), using the same cookie jar as the browser.
 *   - This bypasses WAF bot detection that targets in-page XHR.
 *   - The Laravel session cookie (established by navigating to the company page)
 *     is automatically included, satisfying the GoDaddy firewall.
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
      const page = await context.newPage();
      // Establish session via mainboard first
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
   * Bulk-fetch history for ALL MSE-listed companies in a single browser session.
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

      // Establish session on the mainboard — sets Laravel session cookie
      this.logger.log('Establishing MSE session via mainboard…');
      await page.goto('https://mse.co.mw/market/mainboard', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {
        this.logger.warn('Mainboard navigation failed — continuing anyway');
      });
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
   * Uses page.request.post() — Playwright's APIRequestContext — which runs
   * HTTP requests from Node.js but uses the browser's cookie jar. This
   * bypasses the GoDaddy WAF bot detection that blocks in-page jQuery XHR.
   *
   * Endpoint: POST https://mse.co.mw/company/{ISIN}/{months}
   * Response: HTML snippet with <canvas data-bs-chart='{ Chart.js config JSON }'>
   */
  private async fetchCompanyHistory(
    page: Page,
    isin: string,
    symbol: string,
    months: number,
  ): Promise<MsePricePoint[]> {
    const companyUrl = `https://mse.co.mw/company/${isin}`;

    // Navigate to company page to establish per-company Laravel session cookie
    await page.goto(companyUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await page.waitForTimeout(1500);

    // Determine periods to try: requested period first, fall back to 1M
    const periodsToTry = months === 1 ? [1] : [months, 1];

    for (const period of periodsToTry) {
      const ajaxUrl = `https://mse.co.mw/company/${isin}/${period}`;

      try {
        this.logger.debug(`${symbol}: POST ${ajaxUrl}`);

        // page.request.post() uses the browser's cookie jar from Node.js side
        const response = await page.request.post(ajaxUrl, {
          headers: {
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'text/html, */*; q=0.01',
            Referer: companyUrl,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          failOnStatusCode: false,
        });

        const status = response.status();

        if (!response.ok()) {
          this.logger.warn(`${symbol}: period=${period} returned HTTP ${status}`);
          continue;
        }

        const html = await response.text();
        this.logger.debug(`${symbol}: period=${period} response: ${html.length} chars`);

        if (html.trim().length < 50) {
          this.logger.warn(`${symbol}: period=${period} response too short (${html.length} chars)`);
          continue;
        }

        const points = this.parseChartHtml(html, symbol);
        if (points.length > 0) {
          if (period !== months) {
            this.logger.warn(`${symbol}: using fallback period=${period} (${points.length} points)`);
          }
          return points;
        }

        this.logger.warn(`${symbol}: period=${period} parsed 0 points — response snippet: ${html.slice(0, 200)}`);

      } catch (err) {
        this.logger.warn({ err, symbol }, `${symbol}: AJAX POST failed for period=${period}`);
      }
    }

    // Last resort: try to extract from Chart.js window object (after page render)
    return this.tryExtractFromPageJs(page, symbol);
  }

  /**
   * Last-resort fallback: read Chart.js data from the JavaScript window object
   * after the chart has rendered on the page.
   */
  private async tryExtractFromPageJs(
    page: Page,
    symbol: string,
  ): Promise<MsePricePoint[]> {
    try {
      await page.waitForTimeout(2000);

      const chartData = await page.evaluate(() => {
        // Chart.js v3+: global registry
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

        // Chart.js v2: canvas._chart
        const canvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas of canvases) {
          const chart =
            (canvas as any)._chart ||
            (canvas as any).__chartjs_chart__ ||
            (window as any).Chart?.getChart?.(canvas);

          if (chart?.data?.labels?.length && chart?.data?.datasets?.[0]?.data?.length) {
            return {
              labels: chart.data.labels as string[],
              data: chart.data.datasets[0].data as number[],
            };
          }
        }

        // Common globals
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
   * Parse the HTML snippet returned by the MSE chart AJAX endpoint.
   *
   * The response is a <canvas> element with the chart config in the
   * `data-bs-chart` attribute as JSON (the primary strategy).
   * Additional strategies handle older/alternative formats.
   */
  parseChartHtml(html: string, symbol: string): MsePricePoint[] {
    try {
      // ── Strategy 0 (PRIMARY): MSE data-bs-chart attribute ─────────────
      // Response: <canvas id="chart" data-bs-chart='{"type":"line","data":{"labels":[...],"datasets":[{"data":[...]}]}}'>
      // The bs-init.js reads this attribute and calls new Chart(canvas, config).
      const bsAttrMatch =
        // Single-quoted attribute value
        html.match(/data-bs-chart\s*=\s*'([\s\S]*?)'\s*(?:>|\/?>|\s)/) ||
        // Double-quoted attribute value
        html.match(/data-bs-chart\s*=\s*"([\s\S]*?)"\s*(?:>|\/?>|\s)/);

      if (bsAttrMatch) {
        try {
          const raw = bsAttrMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');

          const cfg = JSON.parse(raw) as {
            data?: { labels?: string[]; datasets?: Array<{ data?: number[] }> };
          };

          const labels  = cfg?.data?.labels ?? [];
          const dataset = cfg?.data?.datasets?.[0]?.data ?? [];

          if (labels.length > 0 && dataset.length > 0) {
            this.logger.debug(
              `${symbol}: parsed ${Math.min(labels.length, dataset.length)} points from data-bs-chart`,
            );
            return this.buildPoints(labels, dataset, symbol);
          }
        } catch (e) {
          this.logger.warn({ e, symbol }, 'data-bs-chart JSON parse failed');
        }
      }

      // ── Strategy 1: Standard Chart.js init — double-quoted labels ─────
      const s1L = html.match(/labels\s*:\s*(\["[\s\S]*?"\])/);
      const s1D = html.match(/datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/);
      if (s1L && s1D) return this.parseLabelsAndData(s1L[1], s1D[1], symbol);

      // ── Strategy 2: Single-quoted labels ─────────────────────────────
      const s2L = html.match(/labels\s*:\s*(\['[\s\S]*?'\])/);
      const s2D = html.match(/datasets\s*:\s*\[[\s\S]*?data\s*:\s*(\[\s*[\d.,\s]+\s*\])/);
      if (s2L && s2D) return this.parseLabelsAndData(s2L[1], s2D[1], symbol);

      // ── Strategy 3: Loose labels + key-quoted data ────────────────────
      const s3L = html.match(/labels\s*:\s*(\[[\s\S]*?\](?=\s*[,}]))/);
      const s3D = html.match(/["']\s*data\s*["']\s*:\s*(\[[\d.,\s]+\])/);
      if (s3L && s3D) return this.parseLabelsAndData(s3L[1], s3D[1], symbol);

      // ── Strategy 4: JSON {dates:[...], prices:[...]} ──────────────────
      const s4D = html.match(/"dates"\s*:\s*(\[[\s\S]*?\])/);
      const s4V = html.match(/"(?:prices|values|data)"\s*:\s*(\[[\d.,\s]+\])/);
      if (s4D && s4V) return this.parseLabelsAndData(s4D[1], s4V[1], symbol);

      this.logger.debug(
        `No chart pattern found in HTML for ${symbol} (${html.length} chars) — ` +
        `snippet: ${html.slice(0, 300)}`,
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
      const rawLabels = JSON.parse(labelsJson.replace(/'/g, '"')) as string[];
      const rawData   = JSON.parse(dataJson.replace(/'/g, '"')) as number[];
      return this.buildPoints(rawLabels, rawData, symbol);
    } catch (err) {
      this.logger.warn({ err, symbol }, 'JSON.parse failed for chart labels/data');
      return [];
    }
  }

  private buildPoints(labels: string[], data: number[], symbol: string): MsePricePoint[] {
    const count = Math.min(labels.length, data.length);
    const points: MsePricePoint[] = [];
    for (let i = 0; i < count; i++) {
      const price = Number(data[i]);
      if (!price || isNaN(price) || price <= 0) continue;
      const date = this.normaliseDate(labels[i]);
      if (date) points.push({ date, close: price });
    }
    this.logger.debug(`Built ${points.length} price points for ${symbol}`);
    return points;
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
