/**
 * rdte-rounding-policy-v1 — exact source-unit rounding tolerance for RDT&E
 * reconciliation.
 *
 * Rules (Phase 4 plan §7):
 *   - independent printed values: max_difference = 1 printed unit;
 *   - total vs N printed child rows: max_difference = (N + 1) × 0.5 printed units;
 *   - no generic percent tolerance;
 *   - all arithmetic on canonical decimal strings — never binary floats.
 */
import { z } from 'zod';
import {
  isCanonicalDecimalString,
  parseCanonicalDecimalString,
  scaleDecimalString,
  type MoneyUnitV1,
} from '../contracts/decimal-string.js';

const canonicalDecimal = z
  .string()
  .refine(isCanonicalDecimalString, { message: 'expected canonical decimal string' });

export const rdteRoundingPolicyV1Schema = z
  .object({
    policyId: z.literal('rdte_source_unit_rounding_v1'),
    unit: z.enum(['dollars', 'thousands', 'millions']),
  })
  .strict();
export type RdteRoundingPolicyV1 = z.infer<typeof rdteRoundingPolicyV1Schema>;

export const RDTE_SOURCE_UNIT_ROUNDING_V1: RdteRoundingPolicyV1 = {
  policyId: 'rdte_source_unit_rounding_v1',
  unit: 'millions',
};

/** Unit scale relative to millions: thousands = 1e-3, dollars = 1e-6. */
function unitToMillionsScale(unit: MoneyUnitV1): number {
  switch (unit) {
    case 'millions':
      return 0;
    case 'thousands':
      return -3;
    case 'dollars':
      return -6;
  }
}

/**
 * Exact decimal-string absolute difference |a - b|.
 * Both inputs must be canonical decimal strings in the SAME unit.
 * Returns a canonical decimal string in that unit.
 */
export function exactAbsDifference(a: string, b: string): string {
  const ca = parseCanonicalDecimalString(a);
  const cb = parseCanonicalDecimalString(b);
  // Decimal subtraction via scaled integers to avoid binary float.
  const scale = Math.max(decimalPlaces(ca), decimalPlaces(cb));
  const ai = toScaledInt(ca, scale);
  const bi = toScaledInt(cb, scale);
  const diff = ai >= bi ? ai - bi : bi - ai;
  return fromScaledInt(diff, scale);
}

/** True when |a - b| <= tolerance, all in the same unit, exact arithmetic. */
export function withinExactTolerance(a: string, b: string, tolerance: string): boolean {
  const diff = exactAbsDifference(a, b);
  return compareCanonicalDecimal(diff, parseCanonicalDecimalString(tolerance)) <= 0;
}

/**
 * Tolerance for two independently rounded values printed in the same unit.
 * Result is expressed in MILLIONS as a canonical decimal string.
 *
 * max_difference = 1 printed unit.
 */
export function independentPrintedValueToleranceMillions(unit: MoneyUnitV1): string {
  return scaleDecimalString('1', unitToMillionsScale(unit));
}

/**
 * Tolerance for a printed total versus the sum of N printed child rows,
 * all in the same unit. Result is in MILLIONS as a canonical decimal string.
 *
 * max_difference = (N + 1) × 0.5 printed units.
 */
export function totalVsChildrenToleranceMillions(childCount: number, unit: MoneyUnitV1): string {
  if (!Number.isInteger(childCount) || childCount < 0) {
    throw new Error(`childCount must be a non-negative integer, got: ${childCount}`);
  }
  // (N + 1) * 0.5 printed units, computed exactly.
  // (N+1)*0.5 = (N+1)/2; keep as exact decimal: even N+1 -> integer, odd -> .5
  const nPlusOne = childCount + 1;
  const halfUnits = nPlusOne % 2 === 0 ? String(nPlusOne / 2) : `${Math.floor(nPlusOne / 2)}.5`;
  return scaleDecimalString(halfUnits, unitToMillionsScale(unit));
}

/* ------------------------------------------------------------------ */
/* internals — exact decimal-string arithmetic                          */
/* ------------------------------------------------------------------ */

function decimalPlaces(canonical: string): number {
  const dot = canonical.indexOf('.');
  return dot >= 0 ? canonical.length - dot - 1 : 0;
}

/** Convert canonical decimal string to a scaled BigInt (exact). */
function toScaledInt(canonical: string, scale: number): bigint {
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const dot = unsigned.indexOf('.');
  const intPart = dot >= 0 ? unsigned.slice(0, dot) : unsigned;
  const fracPart = dot >= 0 ? unsigned.slice(dot + 1) : '';
  const paddedFrac = fracPart.padEnd(scale, '0');
  const digits = (intPart + paddedFrac).replace(/^0+(?=\d)/, '') || '0';
  const value = BigInt(digits);
  return negative ? -value : value;
}

/** Convert a scaled non-negative BigInt back to canonical decimal string. */
function fromScaledInt(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const intPart = digits.slice(0, digits.length - scale) || '0';
  const fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/** Compare two canonical decimal strings: -1, 0, 1. Exact. */
export function compareCanonicalDecimal(a: string, b: string): number {
  const scale = Math.max(decimalPlaces(a), decimalPlaces(b));
  const ai = toScaledInt(a, scale);
  const bi = toScaledInt(b, scale);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}
