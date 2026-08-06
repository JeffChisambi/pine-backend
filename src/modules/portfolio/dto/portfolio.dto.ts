import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PortfolioHistoryQueryDto {
  @ApiPropertyOptional({ example: 90, default: 90, description: 'Number of days of history' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
