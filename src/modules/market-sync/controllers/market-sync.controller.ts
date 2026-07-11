import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketSyncService } from '../services/market-sync.service';
import { MarketSyncCronService } from '../services/market-sync-cron.service';
import { TriggerSyncDto } from '../dto/trigger-sync.dto';
import type { SyncStatusResponseDto } from '../dto/sync-status-response.dto';
import type { SyncHistoryResponseDto } from '../dto/sync-history-response.dto';

/**
 * Admin-facing endpoints for market data synchronization.
 *
 * In a fully implemented system, these would be protected by an
 * `@Roles(Role.SUPER_ADMIN, Role.MARKET_OPERATIONS)` guard (Phase 2).
 * For now they are unguarded to enable testing during Phase 4
 * development — the auth guard will be added when the AuthModule
 * is implemented.
 *
 * All routes are under `/v1/admin/market-sync` via the global prefix
 * + versioning + this controller's path.
 */
@ApiTags('admin', 'market-sync')
@Controller('admin/market-sync')
export class MarketSyncController {
  constructor(
    private readonly marketSyncService: MarketSyncService,
    private readonly cronService: MarketSyncCronService,
  ) {}

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

