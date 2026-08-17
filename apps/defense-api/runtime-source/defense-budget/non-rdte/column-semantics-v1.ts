/**
 * column-semantics-v1 — explicit source-header binding types for non-RDT&E
 * budget extraction.
 *
 * Binds fiscal year, value kind, base/OCO/OOC/total status, request/actual/
 * prior/outyear status, quantity versus money versus unit cost, printed unit,
 * and scope from the actual source header. Never derives FY solely from
 * column position.
 *
 * Pure module. No side effects.
 */
import { z } from 'zod';
import type { PrintedUnitV1 } from './unit-semantics-v1.js';

/* ------------------------------------------------------------------ */
/* Value kind vocabulary                                                */
/* ------------------------------------------------------------------ */

export const VALUE_KIND_V1_VALUES = ['money', 'quantity', 'unit_cost', 'text'] as const;
export const valueKindV1Schema = z.enum(VALUE_KIND_V1_VALUES);
export type ValueKindV1 = z.infer<typeof valueKindV1Schema>;

/* ------------------------------------------------------------------ */
/* Base/OCO/OOC/total status                                            */
/* ------------------------------------------------------------------ */

export const BASE_OCO_STATUS_V1_VALUES = ['base', 'oco', 'ooc', 'total', 'none'] as const;
export const baseOcoStatusV1Schema = z.enum(BASE_OCO_STATUS_V1_VALUES);
export type BaseOcoStatusV1 = z.infer<typeof baseOcoStatusV1Schema>;

/* ------------------------------------------------------------------ */
/* Funding stage vocabulary                                             */
/* ------------------------------------------------------------------ */

export const FUNDING_STAGE_V1_VALUES = [
  'prior_actual',
  'current_enacted',
  'budget_year_request',
  'outyear_projection',
  'continuation',
  'cost_to_complete',
  'total_cost',
  'unknown',
] as const;
export const fundingStageV1Schema = z.enum(FUNDING_STAGE_V1_VALUES);
export type FundingStageV1 = z.infer<typeof fundingStageV1Schema>;

/* ------------------------------------------------------------------ */
/* Column binding                                                       */
/* ------------------------------------------------------------------ */

/**
 * A column binding represents the semantic meaning of one printed column
 * header as determined from the actual source header text.
 *
 * The binding is evidence-backed: it records the header text that was
 * interpreted and the reason for the classification.
 */
export const columnBindingV1Schema = z
  .object({
    columnIndex: z.number().int().nonnegative(),
    headerText: z.string(),
    fiscalYear: z.number().int().min(1900).max(2200).optional(),
    valueKind: valueKindV1Schema,
    baseOcoStatus: baseOcoStatusV1Schema,
    fundingStage: fundingStageV1Schema,
    printedUnit: z.enum(['dollars', 'thousands', 'millions']).optional(),
    /** True when the classification is certain from explicit labels. */
    confident: z.boolean(),
    /** Human-readable reason for audit. */
    reason: z.string(),
  })
  .strict();
export type ColumnBindingV1 = z.infer<typeof columnBindingV1Schema>;

/* ------------------------------------------------------------------ */
/* Header binding result                                                */
/* ------------------------------------------------------------------ */

export const headerBindingResultV1Schema = z
  .object({
    bindings: z.array(columnBindingV1Schema),
    /** True when at least one column had ambiguous classification. */
    hasAmbiguousColumns: z.boolean(),
    /** Column indices that could not be confidently classified. */
    unresolvedColumnIndices: z.array(z.number().int().nonnegative()),
  })
  .strict();
export type HeaderBindingResultV1 = z.infer<typeof headerBindingResultV1Schema>;

/* ------------------------------------------------------------------ */
/* Header binder                                                        */
/* ------------------------------------------------------------------ */

const FY_RE = /\b(?:FY\s*)?(\d{4})\b/i;
const BASE_RE = /\bbase\b/i;
const OCO_RE = /\boco\b/i;
const OOC_RE = /\booc\b/i;
const TOTAL_RE = /\btotal\b/i;
const PRIOR_RE = /\bprior\b/i;
const ACTUAL_RE = /\bactual\b/i;
const ENACTED_RE = /\benacted\b/i;
const REQUEST_RE = /\brequest\b/i;
const QUANTITY_RE = /\b(?:qty|quantity|units)\b/i;
const UNIT_COST_RE = /\bunit\s*cost\b/i;
const COST_COMPLETE_RE = /\bcost\s*to\s*complete\b/i;
const TOTAL_COST_RE = /\btotal\s*cost\b/i;
const MILLIONS_RE = /\bmillions?\b/i;
const THOUSANDS_RE = /\bthousands?\b/i;
const DOLLARS_RE = /\bdollars?\b/i;

/**
 * Bind column headers from the actual source header row.
 *
 * FY is bound from the actual header text, never derived from column position.
 * When column binding is ambiguous, the column is marked as unresolved.
 */
export function bindHeaders(input: {
  headers: ReadonlyArray<{ columnIndex: number; text: string }>;
  cycleFiscalYear: number;
}): HeaderBindingResultV1 {
  const bindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  for (const header of input.headers) {
    const text = header.text.trim();
    if (text.length === 0) {
      unresolvedColumnIndices.push(header.columnIndex);
      continue;
    }

    const binding = classifyHeader(text, header.columnIndex, input.cycleFiscalYear);
    if (binding == null) {
      // Label columns (BLIN, Title, Line, Code, etc.) are not unresolved
      // data columns — they are identity/label columns that don't need
      // FY/unit classification. Only flag as unresolved when the header
      // looks like it should carry data but couldn't be classified.
      const labelWords = new Set([
        'blin',
        'line',
        'title',
        'code',
        'pe',
        'li',
        'line item',
        'description',
        'item',
        'name',
        'type',
        'category',
        'service',
        'component',
        'account',
        'appropriation',
        'activity',
        // O-1 (O&M Summary) label column headers
        'sag',
        'ba',
        'bag',
        'budget activity',
        'budget activity group',
        'activity group',
        'subactivity group',
        'subactivity',
        'subactivity group code',
        'subactivity group title',
        'sag code',
        'sag title',
        'sag no.',
        'sag/subactivity',
        'budget activity (ba)',
        'budget activity group (bag)',
        'budget activity no.',
      ]);
      if (!labelWords.has(text.toLowerCase())) {
        unresolvedColumnIndices.push(header.columnIndex);
      }
    } else {
      bindings.push(binding);
    }
  }

  return {
    bindings,
    hasAmbiguousColumns: unresolvedColumnIndices.length > 0,
    unresolvedColumnIndices,
  };
}

function classifyHeader(
  text: string,
  columnIndex: number,
  cycleFiscalYear: number,
): ColumnBindingV1 | null {
  const lower = text.toLowerCase();

  // Detect FY from header text.
  const fyMatch = FY_RE.exec(text);
  let fiscalYear: number | undefined;
  if (fyMatch != null) {
    const year = Number.parseInt(fyMatch[1] ?? '', 10);
    if (year >= 1900 && year <= 2200) {
      fiscalYear = year;
    }
  }

  // Detect value kind.
  let valueKind: ValueKindV1 = 'money';
  if (QUANTITY_RE.test(lower)) {
    valueKind = 'quantity';
  } else if (UNIT_COST_RE.test(lower)) {
    valueKind = 'unit_cost';
  } else if (COST_COMPLETE_RE.test(lower) || TOTAL_COST_RE.test(lower)) {
    valueKind = 'money';
  }

  // Detect base/OCO/OOC/total status.
  let baseOcoStatus: BaseOcoStatusV1 = 'none';
  if (BASE_RE.test(lower)) {
    baseOcoStatus = 'base';
  } else if (OCO_RE.test(lower)) {
    baseOcoStatus = 'oco';
  } else if (OOC_RE.test(lower)) {
    baseOcoStatus = 'ooc';
  } else if (TOTAL_RE.test(lower) && !TOTAL_COST_RE.test(lower)) {
    baseOcoStatus = 'total';
  }

  // Detect funding stage.
  let fundingStage: FundingStageV1 = 'unknown';
  if (COST_COMPLETE_RE.test(lower)) {
    fundingStage = 'cost_to_complete';
  } else if (TOTAL_COST_RE.test(lower)) {
    fundingStage = 'total_cost';
  } else if (PRIOR_RE.test(lower) || ACTUAL_RE.test(lower)) {
    fundingStage = 'prior_actual';
  } else if (ENACTED_RE.test(lower)) {
    fundingStage = 'current_enacted';
  } else if (REQUEST_RE.test(lower)) {
    fundingStage = 'budget_year_request';
  } else if (fiscalYear != null && fiscalYear > cycleFiscalYear) {
    fundingStage = 'outyear_projection';
  } else if (fiscalYear != null && fiscalYear < cycleFiscalYear) {
    fundingStage = fiscalYear === cycleFiscalYear - 1 ? 'current_enacted' : 'prior_actual';
  } else if (fiscalYear === cycleFiscalYear) {
    fundingStage = 'budget_year_request';
  }

  // Detect printed unit.
  let printedUnit: PrintedUnitV1 | undefined;
  if (MILLIONS_RE.test(lower)) {
    printedUnit = 'millions';
  } else if (THOUSANDS_RE.test(lower)) {
    printedUnit = 'thousands';
  } else if (DOLLARS_RE.test(lower)) {
    printedUnit = 'dollars';
  }

  // Confidence: confident when we could determine at least FY or a clear label.
  const confident =
    fiscalYear != null ||
    fundingStage !== 'unknown' ||
    baseOcoStatus !== 'none' ||
    valueKind !== 'money';

  // If nothing could be classified at all, return null (unresolved).
  if (
    fiscalYear == null &&
    fundingStage === 'unknown' &&
    baseOcoStatus === 'none' &&
    valueKind === 'money' &&
    printedUnit == null
  ) {
    return null;
  }

  const reasons: string[] = [];
  if (fiscalYear != null) reasons.push(`FY ${fiscalYear} from header`);
  if (fundingStage !== 'unknown') reasons.push(`stage: ${fundingStage}`);
  if (baseOcoStatus !== 'none') reasons.push(`base/OCO: ${baseOcoStatus}`);
  if (valueKind !== 'money') reasons.push(`kind: ${valueKind}`);
  if (printedUnit != null) reasons.push(`unit: ${printedUnit}`);

  return {
    columnIndex,
    headerText: text,
    ...(fiscalYear != null ? { fiscalYear } : {}),
    valueKind,
    baseOcoStatus,
    fundingStage,
    ...(printedUnit != null ? { printedUnit } : {}),
    confident,
    reason: reasons.join('; ') || 'minimal classification',
  };
}

/* ------------------------------------------------------------------ */
/* Scope compatibility for summary/detail comparison                    */
/* ------------------------------------------------------------------ */

/**
 * Determine whether two column bindings are scope-compatible for
 * arithmetic comparison. Only values with matching FY, value kind,
 * base/OCO status, and funding stage can be compared.
 */
export function areColumnBindingsCompatible(a: ColumnBindingV1, b: ColumnBindingV1): boolean {
  if (a.valueKind !== b.valueKind) return false;
  if (a.fiscalYear !== b.fiscalYear) return false;
  if (a.baseOcoStatus !== b.baseOcoStatus) return false;
  if (a.fundingStage !== b.fundingStage) return false;
  return true;
}
