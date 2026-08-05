/**
 * procurement-reconciliation-v1 — P-1 ↔ P-40 amount reconciliation for one
 * procurement cycle.
 *
 * For each procurement BLIN identity and FY/scope, compares the P-1 summary
 * value against the P-40 detail value. Only matching FY, value kind,
 * base/OCO status, and funding stage are compared. Missing comparison source
 * is NOT_RUN and may block certification when the manifest requires it.
 *
 * Tolerance derives from printed units and source rounding using exact
 * decimal-string arithmetic. NaN/infinity/ambiguous units reject before
 * comparison.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 */
import type { MoneyUnitV1 } from '../contracts/decimal-string.js';
import {
  comparisonTolerance,
  valuesWithinTolerance,
  compareCanonicalDecimal,
  toCanonicalDecimal,
  convertUnit,
  type PrintedUnitV1,
} from '../non-rdte/unit-semantics-v1.js';
import type { ColumnBindingV1 } from '../non-rdte/column-semantics-v1.js';
import type { ProcurementBlinIdentityV1 } from '../non-rdte/identity-v1.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

/** A funding value extracted from P-1 or P-40 for one BLIN identity, FY, and scope. */
export interface ProcurementFundingValueV1 {
  identityNaturalKey: string;
  identity: ProcurementBlinIdentityV1;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  page: number;
}

/** A quantity value extracted from P-1 or P-40. */
export interface ProcurementQuantityValueV1 {
  identityNaturalKey: string;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  quantity: string;
  page: number;
}

/** A unit-cost value extracted from P-40. */
export interface ProcurementUnitCostValueV1 {
  identityNaturalKey: string;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  unitCostDollars: string;
  page: number;
}

/* ------------------------------------------------------------------ */
/* Comparison result                                                    */
/* ------------------------------------------------------------------ */

export type ProcurementComparisonResult =
  | 'pass'
  | 'fail'
  | 'review'
  | 'not_applicable'
  | 'not_run';

export interface ProcurementFundingComparison {
  identityNaturalKey: string;
  printedCode: string;
  fiscalYear: number;
  columnRole: string;
  p1ValueMillions?: string;
  p40ValueMillions?: string;
  result: ProcurementComparisonResult;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/** Scope key for matching P-1 and P-40 values: identity + FY + base/OCO + stage. */
function scopeKey(
  identityNaturalKey: string,
  fiscalYear: number | undefined,
  binding: ColumnBindingV1,
): string {
  return `${identityNaturalKey}|${fiscalYear ?? 'none'}|${binding.baseOcoStatus}|${binding.fundingStage}|${binding.valueKind}`;
}

/**
 * Reconcile P-1 and P-40 funding values for every matching BLIN identity,
 * FY, and scope. Only values with matching FY, value kind, base/OCO status,
 * and funding stage are compared.
 *
 * Rules:
 *   - Missing P-1 or P-40 for a scope is NOT_RUN, never pass.
 *   - P-1 base and P-40 advance cannot reconcile (different identities).
 *   - NaN/infinity/ambiguous units reject before comparison.
 *   - Tolerance derives from printed units and source rounding.
 *   - Same line code in different accounts remains separate (by natural key).
 */
export function reconcileProcurementFunding(input: {
  p1Values: readonly ProcurementFundingValueV1[];
  p40Values: readonly ProcurementFundingValueV1[];
}): ProcurementFundingComparison[] {
  const { p1Values, p40Values } = input;
  const comparisons: ProcurementFundingComparison[] = [];

  /* Build scope-keyed maps for P-1 and P-40. */
  const p1ByKey = new Map<string, ProcurementFundingValueV1[]>();
  for (const v of p1Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.columnBinding);
    const list = p1ByKey.get(key) ?? [];
    list.push(v);
    p1ByKey.set(key, list);
  }
  const p40ByKey = new Map<string, ProcurementFundingValueV1[]>();
  for (const v of p40Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.columnBinding);
    const list = p40ByKey.get(key) ?? [];
    list.push(v);
    p40ByKey.set(key, list);
  }

  /* All unique scope keys from both sides. */
  const allKeys = new Set<string>([...p1ByKey.keys(), ...p40ByKey.keys()]);

  for (const key of allKeys) {
    const p1List = p1ByKey.get(key) ?? [];
    const p40List = p40ByKey.get(key) ?? [];

    /* If neither side has values, skip. */
    if (p1List.length === 0 && p40List.length === 0) continue;

    const first = p1List[0] ?? p40List[0]!;
    const identityKey = first.identityNaturalKey;
    const fiscalYear = first.fiscalYear;
    const columnRole = first.columnBinding.fundingStage;
    const printedCode = first.identity.printedCode;

    /* Missing P-1 or P-40 → NOT_RUN */
    if (p1List.length === 0 || p40List.length === 0) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        ...(p1List.length > 0 ? { p1ValueMillions: p1List[0]!.valueMillions } : {}),
        ...(p40List.length > 0 ? { p40ValueMillions: p40List[0]!.valueMillions } : {}),
        result: 'not_run',
        message: `Missing ${p1List.length === 0 ? 'P-1' : 'P-40'} for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    /* Multiple values on the same side for the same scope → review (conflict). */
    if (p1List.length > 1 || p40List.length > 1) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        p1ValueMillions: p1List[0]!.valueMillions,
        p40ValueMillions: p40List[0]!.valueMillions,
        result: 'review',
        message: `Multiple ${p1List.length > 1 ? 'P-1' : 'P-40'} values for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    const p1Val = p1List[0]!;
    const p40Val = p40List[0]!;

    /* Reject NaN/infinity/ambiguous units before comparison. */
    try {
      toCanonicalDecimal(p1Val.valueMillions);
      toCanonicalDecimal(p40Val.valueMillions);
    } catch {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        p1ValueMillions: p1Val.valueMillions,
        p40ValueMillions: p40Val.valueMillions,
        result: 'review',
        message: `Non-finite or ambiguous value for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    /* If units differ, convert both to millions for comparison. */
    /* Both values are already in millions (valueMillions field). */
    const tolerance = comparisonTolerance(p1Val.originalUnit, p40Val.originalUnit);
    const within = valuesWithinTolerance(p1Val.valueMillions, p40Val.valueMillions, tolerance);
    const exact = compareCanonicalDecimal(p1Val.valueMillions, p40Val.valueMillions) === 0;

    if (exact) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        p1ValueMillions: p1Val.valueMillions,
        p40ValueMillions: p40Val.valueMillions,
        result: 'pass',
        message: `P-1 and P-40 match exactly for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
    } else if (within) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        p1ValueMillions: p1Val.valueMillions,
        p40ValueMillions: p40Val.valueMillions,
        result: 'pass',
        message: `P-1 and P-40 within tolerance for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
    } else {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        p1ValueMillions: p1Val.valueMillions,
        p40ValueMillions: p40Val.valueMillions,
        result: 'fail',
        message: `P-1 (${p1Val.valueMillions}) != P-40 (${p40Val.valueMillions}) for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
    }
  }

  /* Deterministic ordering. */
  comparisons.sort((a, b) => {
    const nk = a.identityNaturalKey.localeCompare(b.identityNaturalKey);
    if (nk !== 0) return nk;
    return a.columnRole.localeCompare(b.columnRole);
  });

  return comparisons;
}

/* ------------------------------------------------------------------ */
/* Unit-converted comparison helper                                    */
/* ------------------------------------------------------------------ */

/**
 * Check whether two values in potentially different printed units are
 * equivalent after unit conversion. Returns pass/fail/not_applicable.
 */
export function compareUnitConvertedValues(
  valueA: string,
  unitA: PrintedUnitV1,
  valueB: string,
  unitB: PrintedUnitV1,
): { result: 'pass' | 'fail' | 'not_applicable'; message: string } {
  try {
    const aInMillions = convertUnit(valueA, unitA, 'millions');
    const bInMillions = convertUnit(valueB, unitB, 'millions');
    const tolerance = comparisonTolerance(unitA, unitB);
    const within = valuesWithinTolerance(aInMillions, bInMillions, tolerance);
    return {
      result: within ? 'pass' : 'fail',
      message: within
        ? `values match within tolerance after unit conversion`
        : `values differ after unit conversion: ${aInMillions} vs ${bInMillions} millions`,
    };
  } catch {
    return {
      result: 'not_applicable',
      message: 'unit conversion failed — ambiguous or unsupported unit',
    };
  }
}
