import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import type {
  IMarketSyncRepository,
  StockRecord,
} from '../interfaces/market-sync-repository.interface';
import type { SyncRunLog } from '../domain/sync-run-log';

const CACHE_PREFIX = 'market-sync';
const LATEST_PRICES_KEY = `${CACHE_PREFIX}:prices:latest`;
const SYNC_RUNS_KEY = `${CACHE_PREFIX}:runs`;
const STOCK_CACHE_KEY = `${CACHE_PREFIX}:stocks:active`;
const LATEST_PRICES_TTL = 300; // 5 minutes
const STOCK_CACHE_TTL = 3600; // 1 hour
const MAX_SYNC_RUNS_STORED = 100;

/**
 * Prisma + Redis-backed repository for market-sync persistence.
 *
 * Read-heavy paths (stock catalogue, latest prices) are cached in
 * Redis with appropriate TTLs. Write paths (upsert prices, record
 * sync runs) go directly to Postgres and invalidate/update the cache.
 *
 * All price upserts use the `(stockId, tradedAt)` unique constraint
 * for idempotency — running the same sync twice for the same date
 * simply overwrites with the latest values, no duplicates.
 */
@Injectable()
export class MarketSyncRepository implements IMarketSyncRepository {
  private readonly logger = new Logger(MarketSyncRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Stock catalogue
  // ──────────────────────────────────────────────────────────────

  async getAllActiveStocks(): Promise<StockRecord[]> {
    // Check cache first
    const cached = await this.redis.get(STOCK_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached) as StockRecord[];
      } catch {
        // Corrupted cache — fall through to DB
      }
    }

    const stocks = await this.prisma.stock.findMany({
      where: { isActive: true },
      select: { id: true, symbol: true, name: true, sector: true },
    });

    // Cache for 1 hour — stock catalogue changes very infrequently
    await this.redis.set(STOCK_CACHE_KEY, JSON.stringify(stocks), 'EX', STOCK_CACHE_TTL);

    return stocks;
  }

  // ──────────────────────────────────────────────────────────────
  // Price upserts
  // ──────────────────────────────────────────────────────────────

  async upsertStockPrices(
    prices: Array<{
      stockId: string;
      openPrice: string;
      closePrice: string;
      highPrice: string;
      lowPrice: string;
      volume: string;
      turnover?: string;
      changePct?: string;
      tradedAt: Date;
    }>,
  ): Promise<number> {
    if (prices.length === 0) return 0;

    let upsertedCount = 0;

    // Batch upserts inside a transaction for atomicity
    await this.prisma.$transaction(async (tx) => {
      for (const price of prices) {
        await tx.stockPrice.upsert({
          where: {
            stockId_tradedAt: {
              stockId: price.stockId,
              tradedAt: price.tradedAt,
            },
          },
          update: {
            openPrice: price.openPrice,
            closePrice: price.closePrice,
            highPrice: price.highPrice,
            lowPrice: price.lowPrice,
            volume: BigInt(Math.floor(parseFloat(price.volume))),
            ...(price.turnover != null ? { turnover: price.turnover.replace(/,/g, '') } : {}),
            ...(price.changePct != null ? { changePct: price.changePct } : {}),
          },
          create: {
            stockId: price.stockId,
            openPrice: price.openPrice,
            closePrice: price.closePrice,
            highPrice: price.highPrice,
            lowPrice: price.lowPrice,
            volume: BigInt(Math.floor(parseFloat(price.volume))),
            turnover: price.turnover != null ? price.turnover.replace(/,/g, '') : null,
            changePct: price.changePct ?? null,
            tradedAt: price.tradedAt,
            source: 'mse-scraper',
          },
        });
        upsertedCount++;
      }
    });

    // Update the latest prices cache
    await this.updateLatestPricesCache(prices);

    this.logger.log({ upsertedCount }, `Upserted ${upsertedCount} stock prices`);
    return upsertedCount;
  }

  private async updateLatestPricesCache(
    prices: Array<{
      stockId: string;
      openPrice: string;
      closePrice: string;
      volume: string;
      tradedAt: Date;
    }>,
  ): Promise<void> {
    try {
      const cachePayload = prices.map((p) => ({
        stockId: p.stockId,
        openPrice: p.openPrice,
        closePrice: p.closePrice,
        volume: p.volume,
        tradedAt: p.tradedAt.toISOString(),
      }));
      await this.redis.set(
        LATEST_PRICES_KEY,
        JSON.stringify(cachePayload),
        'EX',
        LATEST_PRICES_TTL,
      );
    } catch (error) {
      // Cache write failure is non-critical — log and continue
      this.logger.warn({ err: error }, 'Failed to update latest prices cache');
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Market calendar
  // ──────────────────────────────────────────────────────────────

  async getMarketStatus(date: Date): Promise<string | null> {
    // Normalize to date-only (strip time component)
    const dateOnly = new Date(Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ));

    const entry = await this.prisma.marketCalendar.findUnique({
      where: { date: dateOnly },
      select: { status: true },
    });

    return entry?.status ?? null;
  }

  // ──────────────────────────────────────────────────────────────
  // Sync run audit log (Redis-backed for operational speed)
  // ──────────────────────────────────────────────────────────────

  async recordSyncRun(log: SyncRunLog): Promise<void> {
    try {
      // Push to a Redis list, keeping only the most recent N runs
      await this.redis.lpush(SYNC_RUNS_KEY, JSON.stringify(log));
      await this.redis.ltrim(SYNC_RUNS_KEY, 0, MAX_SYNC_RUNS_STORED - 1);
    } catch (error) {
      // Sync run logging is operational, not critical — don't crash
      this.logger.warn({ err: error }, 'Failed to record sync run in Redis');
    }
  }

  async getRecentSyncRuns(limit = 20): Promise<SyncRunLog[]> {
    try {
      const raw = await this.redis.lrange(SYNC_RUNS_KEY, 0, limit - 1);
      return raw.map((entry) => JSON.parse(entry) as SyncRunLog);
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to read sync runs from Redis');
      return [];
    }
  }
}
