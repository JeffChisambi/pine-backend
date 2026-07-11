import { Decimal } from 'decimal.js';

/**
 * The ONLY sanctioned representation of a currency amount in this
 * codebase. Never use `number` for money — JS floating point cannot
 * represent decimal fractions exactly (`0.1 + 0.2 !== 0.3`), which is
 * unacceptable once real deposits/withdrawals/trades are involved.
 *
 * Backed by decimal.js, immutable, and currency-aware so a Malawian
 * Kwacha amount can never be accidentally added to a USD amount.
 *
 * Persisted in Postgres as `NUMERIC(18,4)` (via Prisma `Decimal`) and
 * only ever converted to/from `Money` at the repository boundary —
 * domain and application code never touches a raw `Decimal` or
 * `number` for currency.
 */

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type CurrencyCode = 'MWK' | 'USD';

export class Money {
  private readonly amount: Decimal;
  public readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount;
    this.currency = currency;
  }

  static of(amount: Decimal.Value, currency: CurrencyCode = 'MWK'): Money {
    const decimal = new Decimal(amount);
    if (!decimal.isFinite()) {
      throw new Error(`Invalid monetary amount: ${String(amount)}`);
    }
    // Money is stored to 4 decimal places internally (sub-tambala
    // precision) to absorb rounding across multi-step calculations
    // (e.g. dividend-per-share * fractional holdings) without drift;
    // display/settlement rounds to 2 places at the edge.
    return new Money(decimal.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN), currency);
  }

  static zero(currency: CurrencyCode = 'MWK'): Money {
    return Money.of(0, currency);
  }

  /** Parses a value out of persistence (Prisma `Decimal` or string). */
  static fromPersistence(value: Decimal.Value, currency: CurrencyCode = 'MWK'): Money {
    return Money.of(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.minus(other.amount), this.currency);
  }

  multiply(factor: Decimal.Value): Money {
    return Money.of(this.amount.times(factor), this.currency);
  }

  divide(divisor: Decimal.Value): Money {
    if (new Decimal(divisor).isZero()) {
      throw new Error('Cannot divide Money by zero');
    }
    return Money.of(this.amount.dividedBy(divisor), this.currency);
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }

  isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.lessThan(other.amount);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /** Raw decimal for handing to Prisma (`Prisma.Decimal`-compatible string). */
  toPersistence(): string {
    return this.amount.toFixed(4);
  }

  /** 2-decimal-place display string without currency symbol, e.g. "1234.50". */
  toDisplayString(): string {
    return this.amount.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toFixed(2);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toDisplayString(), currency: this.currency };
  }
}
