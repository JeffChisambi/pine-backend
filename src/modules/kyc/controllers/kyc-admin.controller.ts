import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminDecisionDto } from '../dto/admin-decision.dto';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../interfaces/kyc-repository.interface';
import { KycVerificationStage } from '../domain/kyc-stage.enum';

/**
 * Admin-facing KYC endpoints for manual review workflows.
 * Protected by `@Roles(Role.COMPLIANCE_OFFICER, Role.SUPER_ADMIN)`
 * in Phase 2 (when AuthModule is implemented).
 */
@ApiTags('admin', 'kyc')
@Controller('admin/kyc')
export class KycAdminController {
  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
  ) {}

  @Get('pending')
  @ApiOperation({
    summary: 'List applications pending manual review',
    description: 'Returns applications that scored MANUAL_REVIEW from the confidence engine.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Pending applications' })
  async getPending(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit ?? '20', 10) || 20, 50);
    const applications = await this.repository.getPendingApplications(
      parsedLimit,
      cursor,
    );

    return {
      applications: applications.map((app) => ({
        id: app.id,
        userId: app.userId,
        status: app.status,
        verificationStage: app.verificationStage,
        confidenceScore: app.confidenceScore,
        facialMatchScore: app.facialMatchScore,
        ocrConfidence: app.ocrConfidence,
        nationalIdNumber: app.nationalIdNumber,
        submittedAt: app.submittedAt.toISOString(),
      })),
      count: applications.length,
    };
  }

  @Get('review')
  @ApiOperation({
    summary: 'Get full application details for manual review',
    description: 'Returns all verification data: images, OCR output, similarity score, fraud flags.',
  })
  @ApiQuery({ name: 'applicationId', required: true, type: String })
  @ApiResponse({ status: 200, description: 'Application review data' })
  async getReviewData(@Query('applicationId') applicationId: string) {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app) {
      throw new Error('Application not found');
    }

    const documents = await this.repository.getDocumentsByApplicationId(applicationId);
    const auditHistory = await this.repository.getAuditHistory(applicationId);

    return {
      application: {
        id: app.id,
        userId: app.userId,
        status: app.status,
        verificationStage: app.verificationStage,
        nationalIdNumber: app.nationalIdNumber,
        dateOfBirth: app.dateOfBirth?.toISOString() ?? null,
        confidenceScore: app.confidenceScore,
        facialMatchScore: app.facialMatchScore,
        ocrConfidence: app.ocrConfidence,
        faceMatchConfidence: app.faceMatchConfidence,
        imageQualityScore: app.imageQualityScore,
        documentQualityScore: app.documentQualityScore,
        fraudScore: app.fraudScore,
        ocrExtractedData: app.ocrExtractedData,
        reviewerNotes: app.reviewerNotes,
        submittedAt: app.submittedAt.toISOString(),
        reviewedAt: app.reviewedAt?.toISOString() ?? null,
      },
      documents: documents.map((doc) => ({
        id: doc.id,
        type: doc.type,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        uploadedAt: doc.uploadedAt.toISOString(),
        // NOTE: Storage keys are never exposed — admin uses signed URLs
      })),
      auditHistory: auditHistory.map((entry) => ({
        action: entry.action,
        actorId: entry.actorId,
        details: entry.details,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a KYC application' })
  @ApiResponse({ status: 200, description: 'Application approved' })
  async approve(@Body() dto: AdminDecisionDto) {
    if (dto.decision !== 'APPROVED') {
      throw new Error('Use /admin/kyc/reject for rejections');
    }

    await this.repository.recordReview({
      applicationId: dto.applicationId,
      reviewerId: 'admin', // TODO: extract from JWT in Phase 2
      reviewerName: 'System', // TODO: populate from JWT in Phase 2
      decision: 'APPROVED',
      notes: dto.notes,
    });

    await this.repository.updateApplicationStatus(
      dto.applicationId,
      'APPROVED',
      { reviewerNotes: dto.notes ?? null },
    );

    await this.repository.recordAuditEntry({
      kycApplicationId: dto.applicationId,
      action: 'ADMIN_APPROVED',
      actorId: 'admin',
      details: { notes: dto.notes },
    });

    return { message: 'Application approved', applicationId: dto.applicationId };
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a KYC application' })
  @ApiResponse({ status: 200, description: 'Application rejected' })
  async reject(@Body() dto: AdminDecisionDto) {
    if (dto.decision !== 'REJECTED') {
      throw new Error('Use /admin/kyc/approve for approvals');
    }

    if (!dto.reason) {
      throw new Error('Rejection reason is required');
    }

    await this.repository.recordReview({
      applicationId: dto.applicationId,
      reviewerId: 'admin',
      reviewerName: 'System', // TODO: populate from JWT in Phase 2
      decision: 'REJECTED',
      reason: dto.reason,
      notes: dto.notes,
    });

    await this.repository.updateApplicationStatus(
      dto.applicationId,
      'REJECTED',
      {
        rejectionReason: dto.reason,
        reviewerNotes: dto.notes ?? null,
      },
    );

    await this.repository.recordAuditEntry({
      kycApplicationId: dto.applicationId,
      action: 'ADMIN_REJECTED',
      actorId: 'admin',
      details: { reason: dto.reason, notes: dto.notes },
    });

    return { message: 'Application rejected', applicationId: dto.applicationId };
  }
}
