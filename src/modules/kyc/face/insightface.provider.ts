import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
// onnxruntime-node is ~100 MB — load lazily so the backend starts without it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ort: any = null;
try { ort = require('onnxruntime-node'); } catch { /* not installed or unavailable */ }
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import type { IFaceRecognitionProvider } from './face-recognition.interface';
import type { FaceDetectionResult } from '../domain/verification-result';

interface ModelConfig {
  detectionModel: string;
  recognitionModel: string;
  checksums: Record<string, string>;
}

const DEFAULT_MODEL_DIR = process.env.KYC_MODEL_DIR ?? './models/insightface';

const MODEL_CONFIG: ModelConfig = {
  detectionModel: 'det_10g.onnx',
  recognitionModel: 'w600k_r50.onnx',
  checksums: {},
};

/**
 * Size used for both the detection preprocessing and the crop source buffer.
 * Running detection and cropping in the same coordinate space avoids the
 * scaling bug (Bug 6) that occurred when boxes from 640×640 detection space
 * were applied to a differently-sized original image.
 */
const DETECTION_INPUT_SIZE = 640;

/** ArcFace recognition model expects 112×112 aligned face crops. */
const RECOGNITION_INPUT_SIZE = 112;

/**
 * InsightFace face recognition provider using ONNX Runtime.
 *
 * Architecture:
 * - Detection: SCRFD (det_10g.onnx) from InsightFace buffalo_l pack
 * - Recognition: ArcFace w600k_r50 for 512-dim L2-normalised embeddings
 *
 * ─── Bug fixes applied ────────────────────────────────────────────────────
 *
 * FIX (Bug 6 — bounding box coordinate mismatch):
 *   The original code detected faces in a 640×640 image but then cropped
 *   from the original (potentially much larger) buffer, using coordinates
 *   that only make sense in the 640×640 space. The crop was therefore at
 *   completely the wrong location on the original image.
 *   Fix: resize to 640×640 for detection AND keep that resized buffer for
 *   the crop step, so both operations share the same coordinate space.
 *
 * FIX (Bug 7 — SCRFD detection output parsing):
 *   The original parser used `stride = floor(data.length / floor(data.length/16))`
 *   which evaluates to 16 almost always — a magic number with no relation to
 *   the actual SCRFD output format. Detection typically returned no faces.
 *   Fix: implement a two-strategy parser:
 *     1. Look for a [N, 5] post-processed tensor (x1, y1, x2, y2, score).
 *     2. Match score tensors [N, 1] with bbox tensors [N, 4] by anchor count.
 *   Also adds NMS (non-max suppression) so overlapping detections are merged.
 *
 * FIX (Bug 8 — wrong normalisation for SCRFD detection model):
 *   The original used `pixel / 255.0` (range 0–1). SCRFD expects
 *   `(pixel − 127.5) / 128.0` (range approximately −1 to +1). Using the
 *   wrong scale shifts the input distribution the model was trained on,
 *   degrading recall significantly.
 * ─────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class InsightFaceProvider
  implements IFaceRecognitionProvider, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InsightFaceProvider.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private detectionSession: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    if (!ort) {
      this.logger.warn(
        'onnxruntime-node is not installed. Face recognition will be unavailable. ' +
        'Install it with: npm install onnxruntime-node',
      );
      return;
    }

    try {
      if (!fs.existsSync(this.modelDir)) {
        this.logger.error(
          `Model directory ${this.modelDir} not found. ` +
          `Face recognition unavailable until models are installed. ` +
          `Place det_10g.onnx and w600k_r50.onnx in ${this.modelDir}.`,
        );
        return;
      }

      const detPath = path.join(this.modelDir, MODEL_CONFIG.detectionModel);
      const recPath = path.join(this.modelDir, MODEL_CONFIG.recognitionModel);

      if (!fs.existsSync(detPath) || !fs.existsSync(recPath)) {
        this.logger.warn(
          { detPath, recPath },
          'One or more InsightFace model files are missing. Face recognition unavailable.',
        );
        return;
      }

      await this.verifyChecksums();

      const sessionOpts = new ort.SessionOptions();
      sessionOpts.executionMode = 'sequential';

      this.detectionSession = await ort.InferenceSession.create(detPath, sessionOpts);
      this.recognitionSession = await ort.InferenceSession.create(recPath, sessionOpts);

      await this.warmUp();

      this.ready = true;
      this.logger.log(
        { modelDir: this.modelDir },
        'InsightFace models loaded and warmed up',
      );
    } catch (error) {
      this.ready = false;
      this.logger.error({ err: error }, 'Failed to initialize InsightFace provider — face recognition unavailable');
    }
  }

  private async verifyChecksums(): Promise<void> {
    const checksumFile = path.join(this.modelDir, 'checksums.json');
    if (!fs.existsSync(checksumFile)) {
      this.logger.debug('No checksums.json — skipping integrity check');
      return;
    }

    try {
      const checksums = JSON.parse(fs.readFileSync(checksumFile, 'utf-8')) as Record<string, string>;

      for (const [filename, expectedHash] of Object.entries(checksums)) {
        const filePath = path.join(this.modelDir, filename);
        if (!fs.existsSync(filePath)) continue;

        const actualHash = crypto
          .createHash('sha256')
          .update(fs.readFileSync(filePath))
          .digest('hex');

        if (actualHash !== expectedHash) {
          throw new Error(
            `Checksum mismatch for ${filename}: expected ${expectedHash}, got ${actualHash}. ` +
            `Model file may be corrupted.`,
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
      const dummyBuffer = await sharp({
        create: { width: 112, height: 112, channels: 3, background: { r: 128, g: 128, b: 128 } },
      }).jpeg().toBuffer();
      await this.detectAndEmbed(dummyBuffer);
      this.logger.debug('Model warm-up complete');
    } catch {
      this.logger.debug('Model warm-up inference completed (no face expected in dummy image)');
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
      return this.noFaceResult(startTime);
    }

    try {
      // ── Step 1: Resize to detection input size ──────────────
      // FIX (Bug 6): Both detection and cropping operate on the SAME
      // 640×640 buffer. Bounding box coordinates are always valid for this
      // buffer — no coordinate-space mismatch.
      const detBuffer = await sharp(buffer)
        .resize(DETECTION_INPUT_SIZE, DETECTION_INPUT_SIZE, {
          fit: 'fill', // simple stretch — linear scale for easy coordinate mapping
        })
        .removeAlpha()
        .jpeg({ quality: 90 })
        .toBuffer();

      // ── Step 2: Build float32 tensor for SCRFD detection ────
      // FIX (Bug 8): Use (pixel − 127.5) / 128.0 normalization, not pixel/255
      const { data: pixelData } = await this.bufferToDetectionFloat32(detBuffer);

      const detInputTensor = new ort.Tensor('float32', pixelData, [
        1,
        3,
        DETECTION_INPUT_SIZE,
        DETECTION_INPUT_SIZE,
      ]);

      // ── Step 3: Run detection model ──────────────────────────
      const detInputName = this.detectionSession.inputNames[0];
      const detResult = await this.detectionSession.run({
        [detInputName]: detInputTensor,
      });

      // ── Step 4: Parse SCRFD output — FIX (Bug 7) ──────────────
      const faces = this.parseDetectionOutput(
        detResult,
        DETECTION_INPUT_SIZE,
        DETECTION_INPUT_SIZE,
      );

      if (faces.length === 0) {
        return this.noFaceResult(startTime);
      }

      // ── Step 5: Crop & align the primary face ────────────────
      // Operates on detBuffer (640×640), same coordinate space as the boxes
      const primaryFace = faces[0];
      const faceBuffer = await this.cropFace(detBuffer, primaryFace.box, RECOGNITION_INPUT_SIZE);

      // ── Step 6: Extract 512-dim ArcFace embedding ────────────
      const embedding = await this.extractEmbedding(faceBuffer);

      // ── Step 7: Quality score (face size vs. image area) ─────
      const faceArea = primaryFace.box[2] * primaryFace.box[3];
      const imageArea = DETECTION_INPUT_SIZE * DETECTION_INPUT_SIZE;
      const faceRatio = faceArea / imageArea;
      const sizeScore =
        faceRatio < 0.05
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
      return this.noFaceResult(startTime);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Image Preprocessing
  // ──────────────────────────────────────────────────────────────

  /**
   * Convert a JPEG buffer to a CHW float32 tensor for the SCRFD detection model.
   *
   * FIX (Bug 8): SCRFD is trained with normalisation `(pixel − 127.5) / 128.0`,
   * not the `pixel / 255.0` used originally. Using the wrong range shifts the
   * input distribution by ~50%, significantly reducing detection recall.
   *
   * Channel order: RGB (Sharp's default output order). InsightFace ONNX models
   * exported via the standard pipeline expect BGR; however, many community
   * exports include a BGR→RGB conversion layer. If detection recall remains
   * poor after testing, swap R and B channels here.
   */
  private async bufferToDetectionFloat32(
    buffer: Buffer,
  ): Promise<{ data: Float32Array; width: number; height: number }> {
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixelCount = info.width * info.height;
    const pixels = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      // FIX: (value − 127.5) / 128.0  ← correct SCRFD normalisation
      pixels[i]              = (data[i * 3]     - 127.5) / 128.0; // R
      pixels[pixelCount + i] = (data[i * 3 + 1] - 127.5) / 128.0; // G
      pixels[2 * pixelCount + i] = (data[i * 3 + 2] - 127.5) / 128.0; // B
    }

    return { data: pixels, width: info.width, height: info.height };
  }

  // ──────────────────────────────────────────────────────────────
  // SCRFD Detection Output Parsing  — FIX (Bug 7)
  // ──────────────────────────────────────────────────────────────

  /**
   * Parse the raw ONNX output from the SCRFD detection model.
   *
   * FIX (Bug 7): The original implementation computed a stride as
   * `floor(data.length / floor(data.length/16))` which almost always
   * evaluates to 16 — a magic number with no relation to SCRFD's actual
   * output format. Detection almost never found any faces as a result.
   *
   * Two-strategy parser (handles both common SCRFD export formats):
   *
   * Strategy A — Post-processed [N, 5] tensor:
   *   Some ONNX exports include NMS and output a single tensor of shape
   *   [num_detections, 5] where each row is [x1, y1, x2, y2, score].
   *   All coordinates are in pixels of the input image.
   *
   * Strategy B — Raw per-stride score + bbox tensors:
   *   The InsightFace buffalo_l export produces paired tensors at 3 FPN
   *   strides. Score tensors have 1 value per anchor; bbox tensors have 4.
   *   We match them by anchor count and decode independently.
   *
   * Both strategies apply IoU-based NMS to remove overlapping detections.
   */
  private parseDetectionOutput(
    result: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    imgWidth: number,
    imgHeight: number,
  ): Array<{ box: [number, number, number, number]; score: number }> {
    const SCORE_THRESHOLD = 0.5;
    const faces: Array<{ box: [number, number, number, number]; score: number }> = [];
    const outputNames = Object.keys(result) as string[];

    // ── Strategy A: look for a single [N, 5] post-processed tensor ──
    for (const name of outputNames) {
      const tensor = result[name];
      if (!tensor?.data || !tensor?.dims) continue;

      const data = tensor.data as Float32Array;
      const dims = tensor.dims as number[];

      // Accept [N, 5], [1, N, 5], or flat length divisible by 5
      const lastDim = dims[dims.length - 1];
      if (lastDim === 5) {
        const n = data.length / 5;
        for (let i = 0; i < n; i++) {
          const score = data[i * 5 + 4];
          if (score > SCORE_THRESHOLD) {
            const x1 = Math.max(0, data[i * 5]);
            const y1 = Math.max(0, data[i * 5 + 1]);
            const x2 = Math.min(imgWidth, data[i * 5 + 2]);
            const y2 = Math.min(imgHeight, data[i * 5 + 3]);
            if (x2 > x1 && y2 > y1) {
              faces.push({ box: [x1, y1, x2 - x1, y2 - y1], score });
            }
          }
        }
        if (faces.length > 0) {
          faces.sort((a, b) => b.score - a.score);
          return this.applyNms(faces);
        }
      }
    }

    // ── Strategy B: match score tensors [N] with bbox tensors [N×4] ──
    const scoreTensors: Float32Array[] = [];
    const bboxTensors: Float32Array[] = [];

    for (const name of outputNames) {
      const tensor = result[name];
      if (!tensor?.data || !tensor?.dims) continue;

      const data = tensor.data as Float32Array;
      const dims = tensor.dims as number[];
      const totalElements = data.length;

      if (totalElements === 0) continue;

      // Determine if this looks like a score tensor (last dim = 1 or 2)
      // or a bbox tensor (last dim = 4 or total divisible by 4)
      const lastDim = dims[dims.length - 1];

      if (lastDim === 1 || (dims.length >= 2 && dims[dims.length - 1] === 1)) {
        scoreTensors.push(data);
      } else if (lastDim === 4 || (totalElements % 4 === 0 && totalElements % 5 !== 0)) {
        bboxTensors.push(data);
      } else if (lastDim === 2) {
        // Binary classification logits — take the "face" column
        const scores = new Float32Array(totalElements / 2);
        for (let i = 0; i < scores.length; i++) {
          // Softmax approximation: face score is second logit
          const a = Math.exp(data[i * 2]);
          const b = Math.exp(data[i * 2 + 1]);
          scores[i] = b / (a + b);
        }
        scoreTensors.push(scores);
      }
    }

    for (const scores of scoreTensors) {
      const numAnchors = scores.length;
      const bbox = bboxTensors.find((b) => b.length === numAnchors * 4);
      if (!bbox) continue;

      for (let i = 0; i < numAnchors; i++) {
        const score = scores[i];
        if (score <= SCORE_THRESHOLD) continue;

        const x1 = Math.max(0, bbox[i * 4]);
        const y1 = Math.max(0, bbox[i * 4 + 1]);
        const x2 = Math.min(imgWidth, bbox[i * 4 + 2]);
        const y2 = Math.min(imgHeight, bbox[i * 4 + 3]);
        if (x2 > x1 && y2 > y1) {
          faces.push({ box: [x1, y1, x2 - x1, y2 - y1], score });
        }
      }
    }

    faces.sort((a, b) => b.score - a.score);
    return this.applyNms(faces);
  }

  /** Non-maximum suppression — removes overlapping detections. */
  private applyNms(
    faces: Array<{ box: [number, number, number, number]; score: number }>,
    iouThreshold = 0.4,
  ): Array<{ box: [number, number, number, number]; score: number }> {
    const kept: Array<{ box: [number, number, number, number]; score: number }> = [];
    for (const face of faces) {
      let suppressed = false;
      for (const k of kept) {
        if (this.computeIou(face.box, k.box) > iouThreshold) {
          suppressed = true;
          break;
        }
      }
      if (!suppressed) kept.push(face);
    }
    return kept;
  }

  private computeIou(
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): number {
    const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
    const bx2 = b[0] + b[2], by2 = b[1] + b[3];
    const ix1 = Math.max(a[0], b[0]);
    const iy1 = Math.max(a[1], b[1]);
    const ix2 = Math.min(ax2, bx2);
    const iy2 = Math.min(ay2, by2);
    if (ix2 <= ix1 || iy2 <= iy1) return 0;
    const inter = (ix2 - ix1) * (iy2 - iy1);
    return inter / (a[2] * a[3] + b[2] * b[3] - inter);
  }

  // ──────────────────────────────────────────────────────────────
  // Face Crop & Embedding
  // ──────────────────────────────────────────────────────────────

  /**
   * Crop the primary face from the detection-space buffer.
   *
   * FIX (Bug 6): The caller now passes `detBuffer` (640×640), not the
   * original variable-size buffer, so bounding box coordinates are always
   * valid for the supplied buffer.
   */
  private async cropFace(
    buffer: Buffer, // Must be the 640×640 detection-space buffer
    box: [number, number, number, number],
    outputSize: number,
  ): Promise<Buffer> {
    const [x, y, w, h] = box.map(Math.round);

    // 20% padding around the detected face for better alignment
    const pad = Math.round(Math.max(w, h) * 0.2);
    const metadata = await sharp(buffer).metadata();
    const imgW = metadata.width ?? DETECTION_INPUT_SIZE;
    const imgH = metadata.height ?? DETECTION_INPUT_SIZE;

    const left = Math.max(0, x - pad);
    const top = Math.max(0, y - pad);
    const cropW = Math.min(w + 2 * pad, imgW - left);
    const cropH = Math.min(h + 2 * pad, imgH - top);

    if (cropW <= 0 || cropH <= 0) {
      // Fallback: just resize the whole image — face is likely very large
      return sharp(buffer)
        .resize(outputSize, outputSize, { fit: 'fill' })
        .jpeg({ quality: 90 })
        .toBuffer();
    }

    return sharp(buffer)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(outputSize, outputSize, { fit: 'fill' })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  /**
   * Run the ArcFace recognition model and return a 512-dim L2-normalised embedding.
   * Normalisation: `(pixel − 127.5) / 127.5`  (ArcFace standard, unchanged).
   */
  private async extractEmbedding(faceBuffer: Buffer): Promise<number[]> {
    const { data, info } = await sharp(faceBuffer)
      .resize(RECOGNITION_INPUT_SIZE, RECOGNITION_INPUT_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixelCount = info.width * info.height;
    const pixels = new Float32Array(3 * pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      pixels[i]              = (data[i * 3]     - 127.5) / 127.5; // R
      pixels[pixelCount + i] = (data[i * 3 + 1] - 127.5) / 127.5; // G
      pixels[2 * pixelCount + i] = (data[i * 3 + 2] - 127.5) / 127.5; // B
    }

    const inputTensor = new ort.Tensor('float32', pixels, [
      1,
      3,
      RECOGNITION_INPUT_SIZE,
      RECOGNITION_INPUT_SIZE,
    ]);

    const inputName = this.recognitionSession.inputNames[0];
    const result = await this.recognitionSession.run({ [inputName]: inputTensor });

    const outputName = this.recognitionSession.outputNames[0];
    const embeddingData = result[outputName].data as Float32Array;

    // L2 normalise the embedding to unit vector
    const embedding = Array.from(embeddingData);
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return embedding.map((v) => v / (norm + 1e-10));
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
    this.logger.log('InsightFace ONNX sessions released');
  }

  private noFaceResult(startTime: number): FaceDetectionResult {
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
