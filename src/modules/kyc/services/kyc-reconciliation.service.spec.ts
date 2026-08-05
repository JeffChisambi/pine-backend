import { describe, expect, it } from 'vitest';
import { KycReconciliationService, type ReconciliationInput } from './kyc-reconciliation.service';

const svc = new KycReconciliationService();

function input(over: Partial<ReconciliationInput['user']>, ocr: Record<string, unknown>): ReconciliationInput {
  return {
    user: {
      firstName: 'Thelmer',
      lastName: 'Chisambi',
      email: 'thelmer@example.com',
      phone: '+265990342842',
      dateOfBirth: new Date(Date.UTC(1979, 2, 12)),
      gender: 'M',
      ...over,
    },
    application: {
      nationalIdNumber: null,
      dateOfBirth: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      district: null,
      ocrExtractedData: ocr,
    },
  };
}

describe('KycReconciliationService', () => {
  it('corroborates a clean OCR name against registration → reconciled', () => {
    const r = svc.reconcile(input({}, { fullName: { value: 'Thelmer Chisambi', confidence: 0.9 } }));
    expect(r.fullName.value).toBe('Thelmer Chisambi');
    expect(r.fullName.source).toBe('reconciled');
    expect(r.fullName.matchesRegistration).toBe(true);
    expect(r.mismatchFlags).not.toContain('fullName');
  });

  it('tolerates OCR typos in the name (fuzzy match still reconciles)', () => {
    // "Thelmer Chisambl" — last char misread l→i
    const r = svc.reconcile(input({}, { fullName: { value: 'Thelmer Chisambl', confidence: 0.5 } }));
    expect(r.fullName.matchesRegistration).toBe(true);
    expect(r.fullName.value).toBe('Thelmer Chisambi'); // registration casing kept
  });

  it('prefers registration and flags a genuine name conflict', () => {
    const r = svc.reconcile(input({}, { fullName: { value: 'John Banda', confidence: 0.9 } }));
    expect(r.fullName.value).toBe('Thelmer Chisambi');
    expect(r.fullName.source).toBe('registration');
    expect(r.fullName.matchesRegistration).toBe(false);
    expect(r.mismatchFlags).toContain('fullName');
  });

  it('falls back to OCR when registration lacks the field', () => {
    const r = svc.reconcile(
      input({ dateOfBirth: null }, { dateOfBirth: { value: '12/03/1979', confidence: 0.99 } }),
    );
    expect(r.dateOfBirth.value).toBe('12/03/1979');
    expect(['ocr', 'mrz']).toContain(r.dateOfBirth.source);
  });

  it('reconciles DOB when registration and extraction agree', () => {
    const withAppDob = input({}, {});
    withAppDob.application.dateOfBirth = new Date(Date.UTC(1979, 2, 12));
    const r = svc.reconcile(withAppDob);
    expect(r.dateOfBirth.value).toBe('12/03/1979');
    expect(r.dateOfBirth.source).toBe('reconciled');
    expect(r.dateOfBirth.matchesRegistration).toBe(true);
  });

  it('treats national ID as extraction-only (no registration anchor)', () => {
    const i = input({}, { nationalIdNumber: { value: 'ABCD1234', confidence: 0.95 } });
    i.application.nationalIdNumber = 'ABCD1234';
    const r = svc.reconcile(i);
    expect(r.nationalId.value).toBe('ABCD1234');
  });

  it('resolveCsdFields applies broker overrides last', () => {
    const fields = svc.resolveCsdFields(
      input({}, { fullName: { value: 'Thelmer Chisambi', confidence: 0.9 } }),
      { bankName: 'NBS Bank', accountName: 'Thelmer Chisambi', accountNumberMasked: '****4321' },
      { bankBranchCode: '012', fullName: 'THELMER J CHISAMBI' },
    );
    expect(fields.fullName).toBe('THELMER J CHISAMBI'); // override wins
    expect(fields.bankBranchCode).toBe('012');
    expect(fields.bankName).toBe('NBS BANK');
    expect(fields.gender).toBe('M');
  });
});
