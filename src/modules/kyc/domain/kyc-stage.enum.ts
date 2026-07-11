/**
 * KYC verification pipeline stages. Each stage represents a
 * discrete processing step that the application transitions
 * through sequentially. The workflow service uses these to
 * track progress and resume after failures.
 */
export enum KycVerificationStage {
  /** Application created, awaiting document uploads */
  CREATED = 'CREATED',

  /** National ID document uploaded, awaiting selfie */
  ID_UPLOADED = 'ID_UPLOADED',

  /** Selfie uploaded, ready for processing */
  SELFIE_UPLOADED = 'SELFIE_UPLOADED',

  /** File validation in progress (MIME, magic bytes, size) */
  VALIDATING = 'VALIDATING',

  /** Image enhancement pipeline running (Sharp) */
  ENHANCING = 'ENHANCING',

  /** OCR extraction in progress (Tesseract) */
  OCR_PROCESSING = 'OCR_PROCESSING',

  /** Face detection and embedding extraction (InsightFace/ONNX) */
  FACE_EXTRACTING = 'FACE_EXTRACTING',

  /** Comparing face embeddings between ID and selfie */
  FACE_MATCHING = 'FACE_MATCHING',

  /** Fraud detection rules executing */
  FRAUD_CHECKING = 'FRAUD_CHECKING',

  /** Confidence engine computing composite score */
  SCORING = 'SCORING',

  /** Decision engine applying thresholds */
  DECIDING = 'DECIDING',

  /** Pipeline complete — final status set */
  COMPLETE = 'COMPLETE',

  /** Pipeline failed — error recorded */
  FAILED = 'FAILED',
}

/**
 * Fraud flag categories. Each represents a distinct fraud signal
 * that the detection engine can raise. Flags are stored individually
 * with severity and evidence metadata.
 */
export enum KycFraudFlagType {
  DUPLICATE_NATIONAL_ID = 'DUPLICATE_NATIONAL_ID',
  DUPLICATE_FACE = 'DUPLICATE_FACE',
  EXPIRED_DOCUMENT = 'EXPIRED_DOCUMENT',
  SCREENSHOT_DETECTED = 'SCREENSHOT_DETECTED',
  PHOTOCOPY_DETECTED = 'PHOTOCOPY_DETECTED',
  EDITED_IMAGE = 'EDITED_IMAGE',
  LOW_RESOLUTION = 'LOW_RESOLUTION',
  MULTIPLE_FACES = 'MULTIPLE_FACES',
  IMPOSSIBLE_MATCH = 'IMPOSSIBLE_MATCH',
  REPEATED_ATTEMPTS = 'REPEATED_ATTEMPTS',
  NO_FACE_DETECTED = 'NO_FACE_DETECTED',
  BLURRY_DOCUMENT = 'BLURRY_DOCUMENT',
}

export enum KycFraudSeverity {
  /** Informational — does not block approval */
  LOW = 'LOW',
  /** Warrants manual review */
  MEDIUM = 'MEDIUM',
  /** Blocks auto-approval, requires human review */
  HIGH = 'HIGH',
  /** Triggers auto-rejection */
  CRITICAL = 'CRITICAL',
}
