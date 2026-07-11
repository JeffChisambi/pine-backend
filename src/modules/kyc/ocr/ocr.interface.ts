import type { OcrExtractionResult } from '../domain/verification-result';

/**
 * Provider port for OCR operations. Tesseract.js implements this
 * today; a PaddleOCR provider (via Python subprocess) or a
 * commercial OCR service can be swapped in by implementing
 * this interface.
 */
export const OCR_PROVIDER = Symbol('OCR_PROVIDER');

export interface OcrOptions {
  /** Language hint for the OCR engine */
  language?: string;
  /** Expected document type for parser selection */
  documentType?: 'national_id' | 'passport' | 'drivers_license';
  /** Whether to apply image preprocessing before OCR */
  preprocess?: boolean;
}

export interface IOcrProvider {
  readonly providerName: string;

  /**
   * Initialize the OCR engine (load models, warm up).
   * Called once at module startup.
   */
  initialize(): Promise<void>;

  /**
   * Extract text and structured fields from a document image.
   *
   * @param buffer Enhanced image buffer (JPEG)
   * @param options OCR configuration
   * @returns Structured extraction result with per-field confidence
   */
  extractFields(
    buffer: Buffer,
    options?: OcrOptions,
  ): Promise<OcrExtractionResult>;

  /**
   * Extract raw text from an image (no field parsing).
   * Useful for debugging and manual review.
   */
  extractRawText(buffer: Buffer): Promise<string>;

  /**
   * Returns true if the engine is initialized and ready.
   */
  isReady(): boolean;

  /**
   * Clean up resources (terminate workers).
   */
  destroy(): Promise<void>;
}
