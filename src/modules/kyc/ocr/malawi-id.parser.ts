import { Logger } from '@nestjs/common';
import type { OcrExtractionResult, OcrFieldResult } from '../domain/verification-result';

/**
 * Malawi National Registration Card (NRC) parser.
 *
 * Extracts structured fields from raw Tesseract OCR output of a Malawi NRC.
 *
 * ─── Card layout ─────────────────────────────────────────────────────────────
 * The Malawi NRC is a bi-lingual card (English / Chichewa) printed in three
 * languages on the back (English, Chichewa, French). Key fields:
 *
 *   Surname / Dzina la Mzana / Nom de famille
 *   First Name(s) / Maina / Prénom(s)
 *   Date of Birth / Tsiku la Kubadwa / Date de naissance  (DD/MM/YYYY)
 *   Sex / Chimiro / Sexe                                  (M or F)
 *   Place of Origin / Kuchokera Ku / Lieu d'origine
 *   National Registration Number / Nambala ya Mbadwo      (NNNNNN/NN/N)
 *   Expiry / Valid Until                                   (MM/YYYY)
 *
 * NRC number format: 6 digits / 2 digits / 1 digit — e.g. 123456/78/9
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * FIX (Bug 9): Original regexes did not match the actual NRC number format
 * NNNNNN/NN/N. Added dedicated patterns for this format.
 *
 * FIX (Bug 10): OCR regularly misreads '/' as '|', '\', 'l', 'I', or '1'
 * (especially in the NRC number separators). Added an OCR correction pass
 * that normalises common substitutions before field extraction.
 */
export class MalawiIdParser {
  private readonly logger = new Logger(MalawiIdParser.name);

  parse(rawText: string, overallOcrConfidence: number): OcrExtractionResult {
    // Step 1: apply global OCR noise corrections before any parsing
    const corrected = this.correctOcrNoise(rawText);

    const lines = corrected
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const fullName = this.extractFullName(lines, corrected);
    const nationalIdNumber = this.extractNationalId(lines, corrected);
    const dateOfBirth = this.extractDateOfBirth(lines, corrected);
    const gender = this.extractGender(lines, corrected);
    const address = this.extractAddress(lines, corrected);
    const expiryDate = this.extractExpiryDate(lines, corrected);

    const fieldConfidences = [
      fullName?.confidence,
      nationalIdNumber?.confidence,
      dateOfBirth?.confidence,
      gender?.confidence,
    ].filter((c): c is number => c !== undefined && c > 0);

    const avgFieldConfidence =
      fieldConfidences.length > 0
        ? fieldConfidences.reduce((a, b) => a + b, 0) / fieldConfidences.length
        : 0;

    // Blend Tesseract engine confidence (40%) with field-level confidence (60%)
    const blendedConfidence =
      overallOcrConfidence * 0.4 + avgFieldConfidence * 0.6;

    return {
      fullName,
      nationalIdNumber,
      dateOfBirth,
      gender,
      address,
      documentNumber: nationalIdNumber, // NRC number doubles as document number
      expiryDate,
      overallConfidence: Math.round(blendedConfidence * 100) / 100,
      rawText,          // Return original (uncorrected) text for audit
      processingTimeMs: 0, // Set by caller
    };
  }

  // ── OCR noise correction ──────────────────────────────────────────────────

  /**
   * Apply heuristic corrections for common OCR misreadings on Malawi NRC
   * cards before any regex-based field extraction.
   *
   * Rules applied (order matters):
   * 1. Normalise various slashes/pipes that appear in the NRC separator
   * 2. Correct digit/letter confusions in purely numeric contexts
   * 3. Normalise whitespace
   */
  private correctOcrNoise(text: string): string {
    let out = text;

    // Normalise line endings
    out = out.replace(/\r\n?/g, '\n');

    // In the NRC number context (digits on both sides), normalise
    // characters that OCR misreads as a slash separator: | \ l I 1
    // Pattern: digit [bad-char] digit inside a known NRC-like string
    out = out.replace(/(\d)[|\\lI](\d)/g, '$1/$2');

    // Replace common letter→digit substitutions inside digit-only runs
    // (e.g. after we find a 6-digit block followed by noise)
    out = out.replace(/(\d{6})[Oo](\d{2})/g, '$10$2'); // O misread as 0 between digit groups
    out = out.replace(/(\d)O(\d)/g, '$10$2');           // O → 0 between digits
    out = out.replace(/(\d)l(\d)/g, '$11$2');           // l → 1 between digits

    // Fix common name/label confusions
    out = out.replace(/\bSurname\b/gi, 'Surname');
    out = out.replace(/\bS[uü]rname\b/gi, 'Surname');
    out = out.replace(/\bD[0O]B\b/gi, 'DOB');
    out = out.replace(/\bSex\b/gi, 'Sex');

    return out;
  }

  // ── Field: Full Name ──────────────────────────────────────────────────────

  private extractFullName(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Attempt 1: parse from labeled fields (Surname + First Name)
      let surname = '';
      let givenNames = '';

      for (const line of lines) {
        // English labels
        const surnameMatch = /(?:surname|last\s*name)\s*[:;]?\s*(.+)/i.exec(line);
        if (surnameMatch) {
          surname = surnameMatch[1].trim();
          continue;
        }

        const givenMatch =
          /(?:first\s*name[s]?|given\s*name[s]?|forename[s]?|maina)\s*[:;]?\s*(.+)/i.exec(
            line,
          );
        if (givenMatch) {
          givenNames = givenMatch[1].trim();
          continue;
        }

        // Chichewa label for surname
        const dzinaMatch = /dzina\s*la\s*mzana\s*[:;]?\s*(.+)/i.exec(line);
        if (dzinaMatch) {
          surname = dzinaMatch[1].trim();
          continue;
        }
      }

      if (surname || givenNames) {
        const fullName = [surname, givenNames].filter(Boolean).join(' ').trim();
        if (fullName.length >= 3) {
          return {
            value: this.cleanName(fullName),
            confidence: 0.75,
            rawValue: fullName,
          };
        }
      }

      // Attempt 2: look for an ALL-CAPS line with 2+ words that precedes
      // the NRC number (common layout on the front of the card)
      const nrcLineIdx = lines.findIndex((l) => /\d{6}\/\d{2}\/\d/.test(l));
      const searchLines =
        nrcLineIdx > 0 ? lines.slice(0, nrcLineIdx) : lines;

      for (const line of searchLines) {
        const cleaned = line.replace(/[^A-Za-z\s-']/g, '').trim();
        const words = cleaned.split(/\s+/);
        if (
          cleaned.length >= 4 &&
          words.length >= 2 &&
          words.length <= 5 &&
          /^[A-Z][A-Z\s\-']+$/.test(cleaned)
        ) {
          return {
            value: this.cleanName(cleaned),
            confidence: 0.45,
            rawValue: line,
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Field: NRC Number ─────────────────────────────────────────────────────

  /**
   * Malawi NRC format: NNNNNN/NN/N (6 digits / 2 digits / 1 digit)
   *
   * FIX (Bug 9): Original patterns were for generic ID formats (letter-digit
   * combos) and never matched the actual Malawi NRC format. Added specific
   * patterns in decreasing confidence order.
   *
   * FIX (Bug 10): After correctOcrNoise(), the separator is normalised to '/'.
   * We also accept raw OCR noise forms as a safety net.
   */
  private extractNationalId(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Pattern A — ideal: exactly NNNNNN/NN/N (post OCR-correction)
      const strictPattern = /\b(\d{6}\/\d{2}\/\d)\b/;

      // Pattern B — OCR noise variants still present after correction
      const loosePattern = /\b(\d{6}[\/|\\lI1]\d{2}[\/|\\lI1]\d)\b/;

      // Check labeled lines first (highest confidence)
      const labelPattern =
        /(?:national\s*reg(?:istration)?\s*(?:no|number|#)|nrc\s*(?:no|number|#)|nambala\s*ya\s*mbadwo|registration\s*no)\s*[:;]?\s*(.+)/i;

      for (const line of lines) {
        const labelMatch = labelPattern.exec(line);
        if (labelMatch) {
          const candidate = labelMatch[1].trim();
          const nrcMatch = strictPattern.exec(candidate) ?? loosePattern.exec(candidate);
          if (nrcMatch) {
            return {
              value: this.normalizeNrc(nrcMatch[1]),
              confidence: 0.90,
              rawValue: nrcMatch[1],
            };
          }
        }
      }

      // Scan all lines for the NRC pattern
      for (const line of lines) {
        const strict = strictPattern.exec(line);
        if (strict) {
          return {
            value: this.normalizeNrc(strict[1]),
            confidence: 0.80,
            rawValue: strict[1],
          };
        }

        const loose = loosePattern.exec(line);
        if (loose) {
          return {
            value: this.normalizeNrc(loose[1]),
            confidence: 0.60,
            rawValue: loose[1],
          };
        }
      }

      // Fallback: scan raw text (OCR may not have line-broken it correctly)
      const rawStrict = strictPattern.exec(rawText);
      if (rawStrict) {
        return {
          value: this.normalizeNrc(rawStrict[1]),
          confidence: 0.70,
          rawValue: rawStrict[1],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Field: Date of Birth ──────────────────────────────────────────────────

  private extractDateOfBirth(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Labels in all three languages on the Malawi NRC
      const dobLabelPattern =
        /(?:date\s*of\s*birth|d\.?o\.?b\.?|born|birth\s*date|tsiku\s*la\s*kubadwa|date\s*de\s*naissance)\s*[:;]?\s*(\d{1,2}[\s/.\-]\d{1,2}[\s/.\-]\d{2,4})/i;

      for (const line of lines) {
        const match = dobLabelPattern.exec(line);
        if (match) {
          return {
            value: this.normalizeDate(match[1]),
            confidence: 0.85,
            rawValue: match[1],
          };
        }
      }

      // Fallback: find all date-like strings and return the most plausible DOB
      // (Malawi NRC uses DD/MM/YYYY; avoid year-only or future dates)
      const datePattern = /\b(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\b/g;
      const allDates: string[] = [];
      let m: RegExpExecArray | null;

      while ((m = datePattern.exec(rawText)) !== null) {
        const normalized = this.normalizeDate(m[1]);
        if (this.isPlausibleDob(normalized)) {
          allDates.push(m[1]);
        }
      }

      if (allDates.length === 1) {
        return {
          value: this.normalizeDate(allDates[0]),
          confidence: 0.45,
          rawValue: allDates[0],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Field: Gender ─────────────────────────────────────────────────────────

  private extractGender(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Labeled patterns in all three languages
      const genderPattern =
        /(?:sex|gender|chimiro|sexe)\s*[:;]?\s*(male|female|m|f)\b/i;

      for (const line of lines) {
        const match = genderPattern.exec(line);
        if (match) {
          const raw = match[1].toUpperCase();
          const value = raw === 'MALE' || raw === 'M' ? 'M' : 'F';
          return { value, confidence: 0.90, rawValue: match[1] };
        }
      }

      // Fallback: look for a standalone M or F near the gender label
      const standalonePattern =
        /(?:sex|gender|chimiro)\s*[:;]?\s*\n?\s*([MF])\b/i;
      const standaloneMatch = standalonePattern.exec(rawText);
      if (standaloneMatch) {
        return {
          value: standaloneMatch[1].toUpperCase(),
          confidence: 0.65,
          rawValue: standaloneMatch[1],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Field: Address / Place of Origin ─────────────────────────────────────

  private extractAddress(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      const addressPattern =
        /(?:address|district|place\s*of\s*(?:origin|birth)|village|kuchokera\s*ku|lieu\s*d['']origine|traditional\s*authority|t\.?a\.?)\s*[:;]?\s*(.+)/i;

      for (const line of lines) {
        const match = addressPattern.exec(line);
        if (match) {
          const value = match[1].trim();
          if (value.length >= 2) {
            return { value, confidence: 0.70, rawValue: match[1] };
          }
        }
      }

      // Fallback: look for known Malawi district names in the text
      const malawiDistricts = [
        'Lilongwe', 'Blantyre', 'Mzuzu', 'Zomba', 'Kasungu', 'Mzimba',
        'Karonga', 'Salima', 'Dedza', 'Ntchisi', 'Dowa', 'Nkhotakota',
        'Nkhata Bay', 'Rumphi', 'Chitipa', 'Machinga', 'Mangochi',
        'Balaka', 'Ntcheu', 'Thyolo', 'Mulanje', 'Phalombe', 'Chiradzulu',
        'Nsanje', 'Chikwawa', 'Neno',
      ];

      for (const line of lines) {
        for (const district of malawiDistricts) {
          if (new RegExp(`\\b${district}\\b`, 'i').test(line)) {
            return { value: district, confidence: 0.50, rawValue: line };
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Field: Expiry Date ────────────────────────────────────────────────────

  private extractExpiryDate(
    lines: string[],
    rawText: string,
  ): OcrFieldResult | null {
    try {
      // Malawi NRC expiry is MM/YYYY (no day component)
      const expiryLabelPattern =
        /(?:expir(?:y|es|ation)|valid\s*(?:until|to|thru)|date\s*d['']expiration)\s*[:;]?\s*(\d{1,2}[\/.\-]\d{4}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i;

      for (const line of lines) {
        const match = expiryLabelPattern.exec(line);
        if (match) {
          return {
            value: this.normalizeDate(match[1]),
            confidence: 0.80,
            rawValue: match[1],
          };
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Normalise the NRC number to canonical NNNNNN/NN/N form,
   * replacing any leftover noise separators with '/'.
   */
  private normalizeNrc(raw: string): string {
    // Replace only the unambiguous non-digit noise characters.
    // '1' is a valid NRC digit and must NOT be replaced globally —
    // a valid NRC ending in '1' (e.g. 123456/78/1) would otherwise
    // become '123456/78//' (C-5 fix).
    return raw.replace(/[|\\lI]/g, '/').replace(/\s+/g, '');
  }

  /** Title-case a name, preserving hyphens and apostrophes. */
  private cleanName(name: string): string {
    return name
      .replace(/[^A-Za-z\s\-']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Normalise date separators to '/'.
   * Malawi NRC uses DD/MM/YYYY; preserve this convention.
   */
  private normalizeDate(dateStr: string): string {
    return dateStr.replace(/[\s.\-]/g, '/').trim();
  }

  /**
   * Reject dates that are clearly not valid dates of birth on a current card:
   * - Year must be between 1900 and 10 years ago (minimum age approximation)
   * - Month must be 1–12
   */
  private isPlausibleDob(normalized: string): boolean {
    try {
      const parts = normalized.split('/');
      if (parts.length < 3) return false;
      const month = parseInt(parts[1], 10);
      const year =
        parseInt(parts[2], 10) + (parseInt(parts[2], 10) < 100 ? 2000 : 0);
      if (month < 1 || month > 12) return false;
      const currentYear = new Date().getFullYear();
      // Minimum KYC age on Pine is 18 years (regulatory requirement)
      if (year < 1900 || year > currentYear - 18) return false;
      return true;
    } catch {
      return false;
    }
  }
}
