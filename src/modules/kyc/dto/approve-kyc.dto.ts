import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Request body for POST /v1/admin/kyc/:applicationId/approve.
 */
export class ApproveKycDto {
  @ApiPropertyOptional({
    description: 'Internal reviewer notes (not shown to applicant). Max 2 000 chars.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
