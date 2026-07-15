import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { MseHistoryScraperService } from './mse-history-scraper.service';

/**
 * Orchestrates daily historical price fetching from the MSE website.
 *
 * The mainboard scraper runs every 5 minutes and only captures today's
 * open/close/volume.  This service runs once per day (and on demand)
 * to back-fill the price history that powers the chart on the stock
 * detail screen.
 *
 * Architecture:
 *   @Cron → fetchAllHistory() → parseChartHtml() → upsert DB rows
 *
 * Performance: ~16 companies × 800 ms delay = ~30 seconds per run.
 * This is run at 2 AM to avoid competing with market-hours scrapes.
 */
@Injectable()
export class MseHistorySyncService {
  private readonly logger = new Logger(MseHistorySyncService.name);
  private isRunning = false;

  constructor(
    private readonly scraper: MseHistoryScraperService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Run once per day at 2:00 AM to refresh the chart history for all
   * MSE-listed companies.  Fetches 1-year of data (MSE months=12).
   */
  @Cron('0 2 * * *', { name: 'mse-history-sync' })
  async runDailySync(): Promise<void> {
    this.logger.log('Daily MSE history sync triggered by cron');
    await this.syncHistory(12);
  }

  /**
   * On-demand sync — called by the API controller or after the first
   * mainboard scrape to populate history for the first time.
   *
   * @param months  MSE months value (1, 2, 6, 12, 24, 60)
   */
  async syncHistory(months = 12): Promise<{ symbol: string; upserted: number }[]> {
    if (this.isRunning) {
      this.logger.warn('History sync already in progress — skipping');
      return [];
    }

    this.isRunning = true;
    const results: { symbol: string; upserted: number }[] = [];

    try {
      // Fetch all active stocks from DB so we can match symbol → stockId
      const stocks = await this.prisma.stock.findMany({
        where: { isActive: true },
        select: { id: true, symbol: true },
      });
      const symbolToId = new Map(stocks.map((s) => [s.symbol, s.id]));

      // Bulk-fetch history from MSE (single browser session for efficiency)
      const historyMap = await this.scraper.fetchAllHistory(months);

      for (const [symbol, points] of historyMap) {
        const stockId = symbolToId.get(symbol);
        if (!stockId) {
          this.logger.warn(`${symbol}: not found in DB — skipping`);
          continue;
        }

        if (points.length === 0) {
          this.logger.warn(`${symbol}: no price points returned`);
          results.push({ symbol, upserted: 0 });
          continue;
        }

        let upserted = 0;

        // Upsert each price point — idempotent on (stockId, tradedAt)
        await this.prisma.$transaction(async (tx) => {
          for (const point of points) {
            const tradedAt = new Date(point.date + 'T00:00:00.000Z');
            const priceStr = point.close.toFixed(4);

            await tx.stockPrice.upsert({
              where: {
                stockId_tradedAt: { stockId, tradedAt },
              },
              update: {
                closePrice: priceStr,
                // Only update high/low if they weren't set by the live scraper
              },
              create: {
                stockId,
                tradedAt,
                openPrice: priceStr,
                closePrice: priceStr,
                highPrice: priceStr,
                lowPrice: priceStr,
                volume: BigInt(0),
                source: 'mse-chart-history',
              },
            });
            upserted++;
          }
        });

        results.push({ symbol, upserted });
        this.logger.log(`${symbol}: upserted ${upserted} historical price points`);
      }
    } catch (err) {
      this.logger.error({ err }, 'History sync failed');
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  /**
   * Fetch and store history for a SINGLE company.
   * Used by the on-demand API endpoint.
   */
  async syncSingleCompany(
    symbol: string,
    months = 12,
  ): Promise<number> {
    const stock = await this.prisma.stock.findFirst({
      where: { symbol: symbol.toUpperCase(), isActive: true },
      select: { id: true },
    });

    if (!stock) throw new Error(`Stock ${symbol} not found in DB`);

    const points = await this.scraper.fetchHistory(symbol, months);
    if (points.length === 0) return 0;

    let upserted = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const point of points) {
        const tradedAt = new Date(point.date + 'T00:00:00.000Z');
        const priceStr = point.close.toFixed(4);
        await tx.stockPrice.upsert({
          where: { stockId_tradedAt: { stockId: stock.id, tradedAt } },
          update: { closePrice: priceStr },
          create: {
            stockId: stock.id,
            tradedAt,
            openPrice: priceStr,
            closePrice: priceStr,
            highPrice: priceStr,
            lowPrice: priceStr,
            volume: BigInt(0),
            source: 'mse-chart-history',
          },
        });
        upserted++;
      }
    });

    return upserted;
  }
}
