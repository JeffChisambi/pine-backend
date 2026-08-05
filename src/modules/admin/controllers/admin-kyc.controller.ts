import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { CsdFormService } from '../../kyc/services/csd-form.service';
import { ApproveKycDto } from '../../kyc/dto/approve-kyc.dto';
import { RejectKycDto } from '../../kyc/dto/reject-kyc.dto';
import { RequestDocsDto } from '../../kyc/dto/request-docs.dto';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../../core/exceptions/app.exception';
import { ErrorCode } from '../../../core/constants/error-codes.constant';

// ── Signed URL TTL for KYC document review ───────────────────────────────────
// Per the Kusata API contract §7: image URLs must be valid for ≥ 1 hour so the
// admin can open images after the detail page has already loaded.
const KYC_SIGNED_URL_TTL_SECONDS = 3600; // 1 hour

// ── Terminal statuses that cannot be mutated ─────────────────────────────────
const TERMINAL_STATUSES = new Set(['APPROVED', 'REJECTED']);

// ── Statuses from which request-docs is allowed ──────────────────────────────
const REQUEST_DOCS_ALLOWED = new Set(['PENDING', 'MANUAL_REVIEW', 'ADDITIONAL_DOCS']);

// ── Helper: scale 0-1 score to 0-100 for the frontend ────────────────────────
function toPercent(v: number | null | undefined): number | null {
  return v != null ? Math.round(v * 100 * 100) / 100 : null;
}

// ── Helper: extract flat KycOcrData from the AI pipeline's OcrExtractionResult
// The OCR pipeline stores fields as { value, confidence } objects.
// The frontend expects flat string values.
function extractOcrData(ocrJson: unknown): Record<string, string | null> | null {
  if (!ocrJson || typeof ocrJson !== 'object') return null;
  const data = ocrJson as Record<string, unknown>;

  function fieldValue(f: unknown): string | null {
    if (!f) return null;
    if (typeof f === 'string') return f || null;
    if (typeof f === 'object' && f !== null && 'value' in f) {
      const v = (f as Record<string, unknown>).value;
      return typeof v === 'string' ? v || null : null;
    }
    return null;
  }

  const fullName = fieldValue(data.fullName);
  const dateOfBirth = fieldValue(data.dateOfBirth);
  const nationalId = fieldValue(data.nationalIdNumber);
  const documentNumber = fieldValue(data.documentNumber);
  const expiryDate = fieldValue(data.expiryDate);
  const address = fieldValue(data.address);
  const nationality = fieldValue(data.nationality);
  const gender = fieldValue(data.gender);

  // Only return an object if at least one meaningful field has a value.
  if (!fullName && !dateOfBirth && !nationalId && !documentNumber) return null;

  return { fullName, dateOfBirth, nationalId, documentNumber, expiryDate, address, nationality, gender };
}

// ── Helper: per-field OCR confidences for the review UI ──────────────────────
function extractOcrFieldConfidences(ocrJson: unknown): Record<string, number> | null {
  if (!ocrJson || typeof ocrJson !== 'object') return null;
  const data = ocrJson as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ['fullName', 'nationalIdNumber', 'dateOfBirth', 'gender', 'documentNumber', 'expiryDate', 'nationality']) {
    const f = data[key];
    if (f && typeof f === 'object' && 'confidence' in (f as any)) {
      const c = (f as any).confidence;
      if (typeof c === 'number') out[key] = Math.round(c * 100);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Helper: build a KycApplicationRow from a Prisma + user record ─────────────
function buildApplicationRow(app: any, user: any): Record<string, unknown> {
  const extraData = (app.ocrExtractedData as Record<string, unknown>) ?? {};

  // ocrConfidence: real value from the AI pipeline (_ocrConfidence in JSON, 0-1)
  const ocrConfidenceRaw = (extraData._ocrConfidence as number) ?? null;
  // facialMatchScore: stored as DECIMAL(5,4) on the model (0-1), multiply to %
  const facialMatchRaw = app.facialMatchScore ? Number(app.facialMatchScore) : null;
  // livenessScore: dedicated column OR JSON fallback (0-1 → %)
  const livenessRaw =
    app.livenessScore != null
      ? Number(app.livenessScore)
      : ((extraData._livenessScore as number) ?? null);

  // riskFlags: dedicated column OR derive from _fraudFlags in OCR JSON
  let riskFlags: string[] | null = null;
  if (Array.isArray(app.riskFlags) && app.riskFlags.length > 0) {
    riskFlags = app.riskFlags as string[];
  } else {
    const jsonFlags = extraData._fraudFlags as Array<{ type?: string }> | undefined;
    if (Array.isArray(jsonFlags) && jsonFlags.length > 0) {
      riskFlags = jsonFlags.map((f) => f.type ?? '').filter(Boolean);
    }
  }

  const reviewNotes =
    app.reviewNotes ?? ((extraData._reviewerNotes as string) ?? null);

  return {
    id: app.id,
    userId: app.userId,

    // User identity
    userName:
      user
        ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'Unknown'
        : 'Unknown',
    userEmail: user?.email ?? null,
    userPhone: user?.phone ?? '',
    city: app.city ?? null,
    emailVerified: user ? user.emailVerifiedAt != null : null,
    phoneVerified: user ? user.phoneVerifiedAt != null : null,

    // Document
    documentType: Array.isArray(app.documents)
      ? (app.documents[0]?.type ?? null)
      : null,
    nationalIdNumber: app.nationalIdNumber ?? null,

    // Tier
    tier: app.tier ?? null,

    // Verification scores (0–100 for the frontend)
    ocrConfidence: toPercent(ocrConfidenceRaw),
    facialMatchScore: toPercent(facialMatchRaw),
    livenessScore: toPercent(livenessRaw),

    // Risk
    riskFlags: riskFlags ?? [],

    // Status
    status: app.status,

    // Review
    reviewDecision: app.reviewDecision ?? null,
    reviewerName: app.reviewerName ?? null,
    reviewNotes,
    reviewedAt: app.reviewedAt?.toISOString() ?? null,

    submittedAt: app.submittedAt.toISOString(),
  };
}

/**
 * Admin KYC Controller — implements the Kusata Broker Dashboard API contract v1.0.
 *
 * Endpoints:
 *   GET  /admin/kyc/queue                       — paginated queue
 *   GET  /admin/kyc/counts                      — counts per status
 *   GET  /admin/kyc/:applicationId              — full detail
 *   POST /admin/kyc/:applicationId/approve      — approve application
 *   POST /admin/kyc/:applicationId/reject       — reject application
 *   POST /admin/kyc/:applicationId/request-docs — request additional documents
 *
 * Auth / RBAC:
 *   - All routes: requires valid admin JWT and KYC_REVIEW permission.
 *   - Mutation routes (approve, reject, request-docs): additionally require
 *     KYC_APPROVE. BROKER role does NOT have KYC_APPROVE, so mutations return
 *     403 automatically for brokers (see permissions.constant.ts).
 */
@ApiTags('admin', 'kyc')
@ApiBearerAuth()
@Controller('admin/kyc')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AdminKycController {
  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly kycRepo: IKycRepository,
    private readonly auditLogService: AuditLogService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly csdFormService: CsdFormService,
  ) {}

  // ── GET /admin/kyc/queue ───────────────────────────────────────────────────

  @Get('queue')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({
    summary: 'Paginated KYC application queue',
    description:
      'Returns a page of KYC applications. The frontend polls this every 30 s.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '1-based page number. Default: 1.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size. Default: 50. Max: 200.' })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description:
      'Filter by status: PENDING, APPROVED, REJECTED, ADDITIONAL_DOCS, MANUAL_REVIEW, NOT_SUBMITTED.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of KycApplicationRow objects.' })
  async getQueue(
    @Query('page') pageStr?: string,
    @Query('limit') limitStr?: string,
    @Query('status') status?: string,
  ) {
    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1);
    const limit = Math.min(Math.max(1, parseInt(limitStr ?? '50', 10) || 50), 200);

    const { applications, total, totalPages } = await this.kycRepo.getQueuePage({
      page,
      limit,
      status: status?.toUpperCase(),
    });

    // getQueuePage returns KycApplicationRecord objects — re-map to KycApplicationRow
    // using the full application record (user fields already joined).
    const rows = applications.map((rec) => {
      // KycApplicationRecord has firstName/lastName/email etc. from the join.
      const syntheticUser = {
        firstName: rec.firstName,
        lastName: rec.lastName,
        email: rec.email,
        // Use epoch Date(0) as a sentinel for "verified at some past point" —
        // the KycApplicationRecord only carries the boolean flag, not the timestamp.
        // Previously this passed {} (empty object), which is truthy but not a Date;
        // any downstream .toISOString() call would throw a TypeError.
        emailVerifiedAt: rec.emailVerified ? new Date(0) : null,
        phone: rec.phone,
        phoneVerifiedAt: rec.phoneVerified ? new Date(0) : null,
      };
      const syntheticApp = {
        ...rec,
        facialMatchScore: rec.facialMatchScore,
        livenessScore: rec.livenessScore,
        riskFlags: rec.riskFlags,
        documents: rec.documentType ? [{ type: rec.documentType }] : [],
      };
      return buildApplicationRow(syntheticApp, syntheticUser);
    });

    return {
      applications: rows,
      count: rows.length,
      total,
      page,
      totalPages,
    };
  }

  // ── GET /admin/kyc/counts ──────────────────────────────────────────────────

  @Get('counts')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({
    summary: 'KYC application counts per status',
    description:
      'Returns aggregate counts for every KYC status. Drives tab badges and stats cards. Polled every 60 s by the frontend.',
  })
  @ApiResponse({ status: 200, description: 'KycCountsByStatus object.' })
  async getCounts() {
    // Application-level counts from kyc_applications
    const appGroups = await this.prisma.kycApplication.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    // NOT_SUBMITTED is best represented by users who have never started KYC
    const notSubmittedCount = await this.prisma.user.count({
      where: { kycStatus: 'NOT_SUBMITTED' },
    });

    const counts: Record<string, number> = {
      NOT_SUBMITTED: notSubmittedCount,
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
      ADDITIONAL_DOCS: 0,
      MANUAL_REVIEW: 0,
    };

    for (const g of appGroups) {
      counts[g.status] = (counts[g.status] ?? 0) + g._count.id;
    }

    return counts;
  }

  // ── GET /admin/kyc/:applicationId ─────────────────────────────────────────

  @Get(':applicationId')
  @RequirePermissions(Permission.KYC_REVIEW)
  @ApiOperation({
    summary: 'Full KYC application review data',
    description:
      'Returns the application detail, OCR data, and document images (presigned URLs, valid for 1 hour).',
  })
  @ApiParam({ name: 'applicationId', description: 'KYC application UUID' })
  @ApiResponse({ status: 200, description: 'KycApplicationDetail object.' })
  @ApiResponse({ status: 404, description: 'Application not found.' })
  async getDetail(@Param('applicationId') applicationId: string) {
    // Fetch application with user and documents joined
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            emailVerifiedAt: true,
            phone: true,
            phoneVerifiedAt: true,
          },
        },
        documents: true,
      },
    });

    if (!app) {
      throw new ResourceNotFoundException('KYC application', applicationId);
    }

    // Generate presigned download URLs (TTL = 1 hour per §7 of the API contract)
    const documents = await Promise.all(
      app.documents.map(async (doc) => {
        let imageUrl: string | null = null;
        try {
          imageUrl = await this.storageService.getSignedDownloadUrl(
            'kyc',
            doc.storageKey,
            KYC_SIGNED_URL_TTL_SECONDS,
          );
        } catch {
          // If storage is unavailable, degrade gracefully — the frontend shows
          // a "Document not uploaded" placeholder for null imageUrl values.
        }
        return {
          id: doc.id,
          type: doc.type,
          imageUrl,
          mimeType: doc.mimeType,
          uploadedAt: doc.uploadedAt.toISOString(),
        };
      }),
    );

    const applicationRow = buildApplicationRow(
      { ...app, documents: app.documents },
      app.user,
    );

    // Extract OCR data from the AI pipeline's JSON blob into the flat KycOcrData shape
    const ocrExtractedData = extractOcrData(app.ocrExtractedData);
    const ocrFieldConfidences = extractOcrFieldConfidences(app.ocrExtractedData);

    // MRZ verification summary (present when the ID back carried a readable MRZ)
    const extraJson = (app.ocrExtractedData ?? {}) as Record<string, unknown>;
    const mrzRaw = extraJson.mrz as { found?: boolean; checkDigitScore?: number } | undefined;
    const mrz = mrzRaw?.found
      ? { found: true, checkDigitScore: Math.round((mrzRaw.checkDigitScore ?? 0) * 100) }
      : null;

    // Extracted + formatted residential address (proof-of-residency pipeline)
    const extractedAddressRaw = extraJson._extractedAddress as
      | { formatted?: string | null; confidence?: number; sourceLines?: string[] }
      | undefined;
    const address = {
      addressLine1: app.addressLine1 ?? null,
      addressLine2: app.addressLine2 ?? null,
      city: app.city ?? null,
      district: app.district ?? null,
      formatted:
        extractedAddressRaw?.formatted ??
        ([app.addressLine1, app.addressLine2, app.city]
          .filter(Boolean)
          .join(', ') || null),
      confidence:
        extractedAddressRaw?.confidence != null
          ? Math.round(extractedAddressRaw.confidence * 100)
          : null,
    };

    return {
      application: {
        ...applicationRow,
        ocrExtractedData,
        ocrFieldConfidences,
        mrz,
        address,
      },
      documents,
    };
  }

  // ── GET /admin/kyc/:applicationId/csd-form ────────────────────────────────

  @Get(':applicationId/csd-form')
  @RequirePermissions(Permission.KYC_REVIEW)
  @Header('Content-Type', 'application/pdf')
  @ApiOperation({
    summary: 'Generate the filled CSD Securities Account Opening form (PDF)',
    description:
      'Returns the Reserve Bank of Malawi CSD account-opening form pre-filled ' +
      'with the applicant\'s verified KYC data, ready for signing and submission.',
  })
  @ApiParam({ name: 'applicationId', description: 'KYC application UUID' })
  @ApiResponse({ status: 200, description: 'PDF document.' })
  @ApiResponse({ status: 404, description: 'Application not found.' })
  async getCsdForm(
    @Param('applicationId') applicationId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!app) {
      throw new ResourceNotFoundException('KYC application', applicationId);
    }

    const pdf = await this.csdFormService.generateForApplication(applicationId);

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_CSD_FORM_GENERATED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
    });

    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `attachment; filename="CSD-Account-Opening-${applicationId.slice(0, 8)}.pdf"`,
    });
  }

  // ── POST /admin/kyc/:applicationId/approve ────────────────────────────────

  @Post(':applicationId/approve')
  @RequirePermissions(Permission.KYC_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve KYC application' })
  @ApiParam({ name: 'applicationId', description: 'KYC application UUID' })
  @ApiResponse({ status: 200, description: 'Application approved.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (BROKER role).' })
  @ApiResponse({ status: 404, description: 'Application not found.' })
  @ApiResponse({ status: 409, description: 'Application already reviewed (terminal state).' })
  async approve(
    @Param('applicationId') applicationId: string,
    @Body() body: ApproveKycDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, userId: true, status: true },
    });
    if (!app) {
      throw new ResourceNotFoundException('KYC application', applicationId);
    }
    if (TERMINAL_STATUSES.has(app.status)) {
      throw new ConflictException(
        'This application has already been reviewed and cannot be changed.',
        ErrorCode.KYC_ALREADY_REVIEWED,
      );
    }

    const reviewerName = await this.getReviewerName(admin);
    const reviewedAt = new Date();

    // Single atomic update — sets status, review fields, and user.kycStatus
    await this.prisma.$transaction(async (tx) => {
      await tx.kycApplication.update({
        where: { id: applicationId },
        data: {
          status: 'APPROVED' as any,
          reviewDecision: 'APPROVED',
          reviewedAt,
          reviewedById: admin.id,
          reviewerName,
          reviewNotes: body.notes ?? null,
        },
      });
      await tx.user.update({
        where: { id: app.userId },
        data: { kycStatus: 'APPROVED' },
      });
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_APPROVED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { notes: body.notes },
    });

    return {
      applicationId,
      userId: app.userId,
      newStatus: 'APPROVED',
      reviewedAt: reviewedAt.toISOString(),
      reviewerName,
    };
  }

  // ── POST /admin/kyc/:applicationId/reject ─────────────────────────────────

  @Post(':applicationId/reject')
  @RequirePermissions(Permission.KYC_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject KYC application' })
  @ApiParam({ name: 'applicationId', description: 'KYC application UUID' })
  @ApiResponse({ status: 200, description: 'Application rejected.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (BROKER role).' })
  @ApiResponse({ status: 404, description: 'Application not found.' })
  @ApiResponse({ status: 409, description: 'Application already reviewed (terminal state).' })
  @ApiResponse({ status: 422, description: 'reason is required.' })
  async reject(
    @Param('applicationId') applicationId: string,
    @Body() body: RejectKycDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    // Explicit business-level reason check — produces the documented REASON_REQUIRED
    // code even if class-validator somehow passes (e.g. the field is whitespace only).
    if (!body.reason || !body.reason.trim()) {
      throw new ValidationException('Reason is required.', {
        code: ErrorCode.KYC_REASON_REQUIRED,
        errors: [{ field: 'reason', message: 'Reason is required' }],
      });
    }

    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, userId: true, status: true },
    });
    if (!app) {
      throw new ResourceNotFoundException('KYC application', applicationId);
    }
    if (TERMINAL_STATUSES.has(app.status)) {
      throw new ConflictException(
        'This application has already been reviewed and cannot be changed.',
        ErrorCode.KYC_ALREADY_REVIEWED,
      );
    }

    const reviewerName = await this.getReviewerName(admin);
    const reviewedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.kycApplication.update({
        where: { id: applicationId },
        data: {
          status: 'REJECTED' as any,
          reviewDecision: 'REJECTED',
          reviewedAt,
          reviewedById: admin.id,
          reviewerName,
          reviewNotes: body.notes ?? null,
          rejectionReason: body.reason,
        },
      });
      await tx.user.update({
        where: { id: app.userId },
        data: { kycStatus: 'REJECTED' },
      });
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_REJECTED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: { reason: body.reason, notes: body.notes },
    });

    return {
      applicationId,
      userId: app.userId,
      newStatus: 'REJECTED',
      reviewedAt: reviewedAt.toISOString(),
      reviewerName,
    };
  }

  // ── POST /admin/kyc/:applicationId/request-docs ───────────────────────────

  @Post(':applicationId/request-docs')
  @RequirePermissions(Permission.KYC_APPROVE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request the applicant resubmit one or more documents',
    description:
      'Sets the application status to ADDITIONAL_DOCS and stores the required document slot list. Upon resubmission the mobile app resets the status to PENDING.',
  })
  @ApiParam({ name: 'applicationId', description: 'KYC application UUID' })
  @ApiResponse({ status: 200, description: 'Document request sent.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions (BROKER role).' })
  @ApiResponse({ status: 404, description: 'Application not found.' })
  @ApiResponse({ status: 409, description: 'Application is in a terminal state.' })
  @ApiResponse({ status: 422, description: 'requiredDocuments missing or contains invalid slot codes.' })
  async requestDocs(
    @Param('applicationId') applicationId: string,
    @Body() body: RequestDocsDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Req() req: RequestWithUser,
  ) {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { id: true, userId: true, status: true },
    });
    if (!app) {
      throw new ResourceNotFoundException('KYC application', applicationId);
    }
    if (TERMINAL_STATUSES.has(app.status)) {
      throw new ConflictException(
        'Cannot request documents for an application that has already been approved or rejected.',
        ErrorCode.KYC_INVALID_STATUS_TRANSITION,
      );
    }
    if (!REQUEST_DOCS_ALLOWED.has(app.status)) {
      throw new ConflictException(
        `Cannot request documents when application status is ${app.status}.`,
        ErrorCode.KYC_INVALID_STATUS_TRANSITION,
      );
    }

    const reviewerName = await this.getReviewerName(admin);

    await this.kycRepo.requestAdditionalDocuments({
      applicationId,
      reviewerId: admin.id,
      reviewerName,
      requiredDocuments: body.requiredDocuments,
      message: body.message,
    });

    // H-4 fix: sync user.kycStatus so the mobile app shows
    // "Additional Documents Required" instead of staying on "Under Review".
    await this.prisma.user.update({
      where: { id: app.userId },
      data: { kycStatus: 'ADDITIONAL_DOCS' as any },
    });

    // M-3 fix: record the event in the KYC application's own audit trail
    // (was only logged to the system-wide AuditLog, not the KYC timeline).
    await this.kycRepo.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'DOCS_REQUESTED',
      actorId: admin.id,
      details: {
        requiredDocuments: body.requiredDocuments,
        message: body.message,
        reviewerName,
      },
    });

    await this.auditLogService.log({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'KYC_DOCS_REQUESTED',
      resourceType: 'KYC_APPLICATION',
      resourceId: applicationId,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      metadata: {
        requiredDocuments: body.requiredDocuments,
        message: body.message,
      },
    });

    return {
      applicationId,
      newStatus: 'ADDITIONAL_DOCS',
      requiredDocuments: body.requiredDocuments,
      reviewerName,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Look up the admin's display name from the User record.
   * Falls back gracefully to email → id so this never throws.
   */
  private async getReviewerName(admin: AuthenticatedUser): Promise<string> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: admin.id },
        select: { firstName: true, lastName: true },
      });
      if (user?.firstName || user?.lastName) {
        return `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
      }
    } catch {
      // Non-critical — fall through to email fallback
    }
    return admin.email ?? admin.id;
  }
}
