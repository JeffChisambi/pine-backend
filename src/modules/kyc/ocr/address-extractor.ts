import { Logger } from '@nestjs/common';

/**
 * Heuristic postal/physical address extraction from proof-of-residency
 * documents (utility bills, bank statements, tenancy letters) for Malawi.
 *
 * Strategy — score every line of the OCR/PDF text against address signals:
 *   1. "P.O. Box NNN" / "Private Bag NNN"       → strong postal signal
 *   2. Plot / House / Area / Sector / Village    → strong physical signal
 *   3. A known Malawi city or district name      → locality signal
 * then assemble the highest-signal contiguous block into a formatted address.
 */

export interface ExtractedAddress {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  district: string | null;
  /** Single display string, comma-joined. */
  formatted: string | null;
  /** 0–1 heuristic confidence. */
  confidence: number;
  /** Lines the extraction was assembled from (audit). */
  sourceLines: string[];
}

const MALAWI_CITIES = [
  'Lilongwe', 'Blantyre', 'Mzuzu', 'Zomba', 'Kasungu', 'Mangochi', 'Salima',
  'Liwonde', 'Balaka', 'Dedza', 'Nkhotakota', 'Karonga', 'Rumphi', 'Mzimba',
  'Ntcheu', 'Mchinji', 'Dowa', 'Ntchisi', 'Chitipa', 'Nkhata Bay', 'Machinga',
  'Thyolo', 'Mulanje', 'Phalombe', 'Chiradzulu', 'Nsanje', 'Chikwawa', 'Neno',
  'Mwanza', 'Luchenza', 'Kameza',
];

const POSTAL_RE = /\b(?:P\.?\s*O\.?\s*Box|Private\s+Bag|PO\s*Box)\s*[.:]?\s*(\d+[A-Za-z]?)/i;
const PHYSICAL_RE = /\b(?:Plot|House|Hse|Area|Sector|Village|Chigwirizano|Township|Location|Stand|Unit)\b\s*(?:No\.?|Number|#)?\s*[\w/-]*/i;
const ROAD_RE = /\b(?:Road|Rd|Street|St|Avenue|Ave|Drive|Crescent|Close|Highway)\b/i;

export class AddressExtractor {
  private readonly logger = new Logger(AddressExtractor.name);

  extract(rawText: string): ExtractedAddress {
    const lines = rawText
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length >= 3 && l.length <= 80);

    interface Scored { line: string; index: number; score: number; city: string | null }
    const scored: Scored[] = lines.map((line, index) => {
      let score = 0;
      let city: string | null = null;

      if (POSTAL_RE.test(line)) score += 3;
      if (PHYSICAL_RE.test(line)) score += 2;
      if (ROAD_RE.test(line)) score += 2;

      for (const c of MALAWI_CITIES) {
        if (new RegExp(`\\b${c}\\b`, 'i').test(line)) {
          score += 2;
          city = c;
          break;
        }
      }

      // Penalise lines that look like amounts / dates / account numbers
      if (/(?:MWK|MK|K)\s*[\d,]+\.?\d*/.test(line)) score -= 2;
      if (/\b(?:total|amount|balance|due|invoice|receipt|vat|tariff)\b/i.test(line)) score -= 2;

      return { line, index, score, city };
    });

    const anchored = scored.filter((s) => s.score >= 2);
    if (anchored.length === 0) {
      return {
        addressLine1: null, addressLine2: null, city: null, district: null,
        formatted: null, confidence: 0, sourceLines: [],
      };
    }

    // Take the best-scoring anchor and pull in adjacent address-ish lines
    anchored.sort((a, b) => b.score - a.score || a.index - b.index);
    const anchor = anchored[0];

    const block: Scored[] = [anchor];
    for (const s of scored) {
      if (s === anchor) continue;
      if (Math.abs(s.index - anchor.index) <= 2 && s.score >= 2) block.push(s);
    }
    block.sort((a, b) => a.index - b.index);

    const city =
      block.map((b) => b.city).find(Boolean) ??
      scored.map((s) => s.city).find(Boolean) ??
      null;

    // Clean each line: strip label prefixes like "Address:" and trailing noise
    const cleaned = block.map((b) =>
      b.line
        .replace(/^(?:physical|postal|residential)?\s*address\s*[:\-]?\s*/i, '')
        .replace(/[|;]+/g, ',')
        .replace(/\s*,\s*/g, ', ')
        .trim(),
    );

    const uniq = [...new Set(cleaned)].filter(Boolean);
    const addressLine1 = uniq[0] ?? null;
    const addressLine2 = uniq.length > 1 ? uniq.slice(1).join(', ') : null;

    // Confidence: anchor strength (max realistic score ≈ 7) + city bonus
    const confidence = Math.min(
      0.95,
      0.35 + anchor.score * 0.08 + (city ? 0.15 : 0),
    );

    const formattedParts = [...uniq];
    if (city && !formattedParts.some((p) => new RegExp(`\\b${city}\\b`, 'i').test(p))) {
      formattedParts.push(city);
    }

    return {
      addressLine1,
      addressLine2,
      city,
      district: city, // Malawi cities double as district names in most cases
      formatted: formattedParts.join(', ') || null,
      confidence: Math.round(confidence * 100) / 100,
      sourceLines: block.map((b) => b.line),
    };
  }
}
