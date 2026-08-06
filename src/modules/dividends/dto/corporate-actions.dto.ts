import { Type } from 'class-transformer';
import { IsString, IsOptional, IsNumber, IsInt, IsDateString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CorporateActionsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by stock UUID' })
  @IsOptional()
  @IsString()
  stockId?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class DeclareDividendDto {
  @ApiProperty({ description: 'Stock UUID' })
  @IsString()
  stockId: string;

  @ApiProperty({ example: 12.5, description: 'Amount per share in MWK' })
  @IsNumber()
  @Min(0.01)
  amountPerShare: number;

  @ApiPropertyOptional({ example: 10, description: 'Withholding tax percentage' })
  @IsOptional()
  @IsNumber()
  withholdingTaxPct?: number;

  @ApiProperty({ example: '2026-07-15', description: 'Ex-dividend date (ISO)' })
  @IsDateString()
  exDividendDate: string;

  @ApiProperty({ example: '2026-07-17', description: 'Record date (ISO)' })
  @IsDateString()
  recordDate: string;

  @ApiProperty({ example: '2026-08-01', description: 'Payment date (ISO)' })
  @IsDateString()
  paymentDate: string;
}

export class DeclareStockSplitDto {
  @ApiProperty({ description: 'Stock UUID' })
  @IsString()
  stockId: string;

  @ApiProperty({ example: 1, description: 'Split from (e.g., 1 in 1-for-2)' })
  @IsInt()
  @Min(1)
  ratioFrom: number;

  @ApiProperty({ example: 2, description: 'Split to (e.g., 2 in 1-for-2)' })
  @IsInt()
  @Min(1)
  ratioTo: number;

  @ApiProperty({ example: '2026-08-01', description: 'Effective date (ISO)' })
  @IsDateString()
  effectiveDate: string;
}

export class DeclareBonusIssueDto {
  @ApiProperty({ description: 'Stock UUID' })
  @IsString()
  stockId: string;

  @ApiProperty({ example: 10, description: 'For every N shares' })
  @IsInt()
  @Min(1)
  ratioFrom: number;

  @ApiProperty({ example: 1, description: 'Get M bonus shares' })
  @IsInt()
  @Min(1)
  ratioTo: number;

  @ApiProperty({ example: '2026-07-20', description: 'Record date (ISO)' })
  @IsDateString()
  recordDate: string;

  @ApiProperty({ example: '2026-08-01', description: 'Effective date (ISO)' })
  @IsDateString()
  effectiveDate: string;
}
