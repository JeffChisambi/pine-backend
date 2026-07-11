import { KycFraudFlagType, KycFraudSeverity } from './kyc-stage.enum';

/**
 * Structured OCR extraction from a national ID document.
 * Every field includes the raw extracted text and a confidence
 * score (0.0–1.0) from the OCR engine.
 */
export interface OcrFieldResult {
  value: string;
  confidence: number;
  /** Raw text before cleanup/normalization */
  rawValue?: string;
}

export interface OcrExtractionResult {
  fullName: OcrFieldResult | null;
  nationalIdNumber: OcrFieldResult | null;
  dateOfBirth: OcrFieldResult | null;
  gender: OcrFieldResult | null;
  address: OcrFieldResult | null;
  documentNumber: OcrFieldResult | null;
  expiryDate: OcrFieldResult | null;
  /** Overall OCR confidence (average of field confidences) */
  overallConfidence: number;
  /** Raw full-text output from OCR engine */
  rawText: string;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Face detection and embedding result from a single image.
 */
export interface FaceDetectionResult {
  /** Whether a face was detected */
  detected: boolean;
  /** Number of faces found (>1 triggers fraud flag) */
  faceCount: number;
  /** Bounding box of primary face [x, y, width, height] */
  boundingBox: [number, number, number, number] | null;
  /** 512-dimensional face embedding vector */
  embedding: number[] | null;
  /** Face detection confidence (0.0–1.0) */
  detectionConfidence: number;
  /** Face quality score (0.0–1.0) based on pose, blur, occlusion */
  qualityScore: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Result of comparing two face embeddings.
 */
export interface FaceMatchResult {
  /** Cosine similarity between the two embeddings (0.0–1.0) */
  similarity: number;
  /** Whether the match exceeds the configured threshold */
  isMatch: boolean;
  /** Confidence level of the match (factoring in quality scores) */
  confidence: number;
  /** ID face detection details */
  idFace: FaceDetectionResult;
  /** Selfie face detection details */
  selfieFace: FaceDetectionResult;
}

/**
 * Image quality analysis result.
 */
export interface ImageQualityResult {
  /** Overall quality score (0.0–1.0) */
  overallScore: number;
  /** Blur/sharpness score (higher = sharper) */
  sharpnessScore: number;
  /** Brightness score (0 = too dark, 1 = ideal, penalized if overexposed) */
  brightnessScore: number;
  /** Resolution adequacy (0.0–1.0 based on min dimensions) */
  resolutionScore: number;
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Whether the image passes minimum quality requirements */
  passesMinimum: boolean;
  /** Reasons for failure, if any */
  failureReasons: string[];
}

/**
 * A single fraud flag raised during verification.
 */
export interface FraudFlag {
  type: KycFraudFlagType;
  severity: KycFraudSeverity;
  /** Human-readable description of the fraud signal */
  description: string;
  /** Evidence data (e.g., matching application ID, similarity score) */
  evidence?: Record<string, unknown>;
}

/**
 * Complete verification result aggregating all pipeline stages.
 */
export interface VerificationResult {
  /** Application ID */
  applicationId: string;

  /** OCR extraction results */
  ocrResult: OcrExtractionResult | null;

  /** Face match results */
  faceMatchResult: FaceMatchResult | null;

  /** ID document image quality */
  idImageQuality: ImageQualityResult | null;

  /** Selfie image quality */
  selfieImageQuality: ImageQualityResult | null;

  /** All fraud flags raised */
  fraudFlags: FraudFlag[];

  /** Composite confidence score (0.0–1.0) */
  confidenceScore: number;

  /** Sub-scores */
  scores: {
    ocr: number;
    faceMatch: number;
    imageQuality: number;
    documentQuality: number;
    fraudRisk: number;
  };

  /** Decision */
  decision: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED';

  /** Decision reason */
  decisionReason: string;

  /** Total pipeline processing time in milliseconds */
  totalProcessingTimeMs: number;
}
