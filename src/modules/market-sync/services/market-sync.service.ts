import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import {
  MARKET_DATA_SOURCE,
  type IMarketDataSource,
} from '../interfaces/market-data-source.interface';
import {
  MARKET_SYNC_REPOSITORY,
  type IMarketSyncRepository,
} from '../interfaces/market-sync-repository.interface';
import { MarketDataValidator } from '../domain/market-data.validator';
import { MarketDataSyncedEvent } from '../events/market-data-synced.event';
import { SyncRunStatus, type SyncRunLog } from '../domain/sync-run-log';

const LOCK_KEY = 'market-sync:lock';
const LOCK_TTL_SECONDS = 120;

// Circuit breaker state
const CIRCUIT_FAILURE_KEY = 'market-sync:circuit:failures';
const CIRCUIT_OPEN_KEY = 'market-sync:circuit:open-until';
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_DURATION_SECONDS = 1800; // 30 minutes

/**
 * Core orchestrator for market data synchronization. Coordinates:
 *
 * 1. Distributed lock acquisition (prevents concurrent syncs)
 * 2. Market calendar check (skip holidays/weekends unless forced)
 * 3. Data collection (via `IMarketDataSource` — currently Playwright scraper)
 * 4. Validation (via `MarketDataValidator` — Zod + cross-field + anomaly)
 * 5. Persistence (via `IMarketSyncRepository` — Prisma upserts)
 * 6. Cache update (Redis latest prices)
 * 7. Domain event emission (for downstream modules)
 * 8. Sync run audit logging
 * 9. Circuit breaker management
 *
 * This class has NO knowledge of Playwright, Prisma, or BullMQ — it
 * operates entirely through port interfaces, making it testable with
 * in-memory fakes and extractable into a microservice.
 */
@Injectable()
export class MarketSyncService {
  private readonly logger = new Logger(MarketSyncService.name);

  /** stockId → trading-day key of the last price-move notification sent. */
  private readonly priceMoveNotified = new Map<string, string>();

  constructor(
    @Inject(MARKET_DATA_SOURCE)
    private readonly dataSource: IMarketDataSource,
    @Inject(MARKET_SYNC_REPOSITORY)
    private readonly repository: IMarketSyncRepository,
    private readonly validator: MarketDataValidator,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * Execute a full sync run. Called by the BullMQ processor (for cron/retry)
   * or directly by the admin controller (for manual triggers).
   *
   * @param trigger What initiated this run
   * @param force   Skip market-calendar check and circuit breaker
   * @returns The sync run log
   */
  async executeSyncRun(
    trigger: 'cron' | 'manual' | 'retry' = 'cron',
    force = false,
  ): Promise<SyncRunLog> {
    const runId = randomUUID();
    const startedAt = new Date();

    this.logger.log({ runId, trigger, force }, 'Starting market sync run');

    // ── Circuit breaker check ───────────────────────────────────
    if (!force) {
      const circuitOpen = await this.isCircuitOpen();
      if (circuitOpen) {
        const log = this.buildLog(runId, startedAt, {
          status: SyncRunStatus.SKIPPED,
          errorMessage: 'Circuit breaker is open — too many recent failures',
          errorCode: 'CIRCUIT_BREAKER_OPEN',
        });
        await this.repository.recordSyncRun(log);
        this.logger.warn({ runId }, 'Sync skipped: circuit breaker open');
        return log;
      }
    }

    // ── Market calendar check ───────────────────────────────────
    if (!force) {
      const today = new Date();
      const marketStatus = await this.repository.getMarketStatus(today);

      if (marketStatus && marketStatus !== 'OPEN' && marketStatus !== 'PRE_OPEN') {
        const log = this.buildLog(runId, startedAt, {
          status: SyncRunStatus.SKIPPED,
          errorMessage: `Market is ${marketStatus} today — sync skipped`,
        });
        await this.repository.recordSyncRun(log);
        this.logger.log({ runId, marketStatus }, 'Sync skipped: market not open');
        return log;
      }
    }

    // ── Distributed lock ────────────────────────────────────────
    const lockAcquired = await this.acquireLock(runId);
    if (!lockAcquired) {
      const log = this.buildLog(runId, startedAt, {
        status: SyncRunStatus.SKIPPED,
        errorMessage: 'Another sync run is already in progress',
        errorCode: 'LOCK_NOT_ACQUIRED',
      });
      await this.repository.recordSyncRun(log);
      this.logger.warn({ runId }, 'Sync skipped: lock not acquired');
      return log;
    }

    try {
      // ── 1. Scrape ─────────────────────────────────────────────
      const snapshot = await this.dataSource.scrape();

      // ── 2. Validate ───────────────────────────────────────────
      const stocks = await this.repository.getAllActiveStocks();
      const knownSymbols = new Set(stocks.map((s) => s.symbol));
      const symbolToId = new Map(stocks.map((s) => [s.symbol, s.id]));

      const validation = this.validator.validate(snapshot, knownSymbols);

      if (validation.validRows.length === 0) {
        const log = this.buildLog(runId, startedAt, {
          status: SyncRunStatus.FAILED,
          rowsFailed: validation.invalidRows.length,
          errorMessage: 'No valid rows after validation',
          errorCode: 'VALIDATION_ALL_FAILED',
        });
        await this.repository.recordSyncRun(log);
        await this.recordFailure();
        return log;
      }

      // ── 3. Build price records ────────────────────────────────
      const tradingDate = this.getTradingDate();
      const priceRecords = validation.validRows
        .filter((row) => symbolToId.has(row.symbol))
        .map((row) => {
          const openPrice = row.openPrice;
          const closePrice = row.closePrice;
          // For MSE, open=high and close=low are reasonable defaults
          // when we don't have intraday OHLC data
          const highPrice = parseFloat(openPrice) >= parseFloat(closePrice)
            ? openPrice
            : closePrice;
          const lowPrice = parseFloat(openPrice) <= parseFloat(closePrice)
            ? openPrice
            : closePrice;

          return {
            stockId: symbolToId.get(row.symbol)!,
            openPrice,
            closePrice,
            highPrice,
            lowPrice,
            volume: row.volume,
            turnover: row.turnover,
            changePct: row.changePct,
            tradedAt: tradingDate,
          };
        });

      // Snapshot the latest stored closes BEFORE persisting so real price
      // movements (close changed) can be detected after the upsert.
      const prevCloses = new Map(
        (await this.repository.getLatestCloses(priceRecords.map((p) => p.stockId)))
          .map((r) => [r.stockId, parseFloat(r.closePrice)]),
      );

      // ── 4. Persist ────────────────────────────────────────────
      const upsertedCount = await this.repository.upsertStockPrices(priceRecords);

      // ── 4b. Price-move notifications ──────────────────────────
      // Emit one `market.price.moved` per stock whose close actually changed
      // (throttled to once per stock per trading day — the sync runs every
      // few minutes, and holders/watchers need a heads-up, not a ticker).
      const todayKey = tradingDate.toISOString().slice(0, 10);
      for (const rec of priceRecords) {
        const prev = prevCloses.get(rec.stockId);
        const close = parseFloat(rec.closePrice);
        const changePct = parseFloat(rec.changePct ?? '0') || 0;
        if (prev === undefined || !isFinite(close) || close === prev || changePct === 0) continue;
        if (this.priceMoveNotified.get(rec.stockId) === todayKey) continue;
        this.priceMoveNotified.set(rec.stockId, todayKey);

        const stock = stocks.find((s) => s.id === rec.stockId);
        if (!stock) continue;
        this.eventEmitter.emit('market.price.moved', {
          stockId: rec.stockId,
          symbol: stock.symbol,
          name: stock.name,
          price: close,
          changePct,
        });
      }

      // ── 5. Emit domain event ──────────────────────────────────
      const durationMs = Date.now() - startedAt.getTime();
      const event = new MarketDataSyncedEvent(
        upsertedCount,
        durationMs,
        trigger,
        validation.warnings.length,
      );
      this.eventEmitter.emit(event.eventName, event);

      // ── 6. Log warnings ───────────────────────────────────────
      if (validation.warnings.length > 0) {
        this.logger.warn(
          { warnings: validation.warnings },
          `${validation.warnings.length} validation warnings during sync`,
        );
      }

      if (validation.unknownSymbols.length > 0) {
        this.logger.warn(
          { unknownSymbols: validation.unknownSymbols },
          `${validation.unknownSymbols.length} unknown symbols found on MSE page`,
        );
      }

      // ── 7. Record success ─────────────────────────────────────
      const hasFailures = validation.invalidRows.length > 0;
      const log = this.buildLog(runId, startedAt, {
        status: hasFailures ? SyncRunStatus.PARTIAL : SyncRunStatus.SUCCESS,
        rowsProcessed: validation.validRows.length,
        rowsFailed: validation.invalidRows.length,
        rowsUpserted: upsertedCount,
      });
      await this.repository.recordSyncRun(log);

      // Reset circuit breaker on success
      await this.resetCircuitBreaker();

      this.logger.log(
        { runId, upsertedCount, durationMs, status: log.status },
        `Sync run complete: ${upsertedCount} prices upserted in ${durationMs}ms`,
      );

      return log;
    } catch (error) {
      const durationMs = Date.now() - startedAt.getTime();
      const errorMessage = error instanceof Error ? error.message : String(error);

      const log = this.buildLog(runId, startedAt, {
        status: SyncRunStatus.FAILED,
        errorMessage,
        errorCode: error instanceof Error ? error.constructor.name : 'UNKNOWN_ERROR',
      });
      await this.repository.recordSyncRun(log);

      // Track failure for circuit breaker
      await this.recordFailure();

      this.logger.error(
        { runId, err: error, durationMs },
        `Sync run failed: ${errorMessage}`,
      );

      throw error; // Re-throw so BullMQ can retry
    } finally {
      await this.releaseLock(runId);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Distributed lock
  // ──────────────────────────────────────────────────────────────

  private async acquireLock(runId: string): Promise<boolean> {
    const result = await this.redis.set(
      LOCK_KEY,
      runId,
      'EX',
      LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }

  private async releaseLock(runId: string): Promise<void> {
    // Only release if we still own the lock (prevent releasing another run's lock)
    const currentOwner = await this.redis.get(LOCK_KEY);
    if (currentOwner === runId) {
      await this.redis.del(LOCK_KEY);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Circuit breaker
  // ──────────────────────────────────────────────────────────────

  private async isCircuitOpen(): Promise<boolean> {
    const openUntil = await this.redis.get(CIRCUIT_OPEN_KEY);
    if (openUntil && Date.now() < parseInt(openUntil, 10)) {
      return true;
    }
    return false;
  }

  private async recordFailure(): Promise<void> {
    const failures = await this.redis.incr(CIRCUIT_FAILURE_KEY);
    await this.redis.expire(CIRCUIT_FAILURE_KEY, CIRCUIT_OPEN_DURATION_SECONDS);

    if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
      const openUntil = Date.now() + CIRCUIT_OPEN_DURATION_SECONDS * 1000;
      await this.redis.set(CIRCUIT_OPEN_KEY, openUntil.toString(), 'EX', CIRCUIT_OPEN_DURATION_SECONDS);
      this.logger.error(
        { failures, openForSeconds: CIRCUIT_OPEN_DURATION_SECONDS },
        'Circuit breaker OPENED — market sync paused',
      );
    }
  }

  private async resetCircuitBreaker(): Promise<void> {
    await this.redis.del(CIRCUIT_FAILURE_KEY);
    await this.redis.del(CIRCUIT_OPEN_KEY);
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Returns today's date as a UTC date-only value for the `tradedAt`
   * column. MSE trades are daily, not intraday, so we collapse
   * all prices to a single date.
   */
  private getTradingDate(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  }

  private buildLog(
    runId: string,
    startedAt: Date,
    partial: Partial<SyncRunLog>,
  ): SyncRunLog {
    const completedAt = new Date();
    return {
      runId,
      startedAt,
      completedAt,
      status: partial.status ?? SyncRunStatus.FAILED,
      trigger: partial.trigger ?? 'cron',
      durationMs: completedAt.getTime() - startedAt.getTime(),
      rowsProcessed: partial.rowsProcessed ?? 0,
      rowsFailed: partial.rowsFailed ?? 0,
      rowsUpserted: partial.rowsUpserted ?? 0,
      errorMessage: partial.errorMessage,
      errorCode: partial.errorCode,
      screenshotPath: partial.screenshotPath,
    };
  }

  /**
   * Returns recent sync run history for admin dashboard.
   */
  async getSyncHistory(limit = 20): Promise<SyncRunLog[]> {
    return this.repository.getRecentSyncRuns(limit);
  }

  /**
   * Returns the current sync status for admin dashboard.
   */
  async getSyncStatus(): Promise<{
    lastRun: SyncRunLog | null;
    circuitBreakerOpen: boolean;
    dataSourceHealthy: boolean;
    consecutiveFailures: number;
  }> {
    const runs = await this.repository.getRecentSyncRuns(1);
    const circuitBreakerOpen = await this.isCircuitOpen();
    const dataSourceHealthy = await this.dataSource.isHealthy();
    const failures = parseInt(await this.redis.get(CIRCUIT_FAILURE_KEY) ?? '0', 10);

    return {
      lastRun: runs[0] ?? null,
      circuitBreakerOpen,
      dataSourceHealthy,
      consecutiveFailures: failures,
    };
  }
}
