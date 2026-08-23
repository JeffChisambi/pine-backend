import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ConfigModule } from '../../config/config.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { StorageModule } from '../../infrastructure/storage/storage.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';

// Interfaces — DI tokens
import { KYC_REPOSITORY } from './interfaces/kyc-repository.interface';
import { IMAGE_PROCESSING_PROVIDER } from './image/image-processing.interface';
import { OCR_PROVIDER } from './ocr/ocr.interface';
import { FACE_RECOGNITION_PROVIDER } from './face/face-recognition.interface';

// Controllers
import { KycController } from './controllers/kyc.controller';

// Services
import { KycWorkflowService } from './services/kyc-workflow.service';
import { CsdFormService } from './services/csd-form.service';
import { KycReconciliationService } from './services/kyc-reconciliation.service';

// Queue Processor
import { KycProcessor } from './processors/kyc.processor';

// Providers (Strategy pattern)
import { SharpProvider } from './image/sharp.provider';
import { TesseractProvider } from './ocr/tesseract.provider';
import { InsightFaceProvider } from './face/insightface.provider';
import { BankAccountCryptoService } from './services/bank-account-crypto.service';
import { FaceMatchingService } from './face/face-matching.service';

// Fraud + Confidence
import { FraudDetectionService } from './fraud/fraud-detection.service';
import { ConfidenceEngine } from './fraud/confidence-engine';

// Repository
import { KycRepository } from './repositories/kyc.repository';

/**
 * KYC Module — Enterprise-grade identity verification.
 *
 * Architecture:
 *   Upload → Validate → Enhance → OCR → Face Detect → Face Match →
 *   Fraud Check → Score → Decide → Approve / Review / Reject
 *
 * Provider abstraction:
 *   - IMAGE_PROCESSING_PROVIDER → SharpProvider
 *   - OCR_PROVIDER              → TesseractProvider  (eng.traineddata from repo root)
 *   - FACE_RECOGNITION_PROVIDER → InsightFaceProvider (InsightFace buffalo_l ONNX)
 *   - KYC_REPOSITORY            → KycRepository (Prisma)
 *
 * To swap any provider, change the `useClass` binding — no other changes needed.
 *
 * FIX (Bug 13): Removed the erroneous import of MarketDataValidator from the
 * market-sync module. It was present in the original module but never used,
 * creating an unnecessary cross-module coupling.
 */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    StorageModule,
    QueueModule,   // provides @InjectQueue(QueueName.KYC) for KycController + KycProcessor
    MulterModule.register({
      storage: memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB
        files: 1,
      },
    }),
  ],
  controllers: [KycController],
  providers: [
    // ── Repository ──────────────────────────────────────────────
    { provide: KYC_REPOSITORY, useClass: KycRepository },

    // ── Image Processing ────────────────────────────────────────
    { provide: IMAGE_PROCESSING_PROVIDER, useClass: SharpProvider },

    // ── OCR Engine ──────────────────────────────────────────────
    { provide: OCR_PROVIDER, useClass: TesseractProvider },

    // ── Face Recognition ────────────────────────────────────────
    { provide: FACE_RECOGNITION_PROVIDER, useClass: InsightFaceProvider },

    // ── Face Matching ───────────────────────────────────────────
    FaceMatchingService,

    // ── Bank account encryption (shared with admin surface) ─────
    BankAccountCryptoService,

    // ── Fraud Detection ─────────────────────────────────────────
    FraudDetectionService,
    ConfidenceEngine,

    // ── Workflow Orchestrator ────────────────────────────────────
    KycWorkflowService,

    // ── CSD Account Opening form generator ──────────────────────
    CsdFormService,

    // ── OCR ↔ registration reconciliation ───────────────────────
    KycReconciliationService,

    // ── BullMQ Processor (H-3 fix: async pipeline) ──────────────
    KycProcessor,
  ],
  exports: [KycWorkflowService, CsdFormService, KycReconciliationService, KYC_REPOSITORY, BankAccountCryptoService],
})
export class KycModule {}
