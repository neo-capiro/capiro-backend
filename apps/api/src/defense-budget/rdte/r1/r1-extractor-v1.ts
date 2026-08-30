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
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';
import { classifyRdteColumn } from '../rdte-column-classifier.js';
import { normalizeRdteHeader, type RawHeaderRowV1 } from '../rdte-header-normalizer.js';
import { resolveRdteUnit } from '../rdte-unit-resolver.js';
import { type RdteColumnRoleV1, type RdteValueDispositionV1 } from '../rdte-column-role-v1.js';
import { detectR1TablesOnPage } from './r1-table-detector.js';
import type { R1RowContextV1 } from './r1-text-row-reconstructor-v1.js';

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
  /** Source-row context (see `R1PeIdentity.sectionHeading`); not canonical. */
  sectionHeading?: string;
  budgetActivity?: string;
  lineNumber?: string;
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
  /**
   * The organizational section heading this row was printed under (e.g.
   * "Defense Threat Reduction Agency"), when known. This is source-row
   * provenance/context, NOT a canonical field: the canonical PE identity
   * remains keyed by `peCode` alone (see `rdtePeIdentityV1Schema`), since
   * an RDT&E PE code already self-encodes its owning service via its
   * suffix letter. Distinct from `component` (the coarse, canonical
   * `BudgetComponentV1` enum) because proven, real-document evidence shows
   * many genuinely different sections (an agency's own chapter vs. the
   * broader Defense-Wide roll-up volume that restates it) share the same
   * coarse component value.
   */
  sectionHeading?: string;
  component?: BudgetComponentV1;
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
  /**
   * Optional row context recovered by `r1-text-row-reconstructor-v1`'s
   * text-reconstruction path (see `R1RowContextV1`), keyed by physical
   * page then by the row index used in that page's `table.cells`. Absent
   * for structural-table R-1 documents, where behavior is unchanged.
   */
  rowContextByPage?: ReadonlyMap<number, ReadonlyMap<number, R1RowContextV1>>;
}): R1ExtractionResult {
  const { pages, cycleFiscalYear } = input;

  /* Resolve unit from page text + manifest policy. */
  const unitCandidates = pages.flatMap((page) => {
    const candidates: Array<{ rawText: string; page: number; printedPage?: string }> = [];
    if (page.text != null) {
      candidates.push({
        rawText: page.text.slice(0, 2000),
        page: page.page,
        printedPage: page.printedPage ?? undefined,
      });
    }
    for (const block of page.blocks) {
      if (block.blockType === 'header' || block.blockType === 'caption') {
        candidates.push({
          rawText: block.text,
          page: page.page,
          printedPage: page.printedPage ?? undefined,
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
  /** Prior (peCode|FY|role) funding occurrences, for dedupe/conflict decisions. */
  const fundingOccurrencesByKey = new Map<
    string,
    Array<{
      originalValue: string;
      page: number;
      budgetActivity?: string;
      lineNumber?: string;
    }>
  >();
  let usedPositionalFallback = false;
  let fallbackPolicyId: string | undefined;

  for (const page of pages) {
    const tables = detectR1TablesOnPage(page, input.rowContextByPage?.get(page.page));

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
          ...(peRow.rowContext?.lineNumber != null
            ? { lineNumber: peRow.rowContext.lineNumber }
            : {}),
          ...(peRow.rowContext?.appropriation != null
            ? { appropriation: peRow.rowContext.appropriation }
            : {}),
          ...(peRow.rowContext?.budgetActivity != null
            ? { budgetActivity: peRow.rowContext.budgetActivity }
            : {}),
          ...(peRow.rowContext?.sectionHeading != null
            ? { sectionHeading: peRow.rowContext.sectionHeading }
            : {}),
          ...(peRow.rowContext?.component != null
            ? { component: peRow.rowContext.component }
            : {}),
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
            ...(peRow.rowContext?.sectionHeading != null
              ? { sectionHeading: peRow.rowContext.sectionHeading }
              : {}),
            ...(peRow.rowContext?.budgetActivity != null
              ? { budgetActivity: peRow.rowContext.budgetActivity }
              : {}),
            ...(peRow.rowContext?.lineNumber != null
              ? { lineNumber: peRow.rowContext.lineNumber }
              : {}),
          };

          /* Duplicate/conflict semantics, keyed by proven business-row
           * identity (Phase 10B-13, correcting a Phase 10B-12 edge case):
           * a PE code recurring across pages is NOT automatically a
           * conflict, but neither is "same PE, same dollar value" alone
           * sufficient to merge -- two legitimate constituent rows can
           * share a PE and a dollar amount while genuinely differing by
           * budget activity, and those must remain two distinct facts.
           *
           * Row identity is `budgetActivity` (+ `lineNumber` when reliably
           * present on both sides, for extra distinguishing precision) --
           * deliberately NOT section heading. Proven empirically against
           * the real 114-page document's projection-planner dry run: every
           * one of its ~240 genuine cross-page reprints (the Defense-Wide
           * roll-up restating an individual agency's own chapter row, e.g.
           * PE 0303150K's BA08 line 279 printed both in the roll-up and in
           * DISA's own chapter) matches on budgetActivity+lineNumber
           * despite printing under two different section headings; the
           * only 15 PE codes that failed to match were exactly the PE
           * codes independently proven (from a real budget-activity
           * subtotal line, for PE 0604201F) to be genuinely split across
           * two budget activities. Section heading remains pure
           * provenance metadata (`value.sectionHeading`, set above) -- an
           * agency chapter and the Defense-Wide roll-up can legitimately
           * reproduce the exact same source row under different headings,
           * and using heading as identity would wrongly treat that
           * reprint as two different rows.
           *
           * Decision matrix:
           *   same row identity + same value      -> deterministic reprint
           *                                           merge (no 2nd assertion)
           *   same row identity + different value -> true blocking conflict
           *   different row identity, any value   -> preserve BOTH facts
           *                                           (never automatically
           *                                           a conflict, never merged)
           *   row identity unknown on either side -> fail closed: never
           *                                           merge; still conflict
           *                                           on a value difference
           *                                           (the original,
           *                                           identity-blind
           *                                           behavior for
           *                                           structural-table
           *                                           documents with no
           *                                           reconstructor context)
           *
           * Whether/how truthful, un-mergeable constituent rows become one
           * canonical ProgramElementYear.request is a governed
           * projection-layer decision (rdte-projection-planner-v1's
           * duplicate_conflict exclusion), never resolved here by picking
           * one value or summing. */
          if (fiscalYear != null) {
            const conflictKey = `${peRow.peCode}|${fiscalYear}|${classification.role}`;
            const priorOccurrences = fundingOccurrencesByKey.get(conflictKey) ?? [];

            const rowIdentityMatch = (
              a: { budgetActivity?: string; lineNumber?: string },
              b: { budgetActivity?: string; lineNumber?: string },
            ): boolean | undefined => {
              if (a.budgetActivity == null || b.budgetActivity == null) return undefined;
              if (a.budgetActivity !== b.budgetActivity) return false;
              if (a.lineNumber != null && b.lineNumber != null) {
                return a.lineNumber === b.lineNumber;
              }
              return true; // BA matches; lineNumber not comparable on at least one side
            };
            const thisRow = {
              budgetActivity: peRow.rowContext?.budgetActivity,
              lineNumber: peRow.rowContext?.lineNumber,
            };

            const mergeablePrior = priorOccurrences.find(
              (occ) =>
                occ.originalValue === value.originalValue &&
                rowIdentityMatch(thisRow, occ) === true,
            );
            if (mergeablePrior != null) {
              /* Deterministic duplicate / provenance merge: the same
               * business row, printed again elsewhere. No second
               * assertion. */
              continue;
            }

            const conflictingPrior = priorOccurrences.find((occ) => {
              if (occ.originalValue === value.originalValue) return false;
              const match = rowIdentityMatch(thisRow, occ);
              /* Row identity unknown on either side -> cannot prove they
               * differ; fail closed and treat as the same identity. A
               * *known-different* identity is never automatically a
               * conflict. */
              return match === true || match === undefined;
            });

            funding.push(value);
            priorOccurrences.push({
              originalValue: value.originalValue,
              page: peRow.page,
              budgetActivity: peRow.rowContext?.budgetActivity,
              lineNumber: peRow.rowContext?.lineNumber,
            });
            fundingOccurrencesByKey.set(conflictKey, priorOccurrences);

            if (conflictingPrior != null) {
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
                  values: [conflictingPrior.originalValue, value.originalValue],
                  pages: [conflictingPrior.page, peRow.page],
                });
              }
            }
          } else {
            funding.push(value);
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
