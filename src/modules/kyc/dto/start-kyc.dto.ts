import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class StartKycDto {
  @ApiPropertyOptional({ description: 'Optional notes from the user' })
  @IsOptional()
  @IsString()
  notes?: string;
}
