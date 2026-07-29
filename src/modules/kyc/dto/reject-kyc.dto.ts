import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Request body for POST /v1/admin/kyc/:applicationId/reject.
 */
export class RejectKycDto {
  @ApiProperty({
    description:
      'Human-readable rejection reason shown to the applicant. Min 10 chars, max 1 000 chars.',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({
    description: 'Internal reviewer notes (not shown to applicant). Max 2 000 chars.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
