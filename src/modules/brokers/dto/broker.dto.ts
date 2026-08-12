import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Broker CRUD ─────────────────────────────────────────────────────

export class CreateBrokerDto {
  @ApiProperty({ example: 'Cedar Capital' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: 'CEDAR', description: 'Unique short code' })
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,20}$/, {
    message: 'code must be 2-20 chars: A-Z, 0-9, _ or -',
  })
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;
}

export class UpdateBrokerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;
}

export class UpdateBrokerStatusDto {
  @ApiProperty({ description: 'true = active, false = deactivated' })
  @IsBoolean()
  isActive!: boolean;
}

// ── Broker admin invitation ─────────────────────────────────────────

export class InviteBrokerAdminDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName!: string;

  @ApiPropertyOptional({ description: 'Phone (E.164). Auto-generated placeholder if omitted.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class ActivateBrokerAdminDto {
  @ApiProperty({ description: 'One-time invitation token' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ description: 'New password (min 12 chars)' })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

// ── Payment configuration ───────────────────────────────────────────

export class UpsertBrokerPaymentConfigDto {
  @ApiPropertyOptional({ default: 'MPGS' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;

  @ApiPropertyOptional({ example: 'https://test-nbm.mtf.gateway.mastercard.com' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  apiVersion?: number;

  @ApiPropertyOptional({ enum: ['test', 'production'] })
  @IsOptional()
  @IsIn(['test', 'production'])
  environment?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchantId?: string;

  @ApiPropertyOptional({
    description: 'Gateway API password. Write-only: encrypted at rest, never returned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  apiPassword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  settlementBankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  settlementAccountName?: string;

  @ApiPropertyOptional({
    description: 'Settlement account number. Write-only: encrypted at rest; only a masked form is returned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  settlementAccountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

// ── API configuration ───────────────────────────────────────────────

export class UpsertBrokerApiConfigDto {
  @ApiProperty({ example: 'ORDER_GATEWAY' })
  @IsString()
  @Matches(/^[A-Z0-9_]{2,40}$/)
  key!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Secret/credential. Write-only: encrypted at rest, never returned.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  secret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

// ── Investor broker selection ───────────────────────────────────────

export class SelectBrokerDto {
  @ApiProperty({ description: 'Broker id chosen by the investor' })
  @IsUUID()
  brokerId!: string;

  @ApiPropertyOptional({
    description: 'Must be true when changing from an existing broker (explicit confirmation).',
  })
  @IsOptional()
  @IsBoolean()
  confirmChange?: boolean;
}
