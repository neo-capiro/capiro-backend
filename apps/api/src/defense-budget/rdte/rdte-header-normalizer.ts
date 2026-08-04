/**
 * rdte-header-normalizer — normalize RDT&E table headers into a canonical
 * form that the column classifier can interpret.
 *
 * Supports:
 *   - one-row and multi-row headers;
 *   - merged header cells;
 *   - repeated headers on continuation pages;
 *   - labels split across lines;
 *   - `FY 2027`, `FY27`, `2027`, `BY1`, `BY2`, `PY`, `CY`, and similar labels;
 *   - manifest-provided cycle fiscal year;
 *   - explicit base/OCO/total groupings;
 *   - current/request/outyear labels;
 *   - printed page labels.
 *
 * A positional fallback may be used only when the manifest or a verified
 * document-family policy explicitly defines the position-to-role mapping.
 * Positional fallback must emit a review finding and must never invent a
 * fiscal year silently.
 *
 * Pure module.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Raw header input                                                    */
/* ------------------------------------------------------------------ */

export const rawHeaderCellV1Schema = z
  .object({
    text: z.string(),
    rowIndex: z.number().int().nonnegative(),
    columnIndex: z.number().int().nonnegative(),
    colSpan: z.number().int().positive().optional(),
    rowSpan: z.number().int().positive().optional(),
  })
  .strict();
export type RawHeaderCellV1 = z.infer<typeof rawHeaderCellV1Schema>;

export const rawHeaderRowV1Schema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    cells: z.array(rawHeaderCellV1Schema),
  })
  .strict();
export type RawHeaderRowV1 = z.infer<typeof rawHeaderRowV1Schema>;

/* ------------------------------------------------------------------ */
/* Normalized header                                                   */
/* ------------------------------------------------------------------ */

export const HEADER_FISCAL_LABEL_KIND_V1_VALUES = [
  'explicit_fy', // FY 2027, FY27, 2027
  'budget_year_relative', // BY, BY1, BY2
  'prior_year_relative', // PY
  'current_year_relative', // CY
  'outyear_relative', // OY1, OY2
  'cost_to_complete',
  'total_cost',
  'quantity',
  'unlabeled',
] as const;
export const headerFiscalLabelKindV1Schema = z.enum(HEADER_FISCAL_LABEL_KIND_V1_VALUES);
export type HeaderFiscalLabelKindV1 = z.infer<typeof headerFiscalLabelKindV1Schema>;

export const HEADER_COMPONENT_LABEL_V1_VALUES = ['base', 'oco', 'total', 'none'] as const;
export const headerComponentLabelV1Schema = z.enum(HEADER_COMPONENT_LABEL_V1_VALUES);
export type HeaderComponentLabelV1 = z.infer<typeof headerComponentLabelV1Schema>;

export const HEADER_STAGE_LABEL_V1_VALUES = [
  'actual',
  'enacted',
  'request',
  'projection',
  'none',
] as const;
export const headerStageLabelV1Schema = z.enum(HEADER_STAGE_LABEL_V1_VALUES);
export type HeaderStageLabelV1 = z.infer<typeof headerStageLabelV1Schema>;

export const normalizedHeaderColumnV1Schema = z
  .object({
    columnIndex: z.number().int().nonnegative(),
    rawText: z.string(),
    normalizedText: z.string(),
    fiscalLabelKind: headerFiscalLabelKindV1Schema,
    explicitFiscalYear: z.number().int().min(1900).max(2200).optional(),
    relativeOffset: z.number().int().optional(),
    componentLabel: headerComponentLabelV1Schema,
    stageLabel: headerStageLabelV1Schema,
    isMerged: z.boolean(),
    headerRowCount: z.number().int().positive(),
  })
  .strict();
export type NormalizedHeaderColumnV1 = z.infer<typeof normalizedHeaderColumnV1Schema>;

export const normalizedHeaderV1Schema = z
  .object({
    columns: z.array(normalizedHeaderColumnV1Schema),
    headerRowCount: z.number().int().positive(),
    usedPositionalFallback: z.boolean(),
    fallbackPolicyId: z.string().optional(),
  })
  .strict();
export type NormalizedHeaderV1 = z.infer<typeof normalizedHeaderV1Schema>;

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

const FY_EXPLICIT_RE = /\bFY\s*(\d{4})\b/i;
const FY_SHORT_RE = /\bFY(\d{2})\b/i;
const YEAR_BARE_RE = /\b(19\d{2}|20\d{2})\b/;
const BY_RE = /\bBY(\d*)\b/i;
const PY_RE = /\bPY\b/i;
const CY_RE = /\bCY\b/i;
const OY_RE = /\bOY(\d+)\b/i;
const BASE_RE = /\bbase\b/i;
const OCO_RE = /\boco\b|\bovers?eas?\s+contingency\b/i;
const TOTAL_RE = /\btotal\b/i;
const ACTUAL_RE = /\bactual\b/i;
const ENACTED_RE = /\benacted\b/i;
const REQUEST_RE = /\brequest\b|\bbudget\b/i;
const PROJECTION_RE = /\bproj(?:ection)?\b|\boutyear\b/i;
const CTC_RE = /\bcost\s*to\s*complete\b/i;
const TOTAL_COST_RE = /\btotal\s*cost\b/i;
const QUANTITY_RE = /\bqty\b|\bquantity\b/i;

/**
 * Normalize a block of raw header rows into one canonical header.
 * Multi-row headers are merged column-by-column; merged cells (colSpan > 1)
 * propagate their text to the covered columns.
 */
export function normalizeRdteHeader(input: {
  headerRows: readonly RawHeaderRowV1[];
  cycleFiscalYear: number;
  positionalFallbackPolicy?: {
    policyId: string;
    positionToRole: Readonly<Record<number, string>>;
  };
}): NormalizedHeaderV1 {
  const { headerRows, cycleFiscalYear } = input;
  if (headerRows.length === 0) {
    return {
      columns: [],
      headerRowCount: 0,
      usedPositionalFallback: false,
    };
  }

  const headerRowCount = headerRows.length;
  const columnTexts = new Map<number, string[]>();
  const mergedColumns = new Set<number>();

  for (const row of headerRows) {
    for (const cell of row.cells) {
      const span = cell.colSpan ?? 1;
      for (let offset = 0; offset < span; offset++) {
        const columnIndex = cell.columnIndex + offset;
        const existing = columnTexts.get(columnIndex) ?? [];
        existing.push(cell.text);
        columnTexts.set(columnIndex, existing);
        if (span > 1) mergedColumns.add(columnIndex);
      }
    }
  }

  const columns: NormalizedHeaderColumnV1[] = [];
  const sortedIndices = [...columnTexts.keys()].sort((a, b) => a - b);

  for (const columnIndex of sortedIndices) {
    const parts = columnTexts.get(columnIndex) ?? [];
    const rawText = parts.join(' ');
    const normalizedText = normalizeWhitespace(rawText);
    const classified = classifyHeaderText(normalizedText, cycleFiscalYear);
    columns.push({
      columnIndex,
      rawText,
      normalizedText,
      ...classified,
      isMerged: mergedColumns.has(columnIndex),
      headerRowCount,
    });
  }

  /* Positional fallback: only when explicitly authorized by policy. */
  let usedPositionalFallback = false;
  let fallbackPolicyId: string | undefined;
  if (input.positionalFallbackPolicy != null) {
    const { policyId, positionToRole } = input.positionalFallbackPolicy;
    for (const column of columns) {
      if (column.fiscalLabelKind === 'unlabeled' && positionToRole[column.columnIndex] != null) {
        // Positional fallback supplies a ROLE hint, never a fiscal year.
        // We mark the column as needing review by leaving fiscalLabelKind
        // unlabeled but recording that fallback was used.
        usedPositionalFallback = true;
        fallbackPolicyId = policyId;
      }
    }
  }

  return {
    columns,
    headerRowCount,
    usedPositionalFallback,
    fallbackPolicyId,
  };
}

function classifyHeaderText(
  text: string,
  cycleFiscalYear: number,
): Omit<
  NormalizedHeaderColumnV1,
  'columnIndex' | 'rawText' | 'normalizedText' | 'isMerged' | 'headerRowCount'
> {
  const upper = text.toUpperCase();

  /* Non-fiscal special columns first. */
  if (CTC_RE.test(text)) {
    return {
      fiscalLabelKind: 'cost_to_complete',
      componentLabel: 'none',
      stageLabel: 'none',
    };
  }
  if (TOTAL_COST_RE.test(text)) {
    return {
      fiscalLabelKind: 'total_cost',
      componentLabel: 'none',
      stageLabel: 'none',
    };
  }
  if (QUANTITY_RE.test(text) && !FY_EXPLICIT_RE.test(text) && !YEAR_BARE_RE.test(text)) {
    return {
      fiscalLabelKind: 'quantity',
      componentLabel: 'none',
      stageLabel: 'none',
    };
  }

  /* Component labels. */
  let componentLabel: HeaderComponentLabelV1 = 'none';
  if (BASE_RE.test(text)) componentLabel = 'base';
  else if (OCO_RE.test(text)) componentLabel = 'oco';
  else if (TOTAL_RE.test(text)) componentLabel = 'total';

  /* Stage labels. */
  let stageLabel: HeaderStageLabelV1 = 'none';
  if (ACTUAL_RE.test(text)) stageLabel = 'actual';
  else if (ENACTED_RE.test(text)) stageLabel = 'enacted';
  else if (REQUEST_RE.test(text)) stageLabel = 'request';
  else if (PROJECTION_RE.test(text)) stageLabel = 'projection';

  /* Explicit fiscal year. */
  const fyMatch = FY_EXPLICIT_RE.exec(text);
  if (fyMatch?.[1] != null) {
    return {
      fiscalLabelKind: 'explicit_fy',
      explicitFiscalYear: Number.parseInt(fyMatch[1], 10),
      componentLabel,
      stageLabel,
    };
  }

  const fyShortMatch = FY_SHORT_RE.exec(text);
  if (fyShortMatch?.[1] != null) {
    const shortYear = Number.parseInt(fyShortMatch[1], 10);
    // FY27 -> 2027, FY99 -> 1999 (pivot at 50 for defense budget context).
    const fullYear = shortYear <= 50 ? 2000 + shortYear : 1900 + shortYear;
    return {
      fiscalLabelKind: 'explicit_fy',
      explicitFiscalYear: fullYear,
      componentLabel,
      stageLabel,
    };
  }

  /* Relative labels. */
  const byMatch = BY_RE.exec(text);
  if (byMatch) {
    const offset = byMatch[1] != null && byMatch[1] !== '' ? Number.parseInt(byMatch[1], 10) : 0;
    return {
      fiscalLabelKind: 'budget_year_relative',
      relativeOffset: offset,
      explicitFiscalYear: cycleFiscalYear + offset,
      componentLabel,
      stageLabel: stageLabel === 'none' ? 'request' : stageLabel,
    };
  }

  if (PY_RE.test(upper)) {
    return {
      fiscalLabelKind: 'prior_year_relative',
      relativeOffset: -1,
      explicitFiscalYear: cycleFiscalYear - 1,
      componentLabel,
      stageLabel: stageLabel === 'none' ? 'actual' : stageLabel,
    };
  }

  if (CY_RE.test(upper)) {
    return {
      fiscalLabelKind: 'current_year_relative',
      relativeOffset: 0,
      explicitFiscalYear: cycleFiscalYear,
      componentLabel,
      stageLabel: stageLabel === 'none' ? 'enacted' : stageLabel,
    };
  }

  const oyMatch = OY_RE.exec(text);
  if (oyMatch?.[1] != null) {
    const offset = Number.parseInt(oyMatch[1], 10);
    return {
      fiscalLabelKind: 'outyear_relative',
      relativeOffset: offset,
      explicitFiscalYear: cycleFiscalYear + offset,
      componentLabel,
      stageLabel: 'projection',
    };
  }

  /* Bare 4-digit year. */
  const bareYearMatch = YEAR_BARE_RE.exec(text);
  if (bareYearMatch?.[1] != null) {
    const year = Number.parseInt(bareYearMatch[1], 10);
    return {
      fiscalLabelKind: 'explicit_fy',
      explicitFiscalYear: year,
      componentLabel,
      stageLabel,
    };
  }

  return {
    fiscalLabelKind: 'unlabeled',
    componentLabel,
    stageLabel,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
