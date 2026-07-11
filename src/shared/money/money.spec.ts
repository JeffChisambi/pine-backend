import { describe, expect, it } from 'vitest';
import { Money } from './money';

describe('Money', () => {
  it('adds two amounts of the same currency correctly', () => {
    const a = Money.of('100.10', 'MWK');
    const b = Money.of('50.05', 'MWK');
    expect(a.add(b).toDisplayString()).toBe('150.15');
  });

  it('never loses precision the way floating point would', () => {
    // The canonical float trap: 0.1 + 0.2 !== 0.3 in JS numbers.
    const a = Money.of('0.1', 'MWK');
    const b = Money.of('0.2', 'MWK');
    expect(a.add(b).toDisplayString()).toBe('0.30');
  });

  it('throws when mixing currencies', () => {
    const mwk = Money.of('100', 'MWK');
    const usd = Money.of('100', 'USD');
    expect(() => mwk.add(usd)).toThrow(/Currency mismatch/);
  });

  it('throws when dividing by zero', () => {
    const money = Money.of('100', 'MWK');
    expect(() => money.divide(0)).toThrow(/divide Money by zero/);
  });

  it('correctly compares amounts', () => {
    const bigger = Money.of('200', 'MWK');
    const smaller = Money.of('100', 'MWK');
    expect(bigger.isGreaterThan(smaller)).toBe(true);
    expect(smaller.isGreaterThan(bigger)).toBe(false);
    expect(bigger.equals(Money.of('200', 'MWK'))).toBe(true);
  });

  it('rejects a non-finite amount', () => {
    expect(() => Money.of(Number.NaN, 'MWK')).toThrow(/Invalid monetary amount/);
  });

  it('rounds display output to 2 decimal places while retaining 4 internally', () => {
    const money = Money.of('10.12345', 'MWK');
    expect(money.toDisplayString()).toBe('10.12');
    expect(money.toPersistence()).toBe('10.1234'); // ROUND_HALF_EVEN at 4dp: 4 is already even
  });

  it('detects negative and zero amounts', () => {
    expect(Money.zero('MWK').isZero()).toBe(true);
    expect(Money.of('-5', 'MWK').isNegative()).toBe(true);
  });
});
