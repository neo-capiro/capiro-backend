/**
 * Workstream H1 — Exact decimal arithmetic.
 *
 * Implement addition, subtraction, multiplication, absolute difference,
 * and tolerance comparison using canonical decimal strings.
 *
 * Do not use binary floating-point arithmetic. All operations work on
 * string representations.
 */
import {
  isCanonicalDecimalString,
  parseCanonicalDecimalString,
} from '../../../contracts/decimal-string.js';

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

/** Parse a canonical decimal string into sign, integer digits, fractional digits. */
function parseParts(input: string): { negative: boolean; intDigits: string; fracDigits: string } {
  const canonical = parseCanonicalDecimalString(input);
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const dotIndex = unsigned.indexOf('.');
  if (dotIndex < 0) {
    return { negative, intDigits: unsigned, fracDigits: '' };
  }
  return {
    negative,
    intDigits: unsigned.slice(0, dotIndex),
    fracDigits: unsigned.slice(dotIndex + 1),
  };
}

/** Convert parts back to a canonical decimal string. */
function partsToCanonical(negative: boolean, intDigits: string, fracDigits: string): string {
  // Normalize: strip leading zeros from int, trailing zeros from frac
  const intNorm = intDigits.replace(/^0+(?=\d)/, '') || '0';
  const fracNorm = fracDigits.replace(/0+$/, '');
  const isZero = intNorm === '0' && fracNorm === '';
  if (isZero) return '0';
  const sign = negative && !isZero ? '-' : '';
  if (fracNorm) {
    return `${sign}${intNorm}.${fracNorm}`;
  }
  return `${sign}${intNorm}`;
}

/** Pad two fractional digit strings to equal length. */
function padFracs(a: string, b: string): { a: string; b: string; len: number } {
  const len = Math.max(a.length, b.length);
  return { a: a.padEnd(len, '0'), b: b.padEnd(len, '0'), len };
}

/** Compare two unsigned integer strings (returns -1, 0, 1). */
function compareUnsignedInt(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Add two unsigned integer digit strings. */
function addUnsignedInt(a: string, b: string): string {
  const len = Math.max(a.length, b.length);
  const pa = a.padStart(len, '0');
  const pb = b.padStart(len, '0');
  let carry = 0;
  const result: string[] = [];
  for (let i = len - 1; i >= 0; i--) {
    const sum = pa.charCodeAt(i) - 48 + (pb.charCodeAt(i) - 48) + carry;
    result.push(String(sum % 10));
    carry = sum > 9 ? 1 : 0;
  }
  if (carry) result.push('1');
  return result.reverse().join('');
}

/** Subtract two unsigned integer digit strings (assumes a >= b). */
function subUnsignedInt(a: string, b: string): string {
  const len = a.length;
  const pb = b.padStart(len, '0');
  let borrow = 0;
  const result: string[] = [];
  for (let i = len - 1; i >= 0; i--) {
    let diff = a.charCodeAt(i) - 48 - (pb.charCodeAt(i) - 48) - borrow;
    if (diff < 0) {
      diff += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result.push(String(diff));
  }
  return (
    result
      .reverse()
      .join('')
      .replace(/^0+(?=\d)/, '') || '0'
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/** Add two canonical decimal strings. */
export function addDecimals(a: string, b: string): string {
  if (!isCanonicalDecimalString(a)) throw new Error(`not canonical: ${a}`);
  if (!isCanonicalDecimalString(b)) throw new Error(`not canonical: ${b}`);

  const pa = parseParts(a);
  const pb = parseParts(b);
  const fracs = padFracs(pa.fracDigits, pb.fracDigits);
  const intLen = Math.max(pa.intDigits.length, pb.intDigits.length);
  const ia = pa.intDigits.padStart(intLen, '0');
  const ib = pb.intDigits.padStart(intLen, '0');
  const fa = fracs.a;
  const fb = fracs.b;

  if (!pa.negative && !pb.negative) {
    // a + b both positive
    const intSum = addUnsignedInt(ia, ib);
    const fracSum = addUnsignedInt(fa, fb);
    // Handle carry from fractional part
    if (fracSum.length > fracs.len) {
      const carry = fracSum[0]!;
      const frac = fracSum.slice(1);
      const intPart = addUnsignedInt(intSum, carry);
      return partsToCanonical(false, intPart, frac);
    }
    return partsToCanonical(false, intSum, fracSum);
  }

  if (pa.negative && pb.negative) {
    // both negative: -( |a| + |b| )
    const result = addDecimals(a.slice(1), b.slice(1));
    return result === '0' ? '0' : `-${result}`;
  }

  // one positive, one negative: subtract
  if (pa.negative) {
    return subtractDecimals(b, a.slice(1));
  }
  return subtractDecimals(a, b.slice(1));
}

/** Subtract b from a (a - b). */
export function subtractDecimals(a: string, b: string): string {
  if (!isCanonicalDecimalString(a)) throw new Error(`not canonical: ${a}`);
  if (!isCanonicalDecimalString(b)) throw new Error(`not canonical: ${b}`);

  const pa = parseParts(a);
  const pb = parseParts(b);

  if (pb.negative) {
    // a - (-b) = a + b
    return addDecimals(a, b.slice(1));
  }
  if (pa.negative) {
    // (-a) - b = -(a + b)
    const result = addDecimals(a.slice(1), b);
    return result === '0' ? '0' : `-${result}`;
  }

  // Both positive: a - b
  const fracs = padFracs(pa.fracDigits, pb.fracDigits);
  const intLen = Math.max(pa.intDigits.length, pb.intDigits.length);
  const ia = pa.intDigits.padStart(intLen, '0');
  const ib = pb.intDigits.padStart(intLen, '0');
  const fa = fracs.a;
  const fb = fracs.b;
  const combinedA = ia + fa;
  const combinedB = ib + fb;
  const cmp = compareUnsignedInt(combinedA, combinedB);
  if (cmp === 0) return '0';
  if (cmp > 0) {
    // a > b
    const diff = subUnsignedInt(combinedA, combinedB);
    const paddedDiff = diff.padStart(intLen + fracs.len, '0');
    const intPart = paddedDiff.slice(0, paddedDiff.length - fracs.len) || '0';
    const fracPart = paddedDiff.slice(paddedDiff.length - fracs.len);
    return partsToCanonical(false, intPart, fracPart);
  }
  // a < b: result is negative
  const diff = subUnsignedInt(combinedB, combinedA);
  const paddedDiff = diff.padStart(intLen + fracs.len, '0');
  const intPart = paddedDiff.slice(0, paddedDiff.length - fracs.len) || '0';
  const fracPart = paddedDiff.slice(paddedDiff.length - fracs.len);
  return partsToCanonical(true, intPart, fracPart);
}

/** Multiply a canonical decimal by an integer string. */
export function multiplyByInteger(a: string, multiplier: string): string {
  if (!isCanonicalDecimalString(a)) throw new Error(`not canonical: ${a}`);
  const m = parseCanonicalDecimalString(multiplier);
  if (!isCanonicalDecimalString(m) || m.includes('.')) {
    throw new Error(`multiplier must be an integer: ${multiplier}`);
  }
  if (m === '0' || a === '0') return '0';

  const pa = parseParts(a);
  const mParts = parseParts(m);
  const negative = pa.negative !== mParts.negative;

  // Multiply integer+fractional digits as one big integer
  const combined = pa.intDigits + pa.fracDigits;
  const fracLen = pa.fracDigits.length;
  const mDigits = mParts.intDigits;

  // Long multiplication
  const result = multiplyDigitStrings(combined, mDigits);
  // Place decimal point: fracLen from the right
  if (fracLen === 0) {
    return partsToCanonical(negative, result, '');
  }
  if (result.length <= fracLen) {
    const padded = '0'.repeat(fracLen - result.length + 1) + result;
    const intPart = '0';
    const fracPart = padded.slice(1);
    return partsToCanonical(negative, intPart, fracPart);
  }
  const intPart = result.slice(0, result.length - fracLen);
  const fracPart = result.slice(result.length - fracLen);
  return partsToCanonical(negative, intPart, fracPart);
}

/** Multiply two digit strings (unsigned). */
function multiplyDigitStrings(a: string, b: string): string {
  if (a === '0' || b === '0') return '0';
  const result: number[] = new Array(a.length + b.length).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const product = (a.charCodeAt(i) - 48) * (b.charCodeAt(j) - 48);
      const pos = i + j + 1;
      const sum = result[pos]! + product;
      result[pos] = sum % 10;
      result[pos - 1]! += Math.floor(sum / 10);
    }
  }
  // Handle carries
  for (let i = result.length - 1; i > 0; i--) {
    if (result[i]! >= 10) {
      result[i - 1]! += Math.floor(result[i]! / 10);
      result[i] = result[i]! % 10;
    }
  }
  const str = result.join('').replace(/^0+(?=\d)/, '');
  return str || '0';
}

/** Absolute difference: |a - b| */
export function absDifference(a: string, b: string): string {
  const diff = subtractDecimals(a, b);
  return diff.startsWith('-') ? diff.slice(1) : diff;
}

/**
 * Compare two canonical decimals with tolerance.
 * Returns 0 if within tolerance, -1 if a < b - tolerance, 1 if a > b + tolerance.
 */
export function compareWithTolerance(a: string, b: string, tolerance: string): -1 | 0 | 1 {
  const aCanonical = parseCanonicalDecimalString(a);
  const bCanonical = parseCanonicalDecimalString(b);
  const diff = subtractDecimals(aCanonical, bCanonical);
  if (diff === '0') return 0;
  const absDiff = diff.startsWith('-') ? diff.slice(1) : diff;
  const cmp = compareUnsignedDecimal(absDiff, tolerance);
  if (cmp <= 0) return 0;
  return diff.startsWith('-') ? -1 : 1;
}

/** Compare two unsigned canonical decimals: -1, 0, 1 */
function compareUnsignedDecimal(a: string, b: string): -1 | 0 | 1 {
  const pa = parseParts(a);
  const pb = parseParts(b);
  const intCmp = compareUnsignedInt(
    pa.intDigits.padStart(Math.max(pa.intDigits.length, pb.intDigits.length), '0'),
    pb.intDigits.padStart(Math.max(pa.intDigits.length, pb.intDigits.length), '0'),
  );
  if (intCmp !== 0) return intCmp as -1 | 0 | 1;
  const fracs = padFracs(pa.fracDigits, pb.fracDigits);
  return compareUnsignedInt(fracs.a, fracs.b) as -1 | 0 | 1;
}

/**
 * H2. Printed-unit tolerance.
 *
 * For values printed in thousands with integer precision:
 * - one printed value has up to ±0.0005 million rounding uncertainty
 * - an N-child sum has bounded cumulative printed rounding uncertainty
 * - use a documented deterministic formula.
 *
 * Tolerance = N * 0.0005 (in millions), where N is the number of terms.
 * The result is a canonical decimal string.
 */
export function printedUnitToleranceMillions(numTerms: number): string {
  if (numTerms <= 0) return '0';
  // Each term has ±0.0005 million uncertainty (printed in thousands)
  // Total tolerance = numTerms * 0.0005
  return multiplyByInteger('0.0005', String(numTerms));
}

/** Sum a list of canonical decimal strings. */
export function sumDecimals(values: readonly string[]): string {
  if (values.length === 0) return '0';
  return values.reduce((acc, v) => addDecimals(acc, v), '0');
}
