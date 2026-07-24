import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Request DTOs ─────────────────────────────────────────────────────────────

export class InitiateBankCardPaymentDto {
  /** Amount to charge in the selected currency */
  @ApiProperty({ description: 'Amount to charge', example: 5000 })
  @IsNumber()
  @Min(1)
  amount: number;

  /** Currency code */
  @ApiProperty({ enum: ['MWK', 'USD'], default: 'MWK' })
  @IsEnum(['MWK', 'USD'])
  currency: 'MWK' | 'USD';

  /** Full name on card */
  @ApiProperty({ description: 'Cardholder name as it appears on the card', example: 'JOHN DOE' })
  @IsString()
  @IsNotEmpty()
  cardholderName: string;

  /**
   * Card number (digits only, 13–19 digits).
   * In production this should be a tokenised card token, NOT a raw PAN.
   */
  @ApiProperty({ description: 'Card number (digits only)', example: '4111111111111111' })
  @IsString()
  @Matches(/^\d{13,19}$/, { message: 'cardNumber must be 13–19 digits' })
  cardNumber: string;

  /** Expiry month — MM */
  @ApiProperty({ description: 'Expiry month (01–12)', example: '12' })
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])$/, { message: 'expiryMonth must be MM format (01–12)' })
  expiryMonth: string;

  /** Expiry year — YY or YYYY */
  @ApiProperty({ description: 'Expiry year (YY or YYYY)', example: '27' })
  @IsString()
  @Matches(/^\d{2}(\d{2})?$/, { message: 'expiryYear must be YY or YYYY format' })
  expiryYear: string;

  /** Card CVV / CVC (3–4 digits) */
  @ApiProperty({ description: 'Card CVV / CVC', example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'cvv must be 3–4 digits' })
  cvv: string;

  /** Optional: payment purpose tag */
  @ApiPropertyOptional({ description: 'Payment purpose', example: 'wallet_deposit' })
  @IsOptional()
  @IsString()
  purpose?: string;

  /** Optional: stock symbol when purpose = BUY_SHARES */
  @ApiPropertyOptional({ description: 'Stock symbol for buy orders', example: 'NBM' })
  @IsOptional()
  @IsString()
  stockSymbol?: string;

  /** Optional: share quantity when purpose = BUY_SHARES */
  @ApiPropertyOptional({ description: 'Number of shares to purchase', example: 10 })
  @IsOptional()
  @IsNumber()
  quantity?: number;
}

export class VerifyBankCardPaymentDto {
  @ApiProperty({ description: 'Transaction reference returned by initiate', example: 'PINE-CARD-abc123' })
  @IsString()
  @IsNotEmpty()
  txRef: string;
}

// ─── Response shapes ──────────────────────────────────────────────────────────

export enum BankCardPaymentStatus {
  PENDING    = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS    = 'SUCCESS',
  FAILED     = 'FAILED',
  CANCELLED  = 'CANCELLED',
  REFUNDED   = 'REFUNDED',
}

export class BankCardPaymentResponse {
  /** Internal Pine transaction reference */
  txRef: string;

  /** Internal Pine wallet transaction ID */
  transactionId: string;

  /** Current status from the card processor */
  status: BankCardPaymentStatus;

  /** Amount charged */
  amount: number;

  /** Currency */
  currency: 'MWK' | 'USD';

  /** Human-readable message */
  message: string;

  /** Processor-specific reference (if available) */
  processorReference?: string;

  /** Last 4 digits of card (safe to store) */
  last4?: string;

  /** Card brand detected by processor (Visa, Mastercard, …) */
  cardBrand?: string;
}

export class BankCardRefundRequest {
  @ApiProperty({ description: 'Transaction reference to refund' })
  @IsString()
  @IsNotEmpty()
  txRef: string;

  @ApiPropertyOptional({ description: 'Amount to refund (partial refund). Omit for full refund.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  amount?: number;
}
