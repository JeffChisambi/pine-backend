import { z } from 'zod';

/**
 * Zod schemas for face match validation. Ensures embedding
 * dimensions are correct and similarity scores are in range.
 */

export const FaceEmbeddingSchema = z
  .array(z.number())
  .length(512, 'Face embedding must be exactly 512 dimensions');

export const FaceDetectionResultSchema = z.object({
  detected: z.boolean(),
  faceCount: z.number().int().min(0),
  boundingBox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .nullable(),
  embedding: FaceEmbeddingSchema.nullable(),
  detectionConfidence: z.number().min(0).max(1),
  qualityScore: z.number().min(0).max(1),
  processingTimeMs: z.number().int().min(0),
});

export const FaceMatchResultSchema = z.object({
  similarity: z.number().min(0).max(1),
  isMatch: z.boolean(),
  confidence: z.number().min(0).max(1),
  idFace: FaceDetectionResultSchema,
  selfieFace: FaceDetectionResultSchema,
});

export type ValidatedFaceMatch = z.infer<typeof FaceMatchResultSchema>;
