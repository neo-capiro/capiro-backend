/**
 * Phase 6 Workstream C — normalized congressional table semantics and
 * duplicate-safe composition.
 *
 * Replaces the legacy "last numeric token is the mark" and last-wins-dedupe
 * behaviour with header-aware semantics that preserve every represented row.
 *
 * Hard rules enforced here:
 *   - column meaning comes from the printed header, never from array position;
 *   - a quantity column is never money;
 *   - every duplicate row is preserved independently;
 *   - equal identity with unequal totals is a conflict, never last-wins;
 *   - a change-only row yields a typed action, and may only become an absolute
 *     position when an exact baseline, matching unit/scope, exact arithmetic,
 *     and an explicit policy allowance all hold — with the derivation recorded;
 *   - direct and derived values are always distinguishable;
 *   - a row that cannot be interpreted is retained as an explicit finding.
 *
 * All money arithmetic uses the exact decimal helpers. No JavaScript
 * floating-point value is ever produced from a printed amount.
 */
import { z } from 'zod';
import { isCanonicalDecimalString } from '../contracts/decimal-string.js';
import { moneyUnitV1Schema, type MoneyUnitV1 } from '../contracts/extraction-artifact-v1.js';
import {
  budgetLineReferenceV1Schema,
  type BudgetLineReferenceV1,
} from './budget-line-reference-v1.js';
import { addDecimals } from '../verification/rules/arithmetic/exact-arithmetic.js';

const decimalStringSchema = z
  .string()
  .refine(isCanonicalDecimalString, { message: 'expected canonical decimal string' });

/* ------------------------------------------------------------------ */
/* money semantics                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a printed money column means. Derived from the header, and the only
 * way a value may be interpreted — there is no positional fallback.
 *
 * `request_baseline` is the President's Budget figure reprinted for comparison.
 * It never transfers request ownership to a later-stage source.
 */
export const MONEY_SEMANTIC_V1_VALUES = [
  'request_baseline',
  'change',
  'recommended_total',
  'authorized_total',
  'appropriated_total',
  'enacted_total',
  'transfer_amount',
  'rescission_amount',
] as const;
export const moneySemanticV1Schema = z.enum(MONEY_SEMANTIC_V1_VALUES);
export type MoneySemanticV1 = z.infer<typeof moneySemanticV1Schema>;

/** Semantics that state an absolute position rather than a delta. */
export const ABSOLUTE_MONEY_SEMANTICS: readonly MoneySemanticV1[] = [
  'recommended_total',
  'authorized_total',
  'appropriated_total',
  'enacted_total',
];

/** Semantics that state a delta and can never stand alone as a position. */
export const DELTA_MONEY_SEMANTICS: readonly MoneySemanticV1[] = [
  'change',
  'transfer_amount',
  'rescission_amount',
];

/* ------------------------------------------------------------------ */
/* row semantics                                                       */
/* ------------------------------------------------------------------ */

export const ROW_SEMANTIC_KIND_V1_VALUES = [
  'absolute_position',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'rescission',
  'quantity_change',
  'undistributed',
  'general_provision',
  'narrative_only',
  'unresolved',
] as const;
export const rowSemanticKindV1Schema = z.enum(ROW_SEMANTIC_KIND_V1_VALUES);
export type RowSemanticKindV1 = z.infer<typeof rowSemanticKindV1Schema>;

/** Row kinds that may carry an absolute funding position. */
export const POSITION_BEARING_ROW_KINDS: readonly RowSemanticKindV1[] = ['absolute_position'];

/**
 * Row kinds whose amounts are actions. They produce typed stage actions and
 * must never be written into a funding field as though they were a total.
 */
export const ACTION_ROW_KINDS: readonly RowSemanticKindV1[] = [
  'adjustment',
  'transfer_in',
  'transfer_out',
  'rescission',
  'undistributed',
];

/* ------------------------------------------------------------------ */
/* columns, cells, rows, table                                         */
/* ------------------------------------------------------------------ */

export const congressionalColumnV1Schema = z
  .object({
    columnIndex: z.number().int().nonnegative(),
    /** Exact printed header text, retained as evidence. */
    headerText: z.string().min(1),
    /**
     * Money meaning, when this column is money. Absent for quantity and
     * label columns. A column with no semantic is never read as money.
     */
    moneySemantic: moneySemanticV1Schema.optional(),
    /** Bound from the header, never inferred from column order. */
    fiscalYear: z.number().int().min(1900).max(2200).optional(),
    /** Per-column unit when the column overrides the table default. */
    declaredUnit: moneyUnitV1Schema.optional(),
    /** True when the column counts items. Quantity is never money. */
    isQuantity: z.boolean(),
  })
  .strict();
export type CongressionalColumnV1 = z.infer<typeof congressionalColumnV1Schema>;

export const congressionalCellV1Schema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    columnIndex: z.number().int().nonnegative(),
    /** Exact printed text. */
    rawText: z.string(),
    /**
     * Parsed exact decimal, when the cell holds a number. Absent for blank,
     * dash, and non-numeric cells — never coerced to zero.
     */
    value: decimalStringSchema.optional(),
    boundingBox: z
      .object({ x0: z.string(), y0: z.string(), x1: z.string(), y1: z.string() })
      .strict()
      .optional(),
    textSpan: z.object({ start: z.number().int(), end: z.number().int() }).strict().optional(),
  })
  .strict();
export type CongressionalCellV1 = z.infer<typeof congressionalCellV1Schema>;

export const congressionalRowV1Schema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    /** Exact printed row label, retained as evidence and never as identity. */
    rawLabel: z.string(),
    reference: budgetLineReferenceV1Schema,
    semanticKind: rowSemanticKindV1Schema,
    cells: z.array(congressionalCellV1Schema),
    /** Why a row is unresolved/narrative, when it is. */
    finding: z.string().optional(),
  })
  .strict();
export type CongressionalRowV1 = z.infer<typeof congressionalRowV1Schema>;

export const CONGRESSIONAL_TABLE_SCHEMA_VERSION = 'congressional_table_v1' as const;

export const congressionalTableV1Schema = z
  .object({
    schemaVersion: z.literal(CONGRESSIONAL_TABLE_SCHEMA_VERSION),
    /** Profile that governs this document; ties the table to a stage/authority. */
    profileId: z.string().min(1),
    sourceDocumentId: z.string().min(1),
    sourceSha256: z.string().min(1),
    /** Physical page. */
    page: z.number().int().positive(),
    /** Printed page identifier when it differs from the physical page. */
    printedPage: z.string().optional(),
    /** Section/account headings above the table, in printed order. */
    headings: z.array(z.string()),
    /**
     * Table-level unit. A table with no declared unit cannot yield money —
     * magnitude is never used to guess a unit.
     */
    declaredUnit: moneyUnitV1Schema.optional(),
    columns: z.array(congressionalColumnV1Schema),
    rows: z.array(congressionalRowV1Schema),
  })
  .strict();
export type CongressionalTableV1 = z.infer<typeof congressionalTableV1Schema>;

/* ------------------------------------------------------------------ */
/* reading money out of a row                                          */
/* ------------------------------------------------------------------ */

export interface RowMoneyV1 {
  semantic: MoneySemanticV1;
  columnIndex: number;
  fiscalYear?: number;
  unit: MoneyUnitV1;
  value: string;
}

/**
 * Every money value in a row, keyed by the column's declared semantic.
 *
 * Quantity columns are skipped. Cells with no parsed value are skipped rather
 * than treated as zero. A table with no unit — and no per-column unit —
 * yields nothing, because the amount cannot be scaled truthfully.
 */
export function rowMoneyV1(table: CongressionalTableV1, row: CongressionalRowV1): RowMoneyV1[] {
  const byIndex = new Map(table.columns.map((column) => [column.columnIndex, column]));
  const out: RowMoneyV1[] = [];
  for (const cell of row.cells) {
    const column = byIndex.get(cell.columnIndex);
    if (!column || column.isQuantity || column.moneySemantic == null) continue;
    if (cell.value == null) continue;
    const unit = column.declaredUnit ?? table.declaredUnit;
    if (unit == null) continue;
    out.push({
      semantic: column.moneySemantic,
      columnIndex: column.columnIndex,
      ...(column.fiscalYear != null ? { fiscalYear: column.fiscalYear } : {}),
      unit,
      value: cell.value,
    });
  }
  return out;
}

/** Quantity values in a row. Kept separate from money by construction. */
export function rowQuantitiesV1(
  table: CongressionalTableV1,
  row: CongressionalRowV1,
): { columnIndex: number; fiscalYear?: number; value: string }[] {
  const byIndex = new Map(table.columns.map((column) => [column.columnIndex, column]));
  const out: { columnIndex: number; fiscalYear?: number; value: string }[] = [];
  for (const cell of row.cells) {
    const column = byIndex.get(cell.columnIndex);
    if (!column || !column.isQuantity || cell.value == null) continue;
    out.push({
      columnIndex: column.columnIndex,
      ...(column.fiscalYear != null ? { fiscalYear: column.fiscalYear } : {}),
      value: cell.value,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* change -> absolute derivation, fail-closed                          */
/* ------------------------------------------------------------------ */

export const DERIVATION_BLOCKED_REASON_V1_VALUES = [
  'no_baseline',
  'no_change',
  'unit_mismatch',
  'fiscal_year_mismatch',
  'policy_forbids_derivation',
  'row_is_not_position_bearing',
] as const;
export type DerivationBlockedReasonV1 = (typeof DERIVATION_BLOCKED_REASON_V1_VALUES)[number];

export type AbsoluteDerivationV1 =
  | {
      status: 'direct';
      value: string;
      unit: MoneyUnitV1;
      semantic: MoneySemanticV1;
      fiscalYear?: number;
    }
  | {
      status: 'derived';
      value: string;
      unit: MoneyUnitV1;
      fiscalYear?: number;
      /** Exact inputs retained so the derivation is auditable. */
      baseline: string;
      change: string;
    }
  | { status: 'blocked'; reason: DerivationBlockedReasonV1 };

/**
 * Resolve a row to an absolute position.
 *
 * A printed absolute total is used directly. Otherwise a baseline plus change
 * may be summed only when the policy allows derivation, the units match, and
 * the fiscal years match. Everything else is blocked — an adjustment never
 * silently becomes a total.
 */
export function deriveAbsolutePositionV1(
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  options: { allowBaselinePlusChange: boolean },
): AbsoluteDerivationV1 {
  if (!POSITION_BEARING_ROW_KINDS.includes(row.semanticKind)) {
    return { status: 'blocked', reason: 'row_is_not_position_bearing' };
  }
  const money = rowMoneyV1(table, row);

  const direct = money.find((entry) => ABSOLUTE_MONEY_SEMANTICS.includes(entry.semantic));
  if (direct) {
    return {
      status: 'direct',
      value: direct.value,
      unit: direct.unit,
      semantic: direct.semantic,
      ...(direct.fiscalYear != null ? { fiscalYear: direct.fiscalYear } : {}),
    };
  }

  const change = money.find((entry) => entry.semantic === 'change');
  if (!change) return { status: 'blocked', reason: 'no_change' };
  const baseline = money.find((entry) => entry.semantic === 'request_baseline');
  if (!baseline) return { status: 'blocked', reason: 'no_baseline' };
  if (!options.allowBaselinePlusChange) {
    return { status: 'blocked', reason: 'policy_forbids_derivation' };
  }
  if (baseline.unit !== change.unit) return { status: 'blocked', reason: 'unit_mismatch' };
  if (baseline.fiscalYear !== change.fiscalYear) {
    return { status: 'blocked', reason: 'fiscal_year_mismatch' };
  }

  return {
    status: 'derived',
    value: addDecimals(baseline.value, change.value),
    unit: baseline.unit,
    ...(baseline.fiscalYear != null ? { fiscalYear: baseline.fiscalYear } : {}),
    baseline: baseline.value,
    change: change.value,
  };
}

/* ------------------------------------------------------------------ */
/* duplicate-safe composition                                          */
/* ------------------------------------------------------------------ */

/**
 * Grouping key for duplicate detection. Deliberately includes the semantic
 * kind and fiscal year: the same line appearing as both a position and an
 * adjustment is not a duplicate, and neither are two fiscal years.
 */
export function rowCompositionKeyV1(row: CongressionalRowV1, fiscalYear?: number): string {
  const reference: BudgetLineReferenceV1 = row.reference;
  const referencePart =
    reference.referenceKind === 'unresolved_reference'
      ? `unresolved:${reference.rawText}`
      : JSON.stringify(reference);
  return `${row.semanticKind}|${fiscalYear ?? 'none'}|${referencePart}`;
}

export interface RowCompositionGroupV1 {
  key: string;
  rows: CongressionalRowV1[];
  /** Set when every row in the group agrees on the same absolute total. */
  agreedValue?: string;
  /** Set when rows share a key but disagree — blocking, never last-wins. */
  conflict?: { values: string[] };
}

/**
 * Group rows for composition without discarding any of them.
 *
 * Rows are never removed: a group with one row composes trivially, a group
 * whose rows all state the same total composes to that total, and a group
 * whose rows disagree is reported as a conflict. No branch picks a winner.
 */
export function composeDuplicateRowsV1(
  table: CongressionalTableV1,
  options: { allowBaselinePlusChange: boolean } = { allowBaselinePlusChange: false },
): RowCompositionGroupV1[] {
  const groups = new Map<string, CongressionalRowV1[]>();
  const order: string[] = [];
  for (const row of table.rows) {
    const derivation = deriveAbsolutePositionV1(table, row, options);
    const fiscalYear =
      derivation.status === 'direct' || derivation.status === 'derived'
        ? derivation.fiscalYear
        : undefined;
    const key = rowCompositionKeyV1(row, fiscalYear);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }

  return order.map((key) => {
    const rows = groups.get(key)!;
    const values = rows
      .map((row) => deriveAbsolutePositionV1(table, row, options))
      .filter(
        (derivation): derivation is Extract<AbsoluteDerivationV1, { value: string }> =>
          derivation.status === 'direct' || derivation.status === 'derived',
      )
      .map((derivation) => derivation.value);
    const distinct = [...new Set(values)];
    if (distinct.length > 1) return { key, rows, conflict: { values: distinct.sort() } };
    if (distinct.length === 1) return { key, rows, agreedValue: distinct[0]! };
    return { key, rows };
  });
}

/** Total of a set of same-unit values, exact. Used for undistributed rollups. */
export function sumRowValuesV1(values: readonly string[]): string {
  return values.reduce((accumulator, value) => addDecimals(accumulator, value), '0');
}
