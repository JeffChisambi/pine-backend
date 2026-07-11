import { IsNumber, IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class DepositDto {
  @ApiProperty({ example: 50000, description: 'Amount in MWK' })
  @IsNumber()
  @Min(100)
  @Max(5_000_000)
  amount: number;

  @ApiPropertyOptional({ description: 'Idempotency key for retry safety' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class WithdrawDto {
  @ApiProperty({ example: 25000, description: 'Amount in MWK' })
  @IsNumber()
  @Min(100)
  @Max(2_000_000)
  amount: number;

  @ApiPropertyOptional({ description: 'Idempotency key for retry safety' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class StatementQueryDto {
  @ApiPropertyOptional({ example: 30, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
