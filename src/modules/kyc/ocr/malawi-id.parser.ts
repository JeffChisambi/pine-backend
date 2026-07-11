import { Logger } from '@nestjs/common';
import type { OcrExtractionResult, OcrFieldResult } from '../domain/verification-result';

/**
 * Malawi National ID document parser. Extracts structured fields
 * from raw OCR text using regex patterns and positional heuristics
 * specific to the Malawi national ID card layout.
 *
 * The Malawi national ID card typically contains:
 * - Full name (SURNAME, GIVEN NAMES)
 * - National ID number
 * - Date of birth
 * - Gender (M/F)
 * - District/place of origin
 * - Expiry date
 *
 * OCR quality varies significantly depending on card condition,
 * photo quality, and lighting — each field extraction is wrapped
 * in try/catch with confidence scoring.
 */
export class MalawiIdParser {
  private readonly logger = new Logger(MalawiIdParser.name);

  parse(rawText: string, overallOcrConfidence: number): OcrExtractionResult {
    const lines = rawText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const fullName = this.extractFullName(lines, rawText);
    const nationalIdNumber = this.extractNationalId(lines, rawText);
    const dateOfBirth = this.extractDateOfBirth(lines, rawText);
    const gender = this.extractGender(lines, rawText);
    const address = this.extractAddress(lines, rawText);
    const expiryDate = this.extractExpiryDate(lines, rawText);

    // Compute field-level confidence as the average of extracted fields
    const fieldConfidences = [
      fullName?.confidence ?? 0,
      nationalIdNumber?.confidence ?? 0,
      dateOfBirth?.confidence ?? 0,
      gender?.confidence ?? 0,
    ].filter((c) => c > 0);

    const avgFieldConfidence = fieldConfidences.length > 0
      ? fieldConfidences.reduce((a, b) => a + b, 0) / fieldConfidences.length
      : 0;

    // Blend OCR engine confidence with field extraction confidence
    const blendedConfidence = overallOcrConfidence * 0.4 + avgFieldConfidence * 0.6;

    return {
      fullName,
      nationalIdNumber,
      dateOfBirth,
      gender,
      address,
      documentNumber: nationalIdNumber, // For Malawi IDs, these are the same
      expiryDate,
      overallConfidence: Math.round(blendedConfidence * 100) / 100,
      rawText,
      processingTimeMs: 0, // Set by caller
    };
  }

  private extractFullName(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Look for "Name" or "Surname" labels
      const namePatterns = [
        /(?:name|surname|full\s*name)\s*[:;]?\s*(.+)/i,
        /(?:given\s*names?)\s*[:;]?\s*(.+)/i,
      ];

      let surname = '';
      let givenNames = '';

      for (const line of lines) {
        for (const pattern of namePatterns) {
          const match = pattern.exec(line);
          if (match) {
            const value = match[1].trim();
            if (/surname/i.test(line)) {
              surname = value;
            } else {
              givenNames = value;
            }
          }
        }
      }

      // If we found labeled names, combine them
      if (surname || givenNames) {
        const fullName = [surname, givenNames].filter(Boolean).join(' ').trim();
        if (fullName.length >= 2) {
          return {
            value: this.cleanName(fullName),
            confidence: 0.7,
            rawValue: fullName,
          };
        }
      }

      // Fallback: look for lines that look like names (all caps, 2+ words)
      for (const line of lines) {
        const cleaned = line.replace(/[^A-Za-z\s]/g, '').trim();
        if (
          cleaned.length > 3 &&
          cleaned.split(/\s+/).length >= 2 &&
          /^[A-Z\s]+$/.test(cleaned)
        ) {
          return {
            value: this.cleanName(cleaned),
            confidence: 0.4,
            rawValue: line,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractNationalId(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Malawi national ID patterns — typically alphanumeric
      const idPatterns = [
        /(?:id\s*(?:no|number|#)?|national\s*id)\s*[:;]?\s*([A-Z0-9\-\s]{5,20})/i,
        /\b([A-Z]{1,3}[\s\-]?\d{6,10}[\s\-]?[A-Z0-9]{0,4})\b/,
        /\b(\d{2}[\s\-]\d{4,8}[\s\-]?\d{0,4})\b/,
      ];

      for (const line of lines) {
        for (const pattern of idPatterns) {
          const match = pattern.exec(line);
          if (match) {
            const id = match[1].replace(/\s+/g, '').trim();
            if (id.length >= 5) {
              return {
                value: id.toUpperCase(),
                confidence: /id|national/i.test(line) ? 0.8 : 0.5,
                rawValue: match[1],
              };
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractDateOfBirth(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Look for DOB labels
      const dobPatterns = [
        /(?:date\s*of\s*birth|d\.?o\.?b\.?|born|birth\s*date)\s*[:;]?\s*(\d{1,2}[\s/.\-]\d{1,2}[\s/.\-]\d{2,4})/i,
      ];

      for (const line of lines) {
        for (const pattern of dobPatterns) {
          const match = pattern.exec(line);
          if (match) {
            return {
              value: this.normalizeDate(match[1]),
              confidence: 0.7,
              rawValue: match[1],
            };
          }
        }
      }

      // Fallback: find any date-like pattern near DOB context
      const datePattern = /(\d{1,2}[\s/.\-]\d{1,2}[\s/.\-]\d{2,4})/g;
      const allDates: string[] = [];
      let dateMatch: RegExpExecArray | null;
      while ((dateMatch = datePattern.exec(rawText)) !== null) {
        allDates.push(dateMatch[1]);
      }

      if (allDates.length === 1) {
        return {
          value: this.normalizeDate(allDates[0]),
          confidence: 0.4,
          rawValue: allDates[0],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractGender(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      const genderPatterns = [
        /(?:sex|gender)\s*[:;]?\s*(male|female|m|f)\b/i,
      ];

      for (const line of lines) {
        for (const pattern of genderPatterns) {
          const match = pattern.exec(line);
          if (match) {
            const value = match[1].toUpperCase();
            return {
              value: value.length === 1 ? value : value.charAt(0),
              confidence: 0.8,
              rawValue: match[1],
            };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractAddress(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      const addressPatterns = [
        /(?:address|district|place\s*of\s*(?:origin|birth)|village)\s*[:;]?\s*(.+)/i,
      ];

      for (const line of lines) {
        for (const pattern of addressPatterns) {
          const match = pattern.exec(line);
          if (match) {
            const value = match[1].trim();
            if (value.length >= 2) {
              return {
                value,
                confidence: 0.6,
                rawValue: match[1],
              };
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractExpiryDate(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      const expiryPatterns = [
        /(?:expir(?:y|es|ation)|valid\s*(?:until|to|thru))\s*[:;]?\s*(\d{1,2}[\s/.\-]\d{1,2}[\s/.\-]\d{2,4})/i,
      ];

      for (const line of lines) {
        for (const pattern of expiryPatterns) {
          const match = pattern.exec(line);
          if (match) {
            return {
              value: this.normalizeDate(match[1]),
              confidence: 0.7,
              rawValue: match[1],
            };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private cleanName(name: string): string {
    return name
      .replace(/[^A-Za-z\s\-']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  private normalizeDate(dateStr: string): string {
    // Normalize separators to /
    return dateStr.replace(/[\s.\-]/g, '/').trim();
  }
}
