import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
  Param,
  Inject,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KycWorkflowService } from '../services/kyc-workflow.service';
import { StartKycDto } from '../dto/start-kyc.dto';
import type {
  KycStatusResponseDto,
  KycResultResponseDto,
} from '../dto/kyc-status-response.dto';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../interfaces/kyc-repository.interface';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/types/request-context.types';

/**
 * Customer-facing KYC endpoints. All routes are under `/v1/kyc/`.
 *
 * In a fully implemented system, these would be protected by
 * `@UseGuards(JwtAuthGuard)` (Phase 2). For now they accept
 * a `userId` from the request body/query for testing.
 */
@ApiTags('kyc')
@Controller('kyc')
export class KycController {
  constructor(
    private readonly workflowService: KycWorkflowService,
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
  ) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start a new KYC application' })
  @ApiResponse({ status: 201, description: 'KYC application created' })
  async start(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ applicationId: string }> {
    return this.workflowService.startApplication(user.id);
  }

  @Post('upload-id')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload national ID document' })
  @ApiResponse({ status: 200, description: 'ID document uploaded' })
  async uploadId(
    @UploadedFile() file: Express.Multer.File,
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ documentId: string }> {
    return this.workflowService.uploadDocument(
      applicationId,
      user.id,
      'NATIONAL_ID',
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }

  @Post('upload-selfie')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload selfie for face verification' })
  @ApiResponse({ status: 200, description: 'Selfie uploaded' })
  async uploadSelfie(
    @UploadedFile() file: Express.Multer.File,
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ documentId: string }> {
    return this.workflowService.uploadDocument(
      applicationId,
      user.id,
      'SELFIE',
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }

  @Post('upload-proof-of-residency')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload proof of residency document' })
  @ApiResponse({ status: 200, description: 'Proof of residency uploaded' })
  async uploadProofOfResidency(
    @UploadedFile() file: Express.Multer.File,
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ documentId: string }> {
    return this.workflowService.uploadDocument(
      applicationId,
      user.id,
      'PROOF_OF_RESIDENCE',
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }

  @Post('process')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger the KYC verification pipeline',
    description: 'Runs the full pipeline: enhance → OCR → face detect → face match → fraud → score → decide',
  })
  @ApiResponse({ status: 202, description: 'Verification processing started' })
  async process(
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ decision: string; confidenceScore: number }> {
    const result = await this.workflowService.processVerification(
      applicationId,
      user.id,
    );
    return {
      decision: result.decision,
      confidenceScore: result.confidenceScore,
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current KYC status for the authenticated user' })
  @ApiResponse({ status: 200, description: 'KYC status' })
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<KycStatusResponseDto> {
    const app = await this.repository.getLatestApplicationByUserId(user.id);

    if (!app) {
      return {
        applicationId: '',
        status: 'NOT_SUBMITTED',
        verificationStage: 'NONE',
        confidenceScore: null,
        submittedAt: '',
        hasIdDocument: false,
        hasSelfie: false,
        canProcess: false,
      };
    }

    const docs = await this.repository.getDocumentsByApplicationId(app.id);
    const hasId = docs.some((d) => d.type === 'NATIONAL_ID');
    const hasSelfie = docs.some((d) => d.type === 'SELFIE');

    return {
      applicationId: app.id,
      status: app.status,
      verificationStage: app.verificationStage,
      confidenceScore: app.confidenceScore,
      submittedAt: app.submittedAt.toISOString(),
      hasIdDocument: hasId,
      hasSelfie: hasSelfie,
      canProcess: hasId && hasSelfie && app.status !== 'APPROVED',
    };
  }

  @Get('result/:applicationId')
  @ApiOperation({ summary: 'Get full verification result' })
  @ApiResponse({ status: 200, description: 'Verification result' })
  async getResult(
    @Param('applicationId') applicationId: string,
  ): Promise<KycResultResponseDto> {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app) {
      throw new Error('Application not found');
    }

    return {
      applicationId: app.id,
      decision: app.status === 'APPROVED'
        ? 'APPROVED'
        : app.status === 'REJECTED'
          ? 'REJECTED'
          : 'MANUAL_REVIEW',
      confidenceScore: app.confidenceScore ?? 0,
      decisionReason: app.rejectionReason ?? '',
      scores: {
        ocr: app.ocrConfidence ?? 0,
        faceMatch: app.faceMatchConfidence ?? 0,
        imageQuality: app.imageQualityScore ?? 0,
        documentQuality: app.documentQualityScore ?? 0,
        fraudRisk: app.fraudScore ?? 0,
      },
      fraudFlagCount: 0, // TODO: query fraud flags
      extractedName: (app.ocrExtractedData as any)?.fullName?.value ?? null,
      extractedIdNumber: app.nationalIdNumber,
      faceMatchSimilarity: app.facialMatchScore,
      totalProcessingTimeMs: 0,
    };
  }

  @Post('retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed KYC verification' })
  async retry(
    @Body('applicationId') applicationId: string,
    @Body('userId') userId: string,
  ): Promise<{ decision: string; confidenceScore: number }> {
    const result = await this.workflowService.processVerification(
      applicationId,
      userId,
    );
    return {
      decision: result.decision,
      confidenceScore: result.confidenceScore,
    };
  }
}
