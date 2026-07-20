import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, IsEmail, ValidateIf } from 'class-validator';
import { normalizeMalawiPhoneNumber } from '../../../shared/phone/malawi-phone';

export class LoginDto {
  @ApiPropertyOptional({ example: '+265991234567', description: 'Login with phone number' })
  @ValidateIf((o) => !o.email)
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty({ message: 'Either phone or email is required' })
  @Matches(/^\+265\d{9}$/, {
    message: 'Phone must be a valid Malawi number (+265XXXXXXXXX)',
  })
  phone?: string;

  @ApiPropertyOptional({ example: 'john@example.com', description: 'Login with email' })
  @ValidateIf((o) => !o.phone)
  @IsEmail({}, { message: 'Must be a valid email address' })
  @IsNotEmpty({ message: 'Either phone or email is required' })
  email?: string;

  @ApiProperty({ example: 'MyStr0ngP@ssword!' })
  @IsString()
  @IsNotEmpty()
  password: string;

  @ApiPropertyOptional({ description: 'Device fingerprint for session binding' })
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @ApiPropertyOptional({ description: 'Platform: ios, android, web' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({ description: 'OS version' })
  @IsOptional()
  @IsString()
  osVersion?: string;

  @ApiPropertyOptional({ description: 'App version' })
  @IsOptional()
  @IsString()
  appVersion?: string;
}
