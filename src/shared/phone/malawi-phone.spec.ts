import { describe, expect, it } from 'vitest';
import { isCanonicalMalawiPhoneNumber, normalizeMalawiPhoneNumber } from './malawi-phone';

describe('Malawi phone normalization', () => {
  it.each([
    ['+265991234567', '+265991234567'],
    ['+265 99 123 4567', '+265991234567'],
    ['+ 265 99 123 4567', '+265991234567'],
    ['+265 099 123 4567', '+265991234567'],
    ['265991234567', '+265991234567'],
    ['0991234567', '+265991234567'],
    ['99 123 4567', '+265991234567'],
    ['00265991234567', '+265991234567'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeMalawiPhoneNumber(input)).toBe(expected);
    expect(isCanonicalMalawiPhoneNumber(expected)).toBe(true);
  });

  it('leaves invalid values invalid for DTO validation to reject', () => {
    const normalized = normalizeMalawiPhoneNumber('+27123456789');

    expect(normalized).toBe('+27123456789');
    expect(isCanonicalMalawiPhoneNumber(normalized)).toBe(false);
  });
});
