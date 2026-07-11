import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InitiatePaymentDto {
  @ApiProperty({ description: 'Amount in the selected currency', example: 5000 })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ enum: ['MWK', 'USD'], default: 'MWK' })
  @IsEnum(['MWK', 'USD'])
  currency: 'MWK' | 'USD';

  @ApiPropertyOptional({ description: 'Stock symbol for the buy order', example: 'NBM' })
  @IsOptional()
  @IsString()
  stockSymbol?: string;

  @ApiPropertyOptional({ description: 'Number of shares to buy', example: 10 })
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @ApiPropertyOptional({ description: 'Purpose of payment', example: 'BUY_SHARES' })
  @IsOptional()
  @IsString()
  purpose?: string;
}

export class VerifyPaymentDto {
  txRef: string;
}

/** Returned to the mobile app after initiating payment */
export class PaymentSessionResponse {
  checkoutUrl: string;
  txRef: string;
  orderId?: string;
  status: string;
}
