/**
 * r2-cost-table-extractor-v1 — complete R-2 PE-level funding and budget
 * position extraction from Phase 3 normalized page results.
 *
 * Workstream G (Phase 4 plan §12). For every R-2 cost table inside a
 * pre-segmented PE page range, captures:
 *   - the authoritative "Total Program Element" row;
 *   - base/OCO/total component rows and component columns;
 *   - project rows when the R-2 cost table includes them;
 *   - subtotal/continuation rows (continuation pages are stitched, never
 *     double-extracted);
 *   - cost-to-complete and total-cost values as non-annual costs.
 *
 * Column interpretation uses Workstream B exclusively
 * (rdte-header-normalizer + rdte-column-classifier). Dispositions follow
 * Phase 4 plan §12:
 *   - cycle-FY budget-year request  -> canonical_request_candidate
 *   - other year-bearing PB values  -> pe_budget_position
 *   - prior actual / current enacted -> contextual_only
 *   - cost to complete / total cost -> non_annual_cost
 *   - base/OCO split                -> contextual components
 *
 * R-1/R-2 agreement is handled by emitting one cross-document comparison
 * request per PE/FY present in both exhibits. R-1 and R-2 always retain
 * different source-document/proof identities.
 *
 * Pure module. Never invokes a parser, never writes to a database.
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

/* ------------------------------------------------------------------ */
/* Segmented PE context (owned by WS E)                                 */
/* ------------------------------------------------------------------ */

/**
 * Pre-segmented PE context supplied by the Workstream E segmenter. The
 * extractor never does its own segmentation.
 */
export interface R2PeContextV1 {
  peCode: string;
  /** Inclusive physical-page range of this PE's R-2 exhibit section. */
  pageStart: number;
  pageEnd: number;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Row kinds                                                            */
/* ------------------------------------------------------------------ */

export const R2_ROW_KIND_V1_VALUES = [
  'pe_total',
  'base_component',
  'oco_component',
  'total_component',
  'project',
  'subtotal',
  'continuation',
] as const;
export type R2RowKindV1 = (typeof R2_ROW_KIND_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Output types                                                         */
/* ------------------------------------------------------------------ */

export interface R2FundingValue {
  peCode: string;
  /** Present when the value sits on a project row inside the PE section. */
  projectCode?: string;
  rowKind: R2RowKindV1;
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
  /** base/OCO/total context: the component this value belongs to. */
  componentContext: 'base' | 'oco' | 'total' | 'none';
  /** True when printed directly; false when derived (never done silently). */
  direct: boolean;
}

export interface R2ExtractionOmission {
  peCode?: string;
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

/**
 * A cross-document comparison request. The R-2 side carries this document's
 * identity; the R-1 side is referenced by natural key only and must be
 * resolved by Phase 2's independent-reference mechanism with a DIFFERENT
 * source-document/proof identity.
 */
export interface R2R1ComparisonRequestV1 {
  comparisonKind: 'r1_r2_pe_funding_agreement';
  peCode: string;
  fiscalYear: number;
  field: 'request';
  r2ValueMillions: string;
  r2Evidence: {
    page: number;
    printedPage?: string;
    tableIndex: number;
    rowIndex: number;
    columnIndex: number;
    headerText: string;
  };
  /** Natural key used to locate the independent R-1 reference. */
  r1ReferenceKey: {
    peCode: string;
    fiscalYear: number;
    field: 'request';
  };
}

export interface R2ExtractionResult {
  peCode: string;
  values: R2FundingValue[];
  omissions: R2ExtractionOmission[];
  /** PE/FY keys present in this R-2 extraction as budget-year requests. */
  requestKeys: Array<{ peCode: string; fiscalYear: number }>;
  unitResolution: ReturnType<typeof resolveRdteUnit>;
  usedPositionalFallback: boolean;
  fallbackPolicyId?: string;
}

/* ------------------------------------------------------------------ */
/* Table detection                                                      */
/* ------------------------------------------------------------------ */

interface R2DetectedRow {
  rowIndex: number;
  kind: R2RowKindV1;
  label: string;
  projectCode?: string;
  cells: Array<{ columnIndex: number; text: string }>;
}

interface R2DetectedTable {
  page: number;
  printedPage?: string;
  tableIndex: number;
  headerRowIndices: number[];
  rows: R2DetectedRow[];
  repeatedHeaderRowIndices: number[];
}

const NUMBER_RE = /^-?[\d,]+(?:\.\d+)?$/;
const PE_TOTAL_RE = /^\s*total\s+program\s+element\b/i;
const BASE_ROW_RE = /^\s*(?:base|base\s+budget|base\s+request)\s*$/i;
const OCO_ROW_RE = /^\s*(?:oco|overseas\s+contingency|overseas\s+contingency\s+operations)\s*$/i;
const TOTAL_ROW_RE = /^\s*(?:total|total\s+request|total\s+funding)\s*$/i;
const SUBTOTAL_ROW_RE = /^\s*(?:subtotal|sub-total|total\s+projects?|program\s+subtotal)\b/i;
const CONTINUATION_RE = /\bcontinued\b|\bcontinuation\b|\bcont['.]?\b|\(\s*continued\s*\)/i;
const PROJECT_CODE_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;
const HEADER_HINT_RE =
  /\b(fy|fiscal|year|cost\s+to\s+complete|total\s+cost|actual|enacted|request|base|oco|total)\b/i;
const UNIT_RE = /\$?\s*in\s+(?:thousands|millions|dollars)\b|^\s*unit\b/i;

function detectR2CostTablesOnPage(page: ParserPageResultV1): R2DetectedTable[] {
  const detected: R2DetectedTable[] = [];
  for (const table of page.tables) {
    const result = analyzeR2Table(page.page, page.printedPage, table);
    if (result != null) detected.push(result);
  }
  return detected;
}

function analyzeR2Table(
  page: number,
  printedPage: string | undefined,
  table: {
    tableIndex: number;
    cells: Array<{ rowIndex: number; columnIndex: number; text: string }>;
  },
): R2DetectedTable | null {
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
  const dataRows: R2DetectedRow[] = [];
  let headerSeen = false;

  for (const [rowIndex, cells] of rows) {
    const firstText = cells[0]?.text.trim() ?? '';
    const rowText = cells
      .map((c) => c.text)
      .join(' ')
      .trim();

    if (rowText === '') continue;

    /* Unit/caption rows are metadata.  A row that carries BOTH a unit
     * label and fiscal-year header vocabulary is a header row, not a
     * caption — fall through to the header check below. */
    if (UNIT_RE.test(rowText) && !HEADER_HINT_RE.test(rowText)) {
      continue;
    }

    /* Authoritative PE-total row. */
    if (PE_TOTAL_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'pe_total',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }

    /* base/OCO/total component rows (label-only first cell). */
    if (BASE_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'base_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }
    if (OCO_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'oco_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }
    if (TOTAL_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'total_component',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }

    /* Subtotal rows are preserved as context. */
    if (SUBTOTAL_ROW_RE.test(firstText)) {
      dataRows.push({
        rowIndex,
        kind: 'subtotal',
        label: firstText,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
      });
      continue;
    }

    /* Continuation marker rows are metadata, not data. A continuation
     * label like "Total Program Element (continued)" keeps its pe_total
     * authority (the "(continued)" suffix is stripped by the pe-total
     * branch above); the row-level continuation branch below handles the
     * second extraction of the same PE total. */
    if (
      CONTINUATION_RE.test(rowText) &&
      !PE_TOTAL_RE.test(firstText) &&
      !NUMBER_RE.test(firstText)
    ) {
      continue;
    }

    /* Header rows: fiscal vocabulary and no numeric payload anywhere in
     * the row. A row that carries numbers is data even when it also
     * contains fiscal words (e.g. a project title mentioning a year). */
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

    /* Project row: short alphanumeric code in the first cell with at least
     * one numeric cell, or a titled row carrying numeric payload. Project
     * rows never contain a bare 4-digit fiscal year in the first cell. */
    const numericCells = cells.filter((c) => NUMBER_RE.test(c.text.trim()));
    if (
      numericCells.length > 0 &&
      firstText !== '' &&
      !/^\d{4}$/.test(firstText) &&
      firstText.length <= 40
    ) {
      const candidate = firstText.replace(/[.\-\s]/g, '');
      const looksLikeCode =
        PROJECT_CODE_RE.test(firstText) &&
        candidate.length <= 12 &&
        /[A-Z]/i.test(firstText) &&
        !/^\d+$/.test(candidate);
      const projectCode = looksLikeCode ? firstText : undefined;
      dataRows.push({
        rowIndex,
        kind: 'project',
        label: firstText,
        ...(projectCode != null ? { projectCode } : {}),
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
/* Disposition policy (Phase 4 plan §12)                                */
/* ------------------------------------------------------------------ */

function dispositionForRole(role: RdteColumnRoleV1): RdteValueDispositionV1 | null {
  switch (role) {
    case 'budget_year_request':
      return 'canonical_request_candidate';
    case 'outyear_projection':
      return 'pe_budget_position';
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
/* Extractor                                                            */
/* ------------------------------------------------------------------ */

export function extractR2PeFunding(input: {
  pages: readonly ParserPageResultV1[];
  peContext: R2PeContextV1;
  cycleFiscalYear: number;
  manifestUnit?: MoneyUnitV1;
  positionalFallbackPolicy?: {
    policyId: string;
    positionToRole: Readonly<Record<number, string>>;
  };
}): R2ExtractionResult {
  const { peContext, cycleFiscalYear } = input;
  const pages = input.pages.filter(
    (page) => page.page >= peContext.pageStart && page.page <= peContext.pageEnd,
  );

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

  const values: R2FundingValue[] = [];
  const omissions: R2ExtractionOmission[] = [];
  const requestKeys = new Map<string, { peCode: string; fiscalYear: number }>();
  let usedPositionalFallback = false;
  let fallbackPolicyId: string | undefined;

  /* Continuation stitching: track whether a pe_total row has already been
   * extracted for this PE. Continuation pages must never double-extract
   * the PE total; they only carry continuation context. */
  let peTotalExtracted = false;

  /* A page whose table carries no data rows (pure repeated header or a
   * bare continuation marker like "Total Program Element (continued)")
   * contributes nothing new; its rows are already classified as
   * continuation/repeated-header notes below. */

  for (const page of pages) {
    const tables = detectR2CostTablesOnPage(page);

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

      /* A page whose table carries no data rows (pure repeated header or a
       * bare continuation marker) contributes nothing new. */
      if (table.rows.length === 0) {
        continue;
      }

      const columnRoles = new Map<number, ReturnType<typeof classifyRdteColumn>>();
      for (const column of header.columns) {
        columnRoles.set(column.columnIndex, classifyRdteColumn({ column, cycleFiscalYear }));
      }

      /* A page whose only repeated content is a header carries no new data
       * unless it also has data rows. */
      if (table.rows.length === 0) {
        continue;
      }

      for (const row of table.rows) {
        /* Continuation pages: a second "Total Program Element" row for the
         * same PE is a subtotal/continuation artifact — mark it and do not
         * re-extract the PE total values. */
        if (row.kind === 'pe_total') {
          if (peTotalExtracted) {
            row.kind = 'continuation';
          } else {
            peTotalExtracted = true;
          }
        }

        if (row.kind === 'continuation') {
          /* Preserved as an omission-style note so downstream can see the
           * row existed without treating it as a second authoritative total. */
          omissions.push({
            peCode: peContext.peCode,
            page: table.page,
            rowIndex: row.rowIndex,
            reason: 'continuation_row',
            rawText: row.label,
          });
          continue;
        }

        for (const cell of row.cells) {
          if (cell.columnIndex === 0) continue;
          const text = cell.text.trim();
          if (text === '' || text === '-' || text === '—') continue;

          const classification = columnRoles.get(cell.columnIndex);
          if (classification == null || classification.role === 'unknown') {
            omissions.push({
              peCode: peContext.peCode,
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
              peCode: peContext.peCode,
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
              peCode: peContext.peCode,
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
              peCode: peContext.peCode,
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
              peCode: peContext.peCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'missing_fiscal_year',
              rawText: text,
            });
            continue;
          }

          const disposition = dispositionForRole(classification.role);
          if (disposition == null) {
            omissions.push({
              peCode: peContext.peCode,
              page: table.page,
              rowIndex: row.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'no_lawful_disposition',
              rawText: text,
            });
            continue;
          }

          /* base/OCO/total context: prefer explicit column component; fall
           * back to the row kind when the column is unlabeled. */
          const componentContext: 'base' | 'oco' | 'total' | 'none' =
            classification.role === 'base_component' ||
            classification.role === 'oco_component' ||
            classification.role === 'total_component'
              ? classification.role === 'base_component'
                ? 'base'
                : classification.role === 'oco_component'
                  ? 'oco'
                  : 'total'
              : row.kind === 'base_component'
                ? 'base'
                : row.kind === 'oco_component'
                  ? 'oco'
                  : row.kind === 'total_component'
                    ? 'total'
                    : 'none';

          const value: R2FundingValue = {
            peCode: peContext.peCode,
            ...(row.projectCode != null ? { projectCode: row.projectCode } : {}),
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
            componentContext,
            direct: true,
          };
          values.push(value);

          if (disposition === 'canonical_request_candidate' && fiscalYear != null) {
            requestKeys.set(`${peContext.peCode}|${fiscalYear}`, {
              peCode: peContext.peCode,
              fiscalYear,
            });
          }
        }
      }

      /* Repeated headers on continuation pages are metadata, not data. */
      for (const rowIndex of table.repeatedHeaderRowIndices) {
        omissions.push({
          peCode: peContext.peCode,
          page: table.page,
          rowIndex,
          reason: 'repeated_header',
          rawText: `table ${table.tableIndex} row ${rowIndex}`,
        });
      }
    }
  }

  return {
    peCode: peContext.peCode,
    values,
    omissions,
    requestKeys: [...requestKeys.values()],
    unitResolution,
    usedPositionalFallback,
    ...(fallbackPolicyId != null ? { fallbackPolicyId } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* R-1/R-2 comparison requests                                          */
/* ------------------------------------------------------------------ */

/**
 * Build one cross-document comparison request for each PE/FY present in
 * BOTH the R-2 extraction and the supplied R-1 key set. The request keeps
 * the R-2 evidence identity on this side and references the R-1 side by
 * natural key only — Phase 2 resolves the R-1 side through the independent
 * reference artifact index, so the two sides always retain different
 * source-document/proof identities.
 */
export function buildR2R1ComparisonRequests(input: {
  r2Results: readonly R2ExtractionResult[];
  r1RequestKeys: ReadonlySet<string>;
}): R2R1ComparisonRequestV1[] {
  const requests: R2R1ComparisonRequestV1[] = [];
  const seen = new Set<string>();

  for (const result of input.r2Results) {
    for (const value of result.values) {
      if (value.disposition !== 'canonical_request_candidate') continue;
      if (value.fiscalYear == null) continue;
      const key = `${value.peCode}|${value.fiscalYear}`;
      if (seen.has(key)) continue;
      if (!input.r1RequestKeys.has(key)) continue;
      seen.add(key);
      requests.push({
        comparisonKind: 'r1_r2_pe_funding_agreement',
        peCode: value.peCode,
        fiscalYear: value.fiscalYear,
        field: 'request',
        r2ValueMillions: value.valueMillions,
        r2Evidence: {
          page: value.page,
          ...(value.printedPage != null ? { printedPage: value.printedPage } : {}),
          tableIndex: value.tableIndex,
          rowIndex: value.rowIndex,
          columnIndex: value.columnIndex,
          headerText: value.headerText,
        },
        r1ReferenceKey: {
          peCode: value.peCode,
          fiscalYear: value.fiscalYear,
          field: 'request',
        },
      });
    }
  }

  return requests.sort((a, b) => a.peCode.localeCompare(b.peCode) || a.fiscalYear - b.fiscalYear);
}
