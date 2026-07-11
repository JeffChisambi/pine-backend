import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for `POST /v1/admin/market-sync/trigger`.
 */
export class TriggerSyncDto {
  @ApiPropertyOptional({
    description:
      'If true, skip market-calendar check and circuit breaker — ' +
      'force a sync even on holidays, weekends, or after repeated failures.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean = false;
}
