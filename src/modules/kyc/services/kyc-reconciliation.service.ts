import { Injectable } from '@nestjs/common';

/**
 * KYC data reconciliation.
 *
 * OCR/MRZ extraction from a photographed ID is never perfect — glare, blur and
 * font quirks corrupt fields. But the applicant ALSO typed their real details
 * (name, date of birth, gender, email, phone) when they registered. Those
 * self-entered values are a high-trust anchor.
 *
 * This service reconciles the two sources field-by-field and produces a single
 * "best value" per field plus provenance, so:
 *   • the broker dashboard can show trusted values (and flag mismatches), and
 *   • the CSD account-opening form is filled from clean data rather than raw,
 *     possibly-garbled OCR output.
 *
 * Trust order per field:
 *   name / dob / gender  → registration wins when it conflicts with a weak
 *                          extraction; extraction only "corroborates".
 *   nationalId / docNo / expiry / nationality → no registration equivalent,
 *                          so MRZ (check-digit-verified) > OCR.
 *   email / phone        → registration is authoritative.
 */

export type FieldSource =
  | 'registration'
  | 'mrz'
  | 'ocr'
  | 'reconciled' // extraction agreed with registration
  | 'override' // broker manually set it
  | 'none';

export interface ReconciledField {
  value: string | null;
  source: FieldSource;
  /** 0–100. */
  confidence: number;
  /** What the user typed at registration (if any). */
  registrationValue?: string | null;
  /** What OCR/MRZ read from the document (if any). */
  extractedValue?: string | null;
  /** True when extraction corroborated registration; false when they conflict. */
  matchesRegistration?: boolean;
}

export interface ReconciledAddress {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  formatted: string | null;
  confidence: number | null;
  source: FieldSource;
}

export interface ReconciledIdentity {
  fullName: ReconciledField;
  dateOfBirth: ReconciledField; // DD/MM/YYYY
  gender: ReconciledField; // 'M' | 'F'
  nationalId: ReconciledField;
  documentNumber: ReconciledField;
  expiryDate: ReconciledField;
  nationality: ReconciledField;
  email: ReconciledField;
  phone: ReconciledField;
  address: ReconciledAddress;
  /** Field keys where extraction conflicts with registration — broker attention. */
  mismatchFlags: string[];
}

/** Inputs the reconciler needs — plain data, no Prisma coupling. */
export interface ReconciliationInput {
  user: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string;
    dateOfBirth: Date | null;
    gender: string | null;
  };
  application: {
    nationalIdNumber: string | null;
    dateOfBirth: Date | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    district: string | null;
    ocrExtractedData: unknown;
  };
}

@Injectable()
export class KycReconciliationService {
  reconcile(input: ReconciliationInput): ReconciledIdentity {
    const ocr = (input.application.ocrExtractedData ?? {}) as Record<string, any>;
    const mismatchFlags: string[] = [];

    // ── Name ──────────────────────────────────────────────────────────────
    const regName = `${input.user.firstName} ${input.user.lastName}`.trim();
    const ocrName = this.fieldValue(ocr.fullName);
    const ocrNameConf = this.fieldConfidence(ocr.fullName);
    const fullName = this.reconcileText(regName, ocrName, ocrNameConf, 'name');
    if (fullName.matchesRegistration === false) mismatchFlags.push('fullName');

    // ── Date of birth ─────────────────────────────────────────────────────
    const regDob = input.user.dateOfBirth ? this.formatDate(input.user.dateOfBirth) : null;
    // Application.dateOfBirth is the pipeline's parsed extraction; the raw OCR
    // field string is the fallback display value.
    const extractedDob =
      (input.application.dateOfBirth ? this.formatDate(input.application.dateOfBirth) : null) ??
      this.normalizeDobString(this.fieldValue(ocr.dateOfBirth));
    const extractedDobConf = this.fieldConfidence(ocr.dateOfBirth);
    const dateOfBirth = this.reconcileExact(regDob, extractedDob, extractedDobConf, 'date');
    if (dateOfBirth.matchesRegistration === false) mismatchFlags.push('dateOfBirth');

    // ── Gender ────────────────────────────────────────────────────────────
    const regGender = this.normalizeGender(input.user.gender);
    const extractedGender = this.normalizeGender(this.fieldValue(ocr.gender));
    const gender = this.reconcileExact(
      regGender,
      extractedGender,
      this.fieldConfidence(ocr.gender),
      'exact',
    );
    if (gender.matchesRegistration === false) mismatchFlags.push('gender');

    // ── National ID / document number / expiry / nationality ──────────────
    // No registration anchor — trust extraction (MRZ merge already preferred
    // check-digit-verified values upstream).
    const nationalId = this.extractionOnly(
      input.application.nationalIdNumber ?? this.fieldValue(ocr.nationalIdNumber),
      this.fieldConfidence(ocr.nationalIdNumber),
    );
    const documentNumber = this.extractionOnly(
      this.fieldValue(ocr.documentNumber),
      this.fieldConfidence(ocr.documentNumber),
    );
    const expiryDate = this.extractionOnly(
      this.fieldValue(ocr.expiryDate),
      this.fieldConfidence(ocr.expiryDate),
    );
    const nationality = this.extractionOnly(
      this.fieldValue(ocr.nationality),
      this.fieldConfidence(ocr.nationality),
    );

    // ── Email / phone (authoritative from registration) ───────────────────
    const email: ReconciledField = {
      value: input.user.email,
      source: 'registration',
      confidence: input.user.email ? 100 : 0,
      registrationValue: input.user.email,
    };
    const phone: ReconciledField = {
      value: input.user.phone,
      source: 'registration',
      confidence: 100,
      registrationValue: input.user.phone,
    };

    // ── Address (extraction only) ─────────────────────────────────────────
    const extractedAddress = ocr._extractedAddress as
      | { formatted?: string | null; confidence?: number }
      | undefined;
    const formatted =
      extractedAddress?.formatted ??
      ([input.application.addressLine1, input.application.addressLine2, input.application.city]
        .filter(Boolean)
        .join(', ') || null);
    const address: ReconciledAddress = {
      addressLine1: input.application.addressLine1,
      addressLine2: input.application.addressLine2,
      city: input.application.city,
      district: input.application.district,
      formatted,
      confidence:
        extractedAddress?.confidence != null ? Math.round(extractedAddress.confidence * 100) : null,
      source: formatted ? 'ocr' : 'none',
    };

    return {
      fullName,
      dateOfBirth,
      gender,
      nationalId,
      documentNumber,
      expiryDate,
      nationality,
      email,
      phone,
      address,
      mismatchFlags,
    };
  }

  /**
   * Flat, CSD-form-ready field values derived from reconciliation, with broker
   * overrides applied last. This is what the editable form binds to and what
   * the PDF renders.
   */
  resolveCsdFields(
    input: ReconciliationInput,
    bank: { bankName?: string | null; accountName?: string | null; accountNumberMasked?: string | null } | null,
    overrides: Record<string, string> = {},
  ): CsdFieldValues {
    const r = this.reconcile(input);

    // Investor type + nationality are derived from the PHONE the user
    // registered with, not from (imperfect) OCR: a Malawi (+265) number means
    // the applicant is, by definition, a LOCAL investor — no document reading
    // required. We only fall back to OCR nationality for non-Malawi numbers.
    const isMalawiPhone = (input.user.phone ?? '').replace(/[\s-]/g, '').startsWith('+265');
    const ocrNationality = r.nationality.value;
    const nationality = isMalawiPhone
      ? 'MALAWIAN'
      : (ocrNationality ?? '');
    const investorType = isMalawiPhone
      ? 'LOCAL'
      : (ocrNationality && ocrNationality !== 'MWI' ? 'FOREIGN' : 'LOCAL');

    const base: CsdFieldValues = {
      fullName: (r.fullName.value ?? '').toUpperCase(),
      gender: (r.gender.value as 'M' | 'F' | '') ?? '',
      idType: 'NATIONAL ID',
      idNumber: (r.nationalId.value ?? '').toUpperCase(),
      dateOfBirth: r.dateOfBirth.value ?? '',
      nationality: nationality.toUpperCase(),
      investorType,
      physicalAddress: (r.address.formatted ?? '').toUpperCase(),
      postalAddress: this.postalFrom(r.address.formatted),
      telephone: r.phone.value ?? '',
      cellphone: r.phone.value ?? '',
      email: (r.email.value ?? '').toUpperCase(),
      bankName: (bank?.bankName ?? '').toUpperCase(),
      bankBranchCode: '',
      accountNumber: bank?.accountNumberMasked ?? '',
      accountName: (bank?.accountName ?? '').toUpperCase(),
    };

    // Apply broker overrides — only for known keys, only non-empty strings.
    for (const key of Object.keys(base) as Array<keyof CsdFieldValues>) {
      const ov = overrides[key];
      if (typeof ov === 'string' && ov.trim() !== '') {
        (base[key] as string) = ov;
      }
    }
    return base;
  }

  // ── Reconciliation primitives ───────────────────────────────────────────

  /** Free-text reconciliation (names) using token-set fuzzy matching. */
  private reconcileText(
    registration: string | null,
    extracted: string | null,
    extractedConf: number,
    kind: 'name',
  ): ReconciledField {
    const reg = registration?.trim() || null;
    const ext = extracted?.trim() || null;

    if (reg && ext) {
      const sim = this.nameSimilarity(reg, ext);
      if (sim >= 0.8) {
        // Corroborated — keep the registration's clean casing.
        return {
          value: reg,
          source: 'reconciled',
          confidence: Math.min(100, Math.round(70 + sim * 30)),
          registrationValue: reg,
          extractedValue: ext,
          matchesRegistration: true,
        };
      }
      // Conflict — trust the user-entered value, but flag it.
      return {
        value: reg,
        source: 'registration',
        confidence: 75,
        registrationValue: reg,
        extractedValue: ext,
        matchesRegistration: false,
      };
    }
    if (reg) {
      return { value: reg, source: 'registration', confidence: 80, registrationValue: reg, extractedValue: null };
    }
    if (ext) {
      return { value: ext, source: 'ocr', confidence: Math.round(extractedConf * 100), extractedValue: ext, registrationValue: null };
    }
    return { value: null, source: 'none', confidence: 0 };
  }

  /** Exact-match reconciliation (dob, gender). */
  private reconcileExact(
    registration: string | null,
    extracted: string | null,
    extractedConf: number,
    kind: 'date' | 'exact',
  ): ReconciledField {
    const reg = registration?.trim() || null;
    const ext = extracted?.trim() || null;

    if (reg && ext) {
      const match = reg.toUpperCase() === ext.toUpperCase();
      if (match) {
        return {
          value: reg,
          source: 'reconciled',
          confidence: 99,
          registrationValue: reg,
          extractedValue: ext,
          matchesRegistration: true,
        };
      }
      return {
        value: reg,
        source: 'registration',
        confidence: 80,
        registrationValue: reg,
        extractedValue: ext,
        matchesRegistration: false,
      };
    }
    if (reg) return { value: reg, source: 'registration', confidence: 90, registrationValue: reg, extractedValue: null };
    if (ext)
      return {
        value: ext,
        source: 'ocr',
        confidence: Math.round(extractedConf * 100),
        extractedValue: ext,
        registrationValue: null,
      };
    return { value: null, source: 'none', confidence: 0 };
  }

  private extractionOnly(value: string | null, conf: number): ReconciledField {
    if (!value) return { value: null, source: 'none', confidence: 0 };
    return { value, source: conf >= 0.9 ? 'mrz' : 'ocr', confidence: Math.round(conf * 100), extractedValue: value };
  }

  // ── Field-shape helpers (ocr fields are {value,confidence} or strings) ────

  private fieldValue(f: unknown): string | null {
    if (!f) return null;
    if (typeof f === 'string') return f.trim() || null;
    if (typeof f === 'object' && f !== null && 'value' in (f as any)) {
      const v = (f as any).value;
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    }
    return null;
  }

  private fieldConfidence(f: unknown): number {
    if (f && typeof f === 'object' && 'confidence' in (f as any)) {
      const c = (f as any).confidence;
      if (typeof c === 'number') return c;
    }
    return 0.5;
  }

  // ── Normalisation ─────────────────────────────────────────────────────────

  private normalizeGender(g: string | null): string | null {
    if (!g) return null;
    const v = g.trim().toUpperCase();
    if (v === 'M' || v === 'MALE') return 'M';
    if (v === 'F' || v === 'FEMALE') return 'F';
    return null;
  }

  /** Coerce a loosely-formatted OCR date into DD/MM/YYYY when possible. */
  private normalizeDobString(s: string | null): string | null {
    if (!s) return null;
    const m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
    if (!m) return s;
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3].length === 2 ? (Number(m[3]) > 30 ? `19${m[3]}` : `20${m[3]}`) : m[3];
    return `${dd}/${mm}/${yyyy}`;
  }

  private formatDate(date: Date): string {
    const d = String(date.getUTCDate()).padStart(2, '0');
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${d}/${m}/${date.getUTCFullYear()}`;
  }

  private postalFrom(formatted: string | null): string {
    if (!formatted) return '';
    const parts = formatted
      .split(',')
      .map((p) => p.trim())
      .filter((p) => /\bP\.?\s*O\.?\s*Box|Private\s+Bag/i.test(p));
    return parts.join(', ').toUpperCase();
  }

  /**
   * Token-set name similarity in [0,1]. Order-independent; tolerant of a
   * middle name appearing on only one side and of small OCR typos per token.
   */
  private nameSimilarity(a: string, b: string): number {
    const norm = (s: string) =>
      s
        .toUpperCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Z\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);
    const ta = norm(a);
    const tb = norm(b);
    if (ta.length === 0 || tb.length === 0) return 0;

    // Each registration token counts as matched if a close token exists in b.
    let matched = 0;
    for (const t of ta) {
      const best = tb.reduce((m, u) => Math.max(m, this.tokenSim(t, u)), 0);
      if (best >= 0.8) matched++;
    }
    return matched / ta.length;
  }

  private tokenSim(a: string, b: string): number {
    if (a === b) return 1;
    const dist = this.levenshtein(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[m][n];
  }
}

/** Flat CSD-form field values (also the editable-form contract with kusata). */
export interface CsdFieldValues {
  fullName: string;
  gender: 'M' | 'F' | '';
  idType: string;
  idNumber: string;
  dateOfBirth: string;
  nationality: string;
  investorType: string;
  physicalAddress: string;
  postalAddress: string;
  telephone: string;
  cellphone: string;
  email: string;
  bankName: string;
  bankBranchCode: string;
  accountNumber: string;
  accountName: string;
}
