/**
 * r2a-project-reconciler — reconcile R-2A project funding detail against the
 * R-2 PE total for the same PE, column, and printing cycle.
 *
 * Workstream I (Phase 4 plan §14). For each PE and reconcilable column:
 *
 *     sum(project detail rows)  <->  R-2 PE total
 *
 * using Workstream B's exact source-unit tolerance:
 *
 *     max_difference = (N + 1) x 0.5 printed units
 *
 * where N is the number of printed child (project) rows entering the sum.
 *
 * Governing rules:
 *   - explicitly labeled subtotal/total rows are EXCLUDED from child sums;
 *   - a project represented on both R-2 and R-2A is never double-counted
 *     (the caller passes dedupe keys; the reconciler counts each
 *     (projectCode, fiscalYear, columnRole) logical cell once);
 *   - the direct printed project total and the computed sum are preserved
 *     separately — the sum never overwrites the printed value;
 *   - a missing project row is NOT treated as zero — it is a blocking
 *     completeness gap;
 *   - an unreconciled required column is blocking;
 *   - a documented source footnote explaining nonadditivity routes the
 *     column to REVIEW — never to an automatic pass.
 *
 * All arithmetic uses exact canonical decimal strings via
 * rdte-rounding-policy-v1. Pure module: no NestJS, Prisma, AWS, parser, or
 * writer dependencies.
 */
import {
  compareCanonicalDecimal,
  exactAbsDifference,
  totalVsChildrenToleranceMillions,
  withinExactTolerance,
} from '../rdte-rounding-policy-v1.js';
import { parseCanonicalDecimalString, scaleDecimalString } from '../../contracts/decimal-string.js';
import type { MoneyUnitV1 } from '../../contracts/decimal-string.js';
import type { RdteColumnRoleV1 } from '../rdte-column-role-v1.js';
import type { R2aProjectFundingValue } from './r2a-project-funding-extractor-v1.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

/**
 * One R-2 PE-total cell that a set of R-2A project cells must reconcile
 * against. Produced by Workstream G (R-2 cost table extraction).
 */
export interface R2PeTotalCell {
  peCode: string;
  fiscalYear: number;
  columnRole: RdteColumnRoleV1;
  /** Printed PE total in the SAME source unit as the child values. */
  printedTotal: string;
  unit: MoneyUnitV1;
  page: number;
  printedPage?: string;
  rowIndex: number;
  columnIndex: number;
}

/**
 * A documented source footnote explaining why a column does not add up
 * (e.g. "project detail does not include classified project X"). A footnote
 * routes the column to review — it is never an automatic pass.
 */
export interface NonadditivityFootnote {
  peCode: string;
  /** Column the footnote applies to; omit to apply to every column. */
  fiscalYear?: number;
  text: string;
  page: number;
}

export interface ReconcileR2aColumnInput {
  peCode: string;
  fiscalYear: number;
  columnRole: RdteColumnRoleV1;
  /** Printed R-2 PE total for this column, in source units. */
  peTotal: R2PeTotalCell;
  /**
   * R-2A project detail values for this column, in the SAME source unit as
   * `peTotal.printedTotal`. Subtotal/total rows must already be excluded by
   * the caller or carry rowKind 'subtotal'/'total' so the reconciler can
   * exclude them.
   */
  projectValues: readonly R2aProjectFundingValue[];
  /** Unit all values are printed in. */
  unit: MoneyUnitV1;
  /**
   * Projects known to exist for this PE (from Workstream H identity
   * extraction). Used to detect MISSING project rows: an identity with no
   * funding cell in this column is a completeness gap, never a zero.
   */
  expectedProjectCodes?: readonly string[];
  /** Documented nonadditivity footnotes for this PE/column. */
  footnotes?: readonly NonadditivityFootnote[];
  /**
   * True when the PE total cell for this column is itself derived from an
   * R-2 project-row representation that also appears on R-2A. Prevents
   * double-counting: the reconciler counts each logical
   * (projectCode, fiscalYear, columnRole) cell once.
   */
  dedupeKeys?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export type R2aReconciliationStatus =
  | 'reconciled' // sum within exact source-unit tolerance
  | 'within_rounding' // nonzero difference within tolerance
  | 'outside_tolerance' // material difference — blocking
  | 'missing_project' // an expected project row is absent — blocking
  | 'missing_pe_total' // required PE total cell absent — blocking
  | 'duplicate_project_row' // the same logical child cell appears twice — blocking
  | 'subtotal_double_count' // a subtotal/total row was presented as a child — blocking
  | 'review_footnote'; // documented nonadditivity — routes to review, never auto-pass

export interface R2aColumnReconciliation {
  peCode: string;
  fiscalYear: number;
  columnRole: RdteColumnRoleV1;
  status: R2aReconciliationStatus;
  /** True when this column blocks ingestion completeness. */
  blocking: boolean;
  /** Computed exact sum of child rows in source units. */
  childSum: string;
  /** Printed PE total in source units (preserved separately from the sum). */
  printedTotal: string;
  /** Exact |childSum - printedTotal| in source units. */
  difference: string;
  /** Exact allowed tolerance in source units: (N + 1) x 0.5 printed units. */
  tolerance: string;
  /** Number of child (project) rows entering the sum. */
  childCount: number;
  /** Project codes that contributed to the sum. */
  includedProjectCodes: string[];
  /** Expected projects with no cell in this column (never treated as zero). */
  missingProjectCodes: string[];
  /** Excluded subtotal/total rows (preserved as context, never summed). */
  excludedRowKinds: string[];
  /** Footnote text when status === 'review_footnote'. */
  footnoteText?: string;
  /** Human-readable explanation for audit. */
  message: string;
}

/* ------------------------------------------------------------------ */
/* Exact decimal-string sum                                            */
/* ------------------------------------------------------------------ */

/**
 * Sum canonical decimal strings exactly (same unit). Zero is a real child
 * value: a zero-valued project row COUNTS toward N in the tolerance.
 */
export function exactDecimalSum(values: readonly string[]): string {
  let scaled: bigint = 0n;
  let scale = 0;
  /* First pass: find the maximum decimal scale. */
  for (const v of values) {
    const canonical = parseCanonicalDecimalString(v);
    const dot = canonical.indexOf('.');
    const places = dot >= 0 ? canonical.length - dot - 1 : 0;
    if (places > scale) scale = places;
  }
  /* Second pass: sum with per-part scaling. */
  scaled = 0n;
  for (let i = 0; i < values.length; i++) {
    const canonical = parseCanonicalDecimalString(values[i]!);
    const dot = canonical.indexOf('.');
    const places = dot >= 0 ? canonical.length - dot - 1 : 0;
    const negative = canonical.startsWith('-');
    const unsigned = negative ? canonical.slice(1) : canonical;
    const digits = unsigned.replace('.', '').replace(/^0+(?=\d)/, '') || '0';
    const padding = scale - places;
    const scaledDigits = digits + '0'.repeat(padding);
    const value = BigInt(scaledDigits);
    scaled += negative ? -value : value;
  }
  return fromScaledIntExact(scaled, scale);
}

function fromScaledIntExact(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const digits = abs.toString().padStart(scale + 1, '0');
  let result: string;
  if (scale === 0) {
    result = digits;
  } else {
    const intPart = digits.slice(0, digits.length - scale) || '0';
    const fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
    result = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  }
  if (result === '0') return '0';
  return negative ? `-${result}` : result;
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

/** Row kinds that must NEVER enter a child sum. */
const EXCLUDED_ROW_KINDS = new Set(['subtotal', 'total']);

/**
 * Roles whose child sums are reconciled against the PE total. Non-annual
 * cost roles (cost_to_complete, total_cost) and contextual roles are NEVER
 * reconciled — they are not annual funding.
 */
function isReconcilableRole(role: RdteColumnRoleV1): boolean {
  return role === 'budget_year_request' || role === 'outyear_projection';
}

/** Dedupe key for one logical child cell. */
export function r2aChildCellKey(value: {
  projectCode: string;
  fiscalYear?: number;
  columnRole: RdteColumnRoleV1;
}): string {
  return `${value.projectCode}|${value.fiscalYear ?? 'na'}|${value.columnRole}`;
}

export function reconcileR2aProjectColumn(input: ReconcileR2aColumnInput): R2aColumnReconciliation {
  const { peCode, fiscalYear, columnRole, peTotal, projectValues, unit } = input;

  /* Non-annual cost columns are excluded from reconciliation entirely. */
  if (!isReconcilableRole(columnRole)) {
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'reconciled',
      blocking: false,
      childSum: '0',
      printedTotal: peTotal.printedTotal,
      difference: '0',
      tolerance: '0',
      childCount: 0,
      includedProjectCodes: [],
      missingProjectCodes: [],
      excludedRowKinds: [],
      message: `column role ${columnRole} is not annual funding; reconciliation not applicable`,
    };
  }

  /* Subtotal/total exclusion: explicitly labeled subtotal/total rows must
   * never be summed as children. Their presence in the child list is a
   * double-count attempt and is blocking. */
  const excludedRowKinds: string[] = [];
  const childRows: R2aProjectFundingValue[] = [];
  let subtotalAttempt = false;
  for (const value of projectValues) {
    if (EXCLUDED_ROW_KINDS.has(value.rowKind)) {
      excludedRowKinds.push(value.rowKind);
      subtotalAttempt = true;
    } else {
      childRows.push(value);
    }
  }

  if (subtotalAttempt) {
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'subtotal_double_count',
      blocking: true,
      childSum: '0',
      printedTotal: peTotal.printedTotal,
      difference: '0',
      tolerance: '0',
      childCount: 0,
      includedProjectCodes: [],
      missingProjectCodes: [],
      excludedRowKinds: [...new Set(excludedRowKinds)],
      message:
        `PE ${peCode} FY${fiscalYear}: subtotal/total rows were presented as ` +
        `child rows (${[...new Set(excludedRowKinds)].join(', ')}); ` +
        `subtotal rows are excluded from child sums and their inclusion is blocking`,
    };
  }

  /* Double-count prevention: count each logical (projectCode, fiscalYear,
   * columnRole) cell once. The same project row printed on R-2 and R-2A, or
   * a duplicated R-2A row, must never be summed twice. */
  const seenKeys = new Set<string>();
  const dedupedRows: R2aProjectFundingValue[] = [];
  const duplicateProjects: string[] = [];
  for (const value of childRows) {
    const key = r2aChildCellKey(value);
    if (seenKeys.has(key) || input.dedupeKeys?.has(key) === true) {
      duplicateProjects.push(value.projectCode);
      continue;
    }
    seenKeys.add(key);
    dedupedRows.push(value);
  }

  if (duplicateProjects.length > 0) {
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'duplicate_project_row',
      blocking: true,
      childSum: '0',
      printedTotal: peTotal.printedTotal,
      difference: '0',
      tolerance: '0',
      childCount: dedupedRows.length,
      includedProjectCodes: dedupedRows.map((v) => v.projectCode),
      missingProjectCodes: [],
      excludedRowKinds: [],
      message:
        `PE ${peCode} FY${fiscalYear}: duplicate project row(s) for ` +
        `${[...new Set(duplicateProjects)].join(', ')}; a project represented ` +
        `twice (R-2 + R-2A or repeated row) is never double-counted`,
    };
  }

  /* Missing project detection: an expected project identity with no funding
   * cell in this column is a completeness gap — NEVER treated as zero. */
  const presentCodes = new Set(dedupedRows.map((v) => v.projectCode));
  const missingProjectCodes = (input.expectedProjectCodes ?? []).filter(
    (code) => !presentCodes.has(code),
  );

  if (missingProjectCodes.length > 0) {
    const partialSum = exactDecimalSum(dedupedRows.map((v) => v.originalValue));
    const tolerance = totalVsChildrenToleranceMillions(dedupedRows.length, unit);
    /* Tolerance is expressed in millions; convert to source units for
     * reporting when the source unit is not millions. */
    const toleranceInSourceUnits = toleranceForUnit(dedupedRows.length, unit);
    void tolerance;
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'missing_project',
      blocking: true,
      childSum: partialSum,
      printedTotal: peTotal.printedTotal,
      difference: exactAbsDifference(partialSum, peTotal.printedTotal),
      tolerance: toleranceInSourceUnits,
      childCount: dedupedRows.length,
      includedProjectCodes: dedupedRows.map((v) => v.projectCode),
      missingProjectCodes: [...missingProjectCodes],
      excludedRowKinds: [],
      message:
        `PE ${peCode} FY${fiscalYear}: missing project funding row(s) for ` +
        `${missingProjectCodes.join(', ')}; a missing project row is a ` +
        `completeness gap and is never treated as zero`,
    };
  }

  /* Documented nonadditivity footnote: routes to review, never auto-pass. */
  const footnote = (input.footnotes ?? []).find(
    (f) => f.peCode === peCode && (f.fiscalYear == null || f.fiscalYear === fiscalYear),
  );

  const childSum = exactDecimalSum(dedupedRows.map((v) => v.originalValue));
  const difference = exactAbsDifference(childSum, peTotal.printedTotal);
  const tolerance = toleranceForUnit(dedupedRows.length, unit);
  const includedProjectCodes = dedupedRows.map((v) => v.projectCode);

  if (footnote != null) {
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'review_footnote',
      blocking: false,
      childSum,
      printedTotal: peTotal.printedTotal,
      difference,
      tolerance,
      childCount: dedupedRows.length,
      includedProjectCodes,
      missingProjectCodes: [],
      excludedRowKinds: [],
      footnoteText: footnote.text,
      message:
        `PE ${peCode} FY${fiscalYear}: documented source footnote explains ` +
        `nonadditivity ("${footnote.text}"); routed to review — never an ` +
        `automatic pass`,
    };
  }

  /* Exact reconciliation: |sum - total| <= (N + 1) x 0.5 printed units. */
  const within = withinExactTolerance(childSum, peTotal.printedTotal, tolerance);
  const exact = compareCanonicalDecimal(difference, '0') === 0;

  if (!within) {
    return {
      peCode,
      fiscalYear,
      columnRole,
      status: 'outside_tolerance',
      blocking: true,
      childSum,
      printedTotal: peTotal.printedTotal,
      difference,
      tolerance,
      childCount: dedupedRows.length,
      includedProjectCodes,
      missingProjectCodes: [],
      excludedRowKinds: [],
      message:
        `PE ${peCode} FY${fiscalYear}: project sum ${childSum} differs from ` +
        `printed PE total ${peTotal.printedTotal} by ${difference} ${unit}; ` +
        `tolerance ${tolerance} exceeded — blocking`,
    };
  }

  return {
    peCode,
    fiscalYear,
    columnRole,
    status: exact ? 'reconciled' : 'within_rounding',
    blocking: false,
    childSum,
    printedTotal: peTotal.printedTotal,
    difference,
    tolerance,
    childCount: dedupedRows.length,
    includedProjectCodes,
    missingProjectCodes: [],
    excludedRowKinds: [],
    message: exact
      ? `PE ${peCode} FY${fiscalYear}: project sum equals printed PE total exactly`
      : `PE ${peCode} FY${fiscalYear}: project sum within source-unit rounding ` +
        `tolerance (difference ${difference} ${unit}, tolerance ${tolerance})`,
  };
}

/**
 * Tolerance for a printed total vs N printed child rows, expressed in the
 * SOURCE unit (not millions): (N + 1) x 0.5 printed units.
 */
function toleranceForUnit(childCount: number, unit: MoneyUnitV1): string {
  /* totalVsChildrenToleranceMillions returns millions; convert back to the
   * source unit by scaling the other direction. */
  const millions = totalVsChildrenToleranceMillions(childCount, unit);
  switch (unit) {
    case 'millions':
      return millions;
    case 'thousands':
      return scaleDecimalString(millions, 3);
    case 'dollars':
      return scaleDecimalString(millions, 6);
  }
}

/* ------------------------------------------------------------------ */
/* PE-level aggregation                                                */
/* ------------------------------------------------------------------ */

export interface R2aPeReconciliationResult {
  peCode: string;
  columns: R2aColumnReconciliation[];
  /** True when ANY required column is unreconciled and blocking. */
  blocking: boolean;
  /** True when every reconcilable column passed exactly or within rounding. */
  complete: boolean;
}

/**
 * Reconcile every required column for one PE. An unreconciled required
 * column (budget-year request or any printed outyear) is blocking.
 */
export function reconcileR2aPe(input: {
  peCode: string;
  columns: readonly ReconcileR2aColumnInput[];
}): R2aPeReconciliationResult {
  const columns = input.columns.map((column) => reconcileR2aProjectColumn(column));
  const blocking = columns.some((c) => c.blocking);
  const complete = columns.every(
    (c) => c.status === 'reconciled' || c.status === 'within_rounding',
  );
  return { peCode: input.peCode, columns, blocking, complete };
}
