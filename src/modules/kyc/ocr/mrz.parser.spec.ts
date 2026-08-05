import { describe, expect, it } from 'vitest';
import { MrzParser } from './mrz.parser';
import { mergeOcrWithMrz } from './ocr-merge.util';
import { AddressExtractor } from './address-extractor';
import type { OcrExtractionResult } from '../domain/verification-result';

/**
 * TD1 MRZ fixture with VALID ICAO check digits (weights 7-3-1):
 *   doc number 'D23145890' → check 7
 *   birth '790312' → check 2 ; expiry '310915' → check 5
 */
const VALID_TD1 = [
  'I<MWID231458907<<<<<<<<<<<<<<<',
  '7903122M3109155MWI<<<<<<<<<<<8',
  'CHISAMBI<<THELMER<<<<<<<<<<<<<',
].join('\n');

describe('MrzParser', () => {
  const parser = new MrzParser();

  it('parses a clean TD1 MRZ with valid check digits', () => {
    const r = parser.parse(VALID_TD1);
    expect(r.found).toBe(true);
    expect(r.issuingCountry).toBe('MWI');
    expect(r.documentNumber?.value).toBe('D23145890');
    expect(r.documentNumber?.checkDigitValid).toBe(true);
    expect(r.birthDate?.value).toBe('12/03/1979');
    expect(r.birthDate?.checkDigitValid).toBe(true);
    expect(r.sex).toBe('M');
    expect(r.expiryDate?.value).toBe('15/09/2031');
    expect(r.expiryDate?.checkDigitValid).toBe(true);
    expect(r.nationality).toBe('MWI');
    expect(r.surname).toBe('Chisambi');
    expect(r.givenNames).toBe('Thelmer');
    expect(r.checkDigitScore).toBe(1);
  });

  it('survives OCR noise (spaces, « for <<, O/0 confusion in dates)', () => {
    const noisy = [
      'I<MWI D2314589O7 <<<<<<<<<<<<<',
      '79O3122M31O9155MWI««««<8',
      'CHISAMBI«THELMER<<<<<<<',
    ].join('\n');
    const r = parser.parse(noisy);
    expect(r.found).toBe(true);
    expect(r.birthDate?.value).toBe('12/03/1979');
    expect(r.sex).toBe('M');
    expect(r.surname).toBe('Chisambi');
  });

  it('parses real Tesseract output where < fillers are misread as K/L', () => {
    // Verbatim output from tesseract.js recognising a rendered TD1 MRZ
    // (scripts/ocr-smoke-test.mjs) — fillers came back as K/L sequences and a
    // stray K was inserted after the 'I<' document code.
    const observed = [
      'I<KMWID231458907<<<<<<<<<<<<K<K<LK',
      '7903122M3109155MWIK<<<<K<K<K<L<LK<LKLE',
      'CHISAMBI<K<THELMER<K<K<K<K<LK<LKKKLKLKLKLK',
    ].join('\n');

    const r = parser.parse(observed);
    expect(r.found).toBe(true);
    expect(r.issuingCountry).toBe('MWI');
    expect(r.documentNumber?.value).toBe('D23145890');
    expect(r.documentNumber?.checkDigitValid).toBe(true);
    expect(r.birthDate?.value).toBe('12/03/1979');
    expect(r.birthDate?.checkDigitValid).toBe(true);
    expect(r.sex).toBe('M');
    expect(r.expiryDate?.value).toBe('15/09/2031');
    expect(r.surname).toBe('Chisambi');
    expect(r.givenNames?.startsWith('Thelmer')).toBe(true);
  });

  it('returns not-found for text without an MRZ', () => {
    const r = parser.parse('REPUBLIC OF MALAWI\nNational Registration Card\nSurname: Banda');
    expect(r.found).toBe(false);
  });
});

describe('mergeOcrWithMrz', () => {
  const parser = new MrzParser();

  const emptyFront: OcrExtractionResult = {
    fullName: null, nationalIdNumber: null, dateOfBirth: null, gender: null,
    address: null, documentNumber: null, expiryDate: null,
    overallConfidence: 0.1, rawText: '', processingTimeMs: 0,
  };

  it('check-digit-valid MRZ fields override weak front OCR', () => {
    const front: OcrExtractionResult = {
      ...emptyFront,
      dateOfBirth: { value: '11/03/1997', confidence: 0.45 },
      fullName: { value: 'Thelma Chisambl', confidence: 0.45 },
    };
    const merged = mergeOcrWithMrz(front, parser.parse(VALID_TD1));
    expect(merged.dateOfBirth?.value).toBe('12/03/1979'); // MRZ wins
    expect(merged.fullName?.value).toBe('Thelmer Chisambi'); // MRZ name wins
    expect(merged.gender?.value).toBe('M');
    expect(merged.nationality?.value).toBe('MWI');
    expect(merged.mrz?.found).toBe(true);
    expect(merged.overallConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it('keeps the front result when no MRZ is found', () => {
    const merged = mergeOcrWithMrz(emptyFront, parser.parse('no mrz here'));
    expect(merged).toBe(emptyFront);
  });
});

describe('AddressExtractor', () => {
  const extractor = new AddressExtractor();

  it('extracts a PO Box + city from a utility bill', () => {
    const text = [
      'ESCOM — Electricity Supply Corporation of Malawi',
      'Invoice No: 8837722',
      'THELMER CHISAMBI',
      'P.O. Box 1234',
      'Area 47, Sector 3',
      'Lilongwe',
      'Billing date: 23/03/2021',
      'Total Amount MWK 189,612.50',
    ].join('\n');

    const r = extractor.extract(text);
    expect(r.formatted).toBeTruthy();
    expect(r.formatted).toMatch(/P\.?O\.? Box 1234/i);
    expect(r.city).toBe('Lilongwe');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns empty for text with no address signals', () => {
    const r = extractor.extract('hello world\nnothing useful here');
    expect(r.formatted).toBeNull();
    expect(r.confidence).toBe(0);
  });
});
