import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../../core/decorators/require-permissions.decorator';
import { Permission } from '../../auth/constants/permissions.constant';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser, RequestWithUser } from '../../../core/types/request-context.types';
import { AuditLogService } from '../../audit/services/audit-log.service';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../../kyc/interfaces/kyc-repository.interface';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

/**
 * Admin KYC Controller — wraps existing KycAdminController logic
 * with proper RBAC permissions and audit logging.
 */
@ApiTags('admin', 'kyc')
@ApiBearerAuth()
@Controller('admin/kyc')
export class AdminKycController {
  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly kycRepo: IKycRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('queue')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'KYC applications queue with optional status filter' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, type: String, description: 'Filter by status: PENDING, APPROVED, REJECTED, or omit for all' })
  @ApiResponse({ status: 200, description: 'KYC applications' })
  async getQueue(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ) {
    const parsedLimit = Math.min(parseInt(limit ?? '50', 10) || 50, 100);
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'NOT_SUBMITTED'];
    const where = status && validStatuses.includes(status.toUpperCase())
      ? { status: status.toUpperCase() as any }
      : {};

    const applications = await this.prisma.kycApplication.findMany({
      where,
      orderBy: { submittedAt: 'desc' },
      take: parsedLimit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        user: { select: { firstName: true, lastName: true, email: true, phone: true } },
        documents: { select: { type: true } },
      },
    });

    const totalCount = await this.prisma.kycApplication.count({ where });

    return {
      applications: applications.map((app: any) => ({
        id: app.id,
        userId: app.userId,
        userName: `${app.user.firstName} ${app.user.lastName}`,
        userEmail: app.user.email,
        userPhone: app.user.phone,
        status: app.status,
        nationalIdNumber: app.nationalIdNumber,
        city: app.city,
        facialMatchScore: app.facialMatchScore ? Number(app.facialMatchScore) * 100 : null,
        ocrConfidence: app.ocrExtractedData ? 85 : null,
        documentType: app.documents?.[0]?.type ?? null,
        reviewDecision: app.reviewDecision,
        submittedAt: app.submittedAt.toISOString(),
        reviewedAt: app.reviewedAt?.toISOString() ?? null,
      })),
      count: totalCount,
    };
  }

  @Get(':applicationId')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({ summary: 'Full KYC application review data' })
  @ApiResponse({ status: 200, description: 'Application review workspace' })
  async getReviewData(@Param('applicationId') applicationId: string) {
    const app = await this.kycRepo.getApplicationById(applicationId);
    if (!app) {
      return { error: 'Application not found' };
    }

    const documents = await this.kycRepo.getDocumentsByApplicationId(applicationId);
    const auditHistory = await this.kycRepo.getAuditHistory(applicationId);

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
      })),
      auditHistory: auditHistory.map((entry) => ({
        action: entry.action,
        actorId: entry.actorId,
        details: entry.details,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  @Post(':applicationId/approve')
  @RequirePermissions(Permission.KYC_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve KYC application' })
  async approve(
    @Param('applicationId') applicationId: string,
    @Body() body: { notes?: string },
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    await this.kycRepo.recordReview({
      applicationId,
      reviewerId: admin.id,
      decision: 'APPROVED',
      notes: body.notes,
    });

    await this.kycRepo.updateApplicationStatus(applicationId, 'APPROVED', {
      reviewerNotes: body.notes ?? null,
    });

    await this.kycRepo.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'ADMIN_APPROVED',
      actorId: admin.id,
      details: { notes: body.notes },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_APPROVED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return { message: 'Application approved', applicationId };
  }

  @Post(':applicationId/reject')
  @RequirePermissions(Permission.KYC_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject KYC application' })
  async reject(
    @Param('applicationId') applicationId: string,
    @Body() body: { reason: string; notes?: string },
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    await this.kycRepo.recordReview({
      applicationId,
      reviewerId: admin.id,
      decision: 'REJECTED',
      reason: body.reason,
      notes: body.notes,
    });

    await this.kycRepo.updateApplicationStatus(applicationId, 'REJECTED', {
      rejectionReason: body.reason,
      reviewerNotes: body.notes ?? null,
    });

    await this.kycRepo.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'ADMIN_REJECTED',
      actorId: admin.id,
      details: { reason: body.reason, notes: body.notes },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_REJECTED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reason: body.reason },
    });

    return { message: 'Application rejected', applicationId };
  }
}
