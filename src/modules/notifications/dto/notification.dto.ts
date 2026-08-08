import { Type } from 'class-transformer';
import { IsString, IsOptional, IsBoolean, IsInt, IsEnum, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MarkReadDto {
  @ApiProperty({ description: 'Notification UUID to mark as read' })
  @IsString()
  notificationId: string;
}

export class UpdatePreferencesDto {
  @ApiProperty({ description: 'Notification category', example: 'TRADING' })
  @IsString()
  category: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  sms?: boolean;
}

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Expo push token', example: 'ExponentPushToken[xxxx]' })
  @IsString()
  token: string;

  @ApiProperty({ description: 'Device platform', example: 'android' })
  @IsString()
  platform: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  appVersion?: string;
}

export class UnregisterDeviceDto {
  @ApiProperty({ description: 'Expo push token to remove' })
  @IsString()
  token: string;
}

export class NotificationQueryDto {
  @ApiPropertyOptional({ example: 30, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
