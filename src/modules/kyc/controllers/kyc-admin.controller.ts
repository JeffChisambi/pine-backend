import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AdminDecisionDto } from '../dto/admin-decision.dto';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../interfaces/kyc-repository.interface';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { KycWorkflowService } from '../services/kyc-workflow.service';

/**
 * Admin-facing KYC endpoints for manual review workflows.
 *
 * Routes (all prefixed /admin/kyc via global v1 prefix → /v1/admin/kyc):
 *   GET  /queue               — paginated application queue
 *   GET  /counts              — counts per status
 *   GET  /:id                 — full detail with signed image URLs + OCR data
 *   POST /:id/approve         — approve (Kusata path-param style)
 *   POST /:id/reject          — reject  (Kusata path-param style)
 *   POST /approve             — [legacy] body-based approve
 *   POST /reject              — [legacy] body-based reject
 */
@ApiTags('admin', 'kyc')
@Controller('admin/kyc')
export class KycAdminController {
  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
    private readonly storageService: StorageService,
    private readonly workflowService: KycWorkflowService,
  ) {}

  // ── Queue ─────────────────────────────────────────────────────────────────

  @Get('queue')
  @ApiOperation({ summary: 'Paginated KYC application queue' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiResponse({ status: 200 })
  async queue(
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('status') status?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit ?? '50', 10) || 50, 100);
    const parsedPage = Math.max(parseInt(page ?? '1', 10) || 1, 1);

    const result = await this.repository.getQueuePage({
      page: parsedPage,
      limit: parsedLimit,
      status,
    });

    return {
      applications: result.applications.map((app) => ({
        id: app.id,
        userId: app.userId,
        userName: (app.firstName && app.lastName)
          ? `${app.firstName} ${app.lastName}`
          : 'Unknown',
        userEmail: app.email ?? null,
        userPhone: app.phone ?? '',
        status: app.status,
        nationalIdNumber: app.nationalIdNumber,
        city: app.city ?? null,
        facialMatchScore: app.facialMatchScore,
        ocrConfidence: app.ocrConfidence,
        livenessScore: app.livenessScore ?? null,
        documentType: app.documentType ?? 'NATIONAL_ID',
        tier: app.tier ?? null,
        reviewDecision: app.reviewDecision ?? null,
        reviewerName: app.reviewerName ?? null,
        reviewNotes: app.reviewerNotes,
        riskFlags: app.riskFlags ?? [],
        emailVerified: app.emailVerified ?? null,
        phoneVerified: app.phoneVerified ?? null,
        submittedAt: app.submittedAt.toISOString(),
        reviewedAt: app.reviewedAt?.toISOString() ?? null,
        confidenceScore: app.confidenceScore,
      })),
      count: result.applications.length,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
    };
  }

  // ── Counts ────────────────────────────────────────────────────────────────

  @Get('counts')
  @ApiOperation({ summary: 'Aggregate KYC counts per status' })
  @ApiResponse({ status: 200 })
  async counts() {
    return this.repository.getCountsByStatus();
  }

  // ── Single Application Detail ─────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Full application detail with signed image URLs + OCR' })
  @ApiResponse({ status: 200 })
  async getDetail(@Param('id') applicationId: string) {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app) {
      throw new Error('Application not found');
    }

    const documents = await this.repository.getDocumentsByApplicationId(applicationId);
    const auditHistory = await this.repository.getAuditHistory(applicationId);

    // Generate signed URLs for all documents
    const docsWithUrls = await Promise.all(
      documents.map(async (doc) => {
        let imageUrl: string | null = null;
        try {
          imageUrl = await this.storageService.getSignedDownloadUrl(
            doc.storageBucket as 'kyc',
            doc.storageKey,
          );
        } catch {
          imageUrl = null;
        }
        return {
          id: doc.id,
          type: doc.type,
          imageUrl,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          uploadedAt: doc.uploadedAt.toISOString(),
        };
      }),
    );

    // Normalise OCR extracted data — backend stores raw OCR objects
    // with nested { value, confidence } shapes; Kusata expects flat strings
    const raw = app.ocrExtractedData as Record<string, any> | null;
    const ocrExtractedData = raw
      ? {
          fullName: raw.fullName?.value ?? raw.fullName ?? null,
          dateOfBirth: raw.dateOfBirth?.value ?? raw.dateOfBirth ?? null,
          nationalId: raw.nationalIdNumber?.value ?? raw.nationalIdNumber ?? app.nationalIdNumber ?? null,
          documentNumber: raw.nationalIdNumber?.value ?? raw.nationalIdNumber ?? app.nationalIdNumber ?? null,
          expiryDate: raw.expiryDate?.value ?? raw.expiryDate ?? null,
          address: raw.address?.value ?? raw.address ?? null,
          nationality: raw.nationality?.value ?? raw.nationality ?? null,
          gender: raw.gender?.value ?? raw.gender ?? null,
        }
      : null;

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
        ocrExtractedData,
        reviewerNotes: app.reviewerNotes,
        submittedAt: app.submittedAt.toISOString(),
        reviewedAt: app.reviewedAt?.toISOString() ?? null,
      },
      documents: docsWithUrls,
      auditHistory: auditHistory.map((entry) => ({
        action: entry.action,
        actorId: entry.actorId,
        details: entry.details,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  // ── Legacy body-based routes (backward compat) ─────────────────────────────
  // IMPORTANT: These MUST be declared before the /:id/* dynamic routes so that
  // NestJS (Express) resolves the static paths first.

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Legacy] Approve — prefer /:id/approve' })
  async approve(@Body() dto: AdminDecisionDto) {
    return this.approveById(dto.applicationId, { notes: dto.notes });
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Legacy] Reject — prefer /:id/reject' })
  async reject(@Body() dto: AdminDecisionDto) {
    return this.rejectById(dto.applicationId, {
      reason: dto.reason ?? 'No reason provided',
      notes: dto.notes,
    });
  }

  // ── Approve (path-param — matches Kusata hook) ────────────────────────────

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a KYC application' })
  @ApiResponse({ status: 200 })
  async approveById(
    @Param('id') applicationId: string,
    @Body() body: { notes?: string },
  ) {
    await this.repository.recordReview({
      applicationId,
      reviewerId: 'admin',
      reviewerName: 'Compliance Officer',
      decision: 'APPROVED',
      notes: body.notes,
    });

    await this.repository.updateApplicationStatus(applicationId, 'APPROVED', {
      reviewerNotes: body.notes ?? null,
    });

    await this.repository.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'ADMIN_APPROVED',
      actorId: 'admin',
      details: { notes: body.notes },
    });

    // Best-effort: sync user.kycStatus. Never let this fail the whole request.
    try {
      const app = await this.repository.getApplicationById(applicationId);
      if (app) {
        await this.workflowService.setUserKycStatus(app.userId, 'APPROVED');
      }
    } catch (syncErr) {
      // Log but do not rethrow — the application is already approved in the DB.
      console.warn('[KycAdmin] setUserKycStatus(APPROVED) failed:', syncErr);
    }

    return { message: 'Application approved', applicationId };
  }

  // ── Reject (path-param — matches Kusata hook) ─────────────────────────────

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a KYC application' })
  @ApiResponse({ status: 200 })
  async rejectById(
    @Param('id') applicationId: string,
    @Body() body: { reason: string; notes?: string },
  ) {
    if (!body.reason) throw new Error('Rejection reason is required');

    await this.repository.recordReview({
      applicationId,
      reviewerId: 'admin',
      reviewerName: 'Compliance Officer',
      decision: 'REJECTED',
      reason: body.reason,
      notes: body.notes,
    });

    await this.repository.updateApplicationStatus(applicationId, 'REJECTED', {
      rejectionReason: body.reason,
      reviewerNotes: body.notes ?? null,
    });

    await this.repository.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'ADMIN_REJECTED',
      actorId: 'admin',
      details: { reason: body.reason, notes: body.notes },
    });

    // Best-effort: sync user.kycStatus. Never let this fail the whole request.
    try {
      const app = await this.repository.getApplicationById(applicationId);
      if (app) {
        await this.workflowService.setUserKycStatus(app.userId, 'REJECTED');
      }
    } catch (syncErr) {
      console.warn('[KycAdmin] setUserKycStatus(REJECTED) failed:', syncErr);
    }

    return { message: 'Application rejected', applicationId };
  }
  }

  @Post('reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Legacy] Reject — prefer /:id/reject' })
  async reject(@Body() dto: AdminDecisionDto) {
    return this.rejectById(dto.applicationId, {
      reason: dto.reason ?? 'No reason provided',
      notes: dto.notes,
    });
  }
}
