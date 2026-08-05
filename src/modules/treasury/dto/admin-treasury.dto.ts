import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, Min,
} from 'class-validator';

export class CreateTreasuryProductDto {
  @ApiProperty({ example: '91-Day Treasury Bill' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({ example: 91, description: 'Tenor in days (e.g. 91, 182, 364)' })
  @IsInt()
  @IsPositive()
  tenorDays: number;

  @ApiProperty({ example: 24.5 })
  @IsNumber()
  @Min(0)
  yieldPercent: number;

  @ApiProperty({ example: 100000 })
  @IsNumber()
  @Min(0)
  minAmount: number;

  @ApiPropertyOptional({ example: 50000000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number;

  @ApiPropertyOptional({ enum: ['Very Low', 'Low'], default: 'Low' })
  @IsOptional()
  @IsIn(['Very Low', 'Low'])
  riskLevel?: string;

  @ApiPropertyOptional({ description: 'ISO date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  auctionDate?: string;

  @ApiPropertyOptional({ description: 'ISO date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  issueDate?: string;

  @ApiPropertyOptional({ description: 'ISO date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  maturityDate?: string;

  @ApiPropertyOptional({ enum: ['open', 'closing_soon', 'closed'], default: 'open' })
  @IsOptional()
  @IsIn(['open', 'closing_soon', 'closed'])
  status?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 'MWK' })
  @IsOptional()
  @IsString()
  currency?: string;
}

export class UpdateTreasuryProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() label?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @IsPositive() tenorDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) yieldPercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) maxAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsIn(['Very Low', 'Low']) riskLevel?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() auctionDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() issueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() maturityDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['open', 'closing_soon', 'closed']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
}
