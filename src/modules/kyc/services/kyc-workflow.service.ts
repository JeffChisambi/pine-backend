import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
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
import { MrzParser } from '../ocr/mrz.parser';
import { mergeOcrWithMrz } from '../ocr/ocr-merge.util';
import { AddressExtractor, type ExtractedAddress } from '../ocr/address-extractor';
import { StorageService } from '../../../infrastructure/storage/storage.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { validateUploadedFile } from '../../../infrastructure/storage/file-validation.util';

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png'];

/**
 * Stage order map for the H-2 regression fix.
 * Only advance the stage — never regress it when documents are re-uploaded.
 */
const STAGE_ORDER: Record<string, number> = {
  CREATED: 0,
  ID_UPLOADED: 1,
  SELFIE_UPLOADED: 2,
  VALIDATING: 3,
  ENHANCING: 4,
  OCR_PROCESSING: 5,
  FACE_EXTRACTING: 6,
  FACE_MATCHING: 7,
  FRAUD_CHECKING: 8,
  SCORING: 9,
  DECIDING: 10,
  COMPLETE: 11,
  FAILED: 12,
};

/**
 * KYC workflow orchestrator. Manages the full verification pipeline
 * as a state machine, transitioning through stages sequentially:
 *
 * CREATED → ID_UPLOADED → SELFIE_UPLOADED → VALIDATING → ENHANCING →
 * OCR_PROCESSING → FACE_EXTRACTING → FACE_MATCHING → FRAUD_CHECKING →
 * SCORING → DECIDING → COMPLETE
 *
 * processVerification() is called by KycProcessor (BullMQ background job).
 * It is no longer called synchronously from the HTTP controller (H-3 fix).
 */
@Injectable()
export class KycWorkflowService {
  private readonly logger = new Logger(KycWorkflowService.name);
  private readonly mrzParser = new MrzParser();
  private readonly addressExtractor = new AddressExtractor();

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
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,  // H-7: concurrency lock
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Application Lifecycle
  // ──────────────────────────────────────────────────────────────

  /**
   * H-9 fix:
   * - Resume existing application for NOT_SUBMITTED / PENDING / ADDITIONAL_DOCS /
   *   MANUAL_REVIEW statuses (was only resuming NOT_SUBMITTED + PENDING).
   * - Block re-application for APPROVED users (was silently creating a duplicate).
   * - REJECTED users can start a fresh application.
   */
  async startApplication(userId: string): Promise<{ applicationId: string }> {
    const existing = await this.repository.getLatestApplicationByUserId(userId);

    if (existing) {
      const RESUMABLE = new Set([
        'NOT_SUBMITTED',
        'PENDING',
        'ADDITIONAL_DOCS',
        'MANUAL_REVIEW',
      ]);
      if (RESUMABLE.has(existing.status)) {
        return { applicationId: existing.id };
      }
      if (existing.status === 'APPROVED') {
        throw new ConflictException('KYC is already approved for this account');
      }
      // REJECTED → fall through to create a fresh application
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
    documentType: 'NATIONAL_ID' | 'NATIONAL_ID_BACK' | 'SELFIE' | 'PROOF_OF_RESIDENCE',
    fileName: string,
    mimeType: string,
    buffer: Buffer,
  ): Promise<{ documentId: string }> {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== userId) {
      throw new Error('Application not found or unauthorized');
    }

    const allowedMimeTypes =
      documentType === 'PROOF_OF_RESIDENCE'
        ? [...ALLOWED_IMAGE_TYPES, 'application/pdf']
        : ALLOWED_IMAGE_TYPES;

    validateUploadedFile(fileName, mimeType, buffer, {
      allowedMimeTypes,
      maxSizeBytes: MAX_UPLOAD_SIZE,
    });

    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

    const uploadResult = await this.storageService.upload({
      bucket: 'kyc',
      keyPrefix: `${userId}/${applicationId}/${documentType.toLowerCase()}`,
      fileName,
      contentType: mimeType,
      body: buffer,
    });

    const doc = await this.repository.createDocument({
      kycApplicationId: applicationId,
      type: documentType,
      storageBucket: uploadResult.bucket,
      storageKey: uploadResult.key,
      mimeType,
      sizeBytes: buffer.byteLength,
      contentHash,
    });

    // H-2 fix: only advance the stage, never regress it.
    // PROOF_OF_RESIDENCE is supplementary — it has no primary upload stage.
    const stageAdvancement: Partial<Record<typeof documentType, KycVerificationStage>> = {
      NATIONAL_ID: KycVerificationStage.ID_UPLOADED,
      NATIONAL_ID_BACK: KycVerificationStage.ID_UPLOADED,
      SELFIE: KycVerificationStage.SELFIE_UPLOADED,
    };
    const proposedStage = stageAdvancement[documentType];
    if (proposedStage !== undefined) {
      const currentOrder = STAGE_ORDER[app.verificationStage ?? 'CREATED'] ?? 0;
      if ((STAGE_ORDER[proposedStage] ?? 0) > currentOrder) {
        await this.repository.updateApplicationStage(applicationId, proposedStage);
      }
    }

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

  /**
   * Called by KycProcessor (BullMQ background job) — NOT from the HTTP controller.
   *
   * H-7 fix: a Redis NX lock prevents two concurrent pipeline runs for the same
   * application (e.g. rapid retry taps on mobile or a race between a queued job
   * and a manual admin trigger). Lock TTL = 10 minutes (well above the typical
   * 30–60 second pipeline duration).
   */
  async processVerification(
    applicationId: string,
    userId: string,
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    // H-7 fix: acquire a Redis NX lock before touching any mutable state
    const lockKey = `kyc:pipeline:lock:${applicationId}`;
    const lockValue = `${userId}:${startTime}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lockAcquired = await (this.redis as any).set(lockKey, lockValue, 'EX', 600, 'NX') === 'OK';

    if (!lockAcquired) {
      this.logger.warn(
        { applicationId },
        'KYC pipeline already running for this application — skipping duplicate job',
      );
      return {
        applicationId,
        ocrResult: null,
        faceMatchResult: null as any,
        idImageQuality: null as any,
        selfieImageQuality: null as any,
        fraudFlags: [],
        confidenceScore: 0,
        scores: { ocr: 0, faceMatch: 0, imageQuality: 0, documentQuality: 0, fraudRisk: 0 },
        decision: 'MANUAL_REVIEW',
        decisionReason: 'Duplicate pipeline request — already processing',
        totalProcessingTimeMs: 0,
      };
    }

    try {
      return await this.runPipeline(applicationId, userId, startTime);
    } finally {
      // H-7: always release the lock, even if the pipeline throws
      await this.redis.del(lockKey);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Public entry point for the admin controller to sync user.kycStatus
   * after a broker manually approves or rejects an application.
   */
  async setUserKycStatus(
    userId: string,
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ADDITIONAL_DOCS',
  ): Promise<void> {
    return this.updateUserKycStatus(userId, status);
  }

  // ──────────────────────────────────────────────────────────────
  // Private — pipeline internals
  // ──────────────────────────────────────────────────────────────

  private async runPipeline(
    applicationId: string,
    userId: string,
    startTime: number,
  ): Promise<VerificationResult> {
    const app = await this.repository.getApplicationById(applicationId);
    if (!app || app.userId !== userId) {
      throw new Error('Application not found or unauthorized');
    }

    const documents = await this.repository.getDocumentsByApplicationId(applicationId);
    const idDoc = documents.find((d) => d.type === 'NATIONAL_ID');
    const selfieDoc = documents.find((d) => d.type === 'SELFIE');

    if (!idDoc || !selfieDoc) {
      throw new Error('Both national ID and selfie must be uploaded before processing');
    }

    // ── Mark as submitted immediately ─────────────────────────────────────────
    // Guarantees the application appears in the broker queue even if the AI
    // pipeline below crashes.
    await this.repository.updateApplicationStatus(applicationId, 'PENDING');
    await this.updateUserKycStatus(userId, 'PENDING');

    await this.repository.recordAuditEntry({
      kycApplicationId: applicationId,
      action: 'KYC_SUBMITTED_FOR_REVIEW',
      actorId: userId,
      details: { hasIdDocument: true, hasSelfie: true },
    });

    this.eventEmitter.emit('kyc.submitted', { applicationId, userId });

    try {
      // ── Stage: ENHANCING ─────────────────────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.ENHANCING,
      );

      const idUrl = await this.storageService.getSignedDownloadUrl('kyc', idDoc.storageKey, undefined, true);
      const selfieUrl = await this.storageService.getSignedDownloadUrl('kyc', selfieDoc.storageKey, undefined, true);

      const idBuffer = await this.downloadBuffer(idUrl);
      const selfieBuffer = await this.downloadBuffer(selfieUrl);

      // Enhance images (JPEG for S3 storage and admin preview)
      const enhancedId = await this.imageProcessor.enhance(idBuffer);
      const enhancedSelfie = await this.imageProcessor.enhance(selfieBuffer, {
        normalize: false, // Selfies usually have good lighting
      });

      // M-5 fix: separate PNG-format enhanced image for OCR (lossless, no blocking
      // artifacts that degrade character recognition on Malawi NRC fonts)
      const enhancedIdForOcr = await this.imageProcessor.enhance(idBuffer, {
        outputFormat: 'png',
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

      // H-5 fix: capture upload results so we can persist the storage keys.
      // The previous code discarded the upload result with await-without-assignment,
      // making updateDocument() a permanent no-op.
      const [idEnhancedUpload, selfieEnhancedUpload, idThumbUpload, selfieThumbUpload] =
        await Promise.all([
          this.storageService.upload({
            bucket: 'kyc',
            keyPrefix: `${userId}/${applicationId}/enhanced`,
            fileName: 'id-enhanced.jpg',
            contentType: 'image/jpeg',
            body: enhancedId,
          }),
          this.storageService.upload({
            bucket: 'kyc',
            keyPrefix: `${userId}/${applicationId}/enhanced`,
            fileName: 'selfie-enhanced.jpg',
            contentType: 'image/jpeg',
            body: enhancedSelfie,
          }),
          this.storageService.upload({
            bucket: 'kyc',
            keyPrefix: `${userId}/${applicationId}/thumbnails`,
            fileName: 'id-thumb.jpg',
            contentType: 'image/jpeg',
            body: idThumb,
          }),
          this.storageService.upload({
            bucket: 'kyc',
            keyPrefix: `${userId}/${applicationId}/thumbnails`,
            fileName: 'selfie-thumb.jpg',
            contentType: 'image/jpeg',
            body: selfieThumb,
          }),
        ]);

      // H-5 fix: persist enhanced and thumbnail keys to the document records
      // so the broker dashboard can link to the AI-enhanced versions.
      await Promise.all([
        this.repository.updateDocument(idDoc.id, {
          enhancedStorageKey: idEnhancedUpload.key,
          thumbnailStorageKey: idThumbUpload.key,
        }),
        this.repository.updateDocument(selfieDoc.id, {
          enhancedStorageKey: selfieEnhancedUpload.key,
          thumbnailStorageKey: selfieThumbUpload.key,
        }),
      ]);

      // ── Stage: OCR_PROCESSING ─────────────────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.OCR_PROCESSING,
      );

      let ocrResult: OcrExtractionResult | null = null;
      if (this.ocrProvider.isReady()) {
        // M-5 fix: use the lossless PNG-enhanced image for OCR
        ocrResult = await this.ocrProvider.extractFields(enhancedIdForOcr, {
          documentType: 'national_id',
          preprocess: true,
        });

        // ── Back of card: machine-readable zone (MRZ) ─────────────────────────
        // The TD1 MRZ carries every identity field in a fixed OCR-B format with
        // ICAO check digits — far more reliable than the printed front. Merge
        // it in with best-field-wins precedence.
        const idBackDoc = documents.find((d) => d.type === 'NATIONAL_ID_BACK');
        if (idBackDoc) {
          try {
            const backUrl = await this.storageService.getSignedDownloadUrl(
              'kyc', idBackDoc.storageKey, undefined, true,
            );
            const backBuffer = await this.downloadBuffer(backUrl);
            const enhancedBack = await this.imageProcessor.enhance(backBuffer, {
              outputFormat: 'png',
            });
            const mrzText = this.ocrProvider.extractMrzText
              ? await this.ocrProvider.extractMrzText(enhancedBack)
              : await this.ocrProvider.extractRawText(enhancedBack);
            const mrz = this.mrzParser.parse(mrzText);

            if (mrz.found) {
              ocrResult = mergeOcrWithMrz(ocrResult, mrz);
              this.logger.log(
                { applicationId, checkDigitScore: mrz.checkDigitScore },
                'MRZ parsed from ID back and merged into OCR result',
              );
            } else {
              // MRZ pass failed — still try the generic parser on the back
              // text in case the printed fields are on the reverse side.
              this.logger.debug({ applicationId }, 'No MRZ found on ID back');
            }
          } catch (backError) {
            this.logger.warn(
              { err: backError, applicationId },
              'ID back OCR failed — continuing with front-side extraction only',
            );
          }
        }

        await this.repository.saveOcrResult({
          kycApplicationId: applicationId,
          documentId: idDoc.id,
          extractedData: ocrResult,
          overallConfidence: ocrResult.overallConfidence,
          rawText: ocrResult.rawText,
        });

        // Always persist confidence + extracted data — even a low-confidence
        // extraction must reach the review dashboard instead of showing 0%.
        await this.repository.updateApplicationStatus(applicationId, 'PENDING', {
          nationalIdNumber: ocrResult.nationalIdNumber?.value ?? null,
          dateOfBirth: ocrResult.dateOfBirth?.value
            ? this.parseDate(ocrResult.dateOfBirth.value)
            : null,
          ocrExtractedData: ocrResult as unknown,
          ocrConfidence: ocrResult.overallConfidence,
        });
      }

      // ── Proof of residency: extract + persist the applicant's address ────────
      const porDoc = documents.find((d) => d.type === 'PROOF_OF_RESIDENCE');
      if (porDoc && this.ocrProvider.isReady()) {
        try {
          const porAddress = await this.extractAddressFromProof(porDoc);
          if (porAddress?.formatted) {
            await this.repository.updateApplicationStatus(applicationId, 'PENDING', {
              addressLine1: porAddress.addressLine1,
              addressLine2: porAddress.addressLine2,
              city: porAddress.city,
              district: porAddress.district,
              ocrExtractedData: { _extractedAddress: porAddress } as unknown,
            });
            this.logger.log(
              { applicationId, confidence: porAddress.confidence },
              'Address extracted from proof of residency',
            );
          }
        } catch (porError) {
          this.logger.warn(
            { err: porError, applicationId },
            'Proof-of-residency address extraction failed — continuing',
          );
        }
      }

      // ── Stage: FACE_EXTRACTING ────────────────────────────────────────────────
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

      // ── Stage: FACE_MATCHING ──────────────────────────────────────────────────
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

      // ── Stage: FRAUD_CHECKING ─────────────────────────────────────────────────
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

      // ── Stage: SCORING ────────────────────────────────────────────────────────
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

      // ── Stage: DECIDING ───────────────────────────────────────────────────────
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.DECIDING,
      );

      // MANUAL_REVIEW is not a DB enum value — keep application PENDING so it
      // appears in the Kusata queue for human broker review.
      const applicationStatus =
        scoring.decision === 'APPROVED'
          ? 'APPROVED'
          : scoring.decision === 'REJECTED'
            ? 'REJECTED'
            : 'PENDING'; // MANUAL_REVIEW stays PENDING

      await this.repository.updateApplicationStatus(applicationId, applicationStatus, {
        confidenceScore: scoring.compositeScore,
        imageQualityScore: scoring.scores.imageQuality,
        documentQualityScore: scoring.scores.documentQuality,
        fraudScore: fraudResult.riskScore,
      });

      if (applicationStatus === 'APPROVED' || applicationStatus === 'REJECTED') {
        await this.updateUserKycStatus(userId, applicationStatus);
      }

      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.COMPLETE,
      );

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

      this.logger.log(
        { applicationId, decision: scoring.decision, compositeScore: scoring.compositeScore, totalProcessingTimeMs },
        `KYC verification complete: ${scoring.decision}`,
      );

      return result;
    } catch (error) {
      // AI pipeline failed — application stays PENDING for manual broker review
      await this.repository.updateApplicationStage(
        applicationId,
        KycVerificationStage.FAILED,
      );

      await this.repository.recordAuditEntry({
        kycApplicationId: applicationId,
        action: 'VERIFICATION_PIPELINE_FAILED',
        actorId: userId,
        details: {
          error: error instanceof Error ? error.message : String(error),
          note: 'Application remains PENDING for manual broker review',
        },
      });

      this.logger.warn(
        { err: error, applicationId },
        'KYC AI pipeline failed — application stays PENDING for manual review',
      );

      return {
        applicationId,
        ocrResult: null,
        faceMatchResult: null as any,
        idImageQuality: null as any,
        selfieImageQuality: null as any,
        fraudFlags: [],
        confidenceScore: 0,
        scores: { ocr: 0, faceMatch: 0, imageQuality: 0, documentQuality: 0, fraudRisk: 0 },
        decision: 'MANUAL_REVIEW',
        decisionReason: 'AI pipeline unavailable — queued for manual broker review',
        totalProcessingTimeMs: Date.now() - startTime,
      };
    }
  }

  private async updateUserKycStatus(
    userId: string,
    status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ADDITIONAL_DOCS',
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: status },
    });
    this.logger.log({ userId, kycStatus: status }, 'User kycStatus updated');
  }

  /**
   * OCR (image) or text-extract (PDF) a proof-of-residency document, then run
   * the heuristic address extractor over the text.
   */
  private async extractAddressFromProof(porDoc: {
    storageKey: string;
    mimeType: string;
  }): Promise<ExtractedAddress | null> {
    const url = await this.storageService.getSignedDownloadUrl(
      'kyc', porDoc.storageKey, undefined, true,
    );
    const buffer = await this.downloadBuffer(url);

    let text = '';
    if (porDoc.mimeType === 'application/pdf') {
      text = await this.extractPdfText(buffer);
    } else {
      const enhanced = await this.imageProcessor.enhance(buffer, {
        outputFormat: 'png',
      });
      text = await this.ocrProvider.extractRawText(enhanced);
    }

    if (!text.trim()) return null;
    return this.addressExtractor.extract(text);
  }

  /** Extract embedded text from a digitally-generated PDF (no OCR). */
  private async extractPdfText(buffer: Buffer): Promise<string> {
    // pdfjs-dist is ESM-only; load lazily so cold paths don't pay the cost.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
    }).promise;

    const parts: string[] = [];
    const pageCount = Math.min(doc.numPages, 5); // bills are 1–2 pages
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Group items into lines by their y-coordinate so the address block
      // survives as consecutive lines for the extractor.
      const rows = new Map<number, Array<{ x: number; str: string }>>();
      for (const item of content.items as Array<{ str: string; transform: number[] }>) {
        if (!item.str?.trim()) continue;
        const y = Math.round(item.transform[5]);
        const x = item.transform[4];
        const bucket = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
        if (!rows.has(bucket)) rows.set(bucket, []);
        rows.get(bucket)!.push({ x, str: item.str });
      }
      const lines = [...rows.entries()]
        .sort((a, b) => b[0] - a[0]) // PDF y-axis is bottom-up
        .map(([, items]) =>
          items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' '),
        );
      parts.push(lines.join('\n'));
    }
    return parts.join('\n');
  }

  private async downloadBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * H-6 fix:
   * - 2-digit years now use a pivot (≤ 30 → 20xx, > 30 → 19xx) so that
   *   a scanned "79" maps to 1979, not 2079.
   * - Uses Date.UTC to avoid the local-timezone offset that new Date(y,m,d)
   *   introduces, which caused dates near midnight to shift by ±1 day in
   *   non-UTC server deployments.
   */
  private parseDate(dateStr: string): Date | null {
    try {
      const parts = dateStr.split('/');
      if (parts.length < 3) return null;
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // 0-based for Date.UTC
      const rawYear = parseInt(parts[2], 10);

      // 2-digit year pivot: ≤ 30 → 2000+, > 30 → 1900+
      const fullYear =
        rawYear < 100
          ? rawYear <= 30
            ? 2000 + rawYear
            : 1900 + rawYear
          : rawYear;

      return new Date(Date.UTC(fullYear, month, day)); // UTC, not local time
    } catch {
      return null;
    }
  }
}
