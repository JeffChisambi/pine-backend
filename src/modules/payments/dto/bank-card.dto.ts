import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
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

  /** Full name on card — required when savedCardId is NOT provided */
  @ApiProperty({ description: 'Cardholder name as it appears on the card', example: 'JOHN DOE' })
  @ValidateIf((o) => !o.savedCardId)
  @IsString()
  @IsNotEmpty()
  cardholderName: string;

  /**
   * Card number (digits only, 13–19 digits).
   * Required when savedCardId is NOT provided.
   */
  @ApiProperty({ description: 'Card number (digits only)', example: '4111111111111111' })
  @ValidateIf((o) => !o.savedCardId)
  @IsString()
  @Matches(/^\d{13,19}$/, { message: 'cardNumber must be 13–19 digits' })
  cardNumber: string;

  /** Expiry month — MM. Required when savedCardId is NOT provided. */
  @ApiProperty({ description: 'Expiry month (01–12)', example: '12' })
  @ValidateIf((o) => !o.savedCardId)
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])$/, { message: 'expiryMonth must be MM format (01–12)' })
  expiryMonth: string;

  /** Expiry year — YY or YYYY. Required when savedCardId is NOT provided. */
  @ApiProperty({ description: 'Expiry year (YY or YYYY)', example: '27' })
  @ValidateIf((o) => !o.savedCardId)
  @IsString()
  @Matches(/^\d{2}(\d{2})?$/, { message: 'expiryYear must be YY or YYYY format' })
  expiryYear: string;

  /** Card CVV / CVC (3–4 digits) */
  @ApiProperty({ description: 'Card CVV / CVC', example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'cvv must be 3–4 digits' })
  cvv: string;

  /** Optional: use a previously saved card instead of raw card details */
  @ApiPropertyOptional({ description: 'ID of a previously saved card to use' })
  @IsOptional()
  @IsUUID()
  savedCardId?: string;

  /** Optional: save the card for future payments (ignored when savedCardId is set) */
  @ApiPropertyOptional({ description: 'Save this card for future payments', default: false })
  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;

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

  /**
   * Client-supplied idempotency key. The same key always maps to the same
   * payment: replays return the current state and are never charged twice.
   */
  @ApiPropertyOptional({ description: 'Idempotency key for duplicate-submit protection' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'idempotencyKey must be 8–64 chars (alphanumeric, - or _)' })
  idempotencyKey?: string;

  /**
   * Test Transaction mode: routes the payment through the mock gateway and
   * simulates the requested outcome end-to-end. Ignored gateway-side in
   * production flows — a test payment is always explicitly labeled.
   */
  @ApiPropertyOptional({
    description: 'Run as a simulated test transaction with the given outcome',
    enum: ['success', 'declined', 'insufficient_funds', 'expired_card', 'network_failure', 'timeout', 'duplicate'],
  })
  @IsOptional()
  @IsIn(['success', 'declined', 'insufficient_funds', 'expired_card', 'network_failure', 'timeout', 'duplicate'])
  testScenario?: 'success' | 'declined' | 'insufficient_funds' | 'expired_card' | 'network_failure' | 'timeout' | 'duplicate';
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
