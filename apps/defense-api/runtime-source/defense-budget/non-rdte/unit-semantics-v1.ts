/**
 * unit-semantics-v1 — printed-unit semantics and exact scaling for non-RDT&E
 * budget extraction.
 *
 * Rules:
 *   - Store numeric source values as canonical decimal strings.
 *   - Do not infer units by magnitude.
 *   - Do not truncate quantities.
 *   - Define source-specific rounding/tolerance helpers based on printed units.
 *   - Add scope compatibility checks so summary/detail arithmetic compares
 *     like with like.
 *
 * Pure module. No binary floating-point in authoritative extraction values.
 */
import {
  parseCanonicalDecimalString,
  scaleDecimalString,
  moneyToMillionsString,
  type MoneyUnitV1,
} from '../contracts/decimal-string.js';

/* ------------------------------------------------------------------ */
/* Printed unit vocabulary (extends contract MoneyUnitV1)              */
/* ------------------------------------------------------------------ */

export type PrintedUnitV1 = MoneyUnitV1;

export const PRINTED_UNIT_V1_VALUES = ['dollars', 'thousands', 'millions'] as const;

/* ------------------------------------------------------------------ */
/* Unit detection from source labels                                    */
/* ------------------------------------------------------------------ */

/**
 * Detect the printed unit from a table/section label.
 * Only detects from explicit text; never infers by magnitude.
 * Returns undefined when no unit label is found.
 */
export function detectPrintedUnit(label: string | undefined): PrintedUnitV1 | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase();
  if (l.includes('million')) return 'millions';
  if (l.includes('thousand')) return 'thousands';
  if (l.includes('dollar')) return 'dollars';
  return undefined;
}

/**
 * Detect the printed unit from a table label, throwing when no unit is found.
 * Use for tables where a unit is required.
 */
export function requirePrintedUnit(label: string | undefined): PrintedUnitV1 {
  const unit = detectPrintedUnit(label);
  if (unit == null) {
    throw new Error(`unable to detect printed unit from label: "${label ?? '(none)'}"`);
  }
  return unit;
}

/* ------------------------------------------------------------------ */
/* Exact value conversion                                               */
/* ------------------------------------------------------------------ */

/**
 * Convert a source value to canonical decimal string form.
 * Rejects NaN, Infinity, blank, exponential notation.
 */
export function toCanonicalDecimal(value: string | number): string {
  return parseCanonicalDecimalString(value);
}

/**
 * Convert a value from one printed unit to another exactly.
 * Uses decimal-point movement, never binary floating-point.
 */
export function convertUnit(
  value: string | number,
  fromUnit: PrintedUnitV1,
  toUnit: PrintedUnitV1,
): string {
  if (fromUnit === toUnit) return toCanonicalDecimal(value);
  const canonical = toCanonicalDecimal(value);
  // Calculate the decimal-place shift between units.
  const fromPlaces = unitDecimalPlaces(fromUnit);
  const toPlaces = unitDecimalPlaces(toUnit);
  return scaleDecimalString(canonical, fromPlaces - toPlaces);
}

function unitDecimalPlaces(unit: PrintedUnitV1): number {
  switch (unit) {
    case 'dollars':
      return 0;
    case 'thousands':
      return 3;
    case 'millions':
      return 6;
    default: {
      const exhaustive: never = unit;
      throw new Error(`unsupported printed unit: ${String(exhaustive)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tolerance and comparison                                             */
/* ------------------------------------------------------------------ */

/**
 * Tolerance for comparing two money values given their printed units.
 *
 * Budget documents print in thousands or millions with finite precision.
 * A value printed in thousands has inherent ±0.5 thousands uncertainty
 * (rounding to the nearest thousand). A value in millions has ±0.5 millions.
 *
 * This function returns the absolute tolerance in the target unit (millions)
 * for comparing two values that may have different source units.
 */
export function comparisonTolerance(unitA: PrintedUnitV1, unitB: PrintedUnitV1): string {
  // Each source has ±0.5 of its own unit. Combined tolerance in millions:
  const tolA = moneyToMillionsString('0.5', unitA);
  const tolB = moneyToMillionsString('0.5', unitB);
  // Sum tolerances exactly (they are small integers or simple decimals).
  return addCanonicalDecimals(tolA, tolB);
}

/**
 * Compare two canonical decimal strings.
 * Returns -1, 0, or 1.
 */
export function compareCanonicalDecimal(a: string, b: string): number {
  const aVal = parseCanonicalDecimalString(a);
  const bVal = parseCanonicalDecimalString(b);
  const aNeg = aVal.startsWith('-');
  const bNeg = bVal.startsWith('-');
  if (aNeg && !bNeg) return -1;
  if (!aNeg && bNeg) return 1;
  const aAbs = aNeg ? aVal.slice(1) : aVal;
  const bAbs = bNeg ? bVal.slice(1) : bVal;
  const cmp = compareAbsDecimal(aAbs, bAbs);
  return aNeg ? -cmp : cmp;
}

/**
 * Check if two values are within tolerance.
 */
export function valuesWithinTolerance(a: string, b: string, toleranceMillions: string): boolean {
  const diff = absDiffCanonicalDecimals(a, b);
  return compareCanonicalDecimal(diff, toleranceMillions) <= 0;
}

/* ------------------------------------------------------------------ */
/* Scope compatibility                                                  */
/* ------------------------------------------------------------------ */

export type ValueScopeV1 =
  | 'total'
  | 'base'
  | 'oco'
  | 'ooc'
  | 'prior_actual'
  | 'current_enacted'
  | 'budget_year_request'
  | 'outyear_projection'
  | 'quantity'
  | 'unit_cost'
  | 'non_annual';

/**
 * Check whether two values are scope-compatible for arithmetic comparison.
 * Only values with matching scopes can be meaningfully compared.
 */
export function isScopeCompatible(a: ValueScopeV1, b: ValueScopeV1): boolean {
  if (a === b) return true;
  // Total can be compared with base+OCO sum, but only by the caller building
  // the sum. At the individual-value level, total and base are not directly
  // comparable.
  return false;
}

/* ------------------------------------------------------------------ */
/* Quantity handling                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse a quantity value as a canonical decimal string.
 * Fractional quantities are preserved or explicitly rejected according to
 * declared source semantics; never silently truncated.
 */
export function parseQuantity(
  value: string | number,
  options?: { allowFractional?: boolean },
): string {
  const canonical = parseCanonicalDecimalString(value);
  const isFractional = canonical.includes('.');
  if (isFractional && !options?.allowFractional) {
    throw new Error(`fractional quantity not allowed by source semantics: ${canonical}`);
  }
  return canonical;
}

/* ------------------------------------------------------------------ */
/* Internals                                                            */
/* ------------------------------------------------------------------ */

function addCanonicalDecimals(a: string, b: string): string {
  // Simple exact addition of two canonical decimal strings.
  const aParsed = parseCanonicalDecimalString(a);
  const bParsed = parseCanonicalDecimalString(b);
  const aNeg = aParsed.startsWith('-');
  const bNeg = bParsed.startsWith('-');
  const aAbs = aNeg ? aParsed.slice(1) : aParsed;
  const bAbs = bNeg ? bParsed.slice(1) : bParsed;

  if (aNeg && bNeg) {
    return '-' + addAbsDecimals(aAbs, bAbs);
  }
  if (!aNeg && !bNeg) {
    return addAbsDecimals(aAbs, bAbs);
  }
  // Mixed signs: subtract
  const cmp = compareAbsDecimal(aAbs, bAbs);
  if (cmp === 0) return '0';
  if (cmp > 0) {
    const result = subAbsDecimals(aAbs, bAbs);
    return (aNeg ? '-' : '') + result;
  }
  const result = subAbsDecimals(bAbs, aAbs);
  return (bNeg ? '-' : '') + result;
}

function addAbsDecimals(a: string, b: string): string {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const aInt = aParts[0] ?? '0';
  const aFrac = aParts[1] ?? '';
  const bInt = bParts[0] ?? '0';
  const bFrac = bParts[1] ?? '';
  const maxFrac = Math.max(aFrac.length, bFrac.length);
  const aPadded = aFrac.padEnd(maxFrac, '0');
  const bPadded = bFrac.padEnd(maxFrac, '0');
  let carry = 0;
  const fracResult: number[] = [];
  for (let i = maxFrac - 1; i >= 0; i--) {
    const sum = Number(aPadded[i] ?? '0') + Number(bPadded[i] ?? '0') + carry;
    fracResult.unshift(sum % 10);
    carry = Math.floor(sum / 10);
  }
  const intA = aInt ?? '0';
  const intB = bInt ?? '0';
  const intResult: number[] = [];
  let i = intA.length - 1;
  let j = intB.length - 1;
  while (i >= 0 || j >= 0 || carry > 0) {
    const dA = i >= 0 ? Number(intA[i--]) : 0;
    const dB = j >= 0 ? Number(intB[j--]) : 0;
    const sum = dA + dB + carry;
    intResult.unshift(sum % 10);
    carry = Math.floor(sum / 10);
  }
  const intStr = intResult.join('').replace(/^0+(?=\d)/, '') || '0';
  const fracStr = fracResult.join('').replace(/0+$/, '');
  if (fracStr.length === 0) return intStr;
  return `${intStr}.${fracStr}`;
}

function subAbsDecimals(a: string, b: string): string {
  // a > b (both positive, canonical)
  const aParts = a.split('.');
  const bParts = b.split('.');
  const aInt = aParts[0] ?? '0';
  const aFrac = aParts[1] ?? '';
  const bInt = bParts[0] ?? '0';
  const bFrac = bParts[1] ?? '';
  const maxFrac = Math.max(aFrac.length, bFrac.length);
  const aPadded = aFrac.padEnd(maxFrac, '0');
  const bPadded = bFrac.padEnd(maxFrac, '0');
  let borrow = 0;
  const fracResult: number[] = [];
  for (let i = maxFrac - 1; i >= 0; i--) {
    let dA = Number(aPadded[i] ?? '0') - borrow;
    const dB = Number(bPadded[i] ?? '0');
    if (dA < dB) {
      dA += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    fracResult.unshift(dA - dB);
  }
  const intResult: number[] = [];
  let i = (aInt ?? '0').length - 1;
  let j = (bInt ?? '0').length - 1;
  while (i >= 0) {
    let dA = Number(aInt[i--]) - borrow;
    const dB = j >= 0 ? Number(bInt[j--]) : 0;
    if (dA < dB) {
      dA += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    intResult.unshift(dA - dB);
  }
  const intStr = intResult.join('').replace(/^0+(?=\d)/, '') || '0';
  const fracStr = fracResult.join('').replace(/0+$/, '');
  if (fracStr.length === 0) return intStr;
  return `${intStr}.${fracStr}`;
}

function compareAbsDecimal(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const aInt = aParts[0] ?? '0';
  const aFrac = aParts[1] ?? '';
  const bInt = bParts[0] ?? '0';
  const bFrac = bParts[1] ?? '';
  // Compare integer parts by length then lexicographically.
  if (aInt.length > bInt.length) return 1;
  if (aInt.length < bInt.length) return -1;
  if (aInt > bInt) return 1;
  if (aInt < bInt) return -1;
  // Compare fractional parts.
  const maxFrac = Math.max(aFrac.length, bFrac.length);
  const aPadded = aFrac.padEnd(maxFrac, '0');
  const bPadded = bFrac.padEnd(maxFrac, '0');
  if (aPadded > bPadded) return 1;
  if (aPadded < bPadded) return -1;
  return 0;
}

function absDiffCanonicalDecimals(a: string, b: string): string {
  const cmp = compareCanonicalDecimal(a, b);
  if (cmp === 0) return '0';
  if (cmp > 0) {
    const aAbs = a.startsWith('-') ? a.slice(1) : a;
    const bAbs = b.startsWith('-') ? b.slice(1) : b;
    return subAbsDecimals(aAbs, bAbs);
  }
  const aAbs = a.startsWith('-') ? a.slice(1) : a;
  const bAbs = b.startsWith('-') ? b.slice(1) : b;
  return subAbsDecimals(bAbs, aAbs);
}
