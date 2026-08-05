import { Logger } from '@nestjs/common';

/**
 * TD1 Machine-Readable Zone (MRZ) parser — ICAO Doc 9303 part 5.
 *
 * The Malawi National Registration Card (and most ID-1 sized identity cards)
 * carries a 3-line × 30-character MRZ on the back:
 *
 *   Line 1: I<MWI D0C UMENTN0 C optional-data<<<<<<<
 *           [0-1] doc code · [2-4] issuer · [5-13] document number ·
 *           [14] check digit · [15-29] optional data (often the NRC number)
 *   Line 2: YYMMDD C S YYMMDD C MWI optional<<<<<< C
 *           [0-5] birth date · [6] check · [7] sex · [8-13] expiry ·
 *           [14] check · [15-17] nationality · [18-28] optional · [29] composite check
 *   Line 3: SURNAME<<GIVEN<NAMES<<<<<<<<<<<<<<<<<<
 *
 * MRZ text survives OCR far better than the card's printed fields (fixed-width
 * OCR-B font, high contrast) and every numeric field carries a check digit, so
 * we can *prove* correct extraction instead of guessing. Fields that pass their
 * check digit get confidence 0.99; fields whose check fails are still returned
 * (confidence 0.35) so a human reviewer sees the best-effort value.
 */

export interface MrzField {
  value: string;
  /** True when the ICAO check digit validates the raw characters. */
  checkDigitValid: boolean;
}

export interface MrzResult {
  found: boolean;
  documentCode: string | null;
  issuingCountry: string | null;
  documentNumber: MrzField | null;
  /** Optional data on line 1 — on the Malawi NRC this is the NRC number. */
  optionalData1: string | null;
  birthDate: MrzField | null;   // normalised DD/MM/YYYY
  sex: string | null;           // 'M' | 'F' | null
  expiryDate: MrzField | null;  // normalised DD/MM/YYYY
  nationality: string | null;
  surname: string | null;
  givenNames: string | null;
  /** Fraction of validatable check digits that passed (0–1). */
  checkDigitScore: number;
  rawLines: string[] | null;
}

const EMPTY: MrzResult = {
  found: false,
  documentCode: null,
  issuingCountry: null,
  documentNumber: null,
  optionalData1: null,
  birthDate: null,
  sex: null,
  expiryDate: null,
  nationality: null,
  surname: null,
  givenNames: null,
  checkDigitScore: 0,
  rawLines: null,
};

export class MrzParser {
  private readonly logger = new Logger(MrzParser.name);

  /**
   * Locate and parse a TD1 MRZ inside raw OCR text.
   * Tolerates common OCR noise: spaces inside lines, `«` for `<<`,
   * digit/letter confusions in the fixed-format numeric fields.
   */
  parse(rawText: string): MrzResult {
    const lines = this.findMrzLines(rawText);
    if (!lines) return { ...EMPTY };

    try {
      const [l1, l2, l3] = lines;

      // ── Line 1 ────────────────────────────────────────────────
      const documentCode = l1.slice(0, 2).replace(/</g, '') || null;
      const issuingCountry = this.fixAlpha(l1.slice(2, 5)) || null;
      const docNumRaw = l1.slice(5, 14);
      const docNumCheck = l1[14];
      const documentNumber = docNumRaw.replace(/</g, '');
      const docNumValid = this.checkDigit(docNumRaw) === docNumCheck;
      const optionalData1 = l1.slice(15, 30).replace(/</g, '') || null;

      // ── Line 2 ────────────────────────────────────────────────
      const birthRaw = this.fixNumeric(l2.slice(0, 6));
      const birthCheck = l2[6];
      const birthValid = this.checkDigit(birthRaw) === birthCheck;
      const sexRaw = l2[7];
      const expiryRaw = this.fixNumeric(l2.slice(8, 14));
      const expiryCheck = l2[14];
      const expiryValid = this.checkDigit(expiryRaw) === expiryCheck;
      const nationality = this.fixAlpha(l2.slice(15, 18)) || null;

      // ── Line 3 ────────────────────────────────────────────────
      const nameField = l3.replace(/[^A-Z<]/g, '');
      const [surnamePart, givenPart] = nameField.split('<<');
      const surname = this.titleCase(surnamePart?.replace(/</g, ' ').trim() ?? '');
      const givenNames = this.titleCase(givenPart?.replace(/</g, ' ').trim() ?? '');

      const checks = [docNumValid, birthValid, expiryValid];
      const checkDigitScore = checks.filter(Boolean).length / checks.length;

      // An MRZ where every check digit fails is probably a false positive
      // (e.g. a barcode line misread as MRZ) — treat as not found.
      if (checkDigitScore === 0 && !surname) return { ...EMPTY };

      return {
        found: true,
        documentCode,
        issuingCountry,
        documentNumber: documentNumber
          ? { value: documentNumber, checkDigitValid: docNumValid }
          : null,
        optionalData1,
        birthDate: birthRaw.length === 6
          ? { value: this.mrzDateToDisplay(birthRaw, 'birth'), checkDigitValid: birthValid }
          : null,
        sex: sexRaw === 'M' || sexRaw === 'F' ? sexRaw : null,
        expiryDate: expiryRaw.length === 6
          ? { value: this.mrzDateToDisplay(expiryRaw, 'expiry'), checkDigitValid: expiryValid }
          : null,
        nationality,
        surname: surname || null,
        givenNames: givenNames || null,
        checkDigitScore,
        rawLines: lines,
      };
    } catch (error) {
      this.logger.warn({ err: error }, 'MRZ parse failed');
      return { ...EMPTY };
    }
  }

  // ── MRZ line detection ─────────────────────────────────────────

  /**
   * Find 3 consecutive TD1-like lines in OCR output. MRZ lines are 30 chars of
   * [A-Z0-9<]. OCR may insert spaces or read `<` as `«`, `(`, or `c` — strip
   * those before testing.
   */
  private findMrzLines(rawText: string): [string, string, string] | null {
    const candidates = rawText
      .split('\n')
      .map((l) => {
        let s = l
          .toUpperCase()
          .replace(/[«]/g, '<<')
          .replace(/\s+/g, '')
          .replace(/[^A-Z0-9<]/g, '');

        // Observed Tesseract noise on MRZ filler runs: '<' misread as K or L
        // (e.g. '<<<<' → 'K<K<LK'). A single K/L sandwiched between '<' is
        // always a misread filler — real letters never appear isolated inside
        // filler runs. Apply repeatedly until stable, then trim trailing noise.
        let prev = '';
        while (prev !== s) {
          prev = s;
          s = s.replace(/<[KL](?=<|$)/g, '<<').replace(/(?:^|<)[KL]</g, (m) =>
            m.replace(/[KL]/, '<'),
          );
        }
        // Trailing filler runs corrupted into K/L sequences (e.g. '<KLKLE')
        s = s.replace(/[KL]{2,}[A-Z]?$/g, (m) => '<'.repeat(m.length));

        // Line-1 re-anchor: OCR sometimes inserts a stray char after 'I<'
        // (observed: 'I<KMWI…'). If the issuer code appears within the first
        // 6 chars, rebuild the canonical 'I<' + issuer prefix.
        const issuerIdx = s.indexOf('MWI');
        if (/^I</.test(s) && issuerIdx > 2 && issuerIdx <= 4) {
          s = 'I<' + s.slice(issuerIdx);
        }
        return s;
      })
      .filter((l) => l.length >= 22); // tolerate dropped trailing fillers

    // Score each line for "MRZ-ness": density of `<` or being the doc line
    const mrzLike = (l: string) =>
      (l.includes('<') && l.length >= 22 && l.length <= 34) ||
      /^I[<A-Z]/.test(l);

    for (let i = 0; i + 2 < candidates.length + 2; i++) {
      const window = candidates.slice(i, i + 3);
      if (window.length === 3 && window.every(mrzLike)) {
        return window.map((l) => this.padTo30(l)) as [string, string, string];
      }
    }

    // Fallback: look for the distinctive line-1 signature anywhere, then take
    // the next two filler-bearing lines.
    const startIdx = candidates.findIndex((l) => /^I[<A-Z]{1,4}/.test(l) && l.includes('<'));
    if (startIdx >= 0 && startIdx + 2 < candidates.length) {
      return [
        this.padTo30(candidates[startIdx]),
        this.padTo30(candidates[startIdx + 1]),
        this.padTo30(candidates[startIdx + 2]),
      ];
    }

    return null;
  }

  private padTo30(line: string): string {
    return line.length >= 30 ? line.slice(0, 30) : line.padEnd(30, '<');
  }

  // ── ICAO check digit (weights 7-3-1) ───────────────────────────

  private checkDigit(field: string): string {
    const weights = [7, 3, 1];
    let sum = 0;
    for (let i = 0; i < field.length; i++) {
      const c = field[i];
      let v: number;
      if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
      else if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 55;
      else v = 0; // '<'
      sum += v * weights[i % 3];
    }
    return String(sum % 10);
  }

  // ── OCR confusion fixes for fixed-format fields ────────────────

  /** In numeric-only MRZ positions, letters are always misreads. */
  private fixNumeric(s: string): string {
    return s
      .replace(/O/g, '0')
      .replace(/Q/g, '0')
      .replace(/D/g, '0')
      .replace(/I/g, '1')
      .replace(/L/g, '1')
      .replace(/Z/g, '2')
      .replace(/S/g, '5')
      .replace(/B/g, '8')
      .replace(/G/g, '6')
      .replace(/</g, '0');
  }

  /** In alpha-only MRZ positions, digits are always misreads. */
  private fixAlpha(s: string): string {
    return s
      .replace(/0/g, 'O')
      .replace(/1/g, 'I')
      .replace(/5/g, 'S')
      .replace(/8/g, 'B')
      .replace(/2/g, 'Z')
      .replace(/6/g, 'G')
      .replace(/</g, '');
  }

  /**
   * Convert an MRZ YYMMDD to DD/MM/YYYY.
   * Century pivot: birth dates >(current 2-digit year) → 19xx;
   * expiry dates are always in the future-ish → 20xx.
   */
  private mrzDateToDisplay(yymmdd: string, kind: 'birth' | 'expiry'): string {
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = yymmdd.slice(2, 4);
    const dd = yymmdd.slice(4, 6);
    const nowYY = new Date().getFullYear() % 100;
    const century = kind === 'birth' ? (yy > nowYY ? 1900 : 2000) : 2000;
    return `${dd}/${mm}/${century + yy}`;
  }

  private titleCase(s: string): string {
    return s
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }
}
