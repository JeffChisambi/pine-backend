import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * All valid document slot codes the applicant may be asked to resubmit.
 * Mirrors the "Document Slot" table in the Kusata API contract (v1.0, §4).
 */
export const VALID_DOCUMENT_SLOTS = [
  'ID_FRONT',
  'ID_BACK',
  'NATIONAL_ID',
  'NATIONAL_ID_BACK',
  'PASSPORT_FRONT',
  'PASSPORT_BACK',
  'DRIVERS_LICENSE_FRONT',
  'DRIVERS_LICENSE_BACK',
  'SELFIE',
  'LIVENESS',
  'PROOF_OF_ADDRESS',
] as const;

export type DocumentSlot = (typeof VALID_DOCUMENT_SLOTS)[number];

/**
 * Request body for POST /v1/admin/kyc/:applicationId/request-docs.
 */
export class RequestDocsDto {
  @ApiProperty({
    description:
      'Array of document slot codes the applicant must resubmit. Min 1, max 5 items.',
    isArray: true,
    enum: VALID_DOCUMENT_SLOTS,
    example: ['ID_FRONT', 'SELFIE'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @IsIn(VALID_DOCUMENT_SLOTS, { each: true })
  requiredDocuments: DocumentSlot[];

  @ApiPropertyOptional({
    description:
      'Optional plain-text message shown to the applicant. Max 1 000 chars.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
