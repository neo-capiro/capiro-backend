/**
 * r3-table-extractor-v1 — complete R-3 performing-activity extraction from
 * Phase 3 normalized page results.
 *
 * Workstream J (Phase 4 plan §15). Captures PE/project context, cost category,
 * performer text (raw + normalized), location, contract method, total cost with
 * unit, fiscal year, and role evidence. Never maps R-3 total cost to PE/project
 * annual funding.
 *
 * Pure module.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import {
  moneyToMillionsString,
  parseCanonicalDecimalString,
  type MoneyUnitV1,
} from '../../contracts/decimal-string.js';
import type { PerformerRoleV1 } from '../../contracts/extraction-artifact-v1.js';
import { resolveRdteUnit } from '../rdte-unit-resolver.js';
import { isNamedCompanyV1 } from './r3-named-company-classifier.js';
import { classifyPerformerRole } from './r3-role-classifier.js';
import { normalizePerformerName, r3PerformerNaturalKey } from './r3-performer-normalizer.js';

/* ------------------------------------------------------------------ */
/* Input / output types                                                */
/* ------------------------------------------------------------------ */

export interface R3PeContextV1 {
  peCode: string;
  pageStart: number;
  pageEnd: number;
  projectCode?: string;
  title?: string;
}

export interface R3PerformerRowV1 {
  parentPeCode: string;
  projectCode?: string;
  performerName: string;
  performerNormalized: string;
  performerRole: PerformerRoleV1;
  roleExplicit: boolean;
  /**
   * A real named company (has a legal suffix, or a plausible proper name) as
   * opposed to a placeholder like `Various`/`TBD`/`MIPR`, a bare government
   * label, or state-code location bleed. Selection-filter grade, not merely
   * display metadata — see `getContractors`'s `namedPrimes` panel.
   */
  isNamedCompany: boolean;
  location?: string;
  contractMethod?: string;
  costCategory?: string;
  fiscalYear?: number;
  totalCost?: {
    originalValue: string;
    originalUnit: MoneyUnitV1;
    valueMillions: string;
  };
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  naturalKey: string;
  rawCells: Array<{ columnIndex: number; text: string }>;
}

export interface R3ExtractionOmission {
  peCode?: string;
  projectCode?: string;
  page: number;
  rowIndex?: number;
  reason: string;
  rawText: string;
}

export interface R3ExtractionConflict {
  naturalKey: string;
  peCode: string;
  performerNames: string[];
  pages: number[];
  reason: string;
}

export interface R3ExtractionResult {
  peCode: string;
  performers: R3PerformerRowV1[];
  omissions: R3ExtractionOmission[];
  conflicts: R3ExtractionConflict[];
  unitResolution: ReturnType<typeof resolveRdteUnit>;
  tableDetected: boolean;
}

/* ------------------------------------------------------------------ */
/* Table detection                                                     */
/* ------------------------------------------------------------------ */

const R3_HEADER_RE = /\bR-3\b|\bRDT&E\s+Cost\s+Analysis\b/i;
const NUMBER_RE = /^-?[\d,]+(?:\.\d+)?$/;
const PE_CODE_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
const PROJECT_CODE_RE = /\bproject\s*(?:code)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9.\-]{0,11})\b/i;
const UNIT_RE = /\$?\s*in\s+(?:thousands|millions|dollars)\b/i;
const FY_RE = /\bFY\s*(\d{2,4})\b/i;

type ColumnRole =
  | 'performer'
  | 'location'
  | 'contract_method'
  | 'cost'
  | 'cost_category'
  | 'fiscal_year'
  | 'unknown';

interface R3DetectedRow {
  rowIndex: number;
  cells: Array<{ columnIndex: number; text: string }>;
}

interface R3DetectedTable {
  page: number;
  printedPage?: string;
  tableIndex: number;
  headerRowIndices: number[];
  rows: R3DetectedRow[];
  columnRoles: Map<number, ColumnRole>;
  costCategory?: string;
}

function detectR3TablesOnPage(page: ParserPageResultV1): R3DetectedTable[] {
  const detected: R3DetectedTable[] = [];
  for (const table of page.tables) {
    const result = analyzeR3Table(page.page, page.printedPage, table);
    if (result != null) detected.push(result);
  }
  return detected;
}

function analyzeR3Table(
  page: number,
  printedPage: string | undefined,
  table: {
    tableIndex: number;
    cells: Array<{ rowIndex: number; columnIndex: number; text: string }>;
  },
): R3DetectedTable | null {
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
  const dataRows: R3DetectedRow[] = [];
  const columnRoles = new Map<number, ColumnRole>();
  let costCategory: string | undefined;

  for (const [rowIndex, cells] of rows) {
    const rowText = cells
      .map((c) => c.text)
      .join(' ')
      .trim();
    if (rowText === '') continue;

    /* Cost-category caption rows (e.g. "Product Development"). */
    if (
      cells.length <= 2 &&
      !NUMBER_RE.test(cells[0]?.text.trim() ?? '') &&
      /\b(product|development|management|support|test|evaluation|production|software|hardware)\b/i.test(
        rowText,
      ) &&
      !/\b(performing|activity|location|contract|cost|method)\b/i.test(rowText)
    ) {
      costCategory = rowText;
      continue;
    }

    const headerLabelCount = cells.filter((c) => {
      const t = c.text.trim().toLowerCase();
      return (
        /\b(performing|activity|performer|contractor|organization)\b/.test(t) ||
        /\b(location|city|state|place)\b/.test(t) ||
        /\b(contract|method|type|award)\b/.test(t) ||
        /\b(cost|total|amount|dollars)\b/.test(t) ||
        /\b(category|cost\s+category)\b/.test(t) ||
        /\b(fy|fiscal|year)\b/.test(t)
      );
    }).length;
    const hasNumeric = cells.some((c) => NUMBER_RE.test(c.text.trim()));
    const isHeader = headerLabelCount >= Math.max(2, Math.ceil(cells.length * 0.4)) && !hasNumeric;

    if (isHeader) {
      headerRowIndices.push(rowIndex);
      for (const cell of cells) {
        const t = cell.text.trim().toLowerCase();
        let role: ColumnRole = 'unknown';
        if (/\b(performing|activity|performer|contractor|organization|name)\b/.test(t)) {
          role = 'performer';
        } else if (/\b(location|city|state|place)\b/.test(t)) {
          role = 'location';
        } else if (/\b(contract|method|type|award)\b/.test(t)) {
          role = 'contract_method';
        } else if (/\b(cost|total|amount|dollars)\b/.test(t)) {
          role = 'cost';
        } else if (/\b(category)\b/.test(t)) {
          role = 'cost_category';
        } else if (/\b(fy|fiscal|year)\b/.test(t)) {
          role = 'fiscal_year';
        }
        columnRoles.set(cell.columnIndex, role);
      }
      continue;
    }

    if (hasNumeric || cells.some((c) => (c.text.trim() ?? '') !== '')) {
      dataRows.push({
        rowIndex,
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
    columnRoles,
    ...(costCategory != null ? { costCategory } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractR3Performers(input: {
  pages: readonly ParserPageResultV1[];
  peContext: R3PeContextV1;
  cycleFiscalYear?: number;
  manifestUnit?: MoneyUnitV1;
  sourceKey?: string;
}): R3ExtractionResult {
  const { peContext } = input;
  const pages = input.pages.filter(
    (page) => page.page >= peContext.pageStart && page.page <= peContext.pageEnd,
  );

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

  const performers: R3PerformerRowV1[] = [];
  const omissions: R3ExtractionOmission[] = [];
  const conflictMap = new Map<string, R3ExtractionConflict>();
  let tableDetected = false;

  if (!isValidPeCode(peContext.peCode)) {
    for (const page of pages) {
      omissions.push({
        peCode: peContext.peCode,
        page: page.page,
        reason: 'invalid_parent_pe',
        rawText: peContext.peCode,
      });
    }
    return {
      peCode: peContext.peCode,
      performers,
      omissions,
      conflicts: [],
      unitResolution,
      tableDetected: false,
    };
  }

  for (const page of pages) {
    const pageText = page.text ?? '';
    const blockTexts = page.blocks.map((b) => b.text);
    const isR3Page = R3_HEADER_RE.test(pageText) || blockTexts.some((t) => R3_HEADER_RE.test(t));
    if (!isR3Page) continue;

    const tables = detectR3TablesOnPage(page);
    if (tables.length > 0) tableDetected = true;

    for (const table of tables) {
      for (const row of table.rows) {
        const getCell = (role: ColumnRole) =>
          row.cells.find((c) => table.columnRoles.get(c.columnIndex) === role);

        const performerCell = getCell('performer') ?? row.cells[0];
        const locationCell = getCell('location');
        const methodCell = getCell('contract_method');
        const costCell = getCell('cost');
        const categoryCell = getCell('cost_category');
        const fyCell = getCell('fiscal_year');

        const performerName = performerCell?.text.trim() ?? '';
        if (performerName === '') {
          omissions.push({
            peCode: peContext.peCode,
            page: table.page,
            rowIndex: row.rowIndex,
            reason: 'missing_performer_name',
            rawText: row.cells.map((c) => c.text).join(' | '),
          });
          continue;
        }

        /* Role classification. */
        const roleClass = classifyPerformerRole({
          performerText: performerName,
          contextText: row.cells.map((c) => c.text).join(' '),
        });

        /* Location: avoid bleed from adjacent cells that look like methods. */
        let location = locationCell?.text.trim();
        if (location != null && location === '') location = undefined;

        const contractMethod = methodCell?.text.trim() || undefined;
        const costCategory = categoryCell?.text.trim() || table.costCategory || undefined;

        /* Project code: row-level wins, then section context. */
        let projectCode: string | undefined;
        const rowText = row.cells.map((c) => c.text).join(' ');
        const projMatch = PROJECT_CODE_RE.exec(rowText);
        if (projMatch?.[1] != null) {
          projectCode = projMatch[1];
        } else if (peContext.projectCode != null) {
          projectCode = peContext.projectCode;
        }

        /* Fiscal year. */
        let fiscalYear: number | undefined;
        if (fyCell != null && fyCell.text.trim() !== '') {
          const fyMatch = FY_RE.exec(fyCell.text) ?? /(\d{4})/.exec(fyCell.text);
          if (fyMatch?.[1] != null) {
            const n = parseInt(fyMatch[1], 10);
            fiscalYear = n < 100 ? 2000 + n : n;
          }
        } else if (input.cycleFiscalYear != null) {
          fiscalYear = input.cycleFiscalYear;
        }

        /* Total cost — never annual funding. */
        let totalCost: R3PerformerRowV1['totalCost'];
        if (costCell != null && costCell.text.trim() !== '') {
          const text = costCell.text.trim();
          if (!NUMBER_RE.test(text)) {
            omissions.push({
              peCode: peContext.peCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              reason: 'invalid_cost_number',
              rawText: text,
            });
          } else if (unitResolution.status !== 'resolved') {
            omissions.push({
              peCode: peContext.peCode,
              projectCode,
              page: table.page,
              rowIndex: row.rowIndex,
              reason: 'missing_unit',
              rawText: text,
            });
          } else {
            try {
              const canonical = parseCanonicalDecimalString(text.replace(/,/g, ''));
              totalCost = {
                originalValue: canonical,
                originalUnit: unitResolution.unit,
                valueMillions: moneyToMillionsString(canonical, unitResolution.unit),
              };
            } catch {
              omissions.push({
                peCode: peContext.peCode,
                projectCode,
                page: table.page,
                rowIndex: row.rowIndex,
                reason: 'invalid_cost_number',
                rawText: text,
              });
            }
          }
        }

        const performerNormalized = normalizePerformerName(performerName);
        const naturalKey = r3PerformerNaturalKey({
          peCode: peContext.peCode,
          projectCode,
          performerNormalized,
          location,
          contractMethod,
          costCategory,
          fiscalYear,
          sourceKey: input.sourceKey,
        });

        /* Conflict detection: same natural key with different raw names. */
        const existing = performers.find((p) => p.naturalKey === naturalKey);
        if (existing != null && existing.performerName !== performerName) {
          const conflict = conflictMap.get(naturalKey) ?? {
            naturalKey,
            peCode: peContext.peCode,
            performerNames: [existing.performerName],
            pages: [existing.page],
            reason: 'conflicting_performer_name',
          };
          if (!conflict.performerNames.includes(performerName)) {
            conflict.performerNames.push(performerName);
            conflict.pages.push(table.page);
          }
          conflictMap.set(naturalKey, conflict);
          /* Do not last-win — retain both as separate findings via conflict. */
          continue;
        }
        if (existing != null) {
          /* Exact duplicate — skip. */
          continue;
        }

        performers.push({
          parentPeCode: peContext.peCode,
          ...(projectCode != null ? { projectCode } : {}),
          performerName,
          performerNormalized,
          performerRole: roleClass.role,
          roleExplicit: roleClass.explicit,
          isNamedCompany: isNamedCompanyV1(performerName),
          ...(location != null ? { location } : {}),
          ...(contractMethod != null ? { contractMethod } : {}),
          ...(costCategory != null ? { costCategory } : {}),
          ...(fiscalYear != null ? { fiscalYear } : {}),
          ...(totalCost != null ? { totalCost } : {}),
          page: table.page,
          ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
          tableIndex: table.tableIndex,
          rowIndex: row.rowIndex,
          naturalKey,
          rawCells: row.cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
        });
      }
    }
  }

  return {
    peCode: peContext.peCode,
    performers,
    omissions,
    conflicts: [...conflictMap.values()],
    unitResolution,
    tableDetected,
  };
}

/**
 * Convenience: extract R-3 performers from a flat page list by grouping
 * contiguous pages that share the same PE header.
 */
export function extractR3PerformersFromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear?: number;
  manifestUnit?: MoneyUnitV1;
  sourceKey?: string;
}): R3ExtractionResult[] {
  const groups = new Map<string, { peCode: string; pages: ParserPageResultV1[] }>();

  for (const page of input.pages) {
    const pageText = page.text ?? '';
    const blockTexts = page.blocks.map((b) => b.text);
    const isR3Page = R3_HEADER_RE.test(pageText) || blockTexts.some((t) => R3_HEADER_RE.test(t));
    if (!isR3Page) continue;

    let peCode = '';
    for (const text of [pageText, ...blockTexts]) {
      const m = PE_CODE_RE.exec(text);
      if (m?.[1] != null && isValidPeCode(m[1])) {
        peCode = m[1];
        break;
      }
    }
    if (peCode === '') continue;

    const existing = groups.get(peCode) ?? { peCode, pages: [] };
    existing.pages.push(page);
    groups.set(peCode, existing);
  }

  const results: R3ExtractionResult[] = [];
  for (const group of groups.values()) {
    const pageStart = Math.min(...group.pages.map((p) => p.page));
    const pageEnd = Math.max(...group.pages.map((p) => p.page));
    results.push(
      extractR3Performers({
        pages: group.pages,
        peContext: { peCode: group.peCode, pageStart, pageEnd },
        ...(input.cycleFiscalYear != null ? { cycleFiscalYear: input.cycleFiscalYear } : {}),
        ...(input.manifestUnit != null ? { manifestUnit: input.manifestUnit } : {}),
        ...(input.sourceKey != null ? { sourceKey: input.sourceKey } : {}),
      }),
    );
  }
  return results;
}

/* Re-export helpers for tests. */
export { UNIT_RE };
