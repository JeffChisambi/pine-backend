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
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
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
  /** Internal reviewer notes stored on the dedicated column (not JSON). */
  reviewerNotes: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  // ── New fields required by the Kusata broker dashboard API contract ──
  /** KYC tier: TIER_1 or TIER_2 */
  tier: string | null;
  /** Anti-spoofing / liveness score (0–1) */
  livenessScore: number | null;
  /** Machine-readable risk flag codes (string[]) */
  riskFlags: string[] | null;
  /** Display name of the reviewer (denormalised) */
  reviewerName: string | null;
  /** Required document slot codes when status = ADDITIONAL_DOCS */
  requiredDocuments: string[] | null;
  /** Message to the applicant when requesting docs */
  requestDocsMessage: string | null;

  // ── Fields joined from the User record (populated by getQueuePage) ──
  /** User's first name */
  firstName?: string | null;
  /** User's last name */
  lastName?: string | null;
  /** User's email */
  email?: string | null;
  /** Whether the user's email has been verified */
  emailVerified?: boolean | null;
  /** User's phone */
  phone?: string | null;
  /** Whether the user's phone has been verified */
  phoneVerified?: boolean | null;
  /** First document type from the application documents array */
  documentType?: string | null;
  /** Owning broker's display name — how platform admins see whose data this is. */
  brokerName?: string | null;
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

  /**
   * Paginated queue of KYC applications for the broker dashboard.
   * Returns page-based metadata matching the Kusata API contract.
   */
  getQueuePage(options: {
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
  }>;

  /** Aggregate counts per KycStatus for the dashboard stats cards. */
  getCountsByStatus(brokerId?: string): Promise<Record<string, number>>;

  recordReview(data: {
    applicationId: string;
    reviewerId: string;
    reviewerName: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    notes?: string;
  }): Promise<void>;

  /**
   * Set status to ADDITIONAL_DOCS and store the required document list
   * and optional message so the applicant's mobile app knows what to resubmit.
   */
  requestAdditionalDocuments(data: {
    applicationId: string;
    reviewerId: string;
    reviewerName: string;
    requiredDocuments: string[];
    message?: string;
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
