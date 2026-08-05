/**
 * milcon-reconciliation-v1 — C-1 ↔ DD1391 amount reconciliation for one
 * MILCON cycle.
 *
 * Matches C-1 and DD1391 by native project identity, not title similarity.
 * Only values with matching FY, funding type, and scope are compared.
 * Missing comparison source is NOT_RUN and may block certification when the
 * manifest requires it.
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

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

export interface MilconFundingValueV1 {
  identityNaturalKey: string;
  printedProjectCode: string;
  fundingType: string;
  fiscalYear: number;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  page: number;
}

/* ------------------------------------------------------------------ */
/* Comparison result                                                    */
/* ------------------------------------------------------------------ */

export type MilconComparisonResult =
  | 'pass'
  | 'fail'
  | 'review'
  | 'not_applicable'
  | 'not_run';

export interface MilconFundingComparison {
  identityNaturalKey: string;
  printedProjectCode: string;
  fiscalYear: number;
  fundingType: string;
  c1ValueMillions?: string;
  dd1391ValueMillions?: string;
  result: MilconComparisonResult;
  message?: string;
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/** Scope key: identity + FY + funding type. */
function scopeKey(
  identityNaturalKey: string,
  fiscalYear: number,
  fundingType: string,
): string {
  return `${identityNaturalKey}|${fiscalYear}|${fundingType}`;
}

/**
 * Reconcile C-1 and DD1391 funding values for every matching project
 * identity, FY, and funding type.
 *
 * Rules:
 *   - Missing C-1 or DD1391 for a scope is NOT_RUN, never pass.
 *   - Different FY does not reconcile.
 *   - NaN/infinity/ambiguous units reject before comparison.
 *   - Tolerance derives from printed units and source rounding.
 *   - Same project number at different installations remains separate.
 */
export function reconcileMilconFunding(input: {
  c1Values: readonly MilconFundingValueV1[];
  dd1391Values: readonly MilconFundingValueV1[];
}): MilconFundingComparison[] {
  const { c1Values, dd1391Values } = input;
  const comparisons: MilconFundingComparison[] = [];

  const c1ByKey = new Map<string, MilconFundingValueV1[]>();
  for (const v of c1Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.fundingType);
    const list = c1ByKey.get(key) ?? [];
    list.push(v);
    c1ByKey.set(key, list);
  }
  const dd1391ByKey = new Map<string, MilconFundingValueV1[]>();
  for (const v of dd1391Values) {
    const key = scopeKey(v.identityNaturalKey, v.fiscalYear, v.fundingType);
    const list = dd1391ByKey.get(key) ?? [];
    list.push(v);
    dd1391ByKey.set(key, list);
  }

  const allKeys = new Set<string>([...c1ByKey.keys(), ...dd1391ByKey.keys()]);

  for (const key of allKeys) {
    const c1List = c1ByKey.get(key) ?? [];
    const dd1391List = dd1391ByKey.get(key) ?? [];

    if (c1List.length === 0 && dd1391List.length === 0) continue;

    const first = c1List[0] ?? dd1391List[0]!;
    const identityKey = first.identityNaturalKey;
    const fiscalYear = first.fiscalYear;
    const fundingType = first.fundingType;
    const printedCode = first.printedProjectCode;

    if (c1List.length === 0 || dd1391List.length === 0) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        ...(c1List.length > 0 ? { c1ValueMillions: c1List[0]!.valueMillions } : {}),
        ...(dd1391List.length > 0
          ? { dd1391ValueMillions: dd1391List[0]!.valueMillions }
          : {}),
        result: 'not_run',
        message: `Missing ${c1List.length === 0 ? 'C-1' : 'DD1391'} for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
      continue;
    }

    if (c1List.length > 1 || dd1391List.length > 1) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        c1ValueMillions: c1List[0]!.valueMillions,
        dd1391ValueMillions: dd1391List[0]!.valueMillions,
        result: 'review',
        message: `Multiple ${c1List.length > 1 ? 'C-1' : 'DD1391'} values for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
      continue;
    }

    const c1Val = c1List[0]!;
    const dd1391Val = dd1391List[0]!;

    try {
      toCanonicalDecimal(c1Val.valueMillions);
      toCanonicalDecimal(dd1391Val.valueMillions);
    } catch {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        c1ValueMillions: c1Val.valueMillions,
        dd1391ValueMillions: dd1391Val.valueMillions,
        result: 'review',
        message: `Non-finite or ambiguous value for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
      continue;
    }

    const tolerance = comparisonTolerance(c1Val.originalUnit, dd1391Val.originalUnit);
    const within = valuesWithinTolerance(c1Val.valueMillions, dd1391Val.valueMillions, tolerance);
    const exact = compareCanonicalDecimal(c1Val.valueMillions, dd1391Val.valueMillions) === 0;

    if (exact) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        c1ValueMillions: c1Val.valueMillions,
        dd1391ValueMillions: dd1391Val.valueMillions,
        result: 'pass',
        message: `C-1 and DD1391 match exactly for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
    } else if (within) {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        c1ValueMillions: c1Val.valueMillions,
        dd1391ValueMillions: dd1391Val.valueMillions,
        result: 'pass',
        message: `C-1 and DD1391 within tolerance for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
    } else {
      comparisons.push({
        identityNaturalKey: identityKey,
        printedProjectCode: printedCode,
        fiscalYear,
        fundingType,
        c1ValueMillions: c1Val.valueMillions,
        dd1391ValueMillions: dd1391Val.valueMillions,
        result: 'fail',
        message: `C-1 (${c1Val.valueMillions}) != DD1391 (${dd1391Val.valueMillions}) for ${printedCode} FY${fiscalYear} ${fundingType}`,
      });
    }
  }

  comparisons.sort((a, b) => {
    const nk = a.identityNaturalKey.localeCompare(b.identityNaturalKey);
    if (nk !== 0) return nk;
    return a.fundingType.localeCompare(b.fundingType);
  });

  return comparisons;
}

/* ------------------------------------------------------------------ */
/* DD1391 cost-category total arithmetic helper                        */
/* ------------------------------------------------------------------ */

/**
 * Check DD1391 cost-category arithmetic: sum of individual cost categories
 * vs total_request, only when the source explicitly defines all components
 * and the total.
 */
export function checkDd1391CostArithmetic(input: {
  costs: ReadonlyArray<{
    identityNaturalKey: string;
    costCategory: string;
    valueMillions: string;
  }>;
}): {
  applicable: boolean;
  passed?: boolean;
  expected?: string;
  actual?: string;
} {
  const { costs } = input;

  const totalRequest = costs.find((c) => c.costCategory === 'total_request');
  if (totalRequest == null) return { applicable: false };

  const components = costs.filter(
    (c) =>
      c.costCategory !== 'total_request' &&
      c.costCategory !== 'current_working_estimate' &&
      c.costCategory !== 'total_project_cost',
  );

  if (components.length === 0) return { applicable: false };

  const hasPrimary = costs.some((c) => c.costCategory === 'primary_facility');
  const hasContingency = costs.some((c) => c.costCategory === 'contingency');
  if (!hasPrimary || !hasContingency) return { applicable: false };

  const sum = components.reduce((acc, c) => acc + parseFloat(c.valueMillions), 0);
  const total = parseFloat(totalRequest.valueMillions);
  const tolerance = Math.max(Math.abs(total) * 0.02, 0.01);

  return {
    applicable: true,
    passed: Math.abs(sum - total) <= tolerance,
    expected: sum.toString(),
    actual: total.toString(),
  };
}
