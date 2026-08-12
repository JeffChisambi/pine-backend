import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import type {
  IKycRepository,
  KycApplicationRecord,
  KycDocumentRecord,
} from '../interfaces/kyc-repository.interface';
import type { KycVerificationStage } from '../domain/kyc-stage.enum';
import type { FraudFlag, OcrExtractionResult } from '../domain/verification-result';

/**
 * Prisma-backed KYC repository.
 *
 * ─── Storage layout ────────────────────────────────────────────────────────────
 * ocrExtractedData (Json?) — stores OCR result fields and internal pipeline state.
 *   Private keys (prefixed _):
 *     _stage              KycVerificationStage
 *     _fraudFlags         FraudFlag[]
 *     _confidenceScore    number
 *     _ocrConfidence      number
 *     _faceMatchConfidence number
 *     _imageQualityScore  number
 *     _documentQualityScore number
 *     _fraudScore         number
 *     _reviewerNotes      string
 *
 *   Every write to this column MUST read → merge → write via readExistingJson().
 *   Never overwrite the column directly.
 *
 * FaceEmbedding (table) — dedicated table for face vectors (M-4 fix).
 *   Replaces _embeddings JSON blob; enables indexed lookups for fraud detection.
 *
 * KycDocument.contentHash (column) — indexed hash for duplicate-doc detection (L-1 fix).
 *   Replaces _documentHashes JSON blob.
 * ───────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class KycRepository implements IKycRepository {
  private readonly logger = new Logger(KycRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Application lifecycle ──────────────────────────────────────────────────

  /**
   * H-1 fix: create with status NOT_SUBMITTED so the application is invisible
   * to the broker queue until the user explicitly triggers processVerification().
   * Previously created as PENDING, which polluted the broker queue immediately.
   */
  async createApplication(userId: string): Promise<KycApplicationRecord> {
    // Stamp broker ownership from the user's persisted broker relationship
    // so KYC data is broker-isolated from the moment it exists.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { brokerId: true },
    });

    const app = await this.prisma.kycApplication.create({
      data: {
        userId,
        brokerId: user?.brokerId ?? null,
        status: 'NOT_SUBMITTED',           // H-1 fix: broker queue-invisible until submitted
        ocrExtractedData: { _stage: 'CREATED' } as any,
      },
    });

    return this.mapApplication(app);
  }

  async getApplicationById(id: string): Promise<KycApplicationRecord | null> {
    const app = await this.prisma.kycApplication.findUnique({ where: { id } });
    return app ? this.mapApplication(app) : null;
  }

  async getApplicationByUserId(
    userId: string,
  ): Promise<KycApplicationRecord | null> {
    const app = await this.prisma.kycApplication.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return app ? this.mapApplication(app) : null;
  }

  async getLatestApplicationByUserId(
    userId: string,
  ): Promise<KycApplicationRecord | null> {
    return this.getApplicationByUserId(userId);
  }

  async updateApplicationStage(
    id: string,
    stage: KycVerificationStage,
  ): Promise<void> {
    const existing = await this.readExistingJson(id);

    await this.prisma.kycApplication.update({
      where: { id },
      data: {
        ocrExtractedData: { ...existing, _stage: stage } as any,
      },
    });

    this.logger.debug({ applicationId: id, stage }, 'Application stage updated');
  }

  async updateApplicationStatus(
    id: string,
    status: string,
    data?: Partial<KycApplicationRecord>,
  ): Promise<void> {
    const updateData: Record<string, unknown> = { status };

    if (data?.nationalIdNumber !== undefined) {
      updateData.nationalIdNumber = data.nationalIdNumber;
    }
    if (data?.dateOfBirth !== undefined) {
      updateData.dateOfBirth = data.dateOfBirth;
    }
    if (data?.facialMatchScore !== undefined) {
      updateData.facialMatchScore = data.facialMatchScore;
    }
    if (data?.rejectionReason !== undefined) {
      updateData.rejectionReason = data.rejectionReason;
    }
    // Address columns — populated by the proof-of-residency extraction stage
    if (data?.addressLine1 !== undefined) updateData.addressLine1 = data.addressLine1;
    if (data?.addressLine2 !== undefined) updateData.addressLine2 = data.addressLine2;
    if (data?.city !== undefined) updateData.city = data.city;
    if (data?.district !== undefined) updateData.district = data.district;

    // Always read → merge → write to preserve existing JSON keys
    if (data?.ocrExtractedData !== undefined || data?.confidenceScore !== undefined) {
      const existing = await this.readExistingJson(id);
      const merged: Record<string, unknown> = { ...existing };

      if (data.ocrExtractedData !== undefined && data.ocrExtractedData !== null) {
        const ocr = data.ocrExtractedData as Record<string, unknown>;
        for (const [k, v] of Object.entries(ocr)) {
          merged[k] = v;
        }
      }

      if (data.confidenceScore !== undefined) merged._confidenceScore = data.confidenceScore;
      if (data.ocrConfidence !== undefined) merged._ocrConfidence = data.ocrConfidence;
      if (data.faceMatchConfidence !== undefined) merged._faceMatchConfidence = data.faceMatchConfidence;
      if (data.imageQualityScore !== undefined) merged._imageQualityScore = data.imageQualityScore;
      if (data.documentQualityScore !== undefined) merged._documentQualityScore = data.documentQualityScore;
      if (data.fraudScore !== undefined) merged._fraudScore = data.fraudScore;
      if (data.reviewerNotes !== undefined) merged._reviewerNotes = data.reviewerNotes;

      updateData.ocrExtractedData = merged;
    }

    if (status === 'APPROVED' || status === 'REJECTED') {
      updateData.reviewedAt = new Date();
      updateData.reviewDecision = status;
    }

    await this.prisma.kycApplication.update({
      where: { id },
      data: updateData,
    });
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  /**
   * L-1 fix: contentHash is stored in the KycDocument.contentHash column (indexed)
   * instead of in the ocrExtractedData JSON blob. This enables O(log n) lookups
   * for duplicate document detection rather than a full-table scan.
   */
  async createDocument(data: {
    kycApplicationId: string;
    type: string;
    storageBucket: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
  }): Promise<KycDocumentRecord> {
    const doc = await this.prisma.kycDocument.create({
      data: {
        kycApplicationId: data.kycApplicationId,
        type: data.type as any,
        storageBucket: data.storageBucket,
        storageKey: data.storageKey,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        contentHash: data.contentHash ?? null,  // L-1 fix: dedicated indexed column
      },
    });

    return this.mapDocument(doc);
  }

  /**
   * L-1 fix: reads contentHash from the document column directly — no JSON join.
   */
  async getDocumentsByApplicationId(
    applicationId: string,
  ): Promise<KycDocumentRecord[]> {
    const docs = await this.prisma.kycDocument.findMany({
      where: { kycApplicationId: applicationId },
    });
    return docs.map((d) => this.mapDocument(d));
  }

  async getDocumentByType(
    applicationId: string,
    type: string,
  ): Promise<KycDocumentRecord | null> {
    const docs = await this.getDocumentsByApplicationId(applicationId);
    return docs.find((d) => d.type === type) ?? null;
  }

  /**
   * H-5 / L-2 fix: was a permanent no-op with a debug log comment.
   * Now writes enhanced and thumbnail storage keys to dedicated columns
   * so the broker dashboard can link to AI-processed versions.
   */
  async updateDocument(
    id: string,
    data: Partial<KycDocumentRecord>,
  ): Promise<void> {
    const updateData: Record<string, unknown> = {};

    if (data.enhancedStorageKey !== undefined) {
      updateData.enhancedStorageKey = data.enhancedStorageKey;
    }
    if (data.thumbnailStorageKey !== undefined) {
      updateData.thumbnailStorageKey = data.thumbnailStorageKey;
    }
    if (data.contentHash !== undefined) {
      updateData.contentHash = data.contentHash;
    }

    if (Object.keys(updateData).length === 0) return;

    await this.prisma.kycDocument.update({
      where: { id },
      data: updateData,
    });

    this.logger.debug({ documentId: id, ...updateData }, 'Document metadata updated');
  }

  // ── OCR Results ────────────────────────────────────────────────────────────

  async saveOcrResult(data: {
    kycApplicationId: string;
    documentId: string;
    extractedData: OcrExtractionResult;
    overallConfidence: number;
    rawText: string;
  }): Promise<void> {
    const existing = await this.readExistingJson(data.kycApplicationId);

    const merged: Record<string, unknown> = { ...existing };
    const ocr = data.extractedData as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(ocr)) {
      merged[k] = v;
    }

    await this.prisma.kycApplication.update({
      where: { id: data.kycApplicationId },
      data: { ocrExtractedData: merged as any },
    });
  }

  // ── Face Embeddings ────────────────────────────────────────────────────────

  /**
   * M-4 fix: stores embeddings in the dedicated FaceEmbedding table (indexed by
   * userId + sourceType) instead of the ocrExtractedData JSON blob. Enables
   * O(log n) duplicate-face fraud checks rather than a full-table JSON scan.
   */
  async saveFaceEmbedding(data: {
    kycApplicationId: string;
    documentId: string | null;
    sourceType: 'national_id' | 'selfie';
    embedding: number[];
    detectionConfidence: number;
    qualityScore: number;
  }): Promise<string> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: data.kycApplicationId },
      select: { userId: true },
    });
    if (!app) {
      throw new Error(`KYC application ${data.kycApplicationId} not found`);
    }

    const embeddingBuf = Buffer.from(new Float32Array(data.embedding).buffer);

    // Upsert: replace any existing embedding for this application + sourceType
    await this.prisma.faceEmbedding.deleteMany({
      where: {
        kycApplicationId: data.kycApplicationId,
        sourceType: data.sourceType,
      },
    });

    const record = await this.prisma.faceEmbedding.create({
      data: {
        kycApplicationId: data.kycApplicationId,
        userId: app.userId,
        sourceType: data.sourceType,
        embeddingData: embeddingBuf,
        detectionConfidence: data.detectionConfidence,
        qualityScore: data.qualityScore,
      },
    });

    return record.id;
  }

  /**
   * M-4 fix: queries the FaceEmbedding table with an index on userId + sourceType
   * and a join filter on KycApplication.status = APPROVED.
   * Previous implementation loaded every application's full JSON blob into memory.
   */
  async getAllApprovedEmbeddings(): Promise<
    Array<{ id: string; userId: string; embedding: number[] }>
  > {
    const embeddings = await this.prisma.faceEmbedding.findMany({
      where: {
        sourceType: 'selfie',
        kycApplication: { status: 'APPROVED' },
      },
      select: {
        id: true,
        userId: true,
        embeddingData: true,
      },
    });

    return embeddings
      .map((e) => {
        try {
          const buf = e.embeddingData;
          const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          return { id: e.id, userId: e.userId, embedding: Array.from(float32) };
        } catch {
          this.logger.warn(
            { embeddingId: e.id },
            'Skipping malformed face embedding during duplicate check',
          );
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }

  // ── Fraud Flags ────────────────────────────────────────────────────────────

  async saveFraudFlags(
    applicationId: string,
    flags: FraudFlag[],
  ): Promise<void> {
    const existing = await this.readExistingJson(applicationId);
    const riskFlagCodes = flags.map((f) => f.type as string);

    await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        ocrExtractedData: { ...existing, _fraudFlags: flags } as any,
        riskFlags: riskFlagCodes as any,
      },
    });
  }

  // ── Document Hashes ────────────────────────────────────────────────────────

  /**
   * M-4b fix: queries the indexed KycDocument.contentHash column — O(log n).
   * Previous implementation scanned all rows and parsed JSON in application code.
   */
  async findApplicationByDocumentHash(hash: string): Promise<string | null> {
    const doc = await this.prisma.kycDocument.findFirst({
      where: { contentHash: hash },
      select: { kycApplicationId: true },
    });
    return doc?.kycApplicationId ?? null;
  }

  // ── Duplicate Checks ───────────────────────────────────────────────────────

  async findApplicationByNationalId(
    nationalIdNumber: string,
    excludeApplicationId?: string,
  ): Promise<KycApplicationRecord | null> {
    const app = await this.prisma.kycApplication.findFirst({
      where: {
        nationalIdNumber,
        status: 'APPROVED',
        ...(excludeApplicationId ? { id: { not: excludeApplicationId } } : {}),
      },
    });
    return app ? this.mapApplication(app) : null;
  }

  async countRecentApplicationsByUserId(
    userId: string,
    withinHours: number,
  ): Promise<number> {
    const since = new Date(Date.now() - withinHours * 3_600_000);
    return this.prisma.kycApplication.count({
      where: { userId, createdAt: { gte: since } },
    });
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  /**
   * WARNING: UNSCOPED — returns pending applications across ALL brokers.
   * Currently unused by the admin surface. Any future caller MUST apply
   * broker scope (user: { brokerId }) like getQueuePage.
   */
  async getPendingApplications(
    limit: number,
    cursor?: string,
  ): Promise<KycApplicationRecord[]> {
    const apps = await this.prisma.kycApplication.findMany({
      where: { status: 'PENDING' },
      orderBy: { submittedAt: 'asc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return apps.map((a) => this.mapApplication(a));
  }

  async getQueuePage(options: {
    page: number;
    limit: number;
    status?: string;
    /** Broker-scoped isolation: restrict to applications of this broker's users. */
    brokerId?: string;
  }): Promise<{
    applications: KycApplicationRecord[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, options.page);
    const limit = Math.min(Math.max(1, options.limit), 200);
    const skip = (page - 1) * limit;

    const validStatuses = [
      'NOT_SUBMITTED',
      'PENDING',
      'APPROVED',
      'REJECTED',
      'ADDITIONAL_DOCS',
      'MANUAL_REVIEW',
    ];

    const where: Record<string, unknown> = {};
    if (options.status) {
      const s = options.status.toUpperCase();
      if (validStatuses.includes(s)) {
        where.status = s;
      }
    }
    if (options.brokerId) {
      // Server-derived broker scope — a broker admin only ever sees
      // their own investors' applications.
      where.user = { brokerId: options.brokerId };
    }

    const [apps, total] = await Promise.all([
      this.prisma.kycApplication.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        take: limit,
        skip,
        include: {
          user: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
              emailVerifiedAt: true,
              phone: true,
              phoneVerifiedAt: true,
            },
          },
          documents: { select: { type: true } },
        },
      }),
      this.prisma.kycApplication.count({ where }),
    ]);

    return {
      applications: apps.map((a) => this.mapApplication(a)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getCountsByStatus(brokerId?: string): Promise<Record<string, number>> {
    const groups = await this.prisma.kycApplication.groupBy({
      by: ['status'],
      where: brokerId ? { user: { brokerId } } : undefined,
      _count: { id: true },
    });

    const counts: Record<string, number> = {
      NOT_SUBMITTED: 0,
      PENDING: 0,
      APPROVED: 0,
      REJECTED: 0,
      ADDITIONAL_DOCS: 0,
      MANUAL_REVIEW: 0,
    };

    for (const g of groups) {
      counts[g.status] = g._count.id;
    }

    return counts;
  }

  async recordReview(data: {
    applicationId: string;
    reviewerId: string;
    reviewerName: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    notes?: string;
  }): Promise<void> {
    const existing = await this.readExistingJson(data.applicationId);
    const merged = { ...existing, _reviewerNotes: data.notes ?? null };

    await this.prisma.kycApplication.update({
      where: { id: data.applicationId },
      data: {
        reviewedAt: new Date(),
        reviewedById: null,  // must be a valid UUID or null — 'admin' string violates FK
        reviewDecision: data.decision,
        rejectionReason: data.reason ?? null,
        reviewerName: data.reviewerName,
        reviewNotes: data.notes ?? null,
        ocrExtractedData: merged as any,
      },
    });
  }

  async requestAdditionalDocuments(data: {
    applicationId: string;
    reviewerId: string;
    reviewerName: string;
    requiredDocuments: string[];
    message?: string;
  }): Promise<void> {
    await this.prisma.kycApplication.update({
      where: { id: data.applicationId },
      data: {
        status: 'ADDITIONAL_DOCS' as any,
        reviewedById: data.reviewerId,
        reviewerName: data.reviewerName,
        requiredDocuments: data.requiredDocuments as any,
        requestDocsMessage: data.message ?? null,
      },
    });
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  async recordAuditEntry(data: {
    kycApplicationId: string;
    action: string;
    actorId?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: data.action,
          resourceType: 'KycApplication',
          resourceId: data.kycApplicationId,
          actorId: data.actorId ?? 'system',
          metadata: (data.details ?? {}) as any,
        },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, action: data.action },
        'Failed to record audit entry',
      );
    }
  }

  async getAuditHistory(applicationId: string): Promise<
    Array<{
      action: string;
      actorId: string | null;
      details: unknown;
      createdAt: Date;
    }>
  > {
    const entries = await this.prisma.auditLog.findMany({
      where: { resourceId: applicationId },
      orderBy: { createdAt: 'desc' },
    });

    return entries.map((e) => ({
      action: e.action,
      actorId: e.actorId,
      details: e.metadata,
      createdAt: e.createdAt,
    }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async readExistingJson(
    applicationId: string,
  ): Promise<Record<string, unknown>> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { ocrExtractedData: true },
    });
    return (app?.ocrExtractedData as Record<string, unknown>) ?? {};
  }

  // ── Mappers ────────────────────────────────────────────────────────────────

  private mapApplication(app: any): KycApplicationRecord {
    const extraData = (app.ocrExtractedData as Record<string, unknown>) ?? {};

    let riskFlags: string[] | null = null;
    if (Array.isArray(app.riskFlags) && app.riskFlags.length > 0) {
      riskFlags = app.riskFlags as string[];
    } else {
      const jsonFlags = extraData._fraudFlags as Array<{ type?: string }> | undefined;
      if (Array.isArray(jsonFlags) && jsonFlags.length > 0) {
        riskFlags = jsonFlags.map((f) => f.type ?? '').filter(Boolean);
      }
    }

    const livenessScore =
      app.livenessScore != null
        ? Number(app.livenessScore)
        : ((extraData._livenessScore as number) ?? null);

    return {
      id: app.id,
      userId: app.userId,
      status: app.status,
      verificationStage: (extraData._stage as string) ?? 'CREATED',
      nationalIdNumber: app.nationalIdNumber,
      dateOfBirth: app.dateOfBirth,
      addressLine1: app.addressLine1 ?? null,
      addressLine2: app.addressLine2 ?? null,
      city: app.city ?? null,
      district: app.district ?? null,
      ocrExtractedData: app.ocrExtractedData,
      facialMatchScore: app.facialMatchScore ? Number(app.facialMatchScore) : null,
      confidenceScore: (extraData._confidenceScore as number) ?? null,
      ocrConfidence: (extraData._ocrConfidence as number) ?? null,
      faceMatchConfidence: (extraData._faceMatchConfidence as number) ?? null,
      imageQualityScore: (extraData._imageQualityScore as number) ?? null,
      documentQualityScore: (extraData._documentQualityScore as number) ?? null,
      fraudScore: (extraData._fraudScore as number) ?? null,
      reviewedById: app.reviewedById,
      reviewDecision: app.reviewDecision,
      rejectionReason: app.rejectionReason,
      reviewerNotes: app.reviewNotes ?? (extraData._reviewerNotes as string) ?? null,
      submittedAt: app.submittedAt,
      reviewedAt: app.reviewedAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      tier: app.tier ?? null,
      livenessScore,
      riskFlags,
      reviewerName: app.reviewerName ?? null,
      requiredDocuments: Array.isArray(app.requiredDocuments) ? app.requiredDocuments : null,
      requestDocsMessage: app.requestDocsMessage ?? null,
      firstName: app.user?.firstName ?? null,
      lastName: app.user?.lastName ?? null,
      email: app.user?.email ?? null,
      emailVerified: app.user != null ? app.user.emailVerifiedAt != null : null,
      phone: app.user?.phone ?? null,
      phoneVerified: app.user != null ? app.user.phoneVerifiedAt != null : null,
      documentType: Array.isArray(app.documents) ? (app.documents[0]?.type ?? null) : null,
    };
  }

  private mapDocument(doc: any): KycDocumentRecord {
    return {
      id: doc.id,
      kycApplicationId: doc.kycApplicationId,
      type: doc.type,
      storageBucket: doc.storageBucket,
      storageKey: doc.storageKey,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      contentHash: doc.contentHash ?? null,             // L-1 fix: from column
      enhancedStorageKey: doc.enhancedStorageKey ?? null, // H-5 fix: from column
      thumbnailStorageKey: doc.thumbnailStorageKey ?? null, // H-5 fix: from column
      uploadedAt: doc.uploadedAt,
    };
  }
}
