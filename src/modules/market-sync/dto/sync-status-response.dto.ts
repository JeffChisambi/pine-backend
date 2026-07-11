import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shape for `GET /v1/admin/market-sync/status`.
 */
export class SyncStatusResponseDto {
  @ApiProperty({ description: 'Whether the data source (Playwright browser) is healthy' })
  dataSourceHealthy: boolean;

  @ApiProperty({ description: 'Whether the circuit breaker is currently open (sync paused)' })
  circuitBreakerOpen: boolean;

  @ApiProperty({ description: 'Number of consecutive failures since last success' })
  consecutiveFailures: number;

  @ApiPropertyOptional({ description: 'Most recent sync run details' })
  lastRun: SyncRunSummaryDto | null;
}

export class SyncRunSummaryDto {
  @ApiProperty() runId: string;
  @ApiProperty() startedAt: string;
  @ApiProperty() completedAt: string;
  @ApiProperty({ enum: ['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'] }) status: string;
  @ApiProperty({ enum: ['cron', 'manual', 'retry'] }) trigger: string;
  @ApiProperty() durationMs: number;
  @ApiProperty() rowsProcessed: number;
  @ApiProperty() rowsFailed: number;
  @ApiProperty() rowsUpserted: number;
  @ApiPropertyOptional() errorMessage?: string;
  @ApiPropertyOptional() errorCode?: string;
}
