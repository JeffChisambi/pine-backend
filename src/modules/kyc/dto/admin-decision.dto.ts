import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminDecisionDto {
  @ApiProperty({ description: 'KYC application ID' })
  @IsString()
  applicationId: string;

  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsEnum(['APPROVED', 'REJECTED'])
  decision: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Rejection reason (required if rejected)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({ description: 'Reviewer notes (internal only)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
