import { ApiProperty } from '@nestjs/swagger';
import { SyncRunSummaryDto } from './sync-status-response.dto';

/**
 * Response shape for `GET /v1/admin/market-sync/history`.
 */
export class SyncHistoryResponseDto {
  @ApiProperty({ type: [SyncRunSummaryDto] })
  runs: SyncRunSummaryDto[];

  @ApiProperty({ description: 'Total number of runs returned' })
  count: number;
}
