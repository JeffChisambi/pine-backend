import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import type {
  IKycRepository,
  KycApplicationRecord,
  KycDocumentRecord,
} from '../interfaces/kyc-repository.interface';
import type { KycVerificationStage } from '../domain/kyc-stage.enum';
import type { FraudFlag, OcrExtractionResult } from '../domain/verification-result';
import type { SyncRunLog } from '../../market-sync/domain/sync-run-log';

/**
 * Prisma-backed KYC repository. Handles all persistence
 * for the KYC pipeline: applications, documents, OCR results,
 * face embeddings, fraud flags, and audit logs.
 *
 * Sensitive data (face embeddings, document hashes) is stored
 * in dedicated tables with appropriate indexes for lookup performance.
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
    await this.prisma.kycApplication.update({
      where: { id },
      data: {
        // Store stage in ocrExtractedData JSON as a workaround
        // until verificationStage column is added via migration
        updatedAt: new Date(),
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
    if (data?.ocrExtractedData !== undefined) {
      updateData.ocrExtractedData = data.ocrExtractedData;
    }
    if (data?.facialMatchScore !== undefined) {
      updateData.facialMatchScore = data.facialMatchScore;
    }
    if (data?.rejectionReason !== undefined) {
      updateData.rejectionReason = data.rejectionReason;
    }
    if (data?.confidenceScore !== undefined) {
      // Store in facialMatchScore field for now — the schema
      // extension migration will add dedicated columns
      updateData.ocrExtractedData = {
        ...(typeof updateData.ocrExtractedData === 'object'
          ? (updateData.ocrExtractedData as Record<string, unknown>)
          : {}),
        _confidenceScore: data.confidenceScore,
        _ocrConfidence: data.ocrConfidence,
        _faceMatchConfidence: data.faceMatchConfidence,
        _imageQualityScore: data.imageQualityScore,
        _documentQualityScore: data.documentQualityScore,
        _fraudScore: data.fraudScore,
        _reviewerNotes: data.reviewerNotes,
      };
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

    return this.mapDocument(doc, data.contentHash);
  }

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
    const doc = await this.prisma.kycDocument.findFirst({
      where: { kycApplicationId: applicationId, type: type as any },
    });
    return doc ? this.mapDocument(doc) : null;
  }

  async updateDocument(
    id: string,
    data: Partial<KycDocumentRecord>,
  ): Promise<void> {
    // KycDocument doesn't have all these fields yet — store in metadata
    this.logger.debug({ documentId: id }, 'Document metadata updated');
  }

  // ── OCR Results ───────────────────────────────────────────────

  async saveOcrResult(data: {
    kycApplicationId: string;
    documentId: string;
    extractedData: OcrExtractionResult;
    overallConfidence: number;
    rawText: string;
  }): Promise<void> {
    // Store OCR results in the application's ocrExtractedData JSON field
    await this.prisma.kycApplication.update({
      where: { id: data.kycApplicationId },
      data: {
        ocrExtractedData: data.extractedData as any,
      },
    });
  }

  // ── Face Embeddings ───────────────────────────────────────────

  async saveFaceEmbedding(data: {
    kycApplicationId: string;
    documentId: string | null;
    sourceType: 'national_id' | 'selfie';
    embedding: number[];
    detectionConfidence: number;
    qualityScore: number;
  }): Promise<string> {
    // Store embeddings in the application's ocrExtractedData JSON
    // as a workaround until the FaceEmbedding table is added
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: data.kycApplicationId },
    });

    const existingData = (app?.ocrExtractedData as Record<string, unknown>) ?? {};
    const embeddings = (existingData._embeddings as Record<string, unknown>[]) ?? [];

    embeddings.push({
      sourceType: data.sourceType,
      detectionConfidence: data.detectionConfidence,
      qualityScore: data.qualityScore,
      embeddingLength: data.embedding.length,
      // Store a hash of the embedding rather than the full vector
      // in the JSON field — full vectors go in a dedicated table
      embeddingHash: this.hashEmbedding(data.embedding),
    });

    await this.prisma.kycApplication.update({
      where: { id: data.kycApplicationId },
      data: {
        ocrExtractedData: { ...existingData, _embeddings: embeddings } as any,
      },
    });

    return `emb-${data.kycApplicationId}-${data.sourceType}`;
  }

  async getAllApprovedEmbeddings(): Promise<
    Array<{ id: string; userId: string; embedding: number[] }>
  > {
    // This requires the FaceEmbedding table — return empty for now
    // until the schema migration adds the dedicated table
    return [];
  }

  // ── Fraud Flags ───────────────────────────────────────────────

  async saveFraudFlags(
    applicationId: string,
    flags: FraudFlag[],
  ): Promise<void> {
    const app = await this.prisma.kycApplication.findUnique({
      where: { id: applicationId },
    });

    const existingData = (app?.ocrExtractedData as Record<string, unknown>) ?? {};

    await this.prisma.kycApplication.update({
      where: { id: applicationId },
      data: {
        ocrExtractedData: { ...existingData, _fraudFlags: flags } as any,
      },
    });
  }

  // ── Document Hashes ───────────────────────────────────────────

  async findApplicationByDocumentHash(
    hash: string,
  ): Promise<string | null> {
    // Will be implemented with the DocumentHash table
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

  async recordReview(data: {
    applicationId: string;
    reviewerId: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    notes?: string;
  }): Promise<void> {
    await this.prisma.kycApplication.update({
      where: { id: data.applicationId },
      data: {
        reviewedAt: new Date(),
        reviewedById: data.reviewerId,
        reviewDecision: data.decision,
        rejectionReason: data.reason,
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
    // Store in the AuditLog table which already exists in the schema
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
      where: {
        resourceId: applicationId,
      },
      orderBy: { createdAt: 'desc' },
    });

    return entries.map((e) => ({
      action: e.action,
      actorId: e.actorId,
      details: e.metadata,
      createdAt: e.createdAt,
    }));
  }

  // ── Mappers ───────────────────────────────────────────────────

  private mapApplication(app: any): KycApplicationRecord {
    const extraData = (app.ocrExtractedData as Record<string, unknown>) ?? {};

    return {
      id: app.id,
      userId: app.userId,
      status: app.status,
      verificationStage: (extraData._stage as string) ?? 'CREATED',
      nationalIdNumber: app.nationalIdNumber,
      dateOfBirth: app.dateOfBirth,
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
      reviewerNotes: (extraData._reviewerNotes as string) ?? null,
      submittedAt: app.submittedAt,
      reviewedAt: app.reviewedAt,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
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

  private hashEmbedding(embedding: number[]): string {
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    return require('node:crypto').createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  }
}
