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
 * Prisma-backed KYC repository. Handles all persistence
 * for the KYC pipeline: applications, documents, OCR results,
 * face embeddings, fraud flags, and audit logs.
 *
 * ─── ocrExtractedData JSON schema (single column stores pipeline state) ───────
 * Top-level keys: OcrExtractionResult fields (fullName, nationalIdNumber, ...)
 * Private keys (prefixed with _):
 *   _stage              KycVerificationStage — current pipeline stage
 *   _embeddings         StoredEmbedding[]    — face embeddings (base64 Float32Array)
 *   _fraudFlags         FraudFlag[]          — fraud flags from detection
 *   _confidenceScore    number
 *   _ocrConfidence      number
 *   _faceMatchConfidence number
 *   _imageQualityScore  number
 *   _documentQualityScore number
 *   _fraudScore         number
 *   _reviewerNotes      string
 *
 * Every write to ocrExtractedData MUST preserve existing keys via readMergeWrite().
 * Never overwrite the column directly — always read → merge → write.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class KycRepository implements IKycRepository {
  private readonly logger = new Logger(KycRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Application lifecycle ─────────────────────────────────────

  async createApplication(userId: string): Promise<KycApplicationRecord> {
    const app = await this.prisma.kycApplication.create({
      data: {
        userId,
        status: 'PENDING',
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

  /**
   * FIX (Bug 1): Was only updating `updatedAt`; the `stage` argument was
   * completely ignored. Now reads existing JSON and merges `_stage` in.
   */
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

  /**
   * FIX (Bug 3): Was blindly overwriting ocrExtractedData whenever
   * confidenceScore or ocrExtractedData was supplied, erasing all
   * previously stored private tracking fields.
   *
   * Now always reads the current JSON first, then merges only the
   * changed fields so every prior key (_stage, _embeddings, OCR
   * fields, etc.) is preserved.
   */
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

    // Always read → merge → write to avoid destroying existing JSON keys
    if (
      data?.ocrExtractedData !== undefined ||
      data?.confidenceScore !== undefined
    ) {
      const existing = await this.readExistingJson(id);

      const merged: Record<string, unknown> = { ...existing };

      // Merge in OCR result fields (preserve private _ keys)
      if (data.ocrExtractedData !== undefined && data.ocrExtractedData !== null) {
        const ocr = data.ocrExtractedData as Record<string, unknown>;
        for (const [k, v] of Object.entries(ocr)) {
          merged[k] = v;
        }
      }

      // Merge in score fields
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

  // ── Documents ─────────────────────────────────────────────────

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
      },
    });

    // Store the hash in ocrExtractedData so it survives across reads.
    // KycDocument table doesn't have a contentHash column yet.
    if (data.contentHash) {
      const existing = await this.readExistingJson(data.kycApplicationId);
      const hashes = (existing._documentHashes as Record<string, string>) ?? {};
      hashes[doc.id] = data.contentHash;
      await this.prisma.kycApplication.update({
        where: { id: data.kycApplicationId },
        data: { ocrExtractedData: { ...existing, _documentHashes: hashes } as any },
      });
    }

    return this.mapDocument(doc, data.contentHash);
  }

  async getDocumentsByApplicationId(
    applicationId: string,
  ): Promise<KycDocumentRecord[]> {
    const [docs, app] = await Promise.all([
      this.prisma.kycDocument.findMany({
        where: { kycApplicationId: applicationId },
      }),
      this.prisma.kycApplication.findUnique({
        where: { id: applicationId },
        select: { ocrExtractedData: true },
      }),
    ]);

    const extraData = (app?.ocrExtractedData as Record<string, unknown>) ?? {};
    const hashes = (extraData._documentHashes as Record<string, string>) ?? {};

    return docs.map((d) => this.mapDocument(d, hashes[d.id]));
  }

  async getDocumentByType(
    applicationId: string,
    type: string,
  ): Promise<KycDocumentRecord | null> {
    const docs = await this.getDocumentsByApplicationId(applicationId);
    return docs.find((d) => d.type === type) ?? null;
  }

  async updateDocument(
    id: string,
    data: Partial<KycDocumentRecord>,
  ): Promise<void> {
    // KycDocument schema doesn't have all fields yet — no-op for now.
    this.logger.debug({ documentId: id }, 'Document metadata updated (no-op until migration)');
  }

  // ── OCR Results ───────────────────────────────────────────────

  /**
   * FIX (Bug 2): Was replacing the entire ocrExtractedData column with
   * just the OcrExtractionResult, wiping _stage, _embeddings, and all
   * other private tracking fields in one shot.
   *
   * Now reads existing JSON and merges OCR fields into it, preserving
   * all private _ keys and any previously stored pipeline state.
   */
  async saveOcrResult(data: {
    kycApplicationId: string;
    documentId: string;
    extractedData: OcrExtractionResult;
    overallConfidence: number;
    rawText: string;
  }): Promise<void> {
    const existing = await this.readExistingJson(data.kycApplicationId);

    // Private _ keys are preserved; OCR result fields are merged in at top level
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

  // ── Face Embeddings ───────────────────────────────────────────

  /**
   * FIX (Bug 4a): Was storing only a short hash of the embedding rather
   * than the actual 512-float32 vector, making getAllApprovedEmbeddings()
   * useless for real duplicate-face detection.
   *
   * Now encodes the full Float32Array as base64 and merges it into
   * ocrExtractedData without destroying any other stored keys.
   */
  async saveFaceEmbedding(data: {
    kycApplicationId: string;
    documentId: string | null;
    sourceType: 'national_id' | 'selfie';
    embedding: number[];
    detectionConfidence: number;
    qualityScore: number;
  }): Promise<string> {
    const existing = await this.readExistingJson(data.kycApplicationId);
    const embeddings =
      (existing._embeddings as Array<Record<string, unknown>>) ?? [];

    // Encode the full embedding so it can be decoded later for comparison
    const embeddingBuf = Buffer.from(new Float32Array(data.embedding).buffer);
    const embeddingBase64 = embeddingBuf.toString('base64');

    const embeddingId = `emb-${data.kycApplicationId}-${data.sourceType}`;

    // Replace any existing entry for this sourceType
    const filtered = embeddings.filter(
      (e) => e.sourceType !== data.sourceType,
    );
    filtered.push({
      embeddingId,
      sourceType: data.sourceType,
      detectionConfidence: data.detectionConfidence,
      qualityScore: data.qualityScore,
      embeddingLength: data.embedding.length,
      embeddingData: embeddingBase64, // Full vector, base64-encoded
    });

    await this.prisma.kycApplication.update({
      where: { id: data.kycApplicationId },
      data: {
        ocrExtractedData: { ...existing, _embeddings: filtered } as any,
      },
    });

    return embeddingId;
  }

  /**
   * FIX (Bug 4b): Was returning an empty array unconditionally, making
   * duplicate-face fraud checks completely ineffective.
   *
   * Now scans all APPROVED applications, decodes their stored selfie
   * embeddings from base64 Float32Array, and returns real vectors for
   * cosine-similarity comparison.
   */
  async getAllApprovedEmbeddings(): Promise<
    Array<{ id: string; userId: string; embedding: number[] }>
  > {
    const apps = await this.prisma.kycApplication.findMany({
      where: { status: 'APPROVED' },
      select: { id: true, userId: true, ocrExtractedData: true },
    });

    const result: Array<{ id: string; userId: string; embedding: number[] }> = [];

    for (const app of apps) {
      const extra = (app.ocrExtractedData as Record<string, unknown>) ?? {};
      const embeddings =
        (extra._embeddings as Array<Record<string, unknown>>) ?? [];

      const selfieEmb = embeddings.find(
        (e) => e.sourceType === 'selfie' && typeof e.embeddingData === 'string',
      );

      if (!selfieEmb) continue;

      try {
        const buf = Buffer.from(selfieEmb.embeddingData as string, 'base64');
        const float32 = new Float32Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength / 4,
        );
        result.push({
          id: (selfieEmb.embeddingId as string) ?? app.id,
          userId: app.userId,
          embedding: Array.from(float32),
        });
      } catch {
        // Skip corrupted embeddings without breaking the whole check
        this.logger.warn(
          { applicationId: app.id },
          'Skipping malformed face embedding during duplicate check',
        );
      }
    }

    return result;
  }

  // ── Fraud Flags ───────────────────────────────────────────────

  async saveFraudFlags(
    applicationId: string,
    flags: FraudFlag[],
  ): Promise<void> {
    const existing = await this.readExistingJson(applicationId);

    // Persist full flag objects in the JSON column (for pipeline introspection)
    // AND store the machine-readable type codes in the dedicated riskFlags column
    // so the broker dashboard can query / display them without parsing JSON.
    const riskFlagCodes = flags.map((f) => f.type as string);

    await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        ocrExtractedData: { ...existing, _fraudFlags: flags } as any,
        riskFlags: riskFlagCodes as any,
      },
    });
  }

  // ── Document Hashes ───────────────────────────────────────────

  async findApplicationByDocumentHash(
    hash: string,
  ): Promise<string | null> {
    // Hash is stored per-document inside ocrExtractedData._documentHashes.
    // Prisma doesn't support querying inside JSON arrays — load all and scan.
    // For scale, add a dedicated DocumentHash table via migration.
    const apps = await this.prisma.kycApplication.findMany({
      select: { id: true, ocrExtractedData: true },
    });

    for (const app of apps) {
      const extra = (app.ocrExtractedData as Record<string, unknown>) ?? {};
      const hashes = (extra._documentHashes as Record<string, string>) ?? {};
      if (Object.values(hashes).includes(hash)) return app.id;
    }

    return null;
  }

  // ── Duplicate Checks ──────────────────────────────────────────

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
    const since = new Date(Date.now() - withinHours * 3600 * 1000);
    return this.prisma.kycApplication.count({
      where: {
        userId,
        createdAt: { gte: since },
      },
    });
  }

  // ── Admin ─────────────────────────────────────────────────────

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
  }): Promise<{
    applications: KycApplicationRecord[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, options.page);
    const limit = Math.min(Math.max(1, options.limit), 200);
    const skip = (page - 1) * limit;

    // The frontend may send status=ADDITIONAL_DOCS which maps directly to
    // the enum value. We also support legacy aliases via the OR clause.
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

  async getCountsByStatus(): Promise<Record<string, number>> {
    const groups = await this.prisma.kycApplication.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    // Start with zero counts for all known statuses so the response is always complete.
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
    // Persist reviewer notes to the dedicated column AND keep the JSON copy
    // for backwards compatibility with the existing pipeline reader.
    const existing = await this.readExistingJson(data.applicationId);
    const merged = { ...existing, _reviewerNotes: data.notes ?? null };

    await this.prisma.kycApplication.update({
      where: { id: data.applicationId },
      data: {
        reviewedAt: new Date(),
        reviewedById: data.reviewerId,
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

  // ── Audit ─────────────────────────────────────────────────────

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
      // Audit logging failures should not crash the pipeline
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

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Read the current ocrExtractedData JSON for the given application.
   * Every write that touches this column MUST call this first to avoid
   * overwriting keys set by other pipeline stages.
   */
  private async readExistingJson(
    applicationId: string,
  ): Promise<Record<string, unknown>> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
      select: { ocrExtractedData: true },
    });
    return (app?.ocrExtractedData as Record<string, unknown>) ?? {};
  }

  // ── Mappers ───────────────────────────────────────────────────

  private mapApplication(app: any): KycApplicationRecord {
    const extraData = (app.ocrExtractedData as Record<string, unknown>) ?? {};

    // Risk flags: prefer the dedicated column, fall back to extracting
    // type codes from the _fraudFlags JSON array written by the AI pipeline.
    let riskFlags: string[] | null = null;
    if (Array.isArray(app.riskFlags) && app.riskFlags.length > 0) {
      riskFlags = app.riskFlags as string[];
    } else {
      const jsonFlags = extraData._fraudFlags as Array<{ type?: string }> | undefined;
      if (Array.isArray(jsonFlags) && jsonFlags.length > 0) {
        riskFlags = jsonFlags.map((f) => f.type ?? '').filter(Boolean);
      }
    }

    // Liveness score: prefer dedicated column, fall back to JSON.
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
      city: app.city ?? null,
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
      // reviewNotes: prefer dedicated column, fall back to JSON for legacy rows
      reviewerNotes: app.reviewNotes ?? (extraData._reviewerNotes as string) ?? null,
      submittedAt: app.submittedAt,
      reviewedAt: app.reviewedAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,

      // New dashboard fields from dedicated columns
      tier: app.tier ?? null,
      livenessScore,
      riskFlags,
      reviewerName: app.reviewerName ?? null,
      requiredDocuments: Array.isArray(app.requiredDocuments) ? app.requiredDocuments : null,
      requestDocsMessage: app.requestDocsMessage ?? null,

      // User join fields (populated by getQueuePage)
      firstName: app.user?.firstName ?? null,
      lastName: app.user?.lastName ?? null,
      email: app.user?.email ?? null,
      emailVerified: app.user != null ? app.user.emailVerifiedAt != null : null,
      phone: app.user?.phone ?? null,
      phoneVerified: app.user != null ? app.user.phoneVerifiedAt != null : null,
      documentType: Array.isArray(app.documents) ? (app.documents[0]?.type ?? null) : null,
    };
  }

  private mapDocument(doc: any, contentHash?: string): KycDocumentRecord {
    return {
      id: doc.id,
      kycApplicationId: doc.kycApplicationId,
      type: doc.type,
      storageBucket: doc.storageBucket,
      storageKey: doc.storageKey,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      contentHash: contentHash ?? null,
      enhancedStorageKey: null,
      thumbnailStorageKey: null,
      uploadedAt: doc.uploadedAt,
    };
  }
}
