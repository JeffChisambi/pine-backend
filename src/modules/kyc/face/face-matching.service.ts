import { Injectable, Logger } from '@nestjs/common';
import type { FaceMatchResult, FaceDetectionResult } from '../domain/verification-result';

/**
 * Face matching service. Compares face embeddings using cosine
 * similarity and applies configurable thresholds for match decisions.
 *
 * This is pure math — no I/O, no model inference. It receives
 * pre-computed embeddings from the face recognition provider.
 */
@Injectable()
export class FaceMatchingService {
  private readonly logger = new Logger(FaceMatchingService.name);

  /** Minimum cosine similarity for a positive match */
  private readonly matchThreshold = parseFloat(
    process.env.KYC_FACE_MATCH_THRESHOLD ?? '0.45',
  );

  /** High confidence threshold */
  private readonly highConfidenceThreshold = parseFloat(
    process.env.KYC_FACE_HIGH_CONFIDENCE ?? '0.60',
  );

  /**
   * Compare two face detection results (ID photo vs selfie).
   */
  compareFaces(
    idFace: FaceDetectionResult,
    selfieFace: FaceDetectionResult,
  ): FaceMatchResult {
    if (!idFace.embedding || !selfieFace.embedding) {
      return {
        similarity: 0,
        isMatch: false,
        confidence: 0,
        idFace,
        selfieFace,
      };
    }

    // Compute cosine similarity
    const similarity = this.cosineSimilarity(
      idFace.embedding,
      selfieFace.embedding,
    );

    const isMatch = similarity >= this.matchThreshold;

    // Confidence factors in both the similarity and the quality
    // of the input faces (poor quality faces → lower confidence
    // even with good similarity)
    const qualityFactor = Math.min(
      idFace.qualityScore,
      selfieFace.qualityScore,
    );

    // Blend similarity with quality: similarity is primary (80%),
    // quality is secondary (20%)
    const confidence = Math.min(
      similarity * 0.8 + qualityFactor * 0.2,
      1.0,
    );

    this.logger.log({
      similarity: Math.round(similarity * 1000) / 1000,
      isMatch,
      confidence: Math.round(confidence * 1000) / 1000,
      idQuality: idFace.qualityScore,
      selfieQuality: selfieFace.qualityScore,
      threshold: this.matchThreshold,
    }, `Face match: similarity=${similarity.toFixed(3)}, match=${isMatch}`);

    return {
      similarity: Math.round(similarity * 10000) / 10000,
      isMatch,
      confidence: Math.round(confidence * 10000) / 10000,
      idFace,
      selfieFace,
    };
  }

  /**
   * Compare a face embedding against a set of existing embeddings
   * for duplicate detection. Returns the highest similarity match.
   */
  findDuplicates(
    embedding: number[],
    existingEmbeddings: Array<{ id: string; userId: string; embedding: number[] }>,
    threshold?: number,
  ): Array<{ id: string; userId: string; similarity: number }> {
    const dupThreshold = threshold ?? this.matchThreshold;
    const matches: Array<{ id: string; userId: string; similarity: number }> = [];

    for (const existing of existingEmbeddings) {
      const similarity = this.cosineSimilarity(embedding, existing.embedding);
      if (similarity >= dupThreshold) {
        matches.push({
          id: existing.id,
          userId: existing.userId,
          similarity: Math.round(similarity * 10000) / 10000,
        });
      }
    }

    // Sort by similarity descending
    matches.sort((a, b) => b.similarity - a.similarity);
    return matches;
  }

  /**
   * Cosine similarity between two unit vectors.
   * Since InsightFace embeddings are L2-normalized, cosine
   * similarity equals the dot product.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(
        `Embedding dimension mismatch: ${a.length} vs ${b.length}`,
      );
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    // Clamp to [0, 1] range (cosine similarity can be negative
    // but face embeddings should always be positive-correlated)
    return Math.max(0, Math.min(dotProduct / denominator, 1));
  }
}
