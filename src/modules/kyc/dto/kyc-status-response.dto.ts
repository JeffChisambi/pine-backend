import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KycStatusResponseDto {
  @ApiProperty() applicationId: string;
  @ApiProperty({ enum: ['NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED'] })
  status: string;
  @ApiProperty() verificationStage: string;
  @ApiPropertyOptional() confidenceScore: number | null;
  @ApiPropertyOptional() submittedAt: string;
  @ApiProperty() hasIdDocument: boolean;
  @ApiProperty() hasSelfie: boolean;
  @ApiProperty() canProcess: boolean;
}

export class KycResultResponseDto {
  @ApiProperty() applicationId: string;
  @ApiProperty({ enum: ['APPROVED', 'MANUAL_REVIEW', 'REJECTED'] })
  decision: string;
  @ApiProperty() confidenceScore: number;
  @ApiPropertyOptional() decisionReason: string;
  @ApiPropertyOptional() scores: {
    ocr: number;
    faceMatch: number;
    imageQuality: number;
    documentQuality: number;
    fraudRisk: number;
  };
  @ApiPropertyOptional() fraudFlagCount: number;
  @ApiPropertyOptional() extractedName: string | null;
  @ApiPropertyOptional() extractedIdNumber: string | null;
  @ApiPropertyOptional() faceMatchSimilarity: number | null;
  @ApiPropertyOptional() totalProcessingTimeMs: number;
}
