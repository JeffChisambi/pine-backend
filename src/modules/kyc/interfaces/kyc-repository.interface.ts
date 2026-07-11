import type { KycVerificationStage } from '../domain/kyc-stage.enum';
import type {
  FaceDetectionResult,
  FraudFlag,
  OcrExtractionResult,
  VerificationResult,
} from '../domain/verification-result';

/**
 * Repository port for KYC persistence operations.
 */
export const KYC_REPOSITORY = Symbol('KYC_REPOSITORY');

export interface KycApplicationRecord {
  id: string;
  userId: string;
  status: string;
  verificationStage: string;
  nationalIdNumber: string | null;
  dateOfBirth: Date | null;
  ocrExtractedData: unknown;
  facialMatchScore: number | null;
  confidenceScore: number | null;
  ocrConfidence: number | null;
  faceMatchConfidence: number | null;
  imageQualityScore: number | null;
  documentQualityScore: number | null;
  fraudScore: number | null;
  reviewedById: string | null;
  reviewDecision: string | null;
  rejectionReason: string | null;
  reviewerNotes: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KycDocumentRecord {
  id: string;
  kycApplicationId: string;
  type: string;
  storageBucket: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 hash of the file content */
  contentHash: string | null;
  /** Enhanced version storage key */
  enhancedStorageKey: string | null;
  /** Thumbnail storage key */
  thumbnailStorageKey: string | null;
  uploadedAt: Date;
}

export interface IKycRepository {
  // ── Application lifecycle ─────────────────────────────────────
  createApplication(userId: string): Promise<KycApplicationRecord>;

  getApplicationById(id: string): Promise<KycApplicationRecord | null>;

  getApplicationByUserId(userId: string): Promise<KycApplicationRecord | null>;

  getLatestApplicationByUserId(userId: string): Promise<KycApplicationRecord | null>;

  updateApplicationStage(
    id: string,
    stage: KycVerificationStage,
  ): Promise<void>;

  updateApplicationStatus(
    id: string,
    status: string,
    data?: Partial<KycApplicationRecord>,
  ): Promise<void>;

  // ── Documents ─────────────────────────────────────────────────
  createDocument(data: {
    kycApplicationId: string;
    type: string;
    storageBucket: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
  }): Promise<KycDocumentRecord>;

  getDocumentsByApplicationId(applicationId: string): Promise<KycDocumentRecord[]>;

  getDocumentByType(
    applicationId: string,
    type: string,
  ): Promise<KycDocumentRecord | null>;

  updateDocument(
    id: string,
    data: Partial<KycDocumentRecord>,
  ): Promise<void>;

  // ── OCR Results ───────────────────────────────────────────────
  saveOcrResult(data: {
    kycApplicationId: string;
    documentId: string;
    extractedData: OcrExtractionResult;
    overallConfidence: number;
    rawText: string;
  }): Promise<void>;

  // ── Face Embeddings ───────────────────────────────────────────
  saveFaceEmbedding(data: {
    kycApplicationId: string;
    documentId: string | null;
    sourceType: 'national_id' | 'selfie';
    embedding: number[];
    detectionConfidence: number;
    qualityScore: number;
  }): Promise<string>;

  /**
   * Find all face embeddings for duplicate detection.
   * Returns embeddings from APPROVED applications only.
   */
  getAllApprovedEmbeddings(): Promise<
    Array<{ id: string; userId: string; embedding: number[] }>
  >;

  // ── Fraud Flags ───────────────────────────────────────────────
  saveFraudFlags(
    applicationId: string,
    flags: FraudFlag[],
  ): Promise<void>;

  // ── Document Hashes ───────────────────────────────────────────
  findApplicationByDocumentHash(hash: string): Promise<string | null>;

  // ── Duplicate Checks ──────────────────────────────────────────
  findApplicationByNationalId(
    nationalIdNumber: string,
    excludeApplicationId?: string,
  ): Promise<KycApplicationRecord | null>;

  countRecentApplicationsByUserId(
    userId: string,
    withinHours: number,
  ): Promise<number>;

  // ── Admin ─────────────────────────────────────────────────────
  getPendingApplications(limit: number, cursor?: string): Promise<KycApplicationRecord[]>;

  recordReview(data: {
    applicationId: string;
    reviewerId: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    notes?: string;
  }): Promise<void>;

  // ── Audit ─────────────────────────────────────────────────────
  recordAuditEntry(data: {
    kycApplicationId: string;
    action: string;
    actorId?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;

  getAuditHistory(applicationId: string): Promise<
    Array<{
      action: string;
      actorId: string | null;
      details: unknown;
      createdAt: Date;
    }>
  >;
}
