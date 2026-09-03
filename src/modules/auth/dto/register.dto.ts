import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsEmail,
  IsIn,
  IsISO8601,
} from 'class-validator';
import { normalizeMalawiPhoneNumber } from '../../../shared/phone/malawi-phone';

export class RegisterDto {
  @ApiProperty({ example: '+265991234567' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+265\d{9}$/, {
    message: 'Phone must be a valid Malawi number (+265XXXXXXXXX)',
  })
  phone: string;

  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  firstName: string;

  @ApiProperty({ example: 'Banda' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(50)
  lastName: string;

  @ApiProperty({ example: 'MyStr0ngP@ssword!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{8,}$/, {
    message:
      'Password must contain at least one uppercase, one lowercase, one digit, and one special character',
  })
  password: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '1998-03-12', description: 'Date of birth (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'M', enum: ['M', 'F'] })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const v = value.trim().toUpperCase();
    if (v === 'MALE') return 'M';
    if (v === 'FEMALE') return 'F';
    return v;
  })
  @IsIn(['M', 'F'])
  gender?: string;

  @ApiPropertyOptional({ description: 'Device fingerprint for trust tracking' })
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @ApiPropertyOptional({ description: 'Platform: ios, android, web' })
  @IsOptional()
  @IsString()
  platform?: string;

  @ApiPropertyOptional({
    description:
      'Invitation token from a broker migration email. Links the new account ' +
      'to the imported record and to that broker.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  migrationToken?: string;
}
