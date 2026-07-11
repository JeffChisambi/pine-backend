import type { FaceDetectionResult } from '../domain/verification-result';

/**
 * Provider port for face recognition operations. InsightFace
 * (via ONNX Runtime) implements this today; a commercial
 * provider (AWS Rekognition, Azure Face) can be swapped in
 * by implementing this interface.
 */
export const FACE_RECOGNITION_PROVIDER = Symbol('FACE_RECOGNITION_PROVIDER');

export interface IFaceRecognitionProvider {
  readonly providerName: string;

  /**
   * Initialize the face recognition engine (load ONNX models).
   * Called once at module startup.
   */
  initialize(): Promise<void>;

  /**
   * Detect faces in an image and extract embeddings.
   *
   * @param buffer JPEG image buffer
   * @returns Detection result with embedding if a face was found
   */
  detectAndEmbed(buffer: Buffer): Promise<FaceDetectionResult>;

  /**
   * Returns true if models are loaded and ready.
   */
  isReady(): boolean;

  /**
   * Clean up resources.
   */
  destroy(): Promise<void>;
}
