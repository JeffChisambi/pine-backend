import type { ImageQualityResult } from '../domain/verification-result';

/**
 * Provider port for image processing operations. The Sharp
 * implementation handles all operations today; swap to a
 * different provider (e.g., cloud-based image processing)
 * by implementing this interface.
 */
export const IMAGE_PROCESSING_PROVIDER = Symbol('IMAGE_PROCESSING_PROVIDER');

export interface EnhanceImageOptions {
  /** Max dimension (width or height) in pixels */
  maxDimension?: number;
  /** Target JPEG quality (1-100) */
  quality?: number;
  /** Whether to auto-rotate based on EXIF */
  autoRotate?: boolean;
  /** Whether to normalize contrast/brightness */
  normalize?: boolean;
  /** Whether to apply noise reduction */
  denoise?: boolean;
  /** Whether to strip EXIF/GPS metadata */
  stripMetadata?: boolean;
}

export interface ThumbnailOptions {
  width: number;
  height: number;
  /** Fit mode: cover, contain, fill, inside, outside */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  sizeBytes: number;
  hasAlpha: boolean;
  orientation?: number;
}

export interface IImageProcessingProvider {
  readonly providerName: string;

  /**
   * Enhance an image for OCR and face recognition.
   * Returns the enhanced image buffer.
   */
  enhance(buffer: Buffer, options?: EnhanceImageOptions): Promise<Buffer>;

  /**
   * Generate a thumbnail for admin review UI.
   */
  generateThumbnail(buffer: Buffer, options: ThumbnailOptions): Promise<Buffer>;

  /**
   * Convert any image format to JPEG for standardized processing.
   */
  toJpeg(buffer: Buffer, quality?: number): Promise<Buffer>;

  /**
   * Extract image metadata without processing the full image.
   */
  getMetadata(buffer: Buffer): Promise<ImageMetadata>;

  /**
   * Analyze image quality (sharpness, brightness, resolution).
   */
  analyzeQuality(buffer: Buffer): Promise<ImageQualityResult>;
}
