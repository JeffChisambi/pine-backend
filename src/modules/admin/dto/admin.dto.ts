import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

// ── Auth DTOs ──────────────────────────────────────────────────

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@pine.mw' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password: string;
}

export class MfaVerifyDto {
  @ApiProperty({ description: 'TOTP code from authenticator app' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'Temporary MFA token from login response' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;
}

export class MfaSetupConfirmDto {
  @ApiProperty({ description: 'Temporary MFA token from login response' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;

  @ApiProperty({ description: 'TOTP code from authenticator app to confirm setup' })
  @IsString()
  @IsNotEmpty()
  code: string;
}

export class MfaSetupDto {
  @ApiProperty({ description: 'Temporary MFA token from login response' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class MfaResetDto {
  @ApiProperty({ description: 'User ID whose MFA to reset' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiPropertyOptional({ description: 'Reason for reset' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RecoveryCodeVerifyDto {
  @ApiProperty({ description: 'Recovery code (format: XXXX-XXXX)' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ description: 'Temporary MFA token from login response' })
  @IsString()
  @IsNotEmpty()
  mfaToken: string;
}

// ── User Management DTOs ───────────────────────────────────────

export class ListUsersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['active', 'frozen', 'deactivated'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'] })
  @IsOptional()
  @IsString()
  kycStatus?: string;

  @ApiPropertyOptional({ enum: ['CUSTOMER', 'SUPER_ADMIN', 'COMPLIANCE_OFFICER', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT', 'MARKET_OPERATIONS', 'AUDITOR'] })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UpdateUserStatusDto {
  @ApiProperty({ enum: ['active', 'frozen', 'deactivated'] })
  @IsString()
  @IsNotEmpty()
  status: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

// ── Trading DTOs ───────────────────────────────────────────────

export class ListOrdersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stockId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ── Notification DTOs ──────────────────────────────────────────

export class BroadcastNotificationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ enum: ['PUSH', 'EMAIL', 'SMS', 'IN_APP'], default: 'IN_APP' })
  @IsOptional()
  @IsString()
  channel?: string;

  @ApiPropertyOptional({ description: 'Target role filter (e.g., CUSTOMER)' })
  @IsOptional()
  @IsString()
  targetRole?: string;
}
