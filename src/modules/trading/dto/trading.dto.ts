import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  Min,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Request DTOs ──────────────────────────────────────────────

export class BuyOrderDto {
  @ApiProperty({ example: 'AIRTEL', description: 'Stock ticker symbol' })
  @IsString()
  stockSymbol: string;

  @ApiProperty({ example: 100, description: 'Number of shares to buy', minimum: 1 })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiProperty({ enum: ['MARKET', 'LIMIT'], example: 'MARKET' })
  @IsEnum(['MARKET', 'LIMIT'])
  orderType: 'MARKET' | 'LIMIT';

  @ApiPropertyOptional({ example: 198.5, description: 'Limit price (required for LIMIT orders)' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  limitPrice?: number;

  @ApiPropertyOptional({ description: 'Client idempotency key to prevent duplicate orders' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class SellOrderDto {
  @ApiProperty({ example: 'NBM', description: 'Stock ticker symbol' })
  @IsString()
  stockSymbol: string;

  @ApiProperty({ example: 50, description: 'Number of shares to sell', minimum: 1 })
  @IsNumber()
  @Min(1)
  quantity: number;

  @ApiProperty({ enum: ['MARKET', 'LIMIT'], example: 'MARKET' })
  @IsEnum(['MARKET', 'LIMIT'])
  orderType: 'MARKET' | 'LIMIT';

  @ApiPropertyOptional({ example: 210.0, description: 'Limit price (required for LIMIT orders)' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  limitPrice?: number;

  @ApiPropertyOptional({ description: 'Client idempotency key to prevent duplicate orders' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class OrderHistoryQueryDto {
  @ApiPropertyOptional({ enum: ['DRAFT', 'PENDING_VALIDATION', 'VALIDATED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_SETTLEMENT', 'SETTLED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['BUY', 'SELL'] })
  @IsOptional()
  @IsString()
  side?: string;

  @ApiPropertyOptional({ example: 20, default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ example: 0, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class TradeHistoryQueryDto {
  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
