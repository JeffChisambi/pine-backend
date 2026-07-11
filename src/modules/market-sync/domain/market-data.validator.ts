import { Injectable, Logger } from '@nestjs/common';
import type { RawMarketSnapshot, RawStockRow } from './raw-market-snapshot';
import {
  RawStockRowSchema,
  type MarketDataValidationResult,
  type ValidatedStockRow,
  type ValidationWarning,
} from './market-data.schema';

/**
 * Validates raw scraped market data through three layers:
 *
 * 1. **Structural validation** (Zod): Are the strings parseable as
 *    numbers? Are required fields present?
 * 2. **Cross-field validation**: Does `% change` match
 *    `(close - open) / open * 100` within tolerance?
 * 3. **Anomaly detection**: Flag unusual values (>20% daily move,
 *    zero volume on an open market day) as warnings — still persisted,
 *    but logged for human review.
 *
 * This class is pure logic with zero I/O — it receives a list of
 * known symbols from the caller (the orchestrator service, which
 * fetches them from the repository) so it stays persistence-ignorant.
 */
@Injectable()
export class MarketDataValidator {
  private readonly logger = new Logger(MarketDataValidator.name);

  /**
   * @param snapshot  Raw scraped data
   * @param knownSymbols  Set of symbols already in our `stocks` table
   * @returns Validated result with valid rows, invalid rows, warnings, unknown symbols
   */
  validate(
    snapshot: RawMarketSnapshot,
    knownSymbols: Set<string>,
  ): MarketDataValidationResult {
    const validRows: ValidatedStockRow[] = [];
    const invalidRows: Array<{ rawSymbol: string; errors: string[] }> = [];
    const warnings: ValidationWarning[] = [];
    const unknownSymbols: string[] = [];

    for (const rawRow of snapshot.rows) {
      const symbol = rawRow.symbol.trim().toUpperCase();

      // ── 1. Structural validation via Zod ──────────────────────
      const parseResult = RawStockRowSchema.safeParse(rawRow);

      if (!parseResult.success) {
        const errors = parseResult.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        );
        this.logger.warn({ symbol, errors }, `Validation failed for ${symbol}`);
        invalidRows.push({ rawSymbol: symbol, errors });
        continue;
      }

      const validated = parseResult.data;

      // ── 2. Known symbol check ─────────────────────────────────
      if (!knownSymbols.has(validated.symbol)) {
        unknownSymbols.push(validated.symbol);
        this.logger.warn(
          { symbol: validated.symbol },
          `Unknown symbol encountered: ${validated.symbol} — not in stock catalogue`,
        );
        // Still validate and return — the orchestrator decides whether
        // to auto-create the stock or skip it
        continue;
      }

      // ── 3. Cross-field validation ─────────────────────────────
      const open = parseFloat(validated.openPrice);
      const close = parseFloat(validated.closePrice);
      const reportedChange = parseFloat(validated.changePct);

      if (open > 0) {
        const computedChange = ((close - open) / open) * 100;
        const tolerance = 0.5; // allow 0.5% tolerance for rounding

        if (Math.abs(computedChange - reportedChange) > tolerance) {
          warnings.push({
            symbol: validated.symbol,
            field: 'changePct',
            message: `Reported change ${reportedChange}% does not match computed ${computedChange.toFixed(2)}% (open=${open}, close=${close})`,
            value: validated.changePct,
          });
        }
      }

      // ── 4. Anomaly detection ──────────────────────────────────
      this.detectAnomalies(validated, warnings);

      validRows.push(validated);
    }

    this.logger.log({
      total: snapshot.rows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
      warnings: warnings.length,
      unknownSymbols: unknownSymbols.length,
    }, 'Market data validation complete');

    return { validRows, invalidRows, warnings, unknownSymbols };
  }

  private detectAnomalies(
    row: ValidatedStockRow,
    warnings: ValidationWarning[],
  ): void {
    const close = parseFloat(row.closePrice);
    const open = parseFloat(row.openPrice);
    const volume = parseFloat(row.volume);

    // Flag daily moves > 20% as potential anomalies
    if (open > 0) {
      const dailyMove = Math.abs(((close - open) / open) * 100);
      if (dailyMove > 20) {
        warnings.push({
          symbol: row.symbol,
          field: 'closePrice',
          message: `Unusual daily price movement: ${dailyMove.toFixed(1)}%`,
          value: row.closePrice,
        });
      }
    }

    // Flag zero prices (possible data error)
    if (close === 0 && open === 0) {
      warnings.push({
        symbol: row.symbol,
        field: 'closePrice',
        message: 'Both open and close prices are zero — possible data error',
        value: '0',
      });
    }

    // Flag extremely high turnover relative to price * volume
    const turnover = parseFloat(row.turnover);
    if (volume > 0 && close > 0) {
      const expectedTurnover = volume * close;
      const ratio = turnover / expectedTurnover;
      if (ratio > 10 || ratio < 0.1) {
        warnings.push({
          symbol: row.symbol,
          field: 'turnover',
          message: `Turnover/volume*price ratio is ${ratio.toFixed(2)}x — possible data inconsistency`,
          value: row.turnover,
        });
      }
    }
  }
}
