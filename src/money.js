// Money helpers: prices are stored as integer cents. No floating-point math is used.

// Non-negative decimal: no sign, no exponent, no leading zeros (except a lone "0"),
// integer part required, optional fraction of 1-2 digits.
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parse a decimal price string (e.g. "14.99") into integer cents (1499).
 * Returns `null` when the input is not a strictly valid price:
 * non-string, negative, non-numeric, more than 2 decimal places,
 * or too large to be represented as a safe integer number of cents.
 */
export function decimalToCents(value) {
  if (typeof value !== 'string') return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return null;

  const [, whole, fraction = ''] = match;
  // BigInt keeps the arithmetic exact even for very long digit strings.
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > MAX_CENTS) return null;
  return Number(cents);
}

/**
 * Format integer cents (1499) as a decimal string with exactly 2 places ("14.99").
 * Throws a TypeError if `cents` is not a non-negative safe integer.
 */
export function centsToDecimal(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new TypeError('cents must be a non-negative safe integer');
  }
  const digits = String(cents).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
