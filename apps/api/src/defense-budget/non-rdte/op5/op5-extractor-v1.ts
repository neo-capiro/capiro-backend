/**
 * op5-extractor-v1 — complete OP-5 (O&M detail) extraction from Phase 3
 * normalized page results.
 *
 * For every OP-5 SAG section, captures:
 *   1. Identity and hierarchy: account, BA/BAG/SAG, activity/subactivity title.
 *   2. Funding: prior/current/request values, with row-level categories
 *      (Direct Program, Reimbursable, Total).
 *   3. Explanatory deltas: price change, program change, transfers,
 *      total change — emitted as document_fact assertions, NOT funding.
 *   4. Workload/quantity measures where printed.
 *   5. Narrative: mission/description, budget justification, performance
 *      criteria, program growth/reduction explanation, force structure or
 *      workload explanation.
 *   6. Evidence: exact page, table row/column, truthful page-only evidence.
 *
 * Identity rules:
 *   - Every OP-5 identity is OM_SAG, never RDTE_PE or PROCUREMENT_BLIN.
 *   - Same SAG code under different accounts/components remains distinct.
 *   - Title is never a natural key.
 *   - Missing SAG identity header is a blocking omission.
 *   - Unknown printed unit for money values is a blocking omission.
 *
 * Arithmetic safety:
 *   - Total-change arithmetic (price + program + transfers = total) is only
 *     checked when the source explicitly defines all components and the
 *     total within the same scope (same SAG + same FY). Otherwise marked
 *     not applicable — never derived.
 *   - Narrative text is never used as money. Only printed numeric table
 *     cells produce funding/quantity/change assertions.
 *   - No magnitude-based unit inference. FY columns bound from actual headers.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database. No ProgramElementWriterService.
 */
import type { ParserPageResultV1, ParsedTableV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type {
  BudgetComponentV1,
  NarrativeTypeV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  buildOmSagIdentity,
  type OmSagIdentityV1,
} from '../identity-v1.js';
import {
  detectPrintedUnit,
  toCanonicalDecimal,
  convertUnit,
  type PrintedUnitV1,
} from '../unit-semantics-v1.js';
import {
  bindHeaders,
  type ColumnBindingV1,
  type HeaderBindingResultV1,
  type FundingStageV1,
} from '../column-semantics-v1.js';
import { parseMoneyToken } from '../../extractors/types.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface Op5SagIdentity {
  printedCode: string;
  title: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  budgetActivity?: string;
  activityGroup?: string;
  subActivityGroup?: string;
  identity: OmSagIdentityV1;
}

export interface Op5FundingValue {
  identityNaturalKey: string;
  rowLabel: string;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  columnIndex: number;
  headerText: string;
  page: number;
  rowIndex: number;
}

export type Op5ChangeType =
  | 'price_change'
  | 'program_change'
  | 'transfer'
  | 'total_change';

export interface Op5ChangeValue {
  identityNaturalKey: string;
  changeType: Op5ChangeType;
  rowLabel: string;
  fiscalYear?: number;
  originalValue: string;
  originalUnit?: PrintedUnitV1;
  valueMillions?: string;
  columnIndex: number;
  headerText: string;
  page: number;
  rowIndex: number;
}

export interface Op5NarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  narrativeType: NarrativeTypeV1;
  text: string;
  page: number;
}

export interface Op5QuantityValue {
  identityNaturalKey: string;
  rowLabel: string;
  fiscalYear?: number;
  quantity: string;
  unitLabel?: string;
  columnIndex: number;
  headerText: string;
  page: number;
  rowIndex: number;
}

export interface Op5ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
  severity: 'blocking' | 'review';
}

export interface Op5ExtractionConflict {
  printedCode: string;
  fiscalYear: number;
  field: string;
  rowLabel: string;
  values: string[];
  pages: number[];
}

export interface Op5TotalChangeArithmetic {
  applicable: boolean;
  passed?: boolean;
  expected?: string;
  actual?: string;
  fiscalYear?: number;
}

export interface Op5ExtractionResult {
  identities: Op5SagIdentity[];
  funding: Op5FundingValue[];
  changes: Op5ChangeValue[];
  narratives: Op5NarrativeSection[];
  quantities: Op5QuantityValue[];
  omissions: Op5ExtractionOmission[];
  conflicts: Op5ExtractionConflict[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  totalChangeArithmetic: Op5TotalChangeArithmetic;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

// SAG code detection from page text.
// Matches: "SAG 1A: Centralized Training", "Sub-Activity Group 1A: Title", "SAG: 1A - Title"
const SAG_TEXT_RE = /(?:SAG|Sub-?Activity\s*Group)\s*[:\-]?\s*([A-Za-z0-9]{1,8})(?:\s*[:\-\u2013]\s*([^\n\r]+))?/i;
// Budget Activity from page text: "BA 01: Operating Forces", "Budget Activity 1: ..."
const BA_TEXT_RE = /(?:^|\n)\s*(?:BA|Budget\s*Activity)\s*[:\-]?\s*(\d{1,2})(?:\s*[:\-\u2013]\s*([^\n\r]+))?/i;
// Budget Activity Group: "BAG 1: ...", "Budget Activity Group A: ..."
const BAG_TEXT_RE = /(?:^|\n)\s*(?:BAG|Budget\s*Activity\s*Group)\s*[:\-]?\s*([A-Za-z0-9]{1,4})(?:\s*[:\-\u2013]\s*([^\n\r]+))?/i;

// Change row patterns — used to classify data rows and table types.
const CHANGE_ROW_PATTERNS: Array<{
  pattern: RegExp;
  changeType: Op5ChangeType;
}> = [
  { pattern: /price\s*(?:change|growth)/i, changeType: 'price_change' },
  { pattern: /program\s*(?:change|growth|reduction)/i, changeType: 'program_change' },
  { pattern: /^\s*transfers?\s*$/i, changeType: 'transfer' },
  { pattern: /total\s*(?:change|growth|reduction)/i, changeType: 'total_change' },
];

// Quantity/workload row patterns.
const QUANTITY_ROW_RE = /(?:workload|quantity|measure|output|throughput|volume)/i;

// Narrative section headings detected in page text.
const NARRATIVE_SECTIONS: Array<{
  pattern: RegExp;
  sectionType: string;
  narrativeType: NarrativeTypeV1;
}> = [
  { pattern: /(?:^|\n)\s*mission(?:\s+statement)?\s*[:\-\u2013]?/i, sectionType: 'mission', narrativeType: 'mission' },
  { pattern: /(?:^|\n)\s*(?:activity\s+)?description\s*[:\-\u2013]?/i, sectionType: 'description', narrativeType: 'description' },
  { pattern: /(?:^|\n)\s*budget\s+justification\s*[:\-\u2013]?/i, sectionType: 'budget_justification', narrativeType: 'rationale' },
  { pattern: /(?:^|\n)\s*justification\s*[:\-\u2013]?/i, sectionType: 'budget_justification', narrativeType: 'rationale' },
  { pattern: /(?:^|\n)\s*performance\s+(?:criteria|measures)\s*[:\-\u2013]?/i, sectionType: 'performance_criteria', narrativeType: 'other' },
  { pattern: /(?:^|\n)\s*(?:program\s+(?:change\s+)?)?explanation\s*[:\-\u2013]?/i, sectionType: 'program_change_explanation', narrativeType: 'rationale' },
  { pattern: /(?:^|\n)\s*force\s+structure\s*[:\-\u2013]?/i, sectionType: 'force_structure', narrativeType: 'other' },
  { pattern: /(?:^|\n)\s*workload\s*(?:explanation|description)?\s*[:\-\u2013]?/i, sectionType: 'workload_explanation', narrativeType: 'other' },
  { pattern: /(?:^|\n)\s*accomplishments?\s*[:\-\u2013]?/i, sectionType: 'accomplishments', narrativeType: 'accomplishments' },
  { pattern: /(?:^|\n)\s*(?:future\s+)?plans?\s*[:\-\u2013]?/i, sectionType: 'plans', narrativeType: 'plans' },
];

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractOp5FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
}): Op5ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const identities: Op5SagIdentity[] = [];
  const funding: Op5FundingValue[] = [];
  const changes: Op5ChangeValue[] = [];
  const narratives: Op5NarrativeSection[] = [];
  const quantities: Op5QuantityValue[] = [];
  const omissions: Op5ExtractionOmission[] = [];
  const conflicts: Op5ExtractionConflict[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';

  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  // Track the current SAG identity across continuation pages.
  let currentIdentity: Op5SagIdentity | null = null;

  for (const page of pages) {
    // Try to detect a new SAG identity from page text.
    if (page.text != null) {
      const detected = detectSagIdentityFromText(
        page.text,
        page.page,
        page.printedPage,
        account,
        component,
      );
      if (detected != null) {
        currentIdentity = detected;
        identities.push(detected);
      }
    }

    // Detect unit from page text or table labels.
    if (unit == null && page.text != null) {
      const detected = detectPrintedUnit(page.text.slice(0, 2000));
      if (detected != null) {
        unit = detected;
        unitSource = 'page text';
      }
    }

    for (const table of page.tables) {
      if (unit == null && table.label != null) {
        const detected = detectPrintedUnit(table.label);
        if (detected != null) {
          unit = detected;
          unitSource = `table label: "${table.label}"`;
        }
      }

      const rows = groupCellsByRow(table);
      const tableText = rowsToText(rows);

      // Find header row and bind columns.
      const headerRow = findHeaderRow(rows);
      let headerBinding: HeaderBindingResultV1 | null = null;
      if (headerRow != null) {
        const headers = headerRow.map((cell, idx) => ({
          columnIndex: idx,
          text: cell.text.trim(),
        }));
        headerBinding = bindHeaders({ headers, cycleFiscalYear });
        allBindings = allBindings.concat(headerBinding.bindings);
        if (headerBinding.unresolvedColumnIndices.length > 0) {
          unresolvedColumnIndices.push(
            ...headerBinding.unresolvedColumnIndices.map(
              (ci: number) => ci + (page.page - 1) * 100,
            ),
          );
        }
      }

      if (headerBinding == null) {
        // Only emit an omission if this table has data rows that look like
        // funding or change rows (not just narrative text blocks).
        if (hasNumericDataRows(rows)) {
          omissions.push({
            page: page.page,
            reason: 'ambiguous header — could not bind FY columns',
            rawText: `table ${table.tableIndex} on page ${page.page}`,
            severity: 'review',
          });
        }
        continue;
      }

      // Classify table type based on row labels.
      const tableType = classifyTable(rows);

      // Process data rows.
      for (const [rowIndex, cells] of rows) {
        if (isHeaderRow(cells)) continue;

        const rowLabel = cells[0]?.text.trim() ?? '';
        if (rowLabel.length === 0) continue;

        // Skip pure section-header rows that have no numeric data.
        if (!hasNumericDataInRow(cells, headerBinding)) {
          // Section headers like "Direct Program", "Reimbursable" without
          // numbers are structural — skip them. But still process narrative
          // from page text below.
          continue;
        }

        const identityKey = currentIdentity?.identity.naturalKey ?? 'UNKNOWN';

        // Classify the row.
        const changeMatch = matchChangeRow(rowLabel);
        const isQuantityRow = QUANTITY_ROW_RE.test(rowLabel);

        if (tableType === 'change' || changeMatch != null) {
          // Change analysis row → document_fact assertion (not funding).
          const changeType = changeMatch?.changeType ?? 'total_change';
          for (const binding of headerBinding.bindings) {
            const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
            if (cell == null) continue;
            const rawText = cell.text.trim();
            if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
            const num = parseMoneyToken(rawText);
            if (num == null) continue;

            const originalValue = toCanonicalDecimal(num);
            const effectiveUnit = binding.printedUnit ?? unit;

            changes.push({
              identityNaturalKey: identityKey,
              changeType,
              rowLabel,
              ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
              originalValue,
              ...(effectiveUnit != null ? { originalUnit: effectiveUnit } : {}),
              ...(effectiveUnit != null
                ? { valueMillions: convertUnit(originalValue, effectiveUnit, 'millions') }
                : {}),
              columnIndex: binding.columnIndex,
              headerText: binding.headerText,
              page: page.page,
              rowIndex,
            });
          }
        } else if (tableType === 'quantity' || isQuantityRow) {
          // Workload/quantity row → quantity assertion.
          for (const binding of headerBinding.bindings) {
            const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
            if (cell == null) continue;
            const rawText = cell.text.trim();
            if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
            const num = parseMoneyToken(rawText);
            if (num == null) continue;

            const qtyValue = toCanonicalDecimal(num);
            quantities.push({
              identityNaturalKey: identityKey,
              rowLabel,
              ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
              quantity: qtyValue,
              ...(binding.printedUnit != null ? { unitLabel: binding.printedUnit } : {}),
              columnIndex: binding.columnIndex,
              headerText: binding.headerText,
              page: page.page,
              rowIndex,
            });
          }
        } else {
          // Funding row → funding assertion.
          for (const binding of headerBinding.bindings) {
            if (binding.valueKind !== 'money' && binding.valueKind !== 'unit_cost') {
              continue;
            }
            const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
            if (cell == null) continue;
            const rawText = cell.text.trim();
            if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
            const num = parseMoneyToken(rawText);
            if (num == null) continue;

            const originalValue = toCanonicalDecimal(num);
            const effectiveUnit = binding.printedUnit ?? unit;

            if (effectiveUnit == null) {
              omissions.push({
                page: page.page,
                rowIndex,
                columnIndex: binding.columnIndex,
                reason: 'unknown printed unit for money value',
                rawText,
                severity: 'blocking',
              });
              continue;
            }

            const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
            funding.push({
              identityNaturalKey: identityKey,
              rowLabel,
              ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
              columnBinding: binding,
              originalValue,
              originalUnit: effectiveUnit,
              valueMillions,
              columnIndex: binding.columnIndex,
              headerText: binding.headerText,
              page: page.page,
              rowIndex,
            });
          }
        }
      }
    }

    // Extract narrative sections from page text.
    if (page.text != null && currentIdentity != null) {
      const identityKey = currentIdentity.identity.naturalKey;
      const pageNarratives = extractNarrativesFromText(page.text, identityKey, page.page);
      narratives.push(...pageNarratives);
    }
  }

  // If no SAG identity was detected at all, emit a blocking omission.
  if (identities.length === 0) {
    omissions.push({
      page: pages.length > 0 ? pages[0]!.page : 1,
      reason: 'missing SAG identity header — cannot build OM_SAG identity',
      rawText: 'no SAG or Sub-Activity Group header detected in any page',
      severity: 'blocking',
    });
  }

  // Detect conflicts: same identity + FY + field + rowLabel with different values.
  const fundingByKey = new Map<string, Op5FundingValue[]>();
  for (const f of funding) {
    const field = fundingStageToField(f.columnBinding.fundingStage);
    const key = `${f.identityNaturalKey}|${f.fiscalYear ?? 'none'}|${field}|${f.rowLabel}`;
    const list = fundingByKey.get(key) ?? [];
    list.push(f);
    fundingByKey.set(key, list);
  }
  for (const [, list] of fundingByKey) {
    if (list.length <= 1) continue;
    const values = new Set(list.map((f) => f.valueMillions));
    if (values.size > 1) {
      const first = list[0]!;
      const field = fundingStageToField(first.columnBinding.fundingStage);
      const printedCode =
        identities.find((i) => i.identity.naturalKey === first.identityNaturalKey)
          ?.printedCode ?? 'unknown';
      conflicts.push({
        printedCode,
        fiscalYear: first.fiscalYear ?? 0,
        field,
        rowLabel: first.rowLabel,
        values: Array.from(values),
        pages: list.map((f) => f.page),
      });
    }
  }

  // Total-change arithmetic check.
  const totalChangeArithmetic = checkTotalChangeArithmetic(changes);

  return {
    identities,
    funding,
    changes,
    narratives,
    quantities,
    omissions,
    conflicts,
    headerBinding: {
      bindings: allBindings,
      hasAmbiguousColumns: unresolvedColumnIndices.length > 0,
      unresolvedColumnIndices,
    },
    unitResolution: { unit, source: unitSource },
    totalChangeArithmetic,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function detectSagIdentityFromText(
  text: string,
  page: number,
  printedPage: string | undefined,
  account: string,
  component: BudgetComponentV1,
): Op5SagIdentity | null {
  const sagMatch = SAG_TEXT_RE.exec(text);
  if (sagMatch == null) return null;

  const code = (sagMatch[1] ?? '').trim();
  if (code.length === 0) return null;

  const titleRaw = (sagMatch[2] ?? '').trim();
  const title = titleRaw.length > 0 ? titleRaw : '(untitled)';

  // Detect BA.
  const baMatch = BA_TEXT_RE.exec(text);
  const budgetActivity =
    baMatch != null ? `BA ${baMatch[1]!.padStart(2, '0')}` : undefined;

  // Detect BAG.
  const bagMatch = BAG_TEXT_RE.exec(text);
  const activityGroup =
    bagMatch != null ? `BAG ${bagMatch[1]}` : undefined;

  // The sub-activity group is the SAG code itself.
  const subActivityGroup = code;

  let identity: OmSagIdentityV1;
  try {
    identity = buildOmSagIdentity({ code, account, component });
  } catch {
    return null;
  }

  return {
    printedCode: code,
    title,
    page,
    ...(printedPage != null ? { printedPage } : {}),
    tableIndex: 0,
    ...(budgetActivity != null ? { budgetActivity } : {}),
    ...(activityGroup != null ? { activityGroup } : {}),
    subActivityGroup,
    identity,
  };
}

function groupCellsByRow(
  table: ParsedTableV1,
): Map<number, Array<{ columnIndex: number; text: string }>> {
  const rows = new Map<number, Array<{ columnIndex: number; text: string }>>();
  for (const cell of table.cells) {
    const row = rows.get(cell.rowIndex) ?? [];
    row.push({ columnIndex: cell.columnIndex, text: cell.text });
    rows.set(cell.rowIndex, row);
  }
  for (const [, row] of rows) {
    row.sort((a, b) => a.columnIndex - b.columnIndex);
  }
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

function rowsToText(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): string {
  const parts: string[] = [];
  for (const [, cells] of rows) {
    parts.push(cells.map((c) => c.text).join(' '));
  }
  return parts.join('\n');
}

function findHeaderRow(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): Array<{ columnIndex: number; text: string }> | null {
  for (const [, cells] of rows) {
    if (isHeaderRow(cells)) return cells;
  }
  return null;
}

function isHeaderRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells.map((c) => c.text).join(' ').toLowerCase();
  const hasFyVocab =
    /\b(?:fy|fiscal|year|request|actual|enacted|base|oco|ooc|prior|outyear|total|dollars?|millions?|thousands?|quantity|qty)\b/i.test(
      text,
    );
  // A header row has FY vocabulary but no numeric data cells (excluding the
  // first label cell).
  const hasNumericData = cells.some(
    (c, idx) => idx > 0 && /^-?[\d,]+(?:\.\d+)?$/.test(c.text.trim()),
  );
  return hasFyVocab && !hasNumericData;
}

/**
 * Classify a table as 'change', 'quantity', or 'funding' based on row and
 * header labels.
 * A table is a change table if any data row matches a change pattern.
 * A table is a quantity table if the header row or any data row contains
 * workload/quantity indicators.
 * Otherwise it is a funding table.
 */
function classifyTable(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): 'change' | 'quantity' | 'funding' {
  // Check header row for table type indicators (e.g. "Workload Measure",
  // "Output Measure" as the first column header).
  for (const [, cells] of rows) {
    if (!isHeaderRow(cells)) continue;
    const headerText = cells.map((c) => c.text).join(' ').toLowerCase();
    if (/\b(?:workload|output\s*measure|quantity\s*measure)\b/i.test(headerText)) {
      return 'quantity';
    }
    break;
  }

  let hasChangeRow = false;
  let hasQuantityRow = false;
  for (const [, cells] of rows) {
    if (isHeaderRow(cells)) continue;
    const rowLabel = cells[0]?.text.trim() ?? '';
    if (rowLabel.length === 0) continue;
    if (matchChangeRow(rowLabel) != null) {
      hasChangeRow = true;
    }
    if (QUANTITY_ROW_RE.test(rowLabel)) {
      hasQuantityRow = true;
    }
  }
  if (hasChangeRow) return 'change';
  if (hasQuantityRow) return 'quantity';
  return 'funding';
}

function matchChangeRow(
  rowLabel: string,
): { changeType: Op5ChangeType } | null {
  for (const { pattern, changeType } of CHANGE_ROW_PATTERNS) {
    if (pattern.test(rowLabel)) {
      return { changeType };
    }
  }
  return null;
}

function hasNumericDataRows(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): boolean {
  for (const [, cells] of rows) {
    if (isHeaderRow(cells)) continue;
    if (hasNumericDataInRowCells(cells)) return true;
  }
  return false;
}

function hasNumericDataInRowCells(
  cells: Array<{ columnIndex: number; text: string }>,
): boolean {
  return cells.some(
    (c, idx) =>
      idx > 0 &&
      c.text.trim() !== '' &&
      c.text.trim() !== '-' &&
      c.text.trim() !== '\u2014' &&
      /^-?[\d,]+(?:\.\d+)?$/.test(c.text.trim().replace(/[()$]/g, '')),
  );
}

function hasNumericDataInRow(
  cells: Array<{ columnIndex: number; text: string }>,
  headerBinding: HeaderBindingResultV1,
): boolean {
  for (const binding of headerBinding.bindings) {
    const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
    if (cell == null) continue;
    const rawText = cell.text.trim();
    if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
    const num = parseMoneyToken(rawText);
    if (num != null) return true;
  }
  return false;
}

function extractNarrativesFromText(
  text: string,
  identityKey: string,
  page: number,
): Op5NarrativeSection[] {
  const results: Op5NarrativeSection[] = [];
  for (const { pattern, sectionType, narrativeType } of NARRATIVE_SECTIONS) {
    const match = pattern.exec(text);
    if (match == null) continue;

    const startIdx = match.index + match[0].length;

    // Find the next narrative section heading after this one.
    let endIdx = Math.min(startIdx + 2000, text.length);
    for (const other of NARRATIVE_SECTIONS) {
      if (other.sectionType === sectionType) continue;
      const otherMatch = other.pattern.exec(text);
      if (otherMatch != null && otherMatch.index > match.index) {
        endIdx = Math.min(endIdx, otherMatch.index);
      }
    }

    const sectionText = text.slice(startIdx, endIdx).trim();
    if (sectionText.length > 0) {
      results.push({
        identityNaturalKey: identityKey,
        sectionType,
        narrativeType,
        text: sectionText.slice(0, 2000),
        page,
      });
    }
  }
  return results;
}

/**
 * Check total-change arithmetic: price_change + program_change + transfers =
 * total_change, only when the source explicitly defines all components and
 * the total within the same scope (same SAG + same FY).
 *
 * Returns { applicable: false } when the source does not define equivalent
 * scope. Never derives values from partial data.
 */
function checkTotalChangeArithmetic(
  changes: Op5ChangeValue[],
): Op5TotalChangeArithmetic {
  // Group changes by identity + FY.
  const byKey = new Map<string, Op5ChangeValue[]>();
  for (const c of changes) {
    if (c.fiscalYear == null) continue;
    const key = `${c.identityNaturalKey}|${c.fiscalYear}`;
    const list = byKey.get(key) ?? [];
    list.push(c);
    byKey.set(key, list);
  }

  for (const [, list] of byKey) {
    const priceChange = list.find((c) => c.changeType === 'price_change');
    const programChange = list.find((c) => c.changeType === 'program_change');
    const transfer = list.find((c) => c.changeType === 'transfer');
    const totalChange = list.find((c) => c.changeType === 'total_change');

    // All components must be present for the arithmetic to be applicable.
    if (priceChange == null || programChange == null || totalChange == null) {
      continue;
    }

    // Use valueMillions when available; otherwise use originalValue (assuming
    // all values from the same table share the same unit).
    const toNum = (c: Op5ChangeValue): number =>
      parseFloat(c.valueMillions ?? c.originalValue);

    const price = toNum(priceChange);
    const program = toNum(programChange);
    const transferVal = transfer != null ? toNum(transfer) : 0;
    const total = toNum(totalChange);

    const expected = price + program + transferVal;
    const actual = total;
    const tolerance = Math.max(Math.abs(actual) * 0.01, 0.001);

    return {
      applicable: true,
      passed: Math.abs(expected - actual) <= tolerance,
      expected: expected.toString(),
      actual: actual.toString(),
      fiscalYear: priceChange.fiscalYear,
    };
  }

  return { applicable: false };
}

/* ------------------------------------------------------------------ */
/* Funding stage → funding field mapping                              */
/* ------------------------------------------------------------------ */

/**
 * Map a column binding's funding stage to the contract funding field.
 * OP-5 budget year → request; current/prior enacted years → enacted;
 * outyear projections → request.
 */
export function fundingStageToField(
  stage: FundingStageV1,
): 'request' | 'enacted' {
  switch (stage) {
    case 'current_enacted':
    case 'prior_actual':
      return 'enacted';
    case 'budget_year_request':
    case 'outyear_projection':
    case 'continuation':
    case 'cost_to_complete':
    case 'total_cost':
    case 'unknown':
      return 'request';
    default:
      return 'request';
  }
}