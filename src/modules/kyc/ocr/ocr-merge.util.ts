import type { OcrExtractionResult, OcrFieldResult } from '../domain/verification-result';
import type { MrzResult } from './mrz.parser';

/**
 * Merge the front-of-card free-text OCR extraction with the back-of-card MRZ
 * extraction into a single best-of result.
 *
 * Precedence: an MRZ field whose ICAO check digit validates is essentially
 * ground truth (confidence 0.99) and always wins. An MRZ field whose check
 * digit fails is still better than nothing (0.4) but loses to a confident
 * front-side extraction. Names have no check digit — the fixed OCR-B font
 * makes them reliable (0.9), but a high-confidence labeled front extraction
 * (≥0.9) can hold its ground.
 */
export function mergeOcrWithMrz(
  front: OcrExtractionResult,
  mrz: MrzResult,
): OcrExtractionResult {
  if (!mrz.found) return front;

  const mrzField = (
    f: { value: string; checkDigitValid: boolean } | null,
  ): OcrFieldResult | null =>
    f
      ? {
          value: f.value,
          confidence: f.checkDigitValid ? 0.99 : 0.4,
          rawValue: f.value,
        }
      : null;

  const pick = (
    a: OcrFieldResult | null,
    b: OcrFieldResult | null,
  ): OcrFieldResult | null => {
    if (!a) return b;
    if (!b) return a;
    return b.confidence >= a.confidence ? b : a;
  };

  // Full name from MRZ line 3
  const mrzName: OcrFieldResult | null =
    mrz.surname || mrz.givenNames
      ? {
          value: [mrz.givenNames, mrz.surname].filter(Boolean).join(' '),
          confidence: 0.9,
          rawValue: `${mrz.surname ?? ''}<<${mrz.givenNames ?? ''}`,
        }
      : null;

  // On the Malawi NRC the line-1 optional field carries the NRC number
  // (8 alphanumerics). The MRZ document number is the card serial.
  const mrzNrc: OcrFieldResult | null = mrz.optionalData1
    ? { value: mrz.optionalData1, confidence: 0.85, rawValue: mrz.optionalData1 }
    : null;

  const gender: OcrFieldResult | null = mrz.sex
    ? { value: mrz.sex, confidence: 0.95, rawValue: mrz.sex }
    : null;

  const nationality: OcrFieldResult | null = mrz.nationality
    ? { value: mrz.nationality, confidence: 0.95, rawValue: mrz.nationality }
    : null;

  const merged: OcrExtractionResult = {
    fullName: pick(front.fullName, mrzName),
    nationalIdNumber: pick(front.nationalIdNumber, mrzNrc),
    dateOfBirth: pick(front.dateOfBirth, mrzField(mrz.birthDate)),
    gender: pick(front.gender, gender),
    address: front.address,
    documentNumber: pick(front.documentNumber, mrzField(mrz.documentNumber)),
    expiryDate: pick(front.expiryDate, mrzField(mrz.expiryDate)),
    nationality: pick(front.nationality ?? null, nationality),
    mrz: {
      found: true,
      checkDigitScore: mrz.checkDigitScore,
      rawLines: mrz.rawLines,
    },
    overallConfidence: 0, // recomputed below
    rawText: front.rawText,
    processingTimeMs: front.processingTimeMs,
  };

  // Recompute the overall confidence from the merged per-field confidences,
  // weighting identity-critical fields. The MRZ check-digit score acts as a
  // floor: a fully-validated MRZ alone justifies ≥0.9.
  const fields = [
    merged.fullName,
    merged.nationalIdNumber,
    merged.dateOfBirth,
    merged.gender,
    merged.documentNumber,
    merged.expiryDate,
  ].filter((f): f is OcrFieldResult => f !== null && f.confidence > 0);

  const avg =
    fields.length > 0
      ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length
      : 0;

  const mrzFloor = mrz.checkDigitScore * 0.92;
  merged.overallConfidence = Math.round(Math.max(avg, mrzFloor) * 100) / 100;

  return merged;
}
