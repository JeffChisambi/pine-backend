import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MinLength, MaxLength, IsEnum } from 'class-validator';
import { normalizeMalawiPhoneNumber } from '../../../shared/phone/malawi-phone';

export class ForgotPasswordDto {
  @ApiProperty({ example: '+265991234567' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+265\d{9}$/)
  phone: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: '+265991234567' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+265\d{9}$/)
  phone: string;

  @ApiProperty({ example: '123456', description: 'OTP sent to phone' })
  @IsString()
  @IsNotEmpty()
  otp: string;

  @ApiProperty({ example: 'MyNewStr0ng!' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{8,}$/, {
    message: 'Password must contain uppercase, lowercase, digit, and special character',
  })
  newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d]).{8,}$/, {
    message: 'Password must contain uppercase, lowercase, digit, and special character',
  })
  newPassword: string;
}

export class CreatePinDto {
  @ApiProperty({ example: '1234', description: '4-6 digit transaction PIN' })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4-6 digits' })
  pin: string;
}

export class VerifyPinDto {
  @ApiProperty({ example: '1234' })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4-6 digits' })
  pin: string;
}

export class ChangePinDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{4,6}$/)
  currentPin: string;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4,6}$/)
  newPin: string;
}

export class SendOtpDto {
  @ApiProperty({ example: '+265991234567', description: 'Phone number to send OTP to' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ enum: ['phone_verification', 'password_reset', 'transaction'] })
  @IsString()
  @IsNotEmpty()
  purpose: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+265991234567' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeMalawiPhoneNumber(value) : value))
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ enum: ['phone_verification', 'password_reset', 'transaction'] })
  @IsString()
  @IsNotEmpty()
  purpose: string;
}
