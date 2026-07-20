const MALAWI_COUNTRY_CODE = '265';
const CANONICAL_MALAWI_PHONE_PATTERN = /^\+265\d{9}$/;

export function normalizeMalawiPhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const hadInternationalPrefix = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');

  if (hadInternationalPrefix && !digits.startsWith(MALAWI_COUNTRY_CODE)) {
    return trimmed;
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith(`${MALAWI_COUNTRY_CODE}0`) && digits.length === 13) {
    return `+${MALAWI_COUNTRY_CODE}${digits.slice(4)}`;
  }

  if (digits.startsWith(MALAWI_COUNTRY_CODE) && digits.length === 12) {
    return `+${digits}`;
  }

  if (digits.startsWith('0') && digits.length === 10) {
    return `+${MALAWI_COUNTRY_CODE}${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `+${MALAWI_COUNTRY_CODE}${digits}`;
  }

  return trimmed;
}

export function isCanonicalMalawiPhoneNumber(value: string): boolean {
  return CANONICAL_MALAWI_PHONE_PATTERN.test(value);
}
