import { Injectable, Logger } from '@nestjs/common';
import type {
  FaceMatchResult,
  ImageQualityResult,
  OcrExtractionResult,
  FraudFlag,
} from '../domain/verification-result';
import { KycFraudSeverity } from '../domain/kyc-stage.enum';

/**
 * Confidence engine weights — configurable via environment.
 */
interface ConfidenceWeights {
  ocr: number;
  faceMatch: number;
  imageQuality: number;
  documentQuality: number;
  fraudRisk: number;
}

/**
 * Decision thresholds — configurable via environment.
 */
interface DecisionThresholds {
  autoApprove: number;
  autoReject: number;
  minFaceMatch: number;
}

/**
 * Weighted confidence scoring engine for KYC decisions.
 *
 * Computes a composite confidence score from sub-scores:
 * - OCR Accuracy (30%): How well we extracted document fields
 * - Face Match (40%): Cosine similarity between ID and selfie
 * - Image Quality (15%): Blur, brightness, resolution
 * - Document Quality (10%): Field completeness and validation
 * - Fraud Risk (5%): Inverse of fraud risk score
 *
 * Decision engine applies thresholds:
 * - Auto-Approve: ≥ 0.85 composite + face match ≥ 0.70 + zero critical flags
 * - Manual Review: 0.60–0.85 composite OR any non-critical flags
 * - Auto-Reject: < 0.60 composite OR any critical fraud flags
 */
@Injectable()
export class ConfidenceEngine {
  private readonly logger = new Logger(ConfidenceEngine.name);

  private readonly weights: ConfidenceWeights = {
    ocr: parseFloat(process.env.KYC_WEIGHT_OCR ?? '0.30'),
    faceMatch: parseFloat(process.env.KYC_WEIGHT_FACE ?? '0.40'),
    imageQuality: parseFloat(process.env.KYC_WEIGHT_IMAGE ?? '0.15'),
    documentQuality: parseFloat(process.env.KYC_WEIGHT_DOCUMENT ?? '0.10'),
    fraudRisk: parseFloat(process.env.KYC_WEIGHT_FRAUD ?? '0.05'),
  };

  private readonly thresholds: DecisionThresholds = {
    autoApprove: parseFloat(process.env.KYC_THRESHOLD_APPROVE ?? '0.85'),
    autoReject: parseFloat(process.env.KYC_THRESHOLD_REJECT ?? '0.60'),
    minFaceMatch: parseFloat(process.env.KYC_THRESHOLD_FACE ?? '0.70'),
  };

  computeScore(input: {
    ocrResult: OcrExtractionResult | null;
    faceMatchResult: FaceMatchResult | null;
    idImageQuality: ImageQualityResult | null;
    selfieImageQuality: ImageQualityResult | null;
    fraudFlags: FraudFlag[];
    fraudRiskScore: number;
  }): {
    compositeScore: number;
    scores: {
      ocr: number;
      faceMatch: number;
      imageQuality: number;
      documentQuality: number;
      fraudRisk: number;
    };
    decision: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED';
    decisionReason: string;
  } {
    // ── 1. OCR sub-score ──────────────────────────────────────
    const ocrScore = this.computeOcrScore(input.ocrResult);

    // ── 2. Face match sub-score ───────────────────────────────
    const faceMatchScore = this.computeFaceMatchScore(input.faceMatchResult);

    // ── 3. Image quality sub-score ────────────────────────────
    const imageQualityScore = this.computeImageQualityScore(
      input.idImageQuality,
      input.selfieImageQuality,
    );

    // ── 4. Document quality sub-score ─────────────────────────
    const documentQualityScore = this.computeDocumentQualityScore(input.ocrResult);

    // ── 5. Fraud risk sub-score (inverted: 0 risk = 1.0 score) ──
    const fraudRiskScore = Math.max(0, 1.0 - input.fraudRiskScore);

    // ── Composite weighted score ──────────────────────────────
    const compositeScore =
      ocrScore * this.weights.ocr +
      faceMatchScore * this.weights.faceMatch +
      imageQualityScore * this.weights.imageQuality +
      documentQualityScore * this.weights.documentQuality +
      fraudRiskScore * this.weights.fraudRisk;

    const roundedComposite = Math.round(compositeScore * 10000) / 10000;

    const scores = {
      ocr: Math.round(ocrScore * 10000) / 10000,
      faceMatch: Math.round(faceMatchScore * 10000) / 10000,
      imageQuality: Math.round(imageQualityScore * 10000) / 10000,
      documentQuality: Math.round(documentQualityScore * 10000) / 10000,
      fraudRisk: Math.round(fraudRiskScore * 10000) / 10000,
    };

    // ── Decision ──────────────────────────────────────────────
    const { decision, decisionReason } = this.makeDecision(
      roundedComposite,
      faceMatchScore,
      input.fraudFlags,
    );

    this.logger.log({
      compositeScore: roundedComposite,
      scores,
      decision,
      decisionReason,
    }, `Confidence score: ${roundedComposite} → ${decision}`);

    return {
      compositeScore: roundedComposite,
      scores,
      decision,
      decisionReason,
    };
  }

  private computeOcrScore(ocrResult: OcrExtractionResult | null): number {
    if (!ocrResult) return 0;
    return ocrResult.overallConfidence;
  }

  private computeFaceMatchScore(faceMatch: FaceMatchResult | null): number {
    if (!faceMatch) return 0;
    if (!faceMatch.isMatch) return faceMatch.similarity * 0.5; // Penalize non-matches
    return faceMatch.confidence;
  }

  private computeImageQualityScore(
    idQuality: ImageQualityResult | null,
    selfieQuality: ImageQualityResult | null,
  ): number {
    const scores: number[] = [];
    if (idQuality) scores.push(idQuality.overallScore);
    if (selfieQuality) scores.push(selfieQuality.overallScore);

    if (scores.length === 0) return 0;
    // Return the minimum quality (weakest link)
    return Math.min(...scores);
  }

  private computeDocumentQualityScore(
    ocrResult: OcrExtractionResult | null,
  ): number {
    if (!ocrResult) return 0;

    // Score based on how many critical fields were extracted
    const criticalFields = [
      ocrResult.fullName,
      ocrResult.nationalIdNumber,
      ocrResult.dateOfBirth,
    ];

    const optionalFields = [
      ocrResult.gender,
      ocrResult.address,
      ocrResult.expiryDate,
    ];

    const criticalExtracted = criticalFields.filter((f) => f !== null).length;
    const optionalExtracted = optionalFields.filter((f) => f !== null).length;

    // Critical fields are worth 80%, optional 20%
    const criticalScore = criticalExtracted / criticalFields.length;
    const optionalScore = optionalExtracted / optionalFields.length;

    return criticalScore * 0.8 + optionalScore * 0.2;
  }

  private makeDecision(
    compositeScore: number,
    faceMatchScore: number,
    fraudFlags: FraudFlag[],
  ): { decision: 'APPROVED' | 'MANUAL_REVIEW' | 'REJECTED'; decisionReason: string } {
    // Critical fraud flags → auto-reject
    const criticalFlags = fraudFlags.filter(
      (f) => f.severity === KycFraudSeverity.CRITICAL,
    );
    if (criticalFlags.length > 0) {
      return {
        decision: 'REJECTED',
        decisionReason: `Critical fraud flag: ${criticalFlags[0].description}`,
      };
    }

    // Very low composite → auto-reject
    if (compositeScore < this.thresholds.autoReject) {
      return {
        decision: 'REJECTED',
        decisionReason: `Composite confidence ${compositeScore} below rejection threshold ${this.thresholds.autoReject}`,
      };
    }

    // High fraud flags → manual review
    const highFlags = fraudFlags.filter(
      (f) => f.severity === KycFraudSeverity.HIGH,
    );
    if (highFlags.length > 0) {
      return {
        decision: 'MANUAL_REVIEW',
        decisionReason: `High-severity fraud flag: ${highFlags[0].description}`,
      };
    }

    // Good composite + good face match + no serious flags → auto-approve
    if (
      compositeScore >= this.thresholds.autoApprove &&
      faceMatchScore >= this.thresholds.minFaceMatch
    ) {
      return {
        decision: 'APPROVED',
        decisionReason: `Composite ${compositeScore} ≥ ${this.thresholds.autoApprove}, face match ${faceMatchScore} ≥ ${this.thresholds.minFaceMatch}`,
      };
    }

    // Everything else → manual review
    return {
      decision: 'MANUAL_REVIEW',
      decisionReason: `Composite ${compositeScore} between ${this.thresholds.autoReject} and ${this.thresholds.autoApprove}`,
    };
  }
}
