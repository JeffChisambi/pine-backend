import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { AppConfigService } from '../../../config/app-config.service';
import type { IMarketDataSource } from '../interfaces/market-data-source.interface';
import { MarketDataSourceError } from '../interfaces/market-data-source.interface';
import type { RawMarketSnapshot, RawStockRow } from '../domain/raw-market-snapshot';

/**
 * Production-grade Playwright scraper for the Malawi Stock Exchange
 * mainboard at https://mse.co.mw/market/mainboard.
 *
 * Design decisions:
 *
 * 1. **GoDaddy Firewall Bypass**: The MSE site sits behind a GoDaddy
 *    security firewall that returns 403 to direct HTTP requests. We
 *    navigate to the homepage first to establish session cookies, then
 *    proceed to the mainboard page.
 *
 * 2. **Browser Pool**: A single Chromium instance is kept alive across
 *    sync runs (launched at module init, closed at shutdown). Each
 *    scrape creates a fresh `BrowserContext` (isolated cookies/cache)
 *    and disposes it after extraction — preventing memory leaks from
 *    tab accumulation while avoiding the 2–4 second cold-start penalty
 *    of launching a new browser per run.
 *
 * 3. **Stealth**: Realistic user-agent, viewport, and locale settings
 *    to avoid bot detection. No additional stealth plugins — the MSE
 *    site's firewall is session-cookie-based, not fingerprint-based.
 *
 * 4. **Screenshot-on-Failure**: On any extraction error, a timestamped
 *    screenshot is saved to `/tmp/pine-market-sync/` for debugging.
 *
 * 5. **Timeouts**: 30s for page navigation, 10s for data extraction.
 *    These are generous to accommodate the MSE site's occasionally
 *    slow response times from Malawi.
 */
@Injectable()
export class MseScraperService implements IMarketDataSource, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MseScraperService.name);
  private browser: Browser | null = null;
  private readonly baseUrl: string;
  private readonly mainboardPath = '/market/mainboard';
  private browserHealthy = false;

  readonly sourceName = 'mse-playwright-scraper';

  // Timeouts
  private readonly navigationTimeoutMs = 30_000;
  private readonly extractionTimeoutMs = 10_000;

  constructor(private readonly config: AppConfigService) {
    this.baseUrl = process.env.MSE_BASE_URL ?? 'https://mse.co.mw';
  }

  async onModuleInit(): Promise<void> {
    await this.launchBrowser();
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeBrowser();
  }

  // ──────────────────────────────────────────────────────────────
  // Browser lifecycle
  // ──────────────────────────────────────────────────────────────

  private async launchBrowser(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--no-first-run',
        ],
      });
      this.browserHealthy = true;
      this.logger.log('Chromium browser launched for MSE scraping');
    } catch (error) {
      this.browserHealthy = false;
      this.logger.error({ err: error }, 'Failed to launch Chromium browser');
    }
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        this.logger.log('Chromium browser closed');
      } catch (error) {
        this.logger.warn({ err: error }, 'Error closing Chromium browser');
      } finally {
        this.browser = null;
        this.browserHealthy = false;
      }
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.logger.warn('Browser not connected — relaunching');
      await this.closeBrowser();
      await this.launchBrowser();
    }
    if (!this.browser) {
      throw new MarketDataSourceError(
        'Failed to launch Chromium browser',
        this.sourceName,
      );
    }
    return this.browser;
  }

  // ──────────────────────────────────────────────────────────────
  // IMarketDataSource implementation
  // ──────────────────────────────────────────────────────────────

  async isHealthy(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) {
      return false;
    }
    return this.browserHealthy;
  }

  async scrape(): Promise<RawMarketSnapshot> {
    const startTime = Date.now();

    if (this.config.market.mockFallback) {
      this.logger.log('Scraper using configured mock market data');
      return this.generateMockSnapshot();
    }

    const browser = await this.ensureBrowser();
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      // Fresh context per scrape — isolated cookies, no state bleed
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'Africa/Blantyre',
        javaScriptEnabled: true,
      });

      page = await context.newPage();

      // Set reasonable timeouts
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      page.setDefaultTimeout(this.extractionTimeoutMs);

      // ── Step 1: Visit homepage to establish session cookies ──
      this.logger.debug('Navigating to MSE homepage for cookie establishment');
      await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded' });
      // Wait for the firewall redirect/cookie-set to complete
      await page.waitForTimeout(2000);

      // ── Step 2: Navigate to mainboard ─────────────────────────
      const mainboardUrl = `${this.baseUrl}${this.mainboardPath}`;
      this.logger.debug({ url: mainboardUrl }, 'Navigating to mainboard');
      await page.goto(mainboardUrl, { waitUntil: 'domcontentloaded' });

      // Wait for the data table to appear
      await page.waitForSelector('table.table tbody tr', {
        timeout: this.extractionTimeoutMs,
      });

      // ── Step 3: Extract market metadata ───────────────────────
      const metadata = await this.extractMarketMetadata(page);

      // ── Step 4: Extract stock table data ──────────────────────
      const rows = await this.extractStockRows(page);

      const durationMs = Date.now() - startTime;
      this.logger.log(
        { rows: rows.length, durationMs, marketStatus: metadata.marketStatus },
        `MSE scrape complete: ${rows.length} stocks in ${durationMs}ms`,
      );

      return {
        scrapedAt: new Date(),
        marketStatus: metadata.marketStatus,
        lastUpdatedRaw: metadata.lastUpdated,
        rows,
        sourceUrl: mainboardUrl,
      };
    } catch (error) {
      this.browserHealthy = false;

      // Screenshot on failure
      if (page) {
        try {
          const screenshotPath = `./logs/market-sync-failure-${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          this.logger.error(
            { err: error, screenshotPath },
            'MSE scrape failed — screenshot saved',
          );
        } catch {
          this.logger.error({ err: error }, 'MSE scrape failed — screenshot also failed');
        }
      }

      throw new MarketDataSourceError(
        `MSE scrape failed: ${error instanceof Error ? error.message : String(error)}`,
        this.sourceName,
        error,
      );
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {
          // Context close failures are non-critical
        }
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Extraction logic
  // ──────────────────────────────────────────────────────────────

  private async extractMarketMetadata(
    page: Page,
  ): Promise<{ marketStatus: string; lastUpdated: string }> {
    try {
      // The MSE page has a header area with market status and last update time.
      // We try multiple selectors for resilience against minor HTML changes.
      const marketStatus = await page
        .locator('text=/Market Status/i')
        .first()
        .evaluate((el) => {
          const text = el.textContent ?? '';
          // Extract status after "Market Status:"
          const match = text.match(/Market\s*Status\s*:?\s*(.+)/i);
          return match ? match[1].trim() : text.trim();
        })
        .catch(() => 'UNKNOWN');

      const lastUpdated = await page
        .locator('text=/Updated on/i')
        .first()
        .evaluate((el) => {
          const text = el.textContent ?? '';
          const match = text.match(/Updated\s*on\s*:?\s*(.+)/i);
          return match ? match[1].trim() : text.trim();
        })
        .catch(() => new Date().toISOString());

      return { marketStatus, lastUpdated };
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Could not extract market metadata — using defaults',
      );
      return { marketStatus: 'UNKNOWN', lastUpdated: new Date().toISOString() };
    }
  }

  private async extractStockRows(page: Page): Promise<RawStockRow[]> {
    // Locate all data rows in the main table. The MSE mainboard uses
    // a standard <table> with <tbody><tr> rows.
    const rows = await page.$$eval(
      'table.table tbody tr',
      (trs: Element[]) => {
        return trs
          .map((tr) => {
            const cells = Array.from(tr.querySelectorAll('td'));
            if (cells.length < 6) return null; // skip header/empty rows

            // Column order: Symbol | Open Price | Close Price | % Change | Volume | Turnover
            const symbolCell = cells[0];
            const symbolLink = symbolCell?.querySelector('a');
            const symbol = (symbolLink?.textContent ?? symbolCell?.textContent ?? '').trim();

            // Extract ISIN from the company link href
            // Format: https://mse.co.mw/company/MW0000000012
            const href = symbolLink?.getAttribute('href') ?? '';
            const isinMatch = href.match(/\/company\/([A-Z0-9]+)/i);
            const isin = isinMatch ? isinMatch[1] : '';

            const openPrice = (cells[1]?.textContent ?? '0').trim();
            const closePrice = (cells[2]?.textContent ?? '0').trim();
            const changePct = (cells[3]?.textContent ?? '0').trim();
            const volume = (cells[4]?.textContent ?? '0').trim();
            const turnover = (cells[5]?.textContent ?? '0').trim();

            return { symbol, isin, openPrice, closePrice, changePct, volume, turnover };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null && row.symbol.length > 0);
      },
    );

    if (rows.length === 0) {
      throw new MarketDataSourceError(
        'No stock rows extracted from MSE mainboard — page structure may have changed',
        this.sourceName,
      );
    }

    return rows;
  }

  private generateMockSnapshot(): RawMarketSnapshot {
    const basePrices: Record<string, number> = {
      AIRTEL: 75.00,
      FDHB: 85.00,
      ICON: 15.00,
      ILLOVO: 1050.00,
      MPICO: 20.00,
      NBM: 1150.00,
      NBS: 110.00,
      NICO: 120.00,
      NITL: 130.00,
      OMU: 1500.00,
      PCL: 2200.00,
      STANDARD: 2400.00,
      SUNBIRD: 190.00,
      TNM: 45.00,
    };

    const rows: RawStockRow[] = Object.entries(basePrices).map(([symbol, basePrice]) => {
      // Generate realistic daily fluctuations (-1.5% to +2.5%)
      const openVar = (Math.random() * 0.04) - 0.015; // -1.5% to +2.5%
      const closeVar = (Math.random() * 0.03) - 0.015; // -1.5% to +1.5% from open

      const openVal = basePrice * (1 + openVar);
      const closeVal = openVal * (1 + closeVar);
      const changeVal = ((closeVal - openVal) / openVal) * 100;

      const volumeVal = Math.floor(Math.random() * 500_000) + 10_000;
      const turnoverVal = closeVal * volumeVal;

      return {
        symbol,
        isin: `MW${symbol.padEnd(10, '0')}`,
        openPrice: openVal.toFixed(2),
        closePrice: closeVal.toFixed(2),
        changePct: (changeVal >= 0 ? '+' : '') + changeVal.toFixed(2),
        volume: volumeVal.toString(),
        turnover: turnoverVal.toFixed(2),
      };
    });

    return {
      scrapedAt: new Date(),
      marketStatus: 'OPEN',
      lastUpdatedRaw: new Date().toLocaleDateString('en-GB') + ' 02:00pm',
      rows,
      sourceUrl: 'https://mse.co.mw/market/mainboard-mock',
    };
  }
}
