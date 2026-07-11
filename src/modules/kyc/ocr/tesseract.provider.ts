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
 * - Maintains a persistent worker pool (1 worker by default, configurable)
 * - Workers are initialized with English language data at module startup
 * - Each recognition call reuses the warm worker (no cold start per image)
 * - Workers are terminated cleanly at module shutdown
 *
 * The raw OCR text is post-processed by document-specific parsers
 * (MalawiIdParser, PassportParser, etc.) that extract structured fields
 * using regex and positional heuristics.
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

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.destroy();
  }

  async initialize(): Promise<void> {
    try {
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: (info) => {
          if (info.status === 'recognizing text') {
            // Suppress noisy progress logs
            return;
          }
          this.logger.debug({ status: info.status }, 'Tesseract worker status');
        },
      });

      // Configure for best accuracy (slower but more reliable for IDs)
      await this.worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
      });

      this.ready = true;
      this.logger.log('Tesseract OCR worker initialized');
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
      // Run recognition
      const result = await this.worker.recognize(buffer);
      const rawText = result.data.text;
      const confidence = result.data.confidence / 100; // Normalize to 0-1

      // Parse structured fields based on document type
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

      this.logger.log({
        documentType,
        confidence: extraction.overallConfidence,
        processingTimeMs: extraction.processingTimeMs,
        fieldsExtracted: this.countExtractedFields(extraction),
      }, 'OCR extraction complete');

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
    let count = 0;
    if (result.fullName) count++;
    if (result.nationalIdNumber) count++;
    if (result.dateOfBirth) count++;
    if (result.gender) count++;
    if (result.address) count++;
    if (result.documentNumber) count++;
    if (result.expiryDate) count++;
    return count;
  }
}
