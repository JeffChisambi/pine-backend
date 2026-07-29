import { IsString, IsNumber, IsPositive, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InvestDto {
  @ApiProperty({ description: 'Treasury product ID' })
  @IsString()
  productId: string;

  @ApiProperty({ description: 'Amount to invest in MWK', example: 100000 })
  @IsNumber()
  @IsPositive()
  amount: number;
}

export class TreasuryProductDto {
  id: string;
  label: string;
  tenorDays: number;
  yieldPercent: number;
  minAmount: number;
  maxAmount: number | null;
  currency: string;
  isActive: boolean;
}

export class TreasuryInvestmentDto {
  investmentId: string;
  status: string;
  amount: string;
  yieldPercent: number;
  earnings: string;
  maturityValue: string;
  maturityDate: string;
  createdAt: Date;
}
