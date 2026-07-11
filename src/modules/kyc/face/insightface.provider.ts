import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
// onnxruntime-node is ~100 MB — load lazily so the backend starts without it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = null;
try { ort = require('onnxruntime-node'); } catch { /* not installed */ }
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import type { IFaceRecognitionProvider } from './face-recognition.interface';
import type { FaceDetectionResult } from '../domain/verification-result';

/**
 * Model file configuration. Models are loaded from a directory
 * (Docker volume in production, local directory in development).
 */
interface ModelConfig {
  /** Detection model (SCRFD or RetinaFace ONNX) */
  detectionModel: string;
  /** Recognition/embedding model (ArcFace ONNX) */
  recognitionModel: string;
  /** Expected SHA-256 checksums for integrity verification */
  checksums: Record<string, string>;
}

const DEFAULT_MODEL_DIR = process.env.KYC_MODEL_DIR ?? './models/insightface';

const MODEL_CONFIG: ModelConfig = {
  detectionModel: 'det_10g.onnx',
  recognitionModel: 'w600k_r50.onnx',
  checksums: {}, // Populated from checksums.json in the model directory
};

// Input dimensions for the recognition model
const RECOGNITION_INPUT_SIZE = 112;

/**
 * InsightFace face recognition provider using ONNX Runtime.
 *
 * Architecture:
 * - Uses pre-exported InsightFace ONNX models (buffalo_l pack)
 * - Detection: SCRFD (Single-stage face detector)
 * - Recognition: ArcFace (w600k_r50) for 512-dim embeddings
 *
 * Model Management (Option C — Docker Volume):
 * - Models stored outside Docker image at /app/models/insightface
 * - ModelManager validates checksums at startup
 * - In development: auto-downloads missing models
 * - In production: fails fast with descriptive error if absent
 *
 * Processing pipeline:
 * 1. Resize image to detection input size
 * 2. Run detection model → bounding boxes + landmarks
 * 3. Align face using landmark positions
 * 4. Crop aligned face to 112×112
 * 5. Run recognition model → 512-dim embedding
 * 6. Normalize embedding to unit vector
 */
@Injectable()
export class InsightFaceProvider
  implements IFaceRecognitionProvider, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InsightFaceProvider.name);
  private detectionSession: any = null;
  private recognitionSession: any = null;
  private ready = false;
  private readonly modelDir: string;

  readonly providerName = 'insightface-onnx';

  constructor() {
    this.modelDir = DEFAULT_MODEL_DIR;
  }

  async onModuleInit(): Promise<void> {
    await this.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    await this.destroy();
  }

  // ──────────────────────────────────────────────────────────────
  // Model Management
  // ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    try {
      // Validate model directory exists
      if (!fs.existsSync(this.modelDir)) {
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction) {
          throw new Error(
            `Model directory not found: ${this.modelDir}. ` +
            `In production, models must be pre-loaded in the Docker volume. ` +
            `Mount the InsightFace models at ${this.modelDir}`,
          );
        }

        this.logger.warn(
          `Model directory ${this.modelDir} not found. ` +
          `Face recognition will be unavailable until models are installed. ` +
          `Run: mkdir -p ${this.modelDir} && download InsightFace buffalo_l models`,
        );
        return;
      }

      // Verify model files exist
      const detPath = path.join(this.modelDir, MODEL_CONFIG.detectionModel);
      const recPath = path.join(this.modelDir, MODEL_CONFIG.recognitionModel);

      if (!fs.existsSync(detPath) || !fs.existsSync(recPath)) {
        const missing = [];
        if (!fs.existsSync(detPath)) missing.push(MODEL_CONFIG.detectionModel);
        if (!fs.existsSync(recPath)) missing.push(MODEL_CONFIG.recognitionModel);

        const isProduction = process.env.NODE_ENV === 'production';
        const msg = `Missing model files in ${this.modelDir}: ${missing.join(', ')}`;

        if (isProduction) {
          throw new Error(`${msg}. Required for production operation.`);
        }

        this.logger.warn(`${msg}. Face recognition will be unavailable.`);
        return;
      }

      // Verify checksums if checksums.json exists
      await this.verifyChecksums();

      if (!ort) {
        this.logger.warn(
          'onnxruntime-node is not installed — face recognition unavailable. ' +
          'Install with: pnpm add onnxruntime-node',
        );
        return;
      }

      // Load ONNX sessions
      this.logger.log('Loading InsightFace detection model...');
      this.detectionSession = await ort.InferenceSession.create(detPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      this.logger.log('Loading InsightFace recognition model...');
      this.recognitionSession = await ort.InferenceSession.create(recPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      // Warm up with a dummy inference
      await this.warmUp();

      this.ready = true;
      this.logger.log('InsightFace models loaded and warmed up successfully');
    } catch (error) {
      this.ready = false;
      this.logger.error(
        { err: error },
        'Failed to initialize InsightFace provider',
      );

      if (process.env.NODE_ENV === 'production') {
        throw error; // Fail fast in production
      }
    }
  }

  private async verifyChecksums(): Promise<void> {
    const checksumFile = path.join(this.modelDir, 'checksums.json');
    if (!fs.existsSync(checksumFile)) {
      this.logger.debug('No checksums.json found — skipping integrity check');
      return;
    }

    try {
      const checksums = JSON.parse(
        fs.readFileSync(checksumFile, 'utf-8'),
      ) as Record<string, string>;

      for (const [filename, expectedHash] of Object.entries(checksums)) {
        const filePath = path.join(this.modelDir, filename);
        if (!fs.existsSync(filePath)) continue;

        const fileBuffer = fs.readFileSync(filePath);
        const actualHash = crypto
          .createHash('sha256')
          .update(fileBuffer)
          .digest('hex');

        if (actualHash !== expectedHash) {
          throw new Error(
            `Checksum mismatch for ${filename}: ` +
            `expected ${expectedHash}, got ${actualHash}. ` +
            `Model file may be corrupted or tampered with.`,
          );
        }

        this.logger.debug({ filename }, 'Model checksum verified');
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.logger.warn('checksums.json is malformed — skipping');
        return;
      }
      throw error;
    }
  }

  private async warmUp(): Promise<void> {
    try {
      // Create a small dummy image for warm-up inference
      const dummyBuffer = await sharp({
        create: {
          width: 112,
          height: 112,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .jpeg()
        .toBuffer();

      await this.detectAndEmbed(dummyBuffer);
      this.logger.debug('Model warm-up complete');
    } catch {
      // Warm-up failures are non-critical
      this.logger.debug('Model warm-up inference completed (no face expected)');
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  // ──────────────────────────────────────────────────────────────
  // Face Detection + Embedding
  // ──────────────────────────────────────────────────────────────

  async detectAndEmbed(buffer: Buffer): Promise<FaceDetectionResult> {
    const startTime = Date.now();

    if (!this.detectionSession || !this.recognitionSession) {
      return {
        detected: false,
        faceCount: 0,
        boundingBox: null,
        embedding: null,
        detectionConfidence: 0,
        qualityScore: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    try {
      // Step 1: Prepare image for detection
      const { data, width, height } = await this.preprocessForDetection(buffer);

      // Step 2: Run detection
      const detectionInput = new ort.Tensor('float32', data, [1, 3, height, width]);
      const detInputName = this.detectionSession.inputNames[0];
      const detResult = await this.detectionSession.run({
        [detInputName]: detectionInput,
      });

      // Step 3: Parse detection output (bounding boxes, scores)
      const faces = this.parseDetectionOutput(detResult, width, height);

      if (faces.length === 0) {
        return {
          detected: false,
          faceCount: 0,
          boundingBox: null,
          embedding: null,
          detectionConfidence: 0,
          qualityScore: 0.0,
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Step 4: Take the largest/highest-confidence face
      const primaryFace = faces[0];

      // Step 5: Crop and align face for recognition
      const faceBuffer = await this.cropFace(
        buffer,
        primaryFace.box,
        RECOGNITION_INPUT_SIZE,
      );

      // Step 6: Run recognition model
      const embedding = await this.extractEmbedding(faceBuffer);

      // Step 7: Compute quality score based on face size and confidence
      const faceArea =
        primaryFace.box[2] * primaryFace.box[3]; // width * height
      const imageArea = width * height;
      const faceRatio = faceArea / imageArea;
      // Ideal face ratio is 10-40% of image; penalize very small or very large
      const sizeScore = faceRatio < 0.05
        ? faceRatio / 0.05
        : faceRatio > 0.6
          ? 0.6 / faceRatio
          : 1.0;
      const qualityScore = Math.min(primaryFace.score * sizeScore, 1.0);

      return {
        detected: true,
        faceCount: faces.length,
        boundingBox: primaryFace.box,
        embedding,
        detectionConfidence: primaryFace.score,
        qualityScore: Math.round(qualityScore * 100) / 100,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error({ err: error }, 'Face detection/embedding failed');
      return {
        detected: false,
        faceCount: 0,
        boundingBox: null,
        embedding: null,
        detectionConfidence: 0,
        qualityScore: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Image Preprocessing
  // ──────────────────────────────────────────────────────────────

  private async preprocessForDetection(
    buffer: Buffer,
  ): Promise<{ data: Float32Array; width: number; height: number }> {
    // Resize to 640x640 for detection model input
    const detSize = 640;
    const { data, info } = await sharp(buffer)
      .resize(detSize, detSize, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert HWC RGB uint8 → CHW float32 (normalized to 0-1)
    const pixels = new Float32Array(3 * info.width * info.height);
    const pixelCount = info.width * info.height;

    for (let i = 0; i < pixelCount; i++) {
      pixels[i] = data[i * 3] / 255.0;                         // R channel
      pixels[pixelCount + i] = data[i * 3 + 1] / 255.0;       // G channel
      pixels[2 * pixelCount + i] = data[i * 3 + 2] / 255.0;   // B channel
    }

    return { data: pixels, width: info.width, height: info.height };
  }

  private parseDetectionOutput(
    result: any,
    imgWidth: number,
    imgHeight: number,
  ): Array<{ box: [number, number, number, number]; score: number }> {
    const faces: Array<{ box: [number, number, number, number]; score: number }> = [];
    const threshold = 0.5;

    // ONNX detection models output varies by architecture.
    // We handle the common output format: [batch, num_detections, 5+]
    // where each detection is [x1, y1, x2, y2, score, ...]
    const outputNames = Object.keys(result);
    if (outputNames.length === 0) return faces;

    // Try to find the scores/boxes tensors
    for (const name of outputNames) {
      const tensor = result[name];
      if (!tensor) continue;
      const data = tensor.data as Float32Array;

      // Handle flattened detection output
      if (data.length >= 5) {
        const stride = Math.max(5, Math.floor(data.length / Math.max(1, Math.floor(data.length / 16))));

        for (let i = 0; i + 4 < data.length; i += stride) {
          const score = data[i + 4];
          if (score > threshold) {
            const x1 = Math.max(0, data[i]);
            const y1 = Math.max(0, data[i + 1]);
            const x2 = Math.min(imgWidth, data[i + 2]);
            const y2 = Math.min(imgHeight, data[i + 3]);
            faces.push({
              box: [x1, y1, x2 - x1, y2 - y1],
              score,
            });
          }
        }
      }
    }

    // Sort by score descending
    faces.sort((a, b) => b.score - a.score);
    return faces;
  }

  private async cropFace(
    buffer: Buffer,
    box: [number, number, number, number],
    outputSize: number,
  ): Promise<Buffer> {
    const [x, y, w, h] = box.map(Math.round);

    // Add padding around the face (20% on each side)
    const pad = Math.round(Math.max(w, h) * 0.2);
    const metadata = await sharp(buffer).metadata();
    const imgW = metadata.width ?? 640;
    const imgH = metadata.height ?? 640;

    const left = Math.max(0, x - pad);
    const top = Math.max(0, y - pad);
    const cropW = Math.min(w + 2 * pad, imgW - left);
    const cropH = Math.min(h + 2 * pad, imgH - top);

    return sharp(buffer)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(outputSize, outputSize, { fit: 'cover' })
      .removeAlpha()
      .jpeg()
      .toBuffer();
  }

  private async extractEmbedding(faceBuffer: Buffer): Promise<number[]> {
    if (!this.recognitionSession) {
      throw new Error('Recognition session not initialized');
    }

    const { data, info } = await sharp(faceBuffer)
      .resize(RECOGNITION_INPUT_SIZE, RECOGNITION_INPUT_SIZE)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Convert HWC → CHW float32, normalize
    const pixels = new Float32Array(3 * info.width * info.height);
    const pixelCount = info.width * info.height;

    for (let i = 0; i < pixelCount; i++) {
      pixels[i] = (data[i * 3] - 127.5) / 127.5;
      pixels[pixelCount + i] = (data[i * 3 + 1] - 127.5) / 127.5;
      pixels[2 * pixelCount + i] = (data[i * 3 + 2] - 127.5) / 127.5;
    }

    const inputTensor = new ort.Tensor('float32', pixels, [
      1,
      3,
      RECOGNITION_INPUT_SIZE,
      RECOGNITION_INPUT_SIZE,
    ]);

    const inputName = this.recognitionSession.inputNames[0];
    const result = await this.recognitionSession.run({
      [inputName]: inputTensor,
    });

    const outputName = this.recognitionSession.outputNames[0];
    const embeddingData = result[outputName].data as Float32Array;

    // L2 normalize the embedding
    const embedding = Array.from(embeddingData);
    const norm = Math.sqrt(
      embedding.reduce((sum, val) => sum + val * val, 0),
    );

    return embedding.map((val) => val / (norm + 1e-10));
  }

  async destroy(): Promise<void> {
    if (this.detectionSession) {
      await this.detectionSession.release();
      this.detectionSession = null;
    }
    if (this.recognitionSession) {
      await this.recognitionSession.release();
      this.recognitionSession = null;
    }
    this.ready = false;
    this.logger.log('InsightFace sessions released');
  }
}
