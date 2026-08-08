import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketSyncService } from '../services/market-sync.service';
import { MarketSyncCronService } from '../services/market-sync-cron.service';
import { MseHistorySyncService } from '../services/mse-history-sync.service';
import { TriggerSyncDto } from '../dto/trigger-sync.dto';
import type { SyncStatusResponseDto } from '../dto/sync-status-response.dto';
import type { SyncHistoryResponseDto } from '../dto/sync-history-response.dto';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';

/**
 * Admin-facing endpoints for market data synchronization.
 *
 * Protected by the global JwtAuthGuard (authentication) plus the
 * PermissionsGuard: every route requires the `market.sync` permission,
 * held only by SUPER_ADMIN and MARKET_OPERATIONS roles. These endpoints
 * trigger expensive scrapes and can bypass the circuit breaker
 * (`force: true`), so they must never be publicly reachable.
 *
 * All routes are under `/v1/admin/market-sync` via the global prefix
 * + versioning + this controller's path.
 */
@ApiTags('admin', 'market-sync')
@ApiBearerAuth()
@Controller('admin/market-sync')
@RequirePermissions(Permission.MARKET_SYNC)
export class MarketSyncController {
  constructor(
    private readonly marketSyncService: MarketSyncService,
    private readonly cronService: MarketSyncCronService,
    private readonly historySyncService: MseHistorySyncService,
  ) {}

  /**
   * POST /admin/market-sync/trigger-history
   * Kick off an immediate full-history fetch from MSE chart endpoints.
   * Use this once after deploying to populate chart data.
   * ?months=12  (default) — MSE period: 1=1M, 2=3M, 6=6M, 12=1Y, 24=2Y, 60=5Y
   */
  @Post('trigger-history')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger MSE chart history sync',
    description:
      'Fetches historical price data for all MSE-listed stocks from the ' +
      'MSE company chart AJAX endpoint. This populates the price history ' +
      'database used by the stock detail chart. Takes ~30-60 seconds. ' +
      'Use months=12 for 1 year, months=60 for 5 years.',
  })
  @ApiQuery({ name: 'months', required: false, description: 'MSE period months (1,2,6,12,24,60). Default: 12' })
  @ApiResponse({ status: 202, description: 'History sync started — check logs for progress' })
  async triggerHistorySync(
    @Query('months') months?: string,
  ): Promise<{ message: string; months: number }> {
    const m = parseInt(months ?? '12', 10);
    // Run in background — don't await
    this.historySyncService.syncHistory(m).catch((err) => {
      console.error('History sync failed:', err);
    });
    return {
      message: 'History sync started in background — check server logs for progress',
      months: m,
    };
  }

  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger a market data sync',
    description:
      'Enqueues a market sync job for immediate processing. ' +
      'Returns the BullMQ job ID for tracking. ' +
      'Use `force: true` to bypass market-calendar and circuit-breaker checks.',
  })
  @ApiResponse({ status: 202, description: 'Sync job enqueued' })
  @ApiResponse({ status: 429, description: 'Sync already in progress' })
  async triggerSync(
    @Body() dto: TriggerSyncDto,
  ): Promise<{ jobId: string; message: string }> {
    const jobId = await this.cronService.triggerManualSync(dto.force ?? false);
    return {
      jobId,
      message: 'Market sync job enqueued for processing',
    };
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get current sync status',
    description:
      'Returns the health of the data source, circuit breaker state, ' +
      'and the most recent sync run details.',
  })
  @ApiResponse({ status: 200, description: 'Current sync status' })
  async getStatus(): Promise<SyncStatusResponseDto> {
    const status = await this.marketSyncService.getSyncStatus();

    return {
      dataSourceHealthy: status.dataSourceHealthy,
      circuitBreakerOpen: status.circuitBreakerOpen,
      consecutiveFailures: status.consecutiveFailures,
      lastRun: status.lastRun
        ? {
            runId: status.lastRun.runId,
            startedAt: status.lastRun.startedAt.toISOString(),
            completedAt: status.lastRun.completedAt.toISOString(),
            status: status.lastRun.status,
            trigger: status.lastRun.trigger,
            durationMs: status.lastRun.durationMs,
            rowsProcessed: status.lastRun.rowsProcessed,
            rowsFailed: status.lastRun.rowsFailed,
            rowsUpserted: status.lastRun.rowsUpserted,
            errorMessage: status.lastRun.errorMessage,
            errorCode: status.lastRun.errorCode,
          }
        : null,
    };
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get sync run history',
    description:
      'Returns the most recent sync runs for the admin dashboard. ' +
      'Stored in Redis, capped at 100 entries.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max runs to return (default 20, max 100)',
  })
  @ApiResponse({ status: 200, description: 'Sync run history' })
  async getHistory(
    @Query('limit') limit?: string,
  ): Promise<SyncHistoryResponseDto> {
    const parsedLimit = Math.min(
      Math.max(parseInt(limit ?? '20', 10) || 20, 1),
      100,
    );

    const runs = await this.marketSyncService.getSyncHistory(parsedLimit);

    return {
      runs: runs.map((run) => ({
        runId: run.runId,
        startedAt:
          run.startedAt instanceof Date
            ? run.startedAt.toISOString()
            : String(run.startedAt),
        completedAt:
          run.completedAt instanceof Date
            ? run.completedAt.toISOString()
            : String(run.completedAt),
        status: run.status,
        trigger: run.trigger,
        durationMs: run.durationMs,
        rowsProcessed: run.rowsProcessed,
        rowsFailed: run.rowsFailed,
        rowsUpserted: run.rowsUpserted,
        errorMessage: run.errorMessage,
        errorCode: run.errorCode,
      })),
      count: runs.length,
    };
  }
}

