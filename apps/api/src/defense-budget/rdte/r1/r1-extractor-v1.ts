/**
 * r1-extractor-v1 — complete R-1 semantic extraction from Phase 3
 * normalized page results.
 *
 * For every R-1 PE row, captures:
 *   - PE code, title, service/component, appropriation, budget activity;
 *   - line number, classification marker as document fact;
 *   - physical PDF page, printed page, table/row evidence;
 *   - every recognized numeric column with original value/unit, fiscal year,
 *     column role, and disposition.
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
import {
  type RdteColumnRoleV1,
  type RdteValueDispositionV1,
} from '../rdte-column-role-v1.js';
import { detectR1TablesOnPage } from './r1-table-detector.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R1FundingValue {
  peCode: string;
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
  direct: boolean;
}

export interface R1PeIdentity {
  peCode: string;
  title: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  lineNumber?: string;
  appropriation?: string;
  budgetActivity?: string;
  budgetActivityName?: string;
  classificationMarker?: string;
}

export interface R1ExtractionOmission {
  peCode?: string;
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface R1ExtractionConflict {
  peCode: string;
  fiscalYear: number;
  columnRole: RdteColumnRoleV1;
  values: string[];
  pages: number[];
}

export interface R1ExtractionResult {
  identities: R1PeIdentity[];
  funding: R1FundingValue[];
  omissions: R1ExtractionOmission[];
  conflicts: R1ExtractionConflict[];
  unitResolution: ReturnType<typeof resolveRdteUnit>;
  usedPositionalFallback: boolean;
  fallbackPolicyId?: string;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

const NUMBER_RE = /^-?[\d,]+(?:\.\d+)?$/;

export function extractR1FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  manifestUnit?: MoneyUnitV1;
  positionalFallbackPolicy?: {
    policyId: string;
    positionToRole: Readonly<Record<number, string>>;
  };
}): R1ExtractionResult {
  const { pages, cycleFiscalYear } = input;

  /* Resolve unit from page text + manifest policy. */
  const unitCandidates = pages.flatMap((page) => {
    const candidates: Array<{ rawText: string; page: number; printedPage?: string }> = [];
    if (page.text != null) {
      candidates.push({
        rawText: page.text.slice(0, 2000),
        page: page.page,
        printedPage: page.printedPage,
      });
    }
    for (const block of page.blocks) {
      if (block.blockType === 'header' || block.blockType === 'caption') {
        candidates.push({
          rawText: block.text,
          page: page.page,
          printedPage: page.printedPage,
        });
      }
    }
    return candidates;
  });
  const unitResolution = resolveRdteUnit({
    candidates: unitCandidates,
    manifestUnit: input.manifestUnit,
  });

  const identities: R1PeIdentity[] = [];
  const funding: R1FundingValue[] = [];
  const omissions: R1ExtractionOmission[] = [];
  const conflictMap = new Map<string, R1ExtractionConflict>();
  let usedPositionalFallback = false;
  let fallbackPolicyId: string | undefined;

  for (const page of pages) {
    const tables = detectR1TablesOnPage(page);

    for (const table of tables) {
      /* Build header from detected header rows. */
      const headerRows: RawHeaderRowV1[] = table.headerRowIndices.map((rowIndex) => {
        const rowCells =
          page.tables
            .find((value) => value.tableIndex === table.tableIndex)
            ?.cells.filter((cell) => cell.rowIndex === rowIndex) ?? [];
        return {
          rowIndex,
          cells: rowCells.map((cell) => ({
            text: cell.text,
            rowIndex: cell.rowIndex,
            columnIndex: cell.columnIndex,
            colSpan: cell.colSpan,
            rowSpan: cell.rowSpan,
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

      /* Process PE rows. */
      for (const peRow of table.peRows) {
        if (!isValidPeCode(peRow.peCode)) {
          omissions.push({
            peCode: peRow.peCode,
            page: peRow.page,
            rowIndex: peRow.rowIndex,
            reason: 'invalid_pe_code',
            rawText: peRow.peCode,
          });
          continue;
        }

        identities.push({
          peCode: peRow.peCode,
          title: peRow.title,
          page: peRow.page,
          printedPage: peRow.printedPage,
          tableIndex: peRow.tableIndex,
          rowIndex: peRow.rowIndex,
        });

        /* Numeric cells: skip first two columns (PE code + title). */
        for (const cell of peRow.cells) {
          if (cell.columnIndex <= 1) continue;
          const text = cell.text.trim();
          if (text === '' || text === '-' || text === '—') continue;

          const classification = columnRoles.get(cell.columnIndex);
          if (classification == null || classification.role === 'unknown') {
            omissions.push({
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'unresolved_column_role',
              rawText: text,
            });
            continue;
          }

          if (!NUMBER_RE.test(text)) {
            omissions.push({
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'invalid_number',
              rawText: text,
            });
            continue;
          }

          if (unitResolution.status !== 'resolved') {
            omissions.push({
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
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
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
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
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'missing_fiscal_year',
              rawText: text,
            });
            continue;
          }

          const disposition = dispositionForRole(classification.role);
          if (disposition == null) {
            omissions.push({
              peCode: peRow.peCode,
              page: peRow.page,
              rowIndex: peRow.rowIndex,
              columnIndex: cell.columnIndex,
              reason: 'no_lawful_disposition',
              rawText: text,
            });
            continue;
          }

          const value: R1FundingValue = {
            peCode: peRow.peCode,
            ...(fiscalYear != null ? { fiscalYear } : {}),
            columnRole: classification.role,
            disposition,
            originalValue: canonical,
            originalUnit: unitResolution.unit,
            valueMillions: moneyToMillionsString(canonical, unitResolution.unit),
            page: peRow.page,
            ...(peRow.printedPage != null ? { printedPage: peRow.printedPage } : {}),
            tableIndex: peRow.tableIndex,
            rowIndex: peRow.rowIndex,
            columnIndex: cell.columnIndex,
            headerText:
              header.columns.find((column) => column.columnIndex === cell.columnIndex)
                ?.normalizedText ?? '',
            direct: true,
          };
          funding.push(value);

          /* Conflict detection: same PE/FY/role with different values. */
          if (fiscalYear != null) {
            const conflictKey = `${peRow.peCode}|${fiscalYear}|${classification.role}`;
            const existing = conflictMap.get(conflictKey);
            if (existing != null) {
              if (!existing.values.includes(value.originalValue)) {
                existing.values.push(value.originalValue);
                existing.pages.push(peRow.page);
              }
            } else {
              conflictMap.set(conflictKey, {
                peCode: peRow.peCode,
                fiscalYear,
                columnRole: classification.role,
                values: [value.originalValue],
                pages: [peRow.page],
              });
            }
          }
        }
      }

      /* Repeated headers are metadata, not PE rows — no action needed. */
      /* Unresolved rows become omissions. */
      for (const rowIndex of table.unresolvedRowIndices) {
        omissions.push({
          page: table.page,
          rowIndex,
          reason: 'unresolved_row_alignment',
          rawText: `table ${table.tableIndex} row ${rowIndex}`,
        });
      }
    }
  }

  /* Only true conflicts (multiple distinct values) are reported. */
  const conflicts = [...conflictMap.values()].filter((conflict) => conflict.values.length > 1);

  return {
    identities,
    funding,
    omissions,
    conflicts,
    unitResolution,
    usedPositionalFallback,
    fallbackPolicyId,
  };
}

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
