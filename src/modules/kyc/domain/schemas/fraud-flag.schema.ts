import { z } from 'zod';
import { KycFraudFlagType, KycFraudSeverity } from '../kyc-stage.enum';

/**
 * Zod schemas for fraud flag validation and persistence.
 */

export const FraudFlagSchema = z.object({
  type: z.nativeEnum(KycFraudFlagType),
  severity: z.nativeEnum(KycFraudSeverity),
  description: z.string().min(1).max(500),
  evidence: z.record(z.unknown()).optional(),
});

export const FraudDetectionResultSchema = z.object({
  flags: z.array(FraudFlagSchema),
  /** Number of critical-severity flags */
  criticalCount: z.number().int().min(0),
  /** Number of high-severity flags */
  highCount: z.number().int().min(0),
  /** Overall fraud risk score (0.0 = clean, 1.0 = definite fraud) */
  riskScore: z.number().min(0).max(1),
  /** Whether any flag blocks auto-approval */
  blocksApproval: z.boolean(),
  processingTimeMs: z.number().int().min(0),
});

export type ValidatedFraudFlag = z.infer<typeof FraudFlagSchema>;
export type ValidatedFraudResult = z.infer<typeof FraudDetectionResultSchema>;
