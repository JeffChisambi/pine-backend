import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
// Parsing helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Strips thousands-separator commas and whitespace, then parses as a
 * non-negative number. Returns the raw numeric string (not a JS
 * `number`) to avoid IEEE-754 precision loss on large MWK values —
 * the repository layer converts this to `Decimal` via Prisma.
 */
const commaNumericString = z
  .string()
  .transform((val) => val.replace(/,/g, '').trim())
  .pipe(
    z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, 'Must be a valid numeric string after stripping commas'),
  );

/**
 * Price field: must be non-negative after parsing.
 */
const priceField = commaNumericString.refine(
  (val) => parseFloat(val) >= 0,
  { message: 'Price must be non-negative' },
);

/**
 * Volume field: must be a non-negative integer-like value.
 */
const volumeField = commaNumericString.refine(
  (val) => parseFloat(val) >= 0,
  { message: 'Volume must be non-negative' },
);

/**
 * Percentage change field: can be negative, zero, or positive.
 * Accepts formats like "+1.45", "-0.32", "0.00", "1.45".
 */
const changePctField = z
  .string()
  .transform((val) => val.replace(/[,%+]/g, '').trim())
  .transform((val) => {
    // Handle the case where the original string had a '-' but was
    // stripped — we need to preserve the sign from the raw string.
    return val;
  })
  .pipe(
    z.string().regex(/^-?\d+(\.\d+)?$/, 'Must be a valid percentage value'),
  );

// ────────────────────────────────────────────────────────────────────
// Row schemas
// ────────────────────────────────────────────────────────────────────

/**
 * Schema for a single raw stock row as extracted from the DOM.
 * Validates string shapes only — does NOT enforce business rules
 * (those live in `MarketDataValidator`).
 */
export const RawStockRowSchema = z.object({
  symbol: z
    .string()
    .min(1, 'Symbol is required')
    .max(20, 'Symbol too long')
    .transform((s) => s.trim().toUpperCase()),

  isin: z
    .string()
    .default('')
    .transform((s) => s.trim()),

  openPrice: priceField,
  closePrice: priceField,
  changePct: changePctField,
  volume: volumeField,
  turnover: commaNumericString,
});

export type ValidatedStockRow = z.infer<typeof RawStockRowSchema>;

// ────────────────────────────────────────────────────────────────────
// Snapshot schema
// ────────────────────────────────────────────────────────────────────

export const RawMarketSnapshotSchema = z.object({
  scrapedAt: z.date(),
  marketStatus: z.string().min(1),
  lastUpdatedRaw: z.string().min(1),
  rows: z.array(RawStockRowSchema).min(1, 'Snapshot must contain at least one stock row'),
  sourceUrl: z.string().url(),
});

export type ValidatedMarketSnapshot = z.infer<typeof RawMarketSnapshotSchema>;

// ────────────────────────────────────────────────────────────────────
// Validation result (used by the validator service)
// ────────────────────────────────────────────────────────────────────

export interface ValidationWarning {
  symbol: string;
  field: string;
  message: string;
  value: string;
}

export interface MarketDataValidationResult {
  /** Successfully validated rows, ready for persistence */
  validRows: ValidatedStockRow[];

  /** Rows that failed validation entirely — not persisted */
  invalidRows: Array<{
    rawSymbol: string;
    errors: string[];
  }>;

  /** Rows that passed but with anomaly warnings — still persisted */
  warnings: ValidationWarning[];

  /** Symbols found on the page but not in our stock catalogue */
  unknownSymbols: string[];
}
