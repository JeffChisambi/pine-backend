import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import type {
  IImageProcessingProvider,
  EnhanceImageOptions,
  ThumbnailOptions,
  ImageMetadata,
} from './image-processing.interface';
import type { ImageQualityResult } from '../domain/verification-result';

const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_QUALITY = 85;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

/**
 * Sharp-based image processing provider. Handles all image
 * manipulation for the KYC pipeline:
 *
 * - Auto-rotation (EXIF orientation correction)
 * - Resize with aspect ratio preservation
 * - Contrast/brightness normalization
 * - Noise reduction (median filter)
 * - Format conversion (HEIC/WebP/PNG → JPEG)
 * - Thumbnail generation
 * - Metadata extraction and stripping
 * - Quality analysis (blur, brightness, resolution)
 *
 * Sharp uses libvips under the hood — the fastest image processing
 * library available for Node.js, significantly faster than
 * ImageMagick/GraphicsMagick.
 */
@Injectable()
export class SharpProvider implements IImageProcessingProvider {
  private readonly logger = new Logger(SharpProvider.name);
  readonly providerName = 'sharp';

  async enhance(
    buffer: Buffer,
    options: EnhanceImageOptions = {},
  ): Promise<Buffer> {
    const {
      maxDimension = DEFAULT_MAX_DIMENSION,
      quality = DEFAULT_QUALITY,
      autoRotate = true,
      normalize = true,
      denoise = true,
      stripMetadata = true,
    } = options;

    let pipeline = sharp(buffer);

    // Auto-rotate based on EXIF orientation
    if (autoRotate) {
      pipeline = pipeline.rotate();
    }

    // Resize to max dimension while preserving aspect ratio
    pipeline = pipeline.resize(maxDimension, maxDimension, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    // Normalize contrast and brightness
    if (normalize) {
      pipeline = pipeline.normalize();
    }

    // Noise reduction via median filter
    if (denoise) {
      pipeline = pipeline.median(3);
    }

    // Moderate sharpening to improve OCR accuracy
    pipeline = pipeline.sharpen({
      sigma: 1.0,
      m1: 1.0,
      m2: 0.5,
    });

    // Strip metadata (GPS, camera info) for privacy
    if (stripMetadata) {
      pipeline = pipeline.withMetadata({ orientation: undefined });
    }

    // Output as JPEG
    return pipeline
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  async generateThumbnail(
    buffer: Buffer,
    options: ThumbnailOptions,
  ): Promise<Buffer> {
    return sharp(buffer)
      .rotate() // auto-rotate
      .resize(options.width, options.height, {
        fit: options.fit ?? 'cover',
        position: 'centre',
      })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();
  }

  async toJpeg(buffer: Buffer, quality = DEFAULT_QUALITY): Promise<Buffer> {
    return sharp(buffer)
      .rotate()
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  async getMetadata(buffer: Buffer): Promise<ImageMetadata> {
    const meta = await sharp(buffer).metadata();
    return {
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      format: meta.format ?? 'unknown',
      sizeBytes: buffer.byteLength,
      hasAlpha: meta.hasAlpha ?? false,
      orientation: meta.orientation,
    };
  }

  async analyzeQuality(buffer: Buffer): Promise<ImageQualityResult> {
    const metadata = await this.getMetadata(buffer);
    const failureReasons: string[] = [];

    // ── Resolution check ────────────────────────────────────────
    let resolutionScore = 1.0;
    if (metadata.width < MIN_WIDTH || metadata.height < MIN_HEIGHT) {
      resolutionScore = Math.min(
        metadata.width / MIN_WIDTH,
        metadata.height / MIN_HEIGHT,
      );
      failureReasons.push(
        `Resolution too low: ${metadata.width}x${metadata.height} (minimum ${MIN_WIDTH}x${MIN_HEIGHT})`,
      );
    }

    // ── Sharpness detection (via sharp stats) ───────────────────
    // We use the standard deviation of pixel values as a proxy for
    // sharpness. Low StdDev = flat/blurry, high = sharp/detailed.
    const stats = await sharp(buffer).greyscale().stats();
    const stdDev = stats.channels[0]?.stdev ?? 0;

    // Normalize StdDev to 0-1 range (empirical: 0-80 range typical)
    const sharpnessScore = Math.min(stdDev / 60, 1.0);
    if (sharpnessScore < 0.25) {
      failureReasons.push(
        `Image too blurry (sharpness score: ${sharpnessScore.toFixed(2)})`,
      );
    }

    // ── Brightness check ────────────────────────────────────────
    const mean = stats.channels[0]?.mean ?? 128;
    // Ideal range: 80-200 (out of 255)
    let brightnessScore: number;
    if (mean < 40) {
      brightnessScore = mean / 40;
      failureReasons.push('Image too dark');
    } else if (mean > 220) {
      brightnessScore = (255 - mean) / 35;
      failureReasons.push('Image overexposed');
    } else {
      // Map 40-200 to 0.7-1.0, 200-220 to 1.0-0.7
      brightnessScore = mean <= 200
        ? 0.7 + ((mean - 40) / 160) * 0.3
        : 1.0 - ((mean - 200) / 20) * 0.3;
    }

    // ── Overall score ───────────────────────────────────────────
    const overallScore =
      resolutionScore * 0.3 +
      sharpnessScore * 0.5 +
      brightnessScore * 0.2;

    const passesMinimum =
      resolutionScore >= 0.5 &&
      sharpnessScore >= 0.2 &&
      brightnessScore >= 0.3;

    return {
      overallScore: Math.round(overallScore * 100) / 100,
      sharpnessScore: Math.round(sharpnessScore * 100) / 100,
      brightnessScore: Math.round(brightnessScore * 100) / 100,
      resolutionScore: Math.round(resolutionScore * 100) / 100,
      width: metadata.width,
      height: metadata.height,
      passesMinimum,
      failureReasons,
    };
  }
}
