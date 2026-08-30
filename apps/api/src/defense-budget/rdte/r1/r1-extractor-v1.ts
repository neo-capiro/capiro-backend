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
      sectionHeading?: string;
      budgetActivity?: string;
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
          };

          /* Duplicate/conflict semantics, keyed by proven source-row
           * identity (Phase 10B-12): a PE code recurring across pages is
           * NOT automatically a conflict. Proven against the real 114-page
           * document (258 cross-page PE codes; zero true same-identity
           * contradictions found): the same value recurring is a
           * provenance reprint (e.g. the Defense-Wide roll-up volume
           * restating an agency's own chapter row) -- deduplicated into a
           * single funding value, never a second assertion. A different
           * value recurring under a *different* row identity (section
           * heading + budget activity -- e.g. PE 0604201F's real BA04 vs
           * BA05 rows) is a legitimate constituent split, not "automatically
           * a conflict": both values are kept as independent facts, and
           * whether/how to reconcile them into one canonical
           * ProgramElementYear.request is a governed projection-layer
           * decision (see rdte-projection-planner-v1's duplicate_conflict
           * exclusion), never resolved here by picking one or summing.
           * Only a different value recurring under the SAME row identity
           * (or with no row-identity evidence available at all, e.g. a
           * structural-table document with no reconstructor context) is a
           * true blocking conflict. */
          if (fiscalYear != null) {
            const conflictKey = `${peRow.peCode}|${fiscalYear}|${classification.role}`;
            const priorOccurrences = fundingOccurrencesByKey.get(conflictKey) ?? [];
            const identityKey = (occ: { sectionHeading?: string; budgetActivity?: string }) =>
              occ.sectionHeading != null && occ.budgetActivity != null
                ? `${occ.sectionHeading}|${occ.budgetActivity}`
                : undefined;
            const thisIdentity = identityKey({
              sectionHeading: peRow.rowContext?.sectionHeading,
              budgetActivity: peRow.rowContext?.budgetActivity,
            });

            const identicalPrior = priorOccurrences.find(
              (occ) => occ.originalValue === value.originalValue,
            );
            if (identicalPrior != null) {
              /* Deterministic duplicate / provenance merge: the same fact,
               * printed again elsewhere. No second assertion. */
              continue;
            }

            const sameIdentityPrior = priorOccurrences.find((occ) => {
              const otherIdentity = identityKey(occ);
              /* Row identity unknown on either side -> cannot prove they
               * differ; treat as the same identity (safe default). */
              if (thisIdentity == null || otherIdentity == null) return true;
              return otherIdentity === thisIdentity;
            });

            funding.push(value);
            priorOccurrences.push({
              originalValue: value.originalValue,
              page: peRow.page,
              sectionHeading: peRow.rowContext?.sectionHeading,
              budgetActivity: peRow.rowContext?.budgetActivity,
            });
            fundingOccurrencesByKey.set(conflictKey, priorOccurrences);

            if (sameIdentityPrior != null) {
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
                  values: [sameIdentityPrior.originalValue, value.originalValue],
                  pages: [sameIdentityPrior.page, peRow.page],
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
