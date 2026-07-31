import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { KycWorkflowService } from '../services/kyc-workflow.service';
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
import {
  QueueName,
  DEFAULT_JOB_OPTIONS,
} from '../../../core/constants/queue-names.constant';

/**
 * Customer-facing KYC endpoints. All routes are under /v1/kyc/.
 *
 * Auth: JwtAuthGuard is registered globally via APP_GUARD in AuthModule.
 * Every route here requires a valid JWT — no @Public() decoration = protected.
 */
@ApiTags('kyc')
@Controller('kyc')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))  // M-10 fix
export class KycController {
  constructor(
    private readonly workflowService: KycWorkflowService,
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
    @InjectQueue(QueueName.KYC)                                       // H-3 fix
    private readonly kycQueue: Queue,
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

  @Post('upload-id-back')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload back side of national ID' })
  @ApiResponse({ status: 200, description: 'ID back uploaded' })
  async uploadIdBack(
    @UploadedFile() file: Express.Multer.File,
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ documentId: string }> {
    return this.workflowService.uploadDocument(
      applicationId,
      user.id,
      'NATIONAL_ID_BACK',
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

  /**
   * Enqueues the full KYC verification pipeline as a background job (H-3 fix).
   * Returns 202 immediately — poll GET /kyc/status/:applicationId for the result.
   * BullMQ jobId deduplication prevents concurrent pipeline runs for the same app.
   */
  @Post('process')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger the KYC verification pipeline',
    description:
      'Enqueues the full pipeline (enhance → OCR → face detect → face match → fraud → score → decide). ' +
      'Returns 202 immediately; poll GET /kyc/status for progress.',
  })
  @ApiResponse({ status: 202, description: 'Verification job enqueued' })
  async process(
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ queued: boolean; applicationId: string }> {
    // Validate ownership and document readiness before enqueueing (fail fast)
    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== user.id) {
      throw new NotFoundException('Application not found');
    }

    const docs = await this.repository.getDocumentsByApplicationId(applicationId);
    const hasId = docs.some((d) => d.type === 'NATIONAL_ID');
    const hasSelfie = docs.some((d) => d.type === 'SELFIE');
    if (!hasId || !hasSelfie) {
      throw new BadRequestException(
        'Both national ID and selfie must be uploaded before processing',
      );
    }

    // jobId uniqueness: BullMQ skips the second enqueue if a job with this ID
    // is already waiting or active — prevents duplicate concurrent pipeline runs.
    await this.kycQueue.add(
      'verify',
      { applicationId, userId: user.id },
      {
        jobId: `kyc-verify-${applicationId}`,
        ...DEFAULT_JOB_OPTIONS,
      },
    );

    return { queued: true, applicationId };
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
        submittedAt: null,        // M-1 fix: null not ''
        hasIdDocument: false,
        hasSelfie: false,
        canProcess: false,
      };
    }

    const docs = await this.repository.getDocumentsByApplicationId(app.id);
    const hasId = docs.some((d) => d.type === 'NATIONAL_ID');
    const hasSelfie = docs.some((d) => d.type === 'SELFIE');

    // M-2 fix: only allow processing when the application is in a state where
    // the user is still expected to submit — NOT when it's APPROVED/REJECTED/PENDING.
    const PROCESSABLE_STATUSES = new Set(['NOT_SUBMITTED', 'ADDITIONAL_DOCS']);
    const canProcess = hasId && hasSelfie && PROCESSABLE_STATUSES.has(app.status);

    return {
      applicationId: app.id,
      status: app.status,
      verificationStage: app.verificationStage,
      confidenceScore: app.confidenceScore,
      submittedAt: app.submittedAt?.toISOString() ?? null,
      hasIdDocument: hasId,
      hasSelfie: hasSelfie,
      canProcess,
    };
  }

  /**
   * C-2 fix: ownership check — a user can only fetch their own result.
   * Without this any authenticated user can request another user's
   * NRC number, face match scores, and fraud flags by guessing a UUID.
   */
  @Get('result/:applicationId')
  @ApiOperation({ summary: 'Get full verification result' })
  @ApiResponse({ status: 200, description: 'Verification result' })
  async getResult(
    @Param('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<KycResultResponseDto> {
    const app = await this.repository.getApplicationById(applicationId);
    // C-2 fix: null check + ownership — throws 404 for both not-found and wrong owner
    if (!app || app.userId !== user.id) {
      throw new NotFoundException('Application not found');
    }

    // H-8 fix: read real fraud flag count from the riskFlags column
    const fraudFlagCount = (app.riskFlags as string[] | null)?.length ?? 0;

    return {
      applicationId: app.id,
      decision:
        app.status === 'APPROVED'
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
      fraudFlagCount,                 // H-8 fix: real count not hardcoded 0
      extractedName: (app.ocrExtractedData as any)?.fullName?.value ?? null,
      extractedIdNumber: app.nationalIdNumber,
      faceMatchSimilarity: app.facialMatchScore,
      totalProcessingTimeMs: 0,       // not persisted; reserved for future column
    };
  }

  /**
   * Retry failed verification.
   * C-1 fix: userId MUST come from the validated JWT (@CurrentUser), not from
   * the request body — otherwise any user can re-run another user's pipeline.
   */
  @Post('retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed KYC verification' })
  async retry(
    @Body('applicationId') applicationId: string,
    @CurrentUser() user: AuthenticatedUser,  // C-1 fix: never trust userId from body
  ): Promise<{ queued: boolean; applicationId: string }> {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== user.id) {
      throw new NotFoundException('Application not found');
    }

    // Unique jobId per retry attempt (unlike process which deduplicates strictly)
    await this.kycQueue.add(
      'verify',
      { applicationId, userId: user.id },
      {
        jobId: `kyc-retry-${applicationId}-${Date.now()}`,
        ...DEFAULT_JOB_OPTIONS,
      },
    );

    return { queued: true, applicationId };
  }
}
