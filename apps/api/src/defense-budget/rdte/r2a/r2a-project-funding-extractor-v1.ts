/**
 * r2a-project-funding-extractor-v1 — complete R-2A project-level funding
 * extraction from Phase 3 normalized page results.
 *
 * Workstream I (Phase 4 plan §14). For every R-2A project funding cell,
 * captures:
 *   - parent PE code, project code exactly as printed, asserted fiscal year;
 *   - original decimal value and unit;
 *   - column role and lawful disposition;
 *   - physical and printed page, row/column evidence, table identity;
 *   - direct/derived flag (extraction is always direct; derivation is never
 *     performed silently);
 *   - position-cycle metadata (every year-bearing value printed in a
 *     President's Budget cycle is a ProgramElementProjectBudgetPosition
 *     candidate tied to THAT cycle — an FYDP outyear is never treated as a
 *     future cycle's independently submitted request).
 *
 * Disposition policy (R-2A, project rows — Phase 4 plan §14):
 *   - cycle-FY budget-year request -> project_budget_position candidate for
 *     the printing cycle (R-2A detail NEVER becomes a PE-level canonical
 *     request assertion on its own; the R-2 PE total owns that stage);
 *   - outyear projections           -> project_budget_position;
 *   - prior actual / current enacted -> contextual_only;
 *   - base/OCO/total component rows -> contextual_only components;
 *   - cost-to-complete / total-cost -> non_annual_cost.
 *
 * Subtotal/total rows are detected and excluded from child sums; they are
 * preserved as extracted context rows with their own row kind so the
 * reconciler can reject any double-count attempt.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import {
  moneyToMillionsString,
  parseCanonicalDecimalString,
} from '../../contracts/decimal-string.js';
import type { MoneyUnitV1 } from '../../contracts/decimal-string.js';
import { classifyRdteColumn } from '../rdte-column-classifier.js';
import { normalizeRdteHeader, type RawHeaderRowV1 } from '../rdte-header-normalizer.js';
import { resolveRdteUnit } from '../rdte-unit-resolver.js';
import type { RdteColumnRoleV1, RdteValueDispositionV1 } from '../rdte-column-role-v1.js';
import { isValidR2aProjectCode } from './r2a-project-section-extractor.js';
import type { R2aProjectPageGroup } from './r2a-project-extractor-v1.js';

/* ------------------------------------------------------------------ */
/* Row kinds                                                           */
/* ------------------------------------------------------------------ */

export const R2A_ROW_KIND_V1_VALUES = [
  'project',
  'project_base_component',
  'project_oco_component',
  'project_total_component',
  'subtotal',
  'total',
  'continuation',
] as const;
export type R2aRowKindV1 = (typeof R2A_ROW_KIND_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R2aProjectFundingValue {
  parentPeCode: string;
  projectCode: string;
  rowKind: R2aRowKindV1;
  /** Fiscal year for year-bearing values; undefined for non-annual costs. */
  fiscalYear?: number;
  columnRole: RdteColumnRoleV1;
  disposition: RdteValueDispositionV1;
  originalValue: string;
  originalUnit: MoneyUnitV1;
  valueMillions: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  columnIndex: number;
  headerText: string;
  /** True when printed directly; extraction never derives values silently. */
  direct: boolean;
  /**
   * The President's Budget cycle that printed this value, e.g. `pb_fy2027`.
   * Every year-bearing R-2A value is a project budget position tied to this
   * cycle — never an independently submitted request of the outyear's cycle.
   */
  positionCycle: string;
}

export interface R2aFundingOmission {
  parentPeCode?: string;
  projectCode?: string;
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface R2aProjectFundingExtractionResult {
  parentPeCode: string;
  projectCode: string;
  values: R2aProjectFundingValue[];
  omissions: R2aFundingOmission[];
  unitResolution: ReturnType<typeof resolveRdteUnit>;
  usedPositionalFallback: boolean;
  fallbackPolicyId?: string;
}

/* ------------------------------------------------------------------ */
/* Table detection                                                     */
/* ------------------------------------------------------------------ */

interface R2aDetectedRow {
  rowIndex: number;
  kind: R2aRowKindV1;
  label: string;
  cells: Array<{ columnIndex: number; text: string }>;
}

interface R2aDetectedTable {
  page: number;
  printedPage?: string;
  tableIndex: number;
  headerRowIndices: number[];
  rows: R2aDetectedRow[];
  repeatedHeaderRowIndices: number[];
}

const NUMBER_RE = /^-?[\d,]+(?:\.\d+)?$/;
const BASE_ROW_RE = /^\s*(?:base|base\s+budget|base\s+request|base\s+funding)\s*:?\s*$/i;
const OCO_ROW_RE =
  /^\s*(?:oco|overseas\s+contingency|overseas\s+contingency\s+operations)\s*:?\s*$/i;
const TOTAL_ROW_RE =
  /^\s*(?:total|total\s+request|total\s+funding|total\s+project|project\s+total)\s*:?\s*$/i;
const SUBTOTAL_ROW_RE = /^\s*(?:subtotal|sub-total|program\s+subtotal)\b/i;
const CONTINUATION_RE = /\bcontinued\b|\bcontinuation\b|\bcont[.]?\b|\(\s*continued\s*\)/i;
const HEADER_HINT_RE =
  /\b(fy|fiscal|year|cost\s+to\s+complete|total\s+cost|actual|enacted|request|base|oco|total)\b/i;
const UNIT_RE = /\$?\s*in\s+(?:thousands|millions|dollars)\b|^\s*unit\b/i;
/**
 * Row labels that announce an R-2A funding table. Typical prints: "Project
 * Cost", "Exhibit R-2A ... Cost ($ in Millions)", "Funding", "R-2A Cost".
 */
const R2A_TABLE_LABEL_RE = /\bcost\b|\bfunding\b|\bbudget\b/i;

function detectR2aFundingTablesOnPage(page: ParserPageResultV1): R2aDetectedTable[] {
  const detected: R2aDetectedTable[] = [];
  for (const table of page.tables) {
    const result = analyzeR2aTable(page.page, page.printedPage, table);
    if (result != null) detected.push(result);
  }
  return detected;
}

function analyzeR2aTable(
  page: number,
  printedPage: string | undefined,
  table: {
    tableIndex: number;
    cells: Array<{ rowIndex: number; columnIndex: number; text: string }>;
  },
): R2aDetectedTable | null {
  const byRow = new Map<number, Array<{ columnIndex: number; text: string }>>();
  for (const cell of table.cells) {
    const existing = byRow.get(cell.rowIndex) ?? [];
    existing.push({ columnIndex: cell.columnIndex, text: cell.text });
    byRow.set(cell.rowIndex, existing);
  }
  const rows = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([rowIndex, cells]) =>
        [rowIndex, cells.sort((a, b) => a.columnIndex - b.columnIndex)] as const,
    );

  const headerRowIndices: number[] = [];
  const repeatedHeaderRowIndices: number[] = [];
  const dataRows: R2aDetectedRow[] = [];
  let headerSeen = false;

  for (const [rowIndex, cells] of rows) {
    const firstText = cells[0]?.text.trim() ?? '';
    const rowText = cells
      .map((c) => c.text)
      .join(' ')
      .trim();

    if (rowText === '') continue;

    /* Unit/caption rows are metadata unless they also carry fiscal header
     * vocabulary (then they are header rows). */
    if (UNIT_RE.test(rowText) && !HEADER_HINT_RE.test(rowText)) {
      continue;
    }

    /* base/OCO/total component rows for the project (label-only first cell). */
    if (BASE_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'project_base_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }
    if (OCO_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'project_oco_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }
    if (TOTAL_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'project_total_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }

    /* Subtotal rows are preserved as context and excluded from child sums. */
    if (SUBTOTAL_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'subtotal',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }

    /* Continuation markers are metadata. */
    if (CONTINUATION_RE.test(rowText) && !NUMBER_RE.test(firstText)) {
      continue;
    }

    /* Header rows: fiscal vocabulary with no numeric payload. */
    const hasNumericPayload = cells.some((c) => NUMBER_RE.test(c.text.trim()));
    if (HEADER_HINT_RE.test(rowText) && !hasNumericPayload) {
      if (!headerSeen) {
        headerRowIndices.push(rowIndex);
        headerSeen = true;
      } else {
        repeatedHeaderRowIndices.push(rowIndex);
      }
      continue;
    }

    /* Project funding row: the row that carries the project's annual values.
     * On an R-2A page the row may be labeled "Project Cost", the project
     * title, the project code, or be the single unlabeled numeric row. */
    if (hasNumericPayload) {
      dataRows.push({
        rowIndex,
        kind: 'project',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
    }
  }

  if (dataRows.length === 0 || headerRowIndices.length === 0) {
    return null;
  }

  return {
    page,
    printedPage,
    tableIndex: table.tableIndex,
    headerRowIndices,
    rows: dataRows,
    repeatedHeaderRowIndices,
  };
}

/* ------------------------------------------------------------------ */
/* Disposition policy (R-2A, Phase 4 plan §14)                          */
/* ------------------------------------------------------------------ */

/**
 * R-2A project values never become PE-level canonical request assertions.
 * The R-2 PE total owns `canonical_request_candidate`; R-2A cycle-FY request
 * values and all outyear values are project budget positions of the printing
 * cycle.
 */
function dispositionForR2aRole(role: RdteColumnRoleV1): RdteValueDispositionV1 | null {
  switch (role) {
    case 'budget_year_request':
    case 'outyear_projection':
      return 'project_budget_position';
    case 'prior_actual_context':
    case 'current_enacted_context':
    case 'base_component':
    case 'oco_component':
    case 'total_component':
      return 'contextual_only';
    case 'cost_to_complete':
    case 'total_cost':
      return 'non_annual_cost';
    case 'quantity':
    case 'unknown':
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract R-2A project funding from a pre-segmented project page group.
 * Segmentation (Workstream E) owns parent PE / project identity; this
 * extractor never re-segments.
 */
export function extractR2aProjectFunding(input: {
  group: R2aProjectPageGroup;
  cycleFiscalYear: number;
  manifestUnit?: MoneyUnitV1;
  positionalFallbackPolicy?: {
    policyId: string;
    positionToRole: Readonly<Record<number, string>>;
  };
}): R2aProjectFundingExtractionResult {
  const { group, cycleFiscalYear } = input;
  const { parentPeCode, projectCode, pages } = group;
  const positionCycle = `pb_fy${cycleFiscalYear}`;

  /* Blocking identity checks. */
  const identityOmissions: R2aFundingOmission[] = [];
  if (!isValidPeCode(parentPeCode)) {
    for (const page of pages) {
      identityOmissions.push({
        projectCode,
        page: page.page,
        reason: 'missing_or_invalid_parent_pe',
        rawText: parentPeCode,
      });
    }
  }
  if (!isValidR2aProjectCode(projectCode)) {
    for (const page of pages) {
      identityOmissions.push({
        parentPeCode,
        projectCode,
        page: page.page,
        reason: 'invalid_project_code',
        rawText: projectCode,
      });
    }
  }

  /* Unit resolution from page text + header/caption blocks. */
  const unitCandidates = pages.flatMap((page) => {
    const candidates: Array<{ rawText: string; page: number; printedPage?: string }> = [];
    if (page.text != null) {
      candidates.push({
        rawText: page.text.slice(0, 2000),
        page: page.page,
        ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
      });
    }
    for (const block of page.blocks) {
      if (block.blockType === 'header' || block.blockType === 'caption') {
        candidates.push({
          rawText: block.text,
          page: page.page,
          ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
        });
      }
    }
    return candidates;
  });
  const unitResolution = resolveRdteUnit({
    candidates: unitCandidates,
    manifestUnit: input.manifestUnit,
  });

  const values: R2aProjectFundingValue[] = [];
  const omissions: R2aFundingOmission[] = [...identityOmissions];
  let usedPositionalFallback = false;
  let fallbackPolicyId: string | undefined;

  if (identityOmissions.length > 0) {
    return {
      parentPeCode,
      projectCode,
      values,
      omissions,
      unitResolution,
      usedPositionalFallback,
    };
  }

  /* Continuation stitching: project rows on continuation pages are extracted
   * once per (table, row) — the same project funding row must never be
   * extracted twice. Track seen (fiscalYear, columnIndex) keys across pages
   * to guard against a repeated row on a continuation page. */
  const seenCells = new Set<string>();

  for (const page of pages) {
    const tables = detectR2aFundingTablesOnPage(page);

    for (const table of tables) {
      const parsedTable = page.tables.find((t) => t.tableIndex === table.tableIndex);
      const headerRows: RawHeaderRowV1[] = table.headerRowIndices.map((rowIndex) => {
        const rowCells = parsedTable?.cells.filter((c) => c.rowIndex === rowIndex) ?? [];
        return {
          rowIndex,
          cells: rowCells.map((c) => ({
            text: c.text,
            rowIndex: c.rowIndex,
            columnIndex: c.columnIndex,
            ...(c.colSpan != null ? { colSpan: c.colSpan } : {}),
            ...(c.rowSpan != null ? { rowSpan: c.rowSpan } : {}),
          })),
        };
      });

      const header = normalizeRdteHeader({
        headerRows,
        cycleFiscalYear,
        positionalFallbackPolicy: input.positionalFallbackPolicy,
      });
      if (header.usedPositionalFallback) {
        usedPositionalFallback = true;
        fallbackPolicyId = header.fallbackPolicyId;
      }

      const columnRoles = new Map<number, ReturnType<typeof classifyRdteColumn>>();
      for (const column of header.columns) {
        columnRoles.set(column.columnIndex, classifyRdteColumn({ column, cycleFiscalYear }));
      }

      for (const row of table.rows) {
        for (const cell of row.cells) {
          if (cell.columnIndex === 0) continue;
          const text = cell.text.trim();
          if (text === '' || text === '-' || text === '—') continue;

          const classification = columnRoles.get(cell.columnIndex);
          if (classification == null || classification.role === 'unknown') {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'unresolved_column_role',
              rawText: text,
            });
            continue;
          }

          if (!NUMBER_RE.test(text)) {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'invalid_number',
              rawText: text,
            });
            continue;
          }

          if (unitResolution.status !== 'resolved') {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'missing_unit',
              rawText: text,
            });
            continue;
          }

          const cleaned = text.replace(/,/g, '');
          let canonical: string;
          try {
            canonical = parseCanonicalDecimalString(cleaned);
          } catch {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'invalid_number',
              rawText: text,
            });
            continue;
          }

          const fiscalYear = classification.fiscalYear;
          const isNonAnnual =
            classification.role === 'cost_to_complete' || classification.role === 'total_cost';
          if (fiscalYear == null && !isNonAnnual) {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'missing_fiscal_year',
              rawText: text,
            });
            continue;
          }

          /* Component rows (base/OCO/total) are always contextual — the
           * column classifier sees the FY header, but the row kind overrides
           * the disposition for these split rows. */
          const isComponentRow =
            row.kind === 'project_base_component' ||
            row.kind === 'project_oco_component' ||
            row.kind === 'project_total_component';
          const disposition = isComponentRow
            ? 'contextual_only'
            : dispositionForR2aRole(classification.role);
          if (disposition == null) {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'no_lawful_disposition',
              rawText: text,
            });
            continue;
          }

          /* Continuation guard: never extract the same logical cell twice. */
          const cellKey = `${row.kind}|${classification.role}|${fiscalYear ?? 'na'}|${canonical}`;
          if (seenCells.has(cellKey)) {
            omissions.push({
              parentPeCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'continuation_row',
              rawText: text,
            });
            continue;
          }
          seenCells.add(cellKey);

          values.push({
            parentPeCode,
            projectCode,
            rowKind: row.kind,
            ...(fiscalYear != null ? { fiscalYear } : {}),
            columnRole: classification.role,
            disposition,
            originalValue: canonical,
            originalUnit: unitResolution.unit,
            valueMillions: moneyToMillionsString(canonical, unitResolution.unit),
            page: table.page,
            ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
            tableIndex: table.tableIndex,
            rowIndex: row.rowIndex,
            columnIndex: cell.columnIndex,
            headerText:
              header.columns.find((c) => c.columnIndex === cell.columnIndex)?.normalizedText ?? '',
            direct: true,
            positionCycle,
          });
        }
      }

      /* Repeated headers on continuation pages are metadata, not data. */
      for (const rowIndex of table.repeatedHeaderRowIndices) {
        omissions.push({
          parentPeCode,
          projectCode,
          page: table.page,
          rowIndex,
          reason: 'repeated_header',
          rawText: `table ${table.tableIndex} row ${rowIndex}`,
        });
      }
    }
  }

  return {
    parentPeCode,
    projectCode,
    values,
    omissions,
    unitResolution,
    usedPositionalFallback,
    ...(fallbackPolicyId != null ? { fallbackPolicyId } : {}),
  };
}

/**
 * Convenience wrapper: extract funding for many pre-segmented project
 * groups. Each group is independent; unit resolution is per-group because
 * different projects may print in different units (the unit evidence must
 * identify the page that supplied it).
 */
export function extractR2aProjectFundingFromGroups(input: {
  groups: readonly R2aProjectPageGroup[];
  cycleFiscalYear: number;
  manifestUnit?: MoneyUnitV1;
  positionalFallbackPolicy?: {
    policyId: string;
    positionToRole: Readonly<Record<number, string>>;
  };
}): R2aProjectFundingExtractionResult[] {
  return input.groups.map((group) =>
    extractR2aProjectFunding({
      group,
      cycleFiscalYear: input.cycleFiscalYear,
      ...(input.manifestUnit != null ? { manifestUnit: input.manifestUnit } : {}),
      ...(input.positionalFallbackPolicy != null
        ? { positionalFallbackPolicy: input.positionalFallbackPolicy }
        : {}),
    }),
  );
}

/* Re-export for consumers that build table captions. */
export { R2A_TABLE_LABEL_RE };
