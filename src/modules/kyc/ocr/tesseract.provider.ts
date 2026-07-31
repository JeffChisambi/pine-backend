import * as path from 'node:path';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Tesseract from 'tesseract.js';
import type { IOcrProvider, OcrOptions } from './ocr.interface';
import type { OcrExtractionResult } from '../domain/verification-result';
import { MalawiIdParser } from './malawi-id.parser';

/**
 * Tesseract.js-backed OCR provider. Uses WebAssembly under the hood —
 * no native dependencies, no Python, works everywhere Node.js runs.
 *
 * Design:
 * - Maintains a persistent worker (1 per service instance)
 * - Workers are initialized with local English language data at startup
 * - Each recognition call reuses the warm worker (no cold start per image)
 * - Workers are terminated cleanly at module shutdown
 *
 * FIX (Bug 5): The original code did not specify a `langPath`, so Tesseract.js
 * attempted to download `eng.traineddata` from the CDN on every cold start.
 * This fails in offline/restricted environments and adds latency.
 * The `eng.traineddata` file (5.2 MB) is committed in the repository root.
 * We now resolve its directory and pass it as `langPath`.
 *
 * FIX (Bug 11): The original code used PSM.AUTO (page segmentation: automatic).
 * For structured identity cards with labeled fields and a fixed layout,
 * PSM.SPARSE_TEXT_OSD gives better recall — it recognises text regardless of
 * reading order and ignores decorative backgrounds. We also set OEM_LSTM_ONLY
 * for accuracy over the legacy engine.
 */
@Injectable()
export class TesseractProvider
  implements IOcrProvider, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TesseractProvider.name);
  private worker: Tesseract.Worker | null = null;
  private ready = false;
  readonly providerName = 'tesseract.js';

  private readonly malawiIdParser = new MalawiIdParser();

  // Path to the directory containing eng.traineddata.
  // The file lives in the project root; resolve relative to CWD.
  private readonly langPath = path.resolve(process.cwd());

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.destroy();
  }

  async initialize(): Promise<void> {
    try {
      this.worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        // FIX: point at the project root where eng.traineddata lives
        langPath: this.langPath,
        logger: (info) => {
          if (info.status === 'recognizing text') return; // suppress noisy progress
          this.logger.debug({ status: info.status }, 'Tesseract worker status');
        },
      });

      // PSM.SPARSE_TEXT: recognises text at arbitrary positions without orientation/
      // script detection (OSD). OSD adds 200–500 ms per image and can misfire on
      // bi-lingual (English/Chichewa) Malawi NRC cards. Auto-rotation is handled
      // upstream by Sharp's EXIF.rotate(), so OSD is redundant here (M-9 fix).
      await this.worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
        // Keep inter-word spacing so label:value patterns survive
        preserve_interword_spaces: '1',
        // Raise minimum word confidence to filter garbage
        tessedit_reject_bad_qual_wds: '1',
      });

      this.ready = true;
      this.logger.log(
        { langPath: this.langPath },
        'Tesseract OCR worker initialized (using local eng.traineddata)',
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to initialize Tesseract worker');
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready && this.worker !== null;
  }

  async extractFields(
    buffer: Buffer,
    options: OcrOptions = {},
  ): Promise<OcrExtractionResult> {
    const startTime = Date.now();

    if (!this.worker || !this.ready) {
      throw new Error('Tesseract worker not initialized');
    }

    try {
      const result = await this.worker.recognize(buffer);
      const rawText = result.data.text;
      const confidence = result.data.confidence / 100; // normalize to 0–1

      const documentType = options.documentType ?? 'national_id';
      let extraction: OcrExtractionResult;

      switch (documentType) {
        case 'national_id':
          extraction = this.malawiIdParser.parse(rawText, confidence);
          break;
        default:
          extraction = this.buildGenericResult(rawText, confidence);
          break;
      }

      extraction.processingTimeMs = Date.now() - startTime;

      this.logger.log(
        {
          documentType,
          confidence: extraction.overallConfidence,
          processingTimeMs: extraction.processingTimeMs,
          fieldsExtracted: this.countExtractedFields(extraction),
        },
        'OCR extraction complete',
      );

      return extraction;
    } catch (error) {
      this.logger.error({ err: error }, 'OCR extraction failed');
      throw error;
    }
  }

  async extractRawText(buffer: Buffer): Promise<string> {
    if (!this.worker || !this.ready) {
      throw new Error('Tesseract worker not initialized');
    }

    const result = await this.worker.recognize(buffer);
    return result.data.text;
  }

  async destroy(): Promise<void> {
    if (this.worker) {
      try {
        await this.worker.terminate();
        this.logger.log('Tesseract worker terminated');
      } catch (error) {
        this.logger.warn({ err: error }, 'Error terminating Tesseract worker');
      } finally {
        this.worker = null;
        this.ready = false;
      }
    }
  }

  private buildGenericResult(
    rawText: string,
    confidence: number,
  ): OcrExtractionResult {
    return {
      fullName: null,
      nationalIdNumber: null,
      dateOfBirth: null,
      gender: null,
      address: null,
      documentNumber: null,
      expiryDate: null,
      overallConfidence: confidence,
      rawText,
      processingTimeMs: 0,
    };
  }

  private countExtractedFields(result: OcrExtractionResult): number {
    return [
      result.fullName,
      result.nationalIdNumber,
      result.dateOfBirth,
      result.gender,
      result.address,
      result.documentNumber,
      result.expiryDate,
    ].filter(Boolean).length;
  }
}
