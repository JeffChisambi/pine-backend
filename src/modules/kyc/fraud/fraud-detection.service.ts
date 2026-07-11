import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  KycFraudFlagType,
  KycFraudSeverity,
} from '../domain/kyc-stage.enum';
import type {
  FraudFlag,
  FaceMatchResult,
  OcrExtractionResult,
  ImageQualityResult,
} from '../domain/verification-result';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../interfaces/kyc-repository.interface';
import { FaceMatchingService } from '../face/face-matching.service';

/**
 * Context passed to the fraud detection engine containing
 * all data collected through the verification pipeline.
 */
export interface FraudCheckContext {
  applicationId: string;
  userId: string;
  ocrResult: OcrExtractionResult | null;
  faceMatchResult: FaceMatchResult | null;
  idImageQuality: ImageQualityResult | null;
  selfieImageQuality: ImageQualityResult | null;
  selfieEmbedding: number[] | null;
  documentHash: string | null;
}

/**
 * Orchestrates all fraud detection rules against a KYC application.
 * Each rule is a separate method that returns zero or more fraud flags.
 * Rules are independently configurable and can be enabled/disabled.
 */
@Injectable()
export class FraudDetectionService {
  private readonly logger = new Logger(FraudDetectionService.name);

  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
    private readonly faceMatching: FaceMatchingService,
  ) {}

  async runAllChecks(context: FraudCheckContext): Promise<{
    flags: FraudFlag[];
    riskScore: number;
    blocksApproval: boolean;
  }> {
    const startTime = Date.now();
    const flags: FraudFlag[] = [];

    // Run all rules in parallel where possible
    const [
      duplicateIdFlags,
      duplicateFaceFlags,
      expiredDocFlags,
      imageFlags,
      repeatedAttemptFlags,
      faceMatchFlags,
    ] = await Promise.all([
      this.checkDuplicateNationalId(context),
      this.checkDuplicateFace(context),
      this.checkExpiredDocument(context),
      this.checkImageTampering(context),
      this.checkRepeatedAttempts(context),
      this.checkFaceMatchAnomalies(context),
    ]);

    flags.push(
      ...duplicateIdFlags,
      ...duplicateFaceFlags,
      ...expiredDocFlags,
      ...imageFlags,
      ...repeatedAttemptFlags,
      ...faceMatchFlags,
    );

    // Compute risk score
    const riskScore = this.computeRiskScore(flags);
    const blocksApproval = flags.some(
      (f) =>
        f.severity === KycFraudSeverity.CRITICAL ||
        f.severity === KycFraudSeverity.HIGH,
    );

    const durationMs = Date.now() - startTime;
    this.logger.log({
      applicationId: context.applicationId,
      flagCount: flags.length,
      riskScore,
      blocksApproval,
      durationMs,
    }, `Fraud checks complete: ${flags.length} flags, risk=${riskScore.toFixed(2)}`);

    return { flags, riskScore, blocksApproval };
  }

  // ── Rule: Duplicate National ID ────────────────────────────────
  private async checkDuplicateNationalId(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    if (!context.ocrResult?.nationalIdNumber?.value) return [];

    const existing = await this.repository.findApplicationByNationalId(
      context.ocrResult.nationalIdNumber.value,
      context.applicationId,
    );

    if (existing) {
      return [{
        type: KycFraudFlagType.DUPLICATE_NATIONAL_ID,
        severity: KycFraudSeverity.CRITICAL,
        description: `National ID number already used in application ${existing.id}`,
        evidence: {
          existingApplicationId: existing.id,
          existingUserId: existing.userId,
          nationalIdNumber: context.ocrResult.nationalIdNumber.value,
        },
      }];
    }

    return [];
  }

  // ── Rule: Duplicate Face Embedding ─────────────────────────────
  private async checkDuplicateFace(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    if (!context.selfieEmbedding) return [];

    const existingEmbeddings = await this.repository.getAllApprovedEmbeddings();

    // Filter out embeddings from the same user
    const otherEmbeddings = existingEmbeddings.filter(
      (e) => e.userId !== context.userId,
    );

    if (otherEmbeddings.length === 0) return [];

    const duplicates = this.faceMatching.findDuplicates(
      context.selfieEmbedding,
      otherEmbeddings,
      0.55, // Higher threshold for duplicate detection than standard matching
    );

    if (duplicates.length > 0) {
      return [{
        type: KycFraudFlagType.DUPLICATE_FACE,
        severity: KycFraudSeverity.CRITICAL,
        description: `Face matches ${duplicates.length} existing account(s) with high confidence`,
        evidence: {
          matches: duplicates.slice(0, 3).map((d) => ({
            userId: d.userId,
            similarity: d.similarity,
          })),
        },
      }];
    }

    return [];
  }

  // ── Rule: Expired Document ─────────────────────────────────────
  private async checkExpiredDocument(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    if (!context.ocrResult?.expiryDate?.value) return [];

    try {
      const expiryStr = context.ocrResult.expiryDate.value;
      const parts = expiryStr.split('/');
      if (parts.length < 3) return [];

      // Try DD/MM/YYYY format
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      const fullYear = year < 100 ? 2000 + year : year;

      const expiryDate = new Date(fullYear, month, day);
      const now = new Date();

      if (expiryDate < now) {
        return [{
          type: KycFraudFlagType.EXPIRED_DOCUMENT,
          severity: KycFraudSeverity.HIGH,
          description: `Document expired on ${expiryDate.toISOString().slice(0, 10)}`,
          evidence: {
            expiryDate: expiryDate.toISOString(),
            daysExpired: Math.floor((now.getTime() - expiryDate.getTime()) / 86400000),
          },
        }];
      }
    } catch {
      // If we can't parse the date, don't raise a flag
    }

    return [];
  }

  // ── Rule: Image Tampering ──────────────────────────────────────
  private async checkImageTampering(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    const flags: FraudFlag[] = [];

    // Check for extremely low resolution (potential screenshot)
    if (context.idImageQuality) {
      if (context.idImageQuality.width < 400 || context.idImageQuality.height < 300) {
        flags.push({
          type: KycFraudFlagType.LOW_RESOLUTION,
          severity: KycFraudSeverity.MEDIUM,
          description: `Document image resolution too low: ${context.idImageQuality.width}x${context.idImageQuality.height}`,
          evidence: {
            width: context.idImageQuality.width,
            height: context.idImageQuality.height,
          },
        });
      }

      if (context.idImageQuality.sharpnessScore < 0.15) {
        flags.push({
          type: KycFraudFlagType.BLURRY_DOCUMENT,
          severity: KycFraudSeverity.MEDIUM,
          description: `Document image is too blurry (sharpness: ${context.idImageQuality.sharpnessScore})`,
          evidence: { sharpnessScore: context.idImageQuality.sharpnessScore },
        });
      }
    }

    // Check selfie quality
    if (context.selfieImageQuality) {
      if (context.selfieImageQuality.sharpnessScore < 0.15) {
        flags.push({
          type: KycFraudFlagType.BLURRY_DOCUMENT,
          severity: KycFraudSeverity.MEDIUM,
          description: `Selfie is too blurry (sharpness: ${context.selfieImageQuality.sharpnessScore})`,
          evidence: { sharpnessScore: context.selfieImageQuality.sharpnessScore },
        });
      }
    }

    return flags;
  }

  // ── Rule: Repeated Attempts ────────────────────────────────────
  private async checkRepeatedAttempts(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    const recentCount = await this.repository.countRecentApplicationsByUserId(
      context.userId,
      24, // within last 24 hours
    );

    // Allow up to 3 attempts per 24h
    if (recentCount > 3) {
      return [{
        type: KycFraudFlagType.REPEATED_ATTEMPTS,
        severity: KycFraudSeverity.MEDIUM,
        description: `${recentCount} KYC attempts in the last 24 hours`,
        evidence: { recentCount, threshold: 3, windowHours: 24 },
      }];
    }

    return [];
  }

  // ── Rule: Face Match Anomalies ─────────────────────────────────
  private async checkFaceMatchAnomalies(
    context: FraudCheckContext,
  ): Promise<FraudFlag[]> {
    const flags: FraudFlag[] = [];

    if (!context.faceMatchResult) return flags;

    // Multiple faces in ID
    if (context.faceMatchResult.idFace.faceCount > 1) {
      flags.push({
        type: KycFraudFlagType.MULTIPLE_FACES,
        severity: KycFraudSeverity.MEDIUM,
        description: `${context.faceMatchResult.idFace.faceCount} faces detected in ID document`,
        evidence: { faceCount: context.faceMatchResult.idFace.faceCount },
      });
    }

    // No face in ID
    if (!context.faceMatchResult.idFace.detected) {
      flags.push({
        type: KycFraudFlagType.NO_FACE_DETECTED,
        severity: KycFraudSeverity.HIGH,
        description: 'No face detected in the ID document',
      });
    }

    // No face in selfie
    if (!context.faceMatchResult.selfieFace.detected) {
      flags.push({
        type: KycFraudFlagType.NO_FACE_DETECTED,
        severity: KycFraudSeverity.HIGH,
        description: 'No face detected in the selfie',
      });
    }

    // Very low similarity with high detection confidence (possible different person)
    if (
      context.faceMatchResult.idFace.detected &&
      context.faceMatchResult.selfieFace.detected &&
      context.faceMatchResult.similarity < 0.25
    ) {
      flags.push({
        type: KycFraudFlagType.IMPOSSIBLE_MATCH,
        severity: KycFraudSeverity.CRITICAL,
        description: `Face similarity extremely low: ${context.faceMatchResult.similarity} — likely different people`,
        evidence: { similarity: context.faceMatchResult.similarity },
      });
    }

    return flags;
  }

  // ── Risk Score Computation ─────────────────────────────────────
  private computeRiskScore(flags: FraudFlag[]): number {
    if (flags.length === 0) return 0;

    const severityWeights: Record<KycFraudSeverity, number> = {
      [KycFraudSeverity.LOW]: 0.05,
      [KycFraudSeverity.MEDIUM]: 0.15,
      [KycFraudSeverity.HIGH]: 0.35,
      [KycFraudSeverity.CRITICAL]: 0.60,
    };

    const totalWeight = flags.reduce(
      (sum, flag) => sum + (severityWeights[flag.severity] ?? 0),
      0,
    );

    // Cap at 1.0
    return Math.min(Math.round(totalWeight * 100) / 100, 1.0);
  }
}
