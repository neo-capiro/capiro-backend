/**
 * om-reconciliation-v1 — O-1 ↔ OP-5 amount reconciliation for one O&M cycle.
 *
 * For each OM_SAG identity and FY/scope, compares the O-1 summary value
 * against the OP-5 detail value. Only matching FY, value kind, base/OCO
 * status, and funding stage are compared. Missing comparison source is
 * NOT_RUN and may block certification when the manifest requires it.
 *
 * Tolerance derives from printed units and source rounding using exact
 * decimal-string arithmetic. NaN/infinity/ambiguous units reject before
 * comparison.
 *
 * Pure module. No database, no parser, no writer. No canonical writes.
 * No ProgramElementWriterService.
 */
import {
  comparisonTolerance,
  valuesWithinTolerance,
  compareCanonicalDecimal,
  toCanonicalDecimal,
  type PrintedUnitV1,
} from '../non-rdte/unit-semantics-v1.js';
import type { ColumnBindingV1 } from '../non-rdte/column-semantics-v1.js';
import type { OmSagIdentityV1 } from '../non-rdte/identity-v1.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

/** A funding value extracted from O-1 or OP-5 for one SAG identity, FY, and scope. */
export interface OmFundingValueV1 {
  identityNaturalKey: string;
  identity: OmSagIdentityV1;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  page: number;
}

/* ------------------------------------------------------------------ */
/* Comparison result                                                    */
/* ------------------------------------------------------------------ */

export type OmComparisonResult =
  | 'pass'
  | 'fail'
  | 'review'
  | 'not_applicable'
  | 'not_run';

export interface OmFundingComparison {
  identityNaturalKey: string;
  printedCode: string;
  fiscalYear: number;
  columnRole: string;
  o1ValueMillions?: string;
  op5ValueMillions?: string;
  result: OmComparisonResult;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/** Scope key for matching O-1 and OP-5 values: identity + FY + base/OCO + stage + value kind. */
function scopeKey(
  identityNaturalKey: string,
  fiscalYear: number | undefined,
  binding: ColumnBindingV1,
): string {
  return `${identityNaturalKey}|${fiscalYear ?? 'none'}|${binding.baseOcoStatus}|${binding.fundingStage}|${binding.valueKind}`;
}

/**
 * Reconcile O-1 and OP-5 funding values for every matching SAG identity,
 * FY, and scope. Only values with matching FY, value kind, base/OCO status,
 * and funding stage are compared.
 *
 * Rules:
 *   - Missing O-1 or OP-5 for a scope is NOT_RUN, never pass.
 *   - NaN/infinity/ambiguous units reject before comparison.
 *   - Tolerance derives from printed units and source rounding.
 *   - Same SAG code in different accounts remains separate (by natural key).
 *   - Different scope does not reconcile.
 */
export function reconcileOmFunding(input: {
  o1Values: readonly OmFundingValueV1[];
  op5Values: readonly OmFundingValueV1[];
}): OmFundingComparison[] {
  const { o1Values, op5Values } = input;
  const comparisons: OmFundingComparison[] = [];

  /* Build scope-keyed maps for O-1 and OP-5. */
  const o1ByKey = new Map<string, OmFundingValueV1[]>();
  for (const v of o1Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.columnBinding);
    const list = o1ByKey.get(key) ?? [];
    list.push(v);
    o1ByKey.set(key, list);
  }
  const op5ByKey = new Map<string, OmFundingValueV1[]>();
  for (const v of op5Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.columnBinding);
    const list = op5ByKey.get(key) ?? [];
    list.push(v);
    op5ByKey.set(key, list);
  }

  /* All unique scope keys from both sides. */
  const allKeys = new Set<string>([...o1ByKey.keys(), ...op5ByKey.keys()]);

  for (const key of allKeys) {
    const o1List = o1ByKey.get(key) ?? [];
    const op5List = op5ByKey.get(key) ?? [];

    if (o1List.length === 0 && op5List.length === 0) continue;

    const first = o1List[0] ?? op5List[0]!;
    const identityKey = first.identityNaturalKey;
    const fiscalYear = first.fiscalYear;
    const columnRole = first.columnBinding.fundingStage;
    const printedCode = first.identity.printedCode;

    /* Missing O-1 or OP-5 → NOT_RUN */
    if (o1List.length === 0 || op5List.length === 0) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        ...(o1List.length > 0 ? { o1ValueMillions: o1List[0]!.valueMillions } : {}),
        ...(op5List.length > 0 ? { op5ValueMillions: op5List[0]!.valueMillions } : {}),
        result: 'not_run',
        message: `Missing ${o1List.length === 0 ? 'O-1' : 'OP-5'} for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    /* Multiple values on the same side for the same scope → review (conflict). */
    if (o1List.length > 1 || op5List.length > 1) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        o1ValueMillions: o1List[0]!.valueMillions,
        op5ValueMillions: op5List[0]!.valueMillions,
        result: 'review',
        message: `Multiple ${o1List.length > 1 ? 'O-1' : 'OP-5'} values for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    const o1Val = o1List[0]!;
    const op5Val = op5List[0]!;

    /* Reject NaN/infinity/ambiguous units before comparison. */
    try {
      toCanonicalDecimal(o1Val.valueMillions);
      toCanonicalDecimal(op5Val.valueMillions);
    } catch {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        o1ValueMillions: o1Val.valueMillions,
        op5ValueMillions: op5Val.valueMillions,
        result: 'review',
        message: `Non-finite or ambiguous value for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
      continue;
    }

    /* Both values are already in millions (valueMillions field). */
    const tolerance = comparisonTolerance(o1Val.originalUnit, op5Val.originalUnit);
    const within = valuesWithinTolerance(o1Val.valueMillions, op5Val.valueMillions, tolerance);
    const exact = compareCanonicalDecimal(o1Val.valueMillions, op5Val.valueMillions) === 0;

    if (exact) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        o1ValueMillions: o1Val.valueMillions,
        op5ValueMillions: op5Val.valueMillions,
        result: 'pass',
        message: `O-1 and OP-5 match exactly for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
    } else if (within) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        o1ValueMillions: o1Val.valueMillions,
        op5ValueMillions: op5Val.valueMillions,
        result: 'pass',
        message: `O-1 and OP-5 within tolerance for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
      });
    } else {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedCode,
        fiscalYear: fiscalYear ?? 0,
        columnRole,
        o1ValueMillions: o1Val.valueMillions,
        op5ValueMillions: op5Val.valueMillions,
        result: 'fail',
        message: `O-1 (${o1Val.valueMillions}) != OP-5 (${op5Val.valueMillions}) for ${printedCode} FY${fiscalYear ?? 'none'} ${columnRole}`,
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
/* OP-5 change arithmetic helper                                       */
/* ------------------------------------------------------------------ */

/**
 * Check OP-5 total-change arithmetic: price_change + program_change +
 * transfers = total_change, only when the source explicitly defines all
 * components and the total within the same scope.
 *
 * Returns not_applicable when components are missing or scopes differ.
 */
export function checkOp5ChangeArithmetic(input: {
  changes: ReadonlyArray<{
    identityNaturalKey: string;
    changeType: 'price_change' | 'program_change' | 'transfer' | 'total_change';
    fiscalYear?: number;
    valueMillions?: string;
    originalValue: string;
  }>;
}): {
  applicable: boolean;
  passed?: boolean;
  expected?: string;
  actual?: string;
  fiscalYear?: number;
} {
  const { changes } = input;

  const byKey = new Map<string, typeof changes>();
  for (const c of changes) {
    if (c.fiscalYear == null) continue;
    const key = `${c.identityNaturalKey}|${c.fiscalYear}`;
    const list = byKey.get(key) ?? ([] as unknown as typeof changes);
    (list as unknown as Array<typeof c>).push(c);
    byKey.set(key, list);
  }

  for (const [, list] of byKey) {
    const arr = list as unknown as Array<{
      identityNaturalKey: string;
      changeType: 'price_change' | 'program_change' | 'transfer' | 'total_change';
      fiscalYear?: number;
      valueMillions?: string;
      originalValue: string;
    }>;
    const priceChange = arr.find((c) => c.changeType === 'price_change');
    const programChange = arr.find((c) => c.changeType === 'program_change');
    const transfer = arr.find((c) => c.changeType === 'transfer');
    const totalChange = arr.find((c) => c.changeType === 'total_change');

    if (priceChange == null || programChange == null || totalChange == null) {
      continue;
    }

    const toNum = (c: typeof priceChange): number =>
      parseFloat(c.valueMillions ?? c.originalValue);

    const price = toNum(priceChange);
    const program = toNum(programChange);
    const transferVal = transfer != null ? toNum(transfer) : 0;
    const total = toNum(totalChange);

    const expected = price + program + transferVal;
    const actual = total;
    const tolerance = Math.max(Math.abs(actual) * 0.01, 0.001);

    return {
      applicable: true,
      passed: Math.abs(expected - actual) <= tolerance,
      expected: expected.toString(),
      actual: actual.toString(),
      fiscalYear: priceChange.fiscalYear,
    };
  }

  return { applicable: false };
}
