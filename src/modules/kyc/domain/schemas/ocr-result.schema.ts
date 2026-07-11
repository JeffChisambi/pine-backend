import { z } from 'zod';

/**
 * Zod schemas for validating OCR extraction results before
 * they are stored in the database. Ensures field formats
 * are correct and confidence values are within bounds.
 */

export const OcrFieldResultSchema = z.object({
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  rawValue: z.string().optional(),
});

/**
 * Malawi National ID number format: two digits, a hyphen or space,
 * then more alphanumeric characters. Flexible to accommodate
 * OCR misreads (allows some variation).
 */
export const MalawiNationalIdSchema = z
  .string()
  .min(5)
  .max(30)
  .transform((val) => val.replace(/\s+/g, '').toUpperCase());

export const DateOfBirthSchema = z
  .string()
  .refine((val) => {
    // Accept multiple date formats from OCR
    const patterns = [
      /^\d{2}\/\d{2}\/\d{4}$/,     // DD/MM/YYYY
      /^\d{4}-\d{2}-\d{2}$/,       // YYYY-MM-DD
      /^\d{2}-\d{2}-\d{4}$/,       // DD-MM-YYYY
      /^\d{2}\.\d{2}\.\d{4}$/,     // DD.MM.YYYY
    ];
    return patterns.some((p) => p.test(val.trim()));
  }, 'Invalid date format')
  .transform((val) => val.trim());

export const GenderSchema = z
  .string()
  .transform((val) => val.trim().toUpperCase())
  .pipe(z.enum(['M', 'F', 'MALE', 'FEMALE']));

export const OcrExtractionResultSchema = z.object({
  fullName: OcrFieldResultSchema.nullable(),
  nationalIdNumber: OcrFieldResultSchema.nullable(),
  dateOfBirth: OcrFieldResultSchema.nullable(),
  gender: OcrFieldResultSchema.nullable(),
  address: OcrFieldResultSchema.nullable(),
  documentNumber: OcrFieldResultSchema.nullable(),
  expiryDate: OcrFieldResultSchema.nullable(),
  overallConfidence: z.number().min(0).max(1),
  rawText: z.string(),
  processingTimeMs: z.number().int().min(0),
});

export type ValidatedOcrResult = z.infer<typeof OcrExtractionResultSchema>;
