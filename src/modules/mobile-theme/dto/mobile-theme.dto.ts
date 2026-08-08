import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsHexColor, IsOptional } from 'class-validator';

/**
 * Broker-editable brand tokens. All optional so the dashboard can send partial
 * updates. Values must be hex colors (e.g. "#164951").
 */
export class UpdateMobileThemeDto {
  @ApiPropertyOptional({ example: '#164951' })
  @IsOptional() @IsHexColor()
  primary?: string;

  @ApiPropertyOptional({ example: '#45B369' })
  @IsOptional() @IsHexColor()
  accent?: string;

  @ApiPropertyOptional({ example: '#FFFFFF' })
  @IsOptional() @IsHexColor()
  background?: string;

  @ApiPropertyOptional({ example: '#F9FAFB' })
  @IsOptional() @IsHexColor()
  card?: string;

  @ApiPropertyOptional({ example: '#111827' })
  @IsOptional() @IsHexColor()
  text?: string;

  @ApiPropertyOptional({ example: '#6B7280' })
  @IsOptional() @IsHexColor()
  mutedForeground?: string;

  @ApiPropertyOptional({ example: '#EBECEF' })
  @IsOptional() @IsHexColor()
  border?: string;

  @ApiPropertyOptional({ example: '#EF4444' })
  @IsOptional() @IsHexColor()
  destructive?: string;
}
