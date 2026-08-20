/**
 * o1-extractor-v1 — complete O-1 (O&M Summary) extraction from Phase 3
 * normalized page results.
 *
 * For every O-1 SAG row, captures:
 *   - component/service;
 *   - appropriation account;
 *   - Budget Activity (BA);
 *   - Budget Activity Group (BAG);
 *   - Subactivity Group (SAG) code and title;
 *   - all printed FY columns;
 *   - base/OCO/OOC/total distinctions;
 *   - request/actual/prior/outyear status;
 *   - funding amount and printed unit;
 *   - exact page and table/cell evidence.
 *
 * FY columns are bound from the actual header. Never derived from column position.
 *
 * Identity rules:
 *   - Every O-1 identity is OM_SAG, never RDTE_PE or PROCUREMENT_BLIN.
 *   - Same SAG code under different accounts/components remains distinct.
 *   - Subtotal/total rows are not treated as SAG identities.
 *   - Repeated headers and continuation pages do not produce duplicate identities.
 *   - Missing SAG code is a blocking omission.
 *   - Unknown printed unit is a blocking omission.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildOmSagIdentity, type OmSagIdentityV1 } from '../identity-v1.js';
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

export interface O1SagIdentity {
  printedCode: string;
  title: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  budgetActivity?: string;
  activityGroup?: string;
  subActivityGroup?: string;
  identity: OmSagIdentityV1;
}

export interface O1FundingValue {
  identityNaturalKey: string;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  originalValue: string;
  originalUnit: PrintedUnitV1;
  valueMillions: string;
  columnIndex: number;
  headerText: string;
  page: number;
}

export interface O1ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface O1ExtractionConflict {
  printedCode: string;
  fiscalYear: number;
  values: string[];
  pages: number[];
}

export interface O1ExtractionResult {
  identities: O1SagIdentity[];
  funding: O1FundingValue[];
  omissions: O1ExtractionOmission[];
  conflicts: O1ExtractionConflict[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  usedPositionalFallback: boolean;
}

/* ------------------------------------------------------------------ */
/* Label column classification                                         */
/* ------------------------------------------------------------------ */

type LabelColumnRole = 'ba' | 'bag' | 'sag_code' | 'title' | null;

interface LabelColumnMap {
  ba?: number;
  bag?: number;
  sagCode?: number;
  title?: number;
}

function classifyLabelColumn(headerText: string): LabelColumnRole {
  const h = headerText.trim().toLowerCase();
  if (h.length === 0) return null;
  if (
    h === 'ba' ||
    h === 'budget activity' ||
    h === 'activity' ||
    h === 'budget activity (ba)' ||
    h === 'budget activity no.'
  ) {
    return 'ba';
  }
  if (
    h === 'bag' ||
    h === 'budget activity group' ||
    h === 'activity group' ||
    h === 'budget activity group (bag)'
  ) {
    return 'bag';
  }
  if (
    h === 'sag' ||
    h === 'sag code' ||
    h === 'subactivity group' ||
    h === 'subactivity group code' ||
    h === 'subactivity' ||
    h === 'code' ||
    h === 'sag/subactivity' ||
    h === 'sag no.'
  ) {
    return 'sag_code';
  }
  if (
    h === 'title' ||
    h === 'description' ||
    h === 'name' ||
    h === 'subactivity group title' ||
    h === 'sag title'
  ) {
    return 'title';
  }
  return null;
}

function mapLabelColumns(
  headers: ReadonlyArray<{ columnIndex: number; text: string }>,
): LabelColumnMap {
  const result: LabelColumnMap = {};
  for (const h of headers) {
    const role = classifyLabelColumn(h.text);
    if (role === 'ba' && result.ba == null) result.ba = h.columnIndex;
    else if (role === 'bag' && result.bag == null) result.bag = h.columnIndex;
    else if (role === 'sag_code' && result.sagCode == null) result.sagCode = h.columnIndex;
    else if (role === 'title' && result.title == null) result.title = h.columnIndex;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* SAG code / row detection patterns                                   */
/* ------------------------------------------------------------------ */

// SAG codes: 1-8 alphanumeric chars (uppercase after normalization)
const SAG_CODE_RE = /^[A-Z0-9]{1,8}$/;

const HEADER_LABELS = new Set([
  'ba',
  'bag',
  'sag',
  'sag code',
  'subactivity group',
  'subactivity',
  'code',
  'title',
  'description',
  'name',
  'account',
  'appropriation',
  'component',
  'service',
  'line',
  'line item',
  'li',
  'blin',
  'pe',
  'budget activity',
  'budget activity group',
  'activity',
  'activity group',
  'subactivity group code',
  'subactivity group title',
  'sag title',
  'budget activity (ba)',
  'budget activity group (bag)',
  'budget activity no.',
  'sag no.',
  'sag/subactivity',
  'total',
  'subtotal',
  'sum',
  'grand total',
]);

// BA section header detection from row text (e.g. "BA 01: Operating Forces")
const BA_SECTION_RE = /\bBA\s*[:\-]?\s*(\d{1,2})\b/i;
// BAG section header detection from row text (e.g. "BAG 1: ...")
const BAG_SECTION_RE = /\bBAG\s*[:\-]?\s*([A-Z0-9]{1,4})\b/i;

function isValidSagCode(text: string): boolean {
  const t = text.trim().toUpperCase();
  if (t.length === 0 || t.length > 8) return false;
  if (HEADER_LABELS.has(t.toLowerCase())) return false;
  if (/\b(?:TOTAL|SUBTOTAL|SUM|GRAND)\b/i.test(t)) return false;
  return SAG_CODE_RE.test(t);
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractO1FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
}): O1ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const identities: O1SagIdentity[] = [];
  const funding: O1FundingValue[] = [];
  const omissions: O1ExtractionOmission[] = [];
  const conflicts: O1ExtractionConflict[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  const usedPositionalFallback = false;

  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  // Track seen natural keys to avoid duplicate identities across continuation pages.
  const seenNaturalKeys = new Set<string>();

  for (const page of pages) {
    for (const table of page.tables) {
      const rows = groupCellsByRow(table);

      // Detect unit from table label or page text
      if (unit == null) {
        if (table.label != null) {
          const detected = detectPrintedUnit(table.label);
          if (detected != null) {
            unit = detected;
            unitSource = `table label: "${table.label}"`;
          }
        }
        if (unit == null && page.text != null) {
          const textSample = page.text.slice(0, 2000);
          const detected = detectPrintedUnit(textSample);
          if (detected != null) {
            unit = detected;
            unitSource = 'page text';
          }
        }
      }

      // Find header row(s) and bind columns
      const headerRow = findHeaderRow(rows);
      let headerBinding: HeaderBindingResultV1 | null = null;
      let labelMap: LabelColumnMap = {};

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
        labelMap = mapLabelColumns(headers);
      }

      // If header binding failed entirely, emit omission and skip table
      if (headerBinding == null) {
        omissions.push({
          page: page.page,
          reason: 'ambiguous header — could not bind FY columns',
          rawText: `table ${table.tableIndex} on page ${page.page}`,
        });
        continue;
      }

      // Carried BA/BAG context within this table
      let currentBa: string | undefined;
      let currentBag: string | undefined;

      // Process data rows (skip header rows)
      for (const [rowIndex, cells] of rows) {
        if (isHeaderRow(cells)) continue;

        // Update BA/BAG context from columns or section headers
        const baFromCol =
          labelMap.ba != null
            ? (cells.find((c) => c.columnIndex === labelMap.ba)?.text.trim() ?? '')
            : '';
        const bagFromCol =
          labelMap.bag != null
            ? (cells.find((c) => c.columnIndex === labelMap.bag)?.text.trim() ?? '')
            : '';

        if (baFromCol.length > 0) {
          currentBa = baFromCol;
        } else {
          // Detect BA from row text (section header pattern)
          const rowText = cells.map((c) => c.text).join(' ');
          const baMatch = BA_SECTION_RE.exec(rowText);
          if (baMatch != null && !isMoneyRow(cells, headerBinding)) {
            currentBa = `BA ${baMatch[1]}`;
          }
        }

        if (bagFromCol.length > 0) {
          currentBag = bagFromCol;
        } else {
          const rowText = cells.map((c) => c.text).join(' ');
          const bagMatch = BAG_SECTION_RE.exec(rowText);
          if (bagMatch != null && !isMoneyRow(cells, headerBinding)) {
            currentBag = `BAG ${bagMatch[1]}`;
          }
        }

        // Skip total/subtotal rows (unless they carry a valid SAG code)
        if (isTotalRow(cells, labelMap)) continue;

        // Detect SAG code
        let printedCode = '';
        if (labelMap.sagCode != null) {
          const sagCell = cells.find((c) => c.columnIndex === labelMap.sagCode);
          if (sagCell != null) {
            const candidate = sagCell.text.trim();
            if (isValidSagCode(candidate)) {
              printedCode = candidate;
            } else {
              // Try extracting code from beginning of cell
              const m = /^([A-Za-z0-9]{1,8})\b/.exec(candidate);
              if (m != null && isValidSagCode(m[1]!)) {
                printedCode = m[1]!;
              }
            }
          }
        } else {
          // No dedicated SAG column — try first cell
          const firstCell = cells[0]?.text.trim() ?? '';
          if (isValidSagCode(firstCell)) {
            printedCode = firstCell;
          }
        }

        // Detect title
        let title = '';
        if (labelMap.title != null) {
          const titleCell = cells.find((c) => c.columnIndex === labelMap.title);
          title = titleCell?.text.trim() ?? '';
        } else if (labelMap.sagCode != null) {
          // Title is the cell after SAG code
          const titleIdx = labelMap.sagCode + 1;
          const titleCell = cells.find((c) => c.columnIndex === titleIdx);
          title = titleCell?.text.trim() ?? '';
        }
        if (title.length === 0) {
          // Fallback: join all non-data, non-label cells
          const dataCols = new Set(headerBinding.bindings.map((b) => b.columnIndex));
          const labelCols = new Set(
            [labelMap.ba, labelMap.bag, labelMap.sagCode, labelMap.title].filter(
              (x): x is number => x != null,
            ),
          );
          title =
            cells
              .filter((c) => !dataCols.has(c.columnIndex) && !labelCols.has(c.columnIndex))
              .map((c) => c.text.trim())
              .filter((t) => t.length > 0)
              .join(' ') || '(untitled)';
        }

        // Check if row has any money values
        const hasMoney = hasMoneyInDataColumns(cells, headerBinding);

        if (printedCode.length === 0) {
          // No SAG code — check if this is a section header (BA/BAG only) or a data row missing code
          if (hasMoney) {
            // Data row with money but no SAG code → blocking omission
            omissions.push({
              page: page.page,
              rowIndex,
              reason: 'missing SAG code — cannot build OM_SAG identity',
              rawText: cells
                .map((c) => c.text)
                .join(' ')
                .slice(0, 200),
            });
          }
          // Otherwise it's a section header or empty row — skip
          continue;
        }

        // Build OM_SAG identity
        let identity: OmSagIdentityV1;
        try {
          identity = buildOmSagIdentity({
            code: printedCode,
            account,
            component,
          });
        } catch {
          omissions.push({
            page: page.page,
            rowIndex,
            reason: 'invalid O&M SAG identity — missing account or component',
            rawText: printedCode,
          });
          continue;
        }

        // Skip duplicate identities (continuation pages, repeated rows)
        if (seenNaturalKeys.has(identity.naturalKey)) {
          continue;
        }
        seenNaturalKeys.add(identity.naturalKey);

        const sagIdentity: O1SagIdentity = {
          printedCode,
          title,
          page: page.page,
          ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
          tableIndex: table.tableIndex,
          rowIndex,
          ...(currentBa != null ? { budgetActivity: currentBa } : {}),
          ...(currentBag != null ? { activityGroup: currentBag } : {}),
          ...(printedCode != null ? { subActivityGroup: printedCode } : {}),
          identity,
        };
        identities.push(sagIdentity);

        // Process numeric cells using header bindings
        for (const binding of headerBinding.bindings) {
          if (binding.valueKind !== 'money' && binding.valueKind !== 'unit_cost') continue;
          const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
          if (cell == null) continue;
          const rawText = cell.text.trim();
          if (rawText === '' || rawText === '-' || rawText === '—') continue;

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
            });
            continue;
          }

          const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
          funding.push({
            identityNaturalKey: identity.naturalKey,
            ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
            columnBinding: binding,
            originalValue,
            originalUnit: effectiveUnit,
            valueMillions,
            columnIndex: binding.columnIndex,
            headerText: binding.headerText,
            page: page.page,
          });
        }
      }
    }
  }

  // Detect conflicts: same identity + FY with different values
  const fundingByKey = new Map<string, O1FundingValue[]>();
  for (const f of funding) {
    const key = `${f.identityNaturalKey}|${f.fiscalYear ?? 'none'}|${f.columnBinding.baseOcoStatus}`;
    const list = fundingByKey.get(key) ?? [];
    list.push(f);
    fundingByKey.set(key, list);
  }
  for (const [, list] of fundingByKey) {
    if (list.length <= 1) continue;
    const values = new Set(list.map((f) => f.valueMillions));
    if (values.size > 1) {
      const first = list[0]!;
      const printedCode =
        identities.find((i) => i.identity.naturalKey === first.identityNaturalKey)?.printedCode ??
        'unknown';
      conflicts.push({
        printedCode,
        fiscalYear: first.fiscalYear ?? 0,
        values: Array.from(values),
        pages: list.map((f) => f.page),
      });
    }
  }

  return {
    identities,
    funding,
    omissions,
    conflicts,
    headerBinding: {
      bindings: allBindings,
      hasAmbiguousColumns: unresolvedColumnIndices.length > 0,
      unresolvedColumnIndices,
    },
    unitResolution: { unit, source: unitSource },
    usedPositionalFallback,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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

function findHeaderRow(
  rows: Map<number, Array<{ columnIndex: number; text: string }>>,
): Array<{ columnIndex: number; text: string }> | null {
  for (const [, cells] of rows) {
    if (isHeaderRow(cells)) return cells;
  }
  return null;
}

function isHeaderRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  const hasFyVocab =
    /\b(?:fy|fiscal|year|request|actual|enacted|base|oco|ooc|prior|outyear|total)\b/i.test(text);
  const hasLabelHeader = cells.some((c) => {
    const role = classifyLabelColumn(c.text);
    return role === 'ba' || role === 'bag' || role === 'sag_code' || role === 'title';
  });
  // If any cell is a valid SAG code, it's a data row, not a header.
  const hasValidSagCode = cells.some((c) => isValidSagCode(c.text));
  return (hasFyVocab || hasLabelHeader) && !hasValidSagCode;
}

function isTotalRow(
  cells: Array<{ columnIndex: number; text: string }>,
  labelMap: LabelColumnMap,
): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  const hasTotalWord = /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
  if (!hasTotalWord) return false;
  // If the row carries a valid SAG code, it's a data row, not a total.
  if (labelMap.sagCode != null) {
    const sagCell = cells.find((c) => c.columnIndex === labelMap.sagCode);
    if (sagCell != null && isValidSagCode(sagCell.text)) return false;
  }
  // If no SAG code column at all, check first cell.
  if (labelMap.sagCode == null && cells[0] != null && isValidSagCode(cells[0].text)) {
    return false;
  }
  return true;
}

function isMoneyRow(
  cells: Array<{ columnIndex: number; text: string }>,
  headerBinding: HeaderBindingResultV1,
): boolean {
  return hasMoneyInDataColumns(cells, headerBinding);
}

function hasMoneyInDataColumns(
  cells: Array<{ columnIndex: number; text: string }>,
  headerBinding: HeaderBindingResultV1,
): boolean {
  for (const binding of headerBinding.bindings) {
    if (binding.valueKind !== 'money' && binding.valueKind !== 'unit_cost') continue;
    const cell = cells.find((c) => c.columnIndex === binding.columnIndex);
    if (cell == null) continue;
    const rawText = cell.text.trim();
    if (rawText === '' || rawText === '-' || rawText === '—') continue;
    const num = parseMoneyToken(rawText);
    if (num != null) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Funding stage → funding field mapping                              */
/* ------------------------------------------------------------------ */

/**
 * Map a column binding's funding stage to the contract funding field.
 * O-1 budget year → request; current/prior enacted years → enacted;
 * outyear projections → request.
 */
export function fundingStageToField(stage: FundingStageV1): 'request' | 'enacted' {
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
