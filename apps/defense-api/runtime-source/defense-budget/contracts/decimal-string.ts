/**
 * Exact decimal-string helpers for the defense-budget extraction contract.
 *
 * Money is represented as canonical decimal strings, never as JavaScript binary
 * floats. Scaling is performed by decimal-point movement on the string, not by
 * floating-point multiplication/division, so values like 1250 thousands ->
 * 1.25 millions are exact.
 *
 * Canonical form rules:
 *   - finite, non-exponential decimal string
 *   - optional leading '-'
 *   - no unnecessary leading zeros ("007" -> "7", "00.5" -> "0.5")
 *   - no unnecessary trailing fractional zeros ("1.2500" -> "1.25")
 *   - "-0" normalizes to "0"
 *   - blank strings, commas, NaN/Infinity, and malformed input are rejected
 */

export type MoneyUnitV1 = 'dollars' | 'thousands' | 'millions';

const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** True when the string is already in canonical decimal form. */
export function isCanonicalDecimalString(input: string): boolean {
  if (!CANONICAL_DECIMAL_RE.test(input)) return false;
  // Reject "-0" and "-0.x" style negative zero / unnecessary leading zeros are
  // already excluded by the regex (0 or non-zero-leading integer part).
  if (input.startsWith('-0') && (input === '-0' || input.startsWith('-0.'))) {
    // "-0" and "-0.x" are not canonical: -0 -> 0, and -0.x is only reachable
    // when the value is negative fractional, which canonical form writes as
    // "-0.x" legitimately. Only bare "-0" is rejected.
    return input !== '-0';
  }
  // Reject trailing fractional zeros ("1.2500").
  const dot = input.indexOf('.');
  if (dot >= 0 && input.endsWith('0')) return false;
  return true;
}

/**
 * Parse a string|number into a canonical decimal string.
 * Throws on NaN, Infinity, blank, comma-containing, exponential, or malformed input.
 */
export function parseCanonicalDecimalString(input: string | number): string {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`non-finite numeric input: ${input}`);
    }
    if (Object.is(input, -0)) return '0';
    // Number -> string without exponential notation.
    return normalizeDecimalString(numberToPlainString(input));
  }
  return normalizeDecimalString(input);
}

/** Convert an integer-valued input to canonical string form. */
export function integerToCanonicalString(input: string | number): string {
  const canonical = parseCanonicalDecimalString(input);
  if (canonical.includes('.')) {
    throw new Error(`expected integer value, got: ${canonical}`);
  }
  return canonical;
}

/**
 * Scale a canonical decimal string by moving the decimal point.
 * Positive decimalPlaces multiplies by 10^places; negative divides.
 * The result is canonical.
 */
export function scaleDecimalString(input: string, decimalPlaces: number): string {
  if (!Number.isInteger(decimalPlaces)) {
    throw new Error(`decimalPlaces must be an integer, got: ${decimalPlaces}`);
  }
  const canonical = parseCanonicalDecimalString(input);
  if (canonical === '0') return '0';

  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const dotIndex = unsigned.indexOf('.');
  const intPart = dotIndex >= 0 ? unsigned.slice(0, dotIndex) : unsigned;
  const fracPart = dotIndex >= 0 ? unsigned.slice(dotIndex + 1) : '';
  const digits = intPart + fracPart;
  // value = digits * 10^(-fracPart.length); scaled by 10^decimalPlaces the new
  // number of fractional digits is fracPart.length - decimalPlaces.
  const newFracLen = fracPart.length - decimalPlaces;

  let newInt: string;
  let newFrac: string;
  if (newFracLen <= 0) {
    // All digits land in the integer part; pad zeros on the right.
    newInt = digits + '0'.repeat(-newFracLen);
    newFrac = '';
  } else if (newFracLen >= digits.length) {
    // All digits land in the fractional part; pad zeros after the point.
    newInt = '0';
    newFrac = '0'.repeat(newFracLen - digits.length) + digits;
  } else {
    newInt = digits.slice(0, digits.length - newFracLen);
    newFrac = digits.slice(digits.length - newFracLen);
  }

  const combined = (negative ? '-' : '') + newInt + (newFrac.length > 0 ? `.${newFrac}` : '');
  return normalizeDecimalString(combined);
}

/** Exact conversion of a money value to USD millions as a canonical string. */
export function moneyToMillionsString(value: string | number, unit: MoneyUnitV1): string {
  const canonical = parseCanonicalDecimalString(value);
  switch (unit) {
    case 'millions':
      return canonical;
    case 'thousands':
      return scaleDecimalString(canonical, -3);
    case 'dollars':
      return scaleDecimalString(canonical, -6);
    default: {
      const exhaustive: never = unit;
      throw new Error(`unsupported money unit: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Render a finite number as a plain (non-exponential) decimal string. */
function numberToPlainString(input: number): string {
  const raw = String(input);
  if (!/[eE]/.test(raw)) return raw;
  // Expand exponential notation exactly using the coefficient digits.
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) throw new Error(`malformed numeric string: ${raw}`);
  const [, sign = '', intDigits = '', fracDigits = '', expRaw = '0'] = match;
  const exponent = Number.parseInt(expRaw, 10);
  const digits = intDigits + fracDigits;
  // coefficient = digits * 10^(-fracDigits.length); times 10^exponent.
  const newFracLen = fracDigits.length - exponent;
  if (newFracLen <= 0) {
    return `${sign}${digits}${'0'.repeat(-newFracLen)}`;
  }
  if (newFracLen >= digits.length) {
    return `${sign}0.${'0'.repeat(newFracLen - digits.length)}${digits}`;
  }
  return `${sign}${digits.slice(0, digits.length - newFracLen)}.${digits.slice(
    digits.length - newFracLen,
  )}`;
}

/** Normalize a decimal string to canonical form. Throws on malformed input. */
function normalizeDecimalString(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('blank decimal string');
  if (/[eE]/.test(trimmed)) {
    throw new Error(`exponential notation is not allowed: ${input}`);
  }
  if (trimmed.includes(',')) {
    throw new Error(`commas must be normalized by the adapter before parsing: ${input}`);
  }
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new Error(`malformed decimal string: ${input}`);
  const [, sign = '', intRaw = '', fracRaw = ''] = match;
  if (intRaw === '' && fracRaw === '') throw new Error(`malformed decimal string: ${input}`);

  // Strip leading zeros from the integer part.
  const intStripped = intRaw.replace(/^0+(?=\d)/, '');
  const intPart = intStripped === '' && fracRaw !== '' ? '0' : intStripped;
  // Strip trailing zeros from the fractional part.
  const fracStripped = fracRaw.replace(/0+$/, '');

  let result: string;
  if (fracRaw !== '' || trimmed.includes('.')) {
    result = fracStripped.length > 0 ? `${intPart}.${fracStripped}` : intPart;
  } else {
    result = intPart;
  }
  if (result === '' || result === '.') throw new Error(`malformed decimal string: ${input}`);
  // Collapse -0 / -0.0 to 0.
  if (sign === '-' && /^0+(?:\.0+)?$/.test(result)) return '0';
  return sign + result;
}
