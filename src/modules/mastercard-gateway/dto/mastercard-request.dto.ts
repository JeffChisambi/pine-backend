import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Card charge / authorize DTOs ─────────────────────────────────────────────

/**
 * DTO for initiating a Mastercard Gateway card charge or authorization.
 * Used by the PaymentsController bank-card endpoints.
 *
 * PCI-DSS note: raw card data (number, CVV) is accepted server-side here
 * only because Direct Payment is the chosen integration model. For lower
 * PCI scope, migrate to the Hosted Session model (JS-captured card fields)
 * and only send a session token here.
 */
export class MastercardChargeDto {
  @ApiProperty({ description: 'Amount in minor units (e.g. MWK 100.00 → 100)', example: 5000 })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ enum: ['MWK', 'USD'], default: 'MWK' })
  @IsEnum(['MWK', 'USD'])
  currency: 'MWK' | 'USD';

  @ApiProperty({ description: 'Full card number (PAN) — transmitted over TLS, never stored', example: '5123450000000008' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{13,19}$/, { message: 'cardNumber must be 13–19 digits' })
  cardNumber: string;

  @ApiProperty({ description: 'Cardholder name as printed on card', example: 'JOHN BANDA' })
  @IsString()
  @IsNotEmpty()
  cardholderName: string;

  @ApiProperty({ description: 'Expiry month (MM)', example: '05' })
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])$/, { message: 'expiryMonth must be MM format (01–12)' })
  expiryMonth: string;

  @ApiProperty({ description: 'Expiry year (YY or YYYY)', example: '28' })
  @IsString()
  @Matches(/^\d{2}(\d{2})?$/, { message: 'expiryYear must be YY or YYYY' })
  expiryYear: string;

  @ApiProperty({ description: 'Card security code (CVV/CVC/CID) — 3 or 4 digits', example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/, { message: 'cvv must be 3 or 4 digits' })
  cvv: string;

  @ApiPropertyOptional({ description: 'Payer email address (for receipt)', example: 'john@example.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ description: 'Human-readable order description shown in gateway reports' })
  @IsOptional()
  @IsString()
  description?: string;
}

/**
 * DTO for capturing a previously-authorized transaction.
 */
export class MastercardCaptureDto {
  @ApiProperty({ description: 'Pine order reference (txRef used in the original authorize call)' })
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiProperty({ description: 'Transaction ID of the original AUTHORIZE transaction' })
  @IsString()
  @IsNotEmpty()
  authorizeTransactionId: string;

  @ApiProperty({ description: 'Amount to capture — must be ≤ the authorized amount', example: 5000 })
  @IsNumber()
  @Min(1)
  amount: number;

  @ApiProperty({ enum: ['MWK', 'USD'], default: 'MWK' })
  @IsEnum(['MWK', 'USD'])
  currency: 'MWK' | 'USD';
}

/**
 * DTO for voiding a transaction.
 */
export class MastercardVoidDto {
  @ApiProperty({ description: 'Pine order reference' })
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @ApiProperty({ description: 'Transaction ID to void' })
  @IsString()
  @IsNotEmpty()
  transactionId: string;
}

/**
 * DTO for verifying a card without charging it.
 */
export class MastercardVerifyCardDto {
  @ApiProperty({ description: 'Unique reference for this verification attempt' })
  @IsString()
  @IsNotEmpty()
  txRef: string;

  @ApiProperty({ example: '5123450000000008' })
  @IsString()
  @Matches(/^\d{13,19}$/, { message: 'cardNumber must be 13–19 digits' })
  cardNumber: string;

  @ApiProperty({ example: 'JOHN BANDA' })
  @IsString()
  @IsNotEmpty()
  cardholderName: string;

  @ApiProperty({ example: '05' })
  @IsString()
  @Matches(/^(0[1-9]|1[0-2])$/)
  expiryMonth: string;

  @ApiProperty({ example: '28' })
  @IsString()
  @Matches(/^\d{2}(\d{2})?$/)
  expiryYear: string;

  @ApiProperty({ example: '123' })
  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv: string;
}

// ─── Webhook / Notification DTOs ──────────────────────────────────────────────

/**
 * Payload sent by the Mastercard Gateway to the merchant's notification URL.
 *
 * The gateway POSTs this when the status of an order or transaction changes.
 * All fields are optional because the gateway delivers different subsets
 * depending on the event type.
 */
export class MastercardWebhookDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  merchantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  transactionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  response?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  order?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  transaction?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  sourceOfFunds?: Record<string, unknown>;
}
