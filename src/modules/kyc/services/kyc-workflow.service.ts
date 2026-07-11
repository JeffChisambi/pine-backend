import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'node:crypto';
import { KycVerificationStage } from '../domain/kyc-stage.enum';
import type {
  FaceMatchResult,
  VerificationResult,
  OcrExtractionResult,
  ImageQualityResult,
  FaceDetectionResult,
} from '../domain/verification-result';
import {
  KYC_REPOSITORY,
  type IKycRepository,
} from '../interfaces/kyc-repository.interface';
import {
  IMAGE_PROCESSING_PROVIDER,
  type IImageProcessingProvider,
} from '../image/image-processing.interface';
import {
  OCR_PROVIDER,
  type IOcrProvider,
} from '../ocr/ocr.interface';
import {
  FACE_RECOGNITION_PROVIDER,
  type IFaceRecognitionProvider,
} from '../face/face-recognition.interface';
import { FaceMatchingService } from '../face/face-matching.service';
import { FraudDetectionService } from '../fraud/fraud-detection.service';
import { ConfidenceEngine } from '../fraud/confidence-engine';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { validateUploadedFile } from '../../../infrastructure/storage/file-validation.util';

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'];

/**
 * KYC workflow orchestrator. Manages the full verification pipeline
 * as a state machine, transitioning through stages sequentially:
 *
 * CREATED → ID_UPLOADED → SELFIE_UPLOADED → VALIDATING → ENHANCING →
 * OCR_PROCESSING → FACE_EXTRACTING → FACE_MATCHING → FRAUD_CHECKING →
 * SCORING → DECIDING → COMPLETE
 *
 * Each stage is isolated and idempotent. The workflow can be resumed
 * from any stage after a failure.
 */
@Injectable()
export class KycWorkflowService {
  private readonly logger = new Logger(KycWorkflowService.name);

  constructor(
    @Inject(KYC_REPOSITORY)
    private readonly repository: IKycRepository,
    @Inject(IMAGE_PROCESSING_PROVIDER)
    private readonly imageProcessor: IImageProcessingProvider,
    @Inject(OCR_PROVIDER)
    private readonly ocrProvider: IOcrProvider,
    @Inject(FACE_RECOGNITION_PROVIDER)
    private readonly faceRecognition: IFaceRecognitionProvider,
    private readonly faceMatching: FaceMatchingService,
    private readonly fraudDetection: FraudDetectionService,
    private readonly confidenceEngine: ConfidenceEngine,
    private readonly storageService: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Application Lifecycle
  // ──────────────────────────────────────────────────────────────

  async startApplication(userId: string): Promise<{ applicationId: string }> {
    // Check for existing pending application
    const existing = await this.repository.getLatestApplicationByUserId(userId);
    if (existing && (existing.status === 'PENDING' || existing.status === 'NOT_SUBMITTED')) {
      return { applicationId: existing.id };
    }

    const application = await this.repository.createApplication(userId);

    await this.repository.recordAuditEntry({
      kycApplicationId: application.id,
      action: 'KYC_STARTED',
      actorId: userId,
    });

    this.eventEmitter.emit('kyc.started', {
      applicationId: application.id,
      userId,
    });

    return { applicationId: application.id };
  }

  // ──────────────────────────────────────────────────────────────
  // Document Upload
  // ──────────────────────────────────────────────────────────────

  async uploadDocument(
    applicationId: string,
    userId: string,
    documentType: 'NATIONAL_ID' | 'SELFIE',
    fileName: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<{ documentId: string }> {
    // Validate the application
    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== userId) {
      throw new Error('Application not found or unauthorized');
    }

    // Validate the file (MIME, magic bytes, size)
    validateUploadedFile(fileName, mimeType, buffer, {
      allowedMimeTypes: ALLOWED_IMAGE_TYPES,
      maxSizeBytes: MAX_UPLOAD_SIZE,
    });

    // Compute content hash for duplicate detection
    const contentHash = crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex');

    // Upload to S3/MinIO
    const uploadResult = await this.storageService.upload({
      bucket: 'kyc',
      keyPrefix: `${userId}/${applicationId}/${documentType.toLowerCase()}`,
      fileName,
      contentType: mimeType,
      body: buffer,
    });

    // Create document record
    const doc = await this.repository.createDocument({
      kycApplicationId: applicationId,
      type: documentType,
      storageBucket: uploadResult.bucket,
      storageKey: uploadResult.key,
      mimeType,
      sizeBytes: buffer.byteLength,
      contentHash,
    });

    // Update application stage
    const newStage = documentType === 'NATIONAL_ID'
      ? KycVerificationStage.ID_UPLOADED
      : KycVerificationStage.SELFIE_UPLOADED;

    await this.repository.updateApplicationStage(applicationId, newStage);

    await this.repository.recordAuditEntry({
      kycApplicationId: applicationId,
      action: `DOCUMENT_UPLOADED:${documentType}`,
      actorId: userId,
      details: {
        documentId: doc.id,
        mimeType,
        sizeBytes: buffer.byteLength,
        contentHash,
      },
    });

    this.eventEmitter.emit('kyc.document.uploaded', {
      applicationId,
      documentId: doc.id,
      documentType,
    });

    return { documentId: doc.id };
  }

  // ──────────────────────────────────────────────────────────────
  // Full Verification Pipeline
  // ──────────────────────────────────────────────────────────────

  async processVerification(
    applicationId: string,
    userId: string,
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== userId) {
      throw new Error('Application not found or unauthorized');
    }

    // Ensure both documents are uploaded
    const documents = await this.repository.getDocumentsByApplicationId(applicationId);
    const idDoc = documents.find((d) => d.type === 'NATIONAL_ID');
    const selfieDoc = documents.find((d) => d.type === 'SELFIE');

    if (!idDoc || !selfieDoc) {
      throw new Error('Both national ID and selfie must be uploaded before processing');
    }

    try {
      // ── Stage: ENHANCING ──────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.ENHANCING,
      );

      const idUrl = await this.storageService.getSignedDownloadUrl('kyc', idDoc.storageKey);
      const selfieUrl = await this.storageService.getSignedDownloadUrl('kyc', selfieDoc.storageKey);

      // For processing we need the raw buffer — download from storage
      // In a real deployment this would use a streaming approach
      const idBuffer = await this.downloadBuffer(idUrl);
      const selfieBuffer = await this.downloadBuffer(selfieUrl);

      // Enhance images
      const enhancedId = await this.imageProcessor.enhance(idBuffer);
      const enhancedSelfie = await this.imageProcessor.enhance(selfieBuffer, {
        normalize: false, // Selfies usually have good lighting
      });

      // Analyze image quality
      const idImageQuality = await this.imageProcessor.analyzeQuality(enhancedId);
      const selfieImageQuality = await this.imageProcessor.analyzeQuality(enhancedSelfie);

      // Generate thumbnails for admin review
      const idThumb = await this.imageProcessor.generateThumbnail(enhancedId, {
        width: 200,
        height: 200,
      });
      const selfieThumb = await this.imageProcessor.generateThumbnail(enhancedSelfie, {
        width: 200,
        height: 200,
      });

      // Upload enhanced images and thumbnails
      await this.storageService.upload({
        bucket: 'kyc',
        keyPrefix: `${userId}/${applicationId}/enhanced`,
        fileName: 'id-enhanced.jpg',
        contentType: 'image/jpeg',
        body: enhancedId,
      });
      await this.storageService.upload({
        bucket: 'kyc',
        keyPrefix: `${userId}/${applicationId}/enhanced`,
        fileName: 'selfie-enhanced.jpg',
        contentType: 'image/jpeg',
        body: enhancedSelfie,
      });
      await this.storageService.upload({
        bucket: 'kyc',
        keyPrefix: `${userId}/${applicationId}/thumbnails`,
        fileName: 'id-thumb.jpg',
        contentType: 'image/jpeg',
        body: idThumb,
      });
      await this.storageService.upload({
        bucket: 'kyc',
        keyPrefix: `${userId}/${applicationId}/thumbnails`,
        fileName: 'selfie-thumb.jpg',
        contentType: 'image/jpeg',
        body: selfieThumb,
      });

      // ── Stage: OCR_PROCESSING ──────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.OCR_PROCESSING,
      );

      let ocrResult: OcrExtractionResult | null = null;
      if (this.ocrProvider.isReady()) {
        ocrResult = await this.ocrProvider.extractFields(enhancedId, {
          documentType: 'national_id',
          preprocess: true,
        });

        await this.repository.saveOcrResult({
          kycApplicationId: applicationId,
          documentId: idDoc.id,
          extractedData: ocrResult,
          overallConfidence: ocrResult.overallConfidence,
          rawText: ocrResult.rawText,
        });

        // Update application with extracted data
        if (ocrResult.nationalIdNumber?.value || ocrResult.dateOfBirth?.value) {
          await this.repository.updateApplicationStatus(applicationId, 'PENDING', {
            nationalIdNumber: ocrResult.nationalIdNumber?.value ?? null,
            dateOfBirth: ocrResult.dateOfBirth?.value
              ? this.parseDate(ocrResult.dateOfBirth.value)
              : null,
            ocrExtractedData: ocrResult as unknown,
            ocrConfidence: ocrResult.overallConfidence,
          });
        }
      }

      // ── Stage: FACE_EXTRACTING ──────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.FACE_EXTRACTING,
      );

      let idFace: FaceDetectionResult = {
        detected: false, faceCount: 0, boundingBox: null,
        embedding: null, detectionConfidence: 0, qualityScore: 0, processingTimeMs: 0,
      };
      let selfieFace: FaceDetectionResult = {
        detected: false, faceCount: 0, boundingBox: null,
        embedding: null, detectionConfidence: 0, qualityScore: 0, processingTimeMs: 0,
      };

      if (this.faceRecognition.isReady()) {
        idFace = await this.faceRecognition.detectAndEmbed(enhancedId);
        selfieFace = await this.faceRecognition.detectAndEmbed(enhancedSelfie);

        // Save embeddings for future duplicate detection
        if (idFace.embedding) {
          await this.repository.saveFaceEmbedding({
            kycApplicationId: applicationId,
            documentId: idDoc.id,
            sourceType: 'national_id',
            embedding: idFace.embedding,
            detectionConfidence: idFace.detectionConfidence,
            qualityScore: idFace.qualityScore,
          });
        }
        if (selfieFace.embedding) {
          await this.repository.saveFaceEmbedding({
            kycApplicationId: applicationId,
            documentId: selfieDoc.id,
            sourceType: 'selfie',
            embedding: selfieFace.embedding,
            detectionConfidence: selfieFace.detectionConfidence,
            qualityScore: selfieFace.qualityScore,
          });
        }
      }

      // ── Stage: FACE_MATCHING ──────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.FACE_MATCHING,
      );

      const faceMatchResult: FaceMatchResult = this.faceMatching.compareFaces(
        idFace,
        selfieFace,
      );

      await this.repository.updateApplicationStatus(applicationId, 'PENDING', {
        facialMatchScore: faceMatchResult.similarity,
        faceMatchConfidence: faceMatchResult.confidence,
      });

      // ── Stage: FRAUD_CHECKING ──────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.FRAUD_CHECKING,
      );

      const fraudResult = await this.fraudDetection.runAllChecks({
        applicationId,
        userId,
        ocrResult,
        faceMatchResult,
        idImageQuality,
        selfieImageQuality,
        selfieEmbedding: selfieFace.embedding,
        documentHash: idDoc.contentHash,
      });

      if (fraudResult.flags.length > 0) {
        await this.repository.saveFraudFlags(applicationId, fraudResult.flags);
      }

      // ── Stage: SCORING ──────────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.SCORING,
      );

      const scoring = this.confidenceEngine.computeScore({
        ocrResult,
        faceMatchResult,
        idImageQuality,
        selfieImageQuality,
        fraudFlags: fraudResult.flags,
        fraudRiskScore: fraudResult.riskScore,
      });

      // ── Stage: DECIDING ──────────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.DECIDING,
      );

      // Map decision to KYC status
      const statusMap = {
        APPROVED: 'APPROVED',
        MANUAL_REVIEW: 'PENDING',
        REJECTED: 'REJECTED',
      } as const;

      const finalStatus = statusMap[scoring.decision];

      await this.repository.updateApplicationStatus(applicationId, finalStatus, {
        confidenceScore: scoring.compositeScore,
        imageQualityScore: scoring.scores.imageQuality,
        documentQualityScore: scoring.scores.documentQuality,
        fraudScore: fraudResult.riskScore,
      });

      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.COMPLETE,
      );

      // Build final result
      const totalProcessingTimeMs = Date.now() - startTime;

      const result: VerificationResult = {
        applicationId,
        ocrResult,
        faceMatchResult,
        idImageQuality,
        selfieImageQuality,
        fraudFlags: fraudResult.flags,
        confidenceScore: scoring.compositeScore,
        scores: scoring.scores,
        decision: scoring.decision,
        decisionReason: scoring.decisionReason,
        totalProcessingTimeMs,
      };

      // Audit trail
      await this.repository.recordAuditEntry({
        kycApplicationId: applicationId,
        action: `VERIFICATION_COMPLETE:${scoring.decision}`,
        actorId: userId,
        details: {
          compositeScore: scoring.compositeScore,
          decision: scoring.decision,
          fraudFlagCount: fraudResult.flags.length,
          totalProcessingTimeMs,
        },
      });

      // Domain events
      this.eventEmitter.emit('kyc.verification.complete', {
        applicationId,
        userId,
        decision: scoring.decision,
        confidenceScore: scoring.compositeScore,
      });

      if (scoring.decision === 'APPROVED') {
        this.eventEmitter.emit('kyc.approved', { applicationId, userId });
      } else if (scoring.decision === 'REJECTED') {
        this.eventEmitter.emit('kyc.rejected', {
          applicationId,
          userId,
          reason: scoring.decisionReason,
        });
      }

      this.logger.log({
        applicationId,
        decision: scoring.decision,
        compositeScore: scoring.compositeScore,
        totalProcessingTimeMs,
      }, `KYC verification complete: ${scoring.decision}`);

      return result;
    } catch (error) {
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.FAILED,
      );

      await this.repository.recordAuditEntry({
        kycApplicationId: applicationId,
        action: 'VERIFICATION_FAILED',
        actorId: userId,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });

      this.logger.error(
        { err: error, applicationId },
        'KYC verification pipeline failed',
      );

      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  private async downloadBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private parseDate(dateStr: string): Date | null {
    try {
      const parts = dateStr.split('/');
      if (parts.length < 3) return null;
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      const fullYear = year < 100 ? 2000 + year : year;
      return new Date(fullYear, month, day);
    } catch {
      return null;
    }
  }
}
