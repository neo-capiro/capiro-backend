/**
 * p1-extractor-v1 — complete P-1 (Procurement Summary) extraction from
 * Phase 3 normalized page results.
 *
 * For every P-1 BLIN row, captures:
 *   - component/service;
 *   - appropriation account code and title;
 *   - budget activity;
 *   - P-1 line number/BLIN;
 *   - item title;
 *   - base versus advance procurement designation where printed;
 *   - all printed FY columns;
 *   - request/actual/prior/outyear status;
 *   - funding amount and printed unit;
 *   - quantity columns when printed;
 *   - exact page and table/cell evidence.
 *
 * FY columns are bound from the actual header. Never derived from column position.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';
import { buildProcurementBlinIdentity, type ProcurementBlinIdentityV1 } from '../identity-v1.js';
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
} from '../column-semantics-v1.js';
import { parseMoneyToken } from '../../extractors/types.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface P1BlinIdentity {
  printedCode: string;
  title: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  budgetActivity?: string;
  advanceProcurement: boolean;
  identity: ProcurementBlinIdentityV1;
}

export interface P1FundingValue {
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

export interface P1QuantityValue {
  identityNaturalKey: string;
  fiscalYear?: number;
  columnBinding: ColumnBindingV1;
  quantity: string;
  unitLabel?: string;
  columnIndex: number;
  headerText: string;
  page: number;
}

export interface P1ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface P1ExtractionConflict {
  printedCode: string;
  fiscalYear: number;
  values: string[];
  pages: number[];
}

export interface P1ExtractionResult {
  identities: P1BlinIdentity[];
  funding: P1FundingValue[];
  quantities: P1QuantityValue[];
  omissions: P1ExtractionOmission[];
  conflicts: P1ExtractionConflict[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  usedPositionalFallback: boolean;
}

/* ------------------------------------------------------------------ */
/* BLIN detection patterns                                             */
/* ------------------------------------------------------------------ */

// Army long-form BLIN: 4 digits + 1-2 letters + 4-5 digits (e.g. 9670A00005)
const LONG_BLIN_RE = /^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}$/;
// Navy/Air Force short-form line numbers: 4-8 alnum chars
const SHORT_LI_RE = /^[A-Z0-9]{4,8}$/;
// Advance procurement detection
const ADVANCE_PROC_RE = /advance\s+procurement|\bAP\b|adv(?:ance)?\s+proc/i;
// Appropriation pattern (e.g. "2031A:")
const APPROP_RE = /\b(\d{4}[A-Z]{1,2}):\s*(.+?)(?:\s*\/|$)/i;
// Budget activity (e.g. "BA 01:")
const BA_RE = /\bBA\s*(\d{2})\b/i;
// PE reference pattern (7 digits + letter)
const PE_REF_RE = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/g;

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractP1FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
}): P1ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const identities: P1BlinIdentity[] = [];
  const funding: P1FundingValue[] = [];
  const quantities: P1QuantityValue[] = [];
  const omissions: P1ExtractionOmission[] = [];
  const conflicts: P1ExtractionConflict[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  let usedPositionalFallback = false;

  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

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
          // Search first 2000 chars of page text for unit indicators
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

      // If header binding failed, emit omission for this table
      if (headerBinding == null) {
        omissions.push({
          page: page.page,
          reason: 'ambiguous header — could not bind FY columns',
          rawText: `table ${table.tableIndex} on page ${page.page}`,
        });
        continue;
      }

      // Process data rows (skip header rows)
      for (const [rowIndex, cells] of rows) {
        if (isHeaderRow(cells)) continue;
        if (isTotalRow(cells)) continue;

        const firstCell = cells[0]?.text.trim() ?? '';
        if (firstCell.length === 0) continue;

        // Detect BLIN/line code
        const codeMatch = detectBlinCode(firstCell);
        if (codeMatch == null) continue;

        const printedCode = codeMatch;
        const title =
          (cells[1]?.text.trim() ?? '').replace(firstCell, '').trim() ||
          cells
            .slice(1)
            .map((c) => c.text)
            .join(' ')
            .trim() ||
          '(untitled)';

        // Detect advance procurement from row text
        const rowText = cells.map((c) => c.text).join(' ');
        const isAdvance = ADVANCE_PROC_RE.test(rowText);

        // Detect budget activity from row text
        const baMatch = BA_RE.exec(rowText);
        const budgetActivity = baMatch != null ? `BA ${baMatch[1]}` : undefined;

        // Detect PE references (cross-references, not identities)
        const _peRefs = Array.from(new Set(rowText.match(PE_REF_RE) ?? []));
        // PE refs are recorded as relationships in the artifact builder, not here.

        // Build identity using WS B builder
        let identity: ProcurementBlinIdentityV1;
        try {
          identity = buildProcurementBlinIdentity({
            code: printedCode,
            account,
            component,
            advanceProcurement: isAdvance,
          });
        } catch {
          omissions.push({
            page: page.page,
            rowIndex,
            reason: 'invalid procurement identity — missing account or component',
            rawText: firstCell,
          });
          continue;
        }

        const blinIdentity: P1BlinIdentity = {
          printedCode,
          title,
          page: page.page,
          ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
          tableIndex: table.tableIndex,
          rowIndex,
          ...(budgetActivity != null ? { budgetActivity } : {}),
          advanceProcurement: isAdvance,
          identity,
        };
        identities.push(blinIdentity);

        // Process numeric cells using header bindings
        for (const binding of headerBinding.bindings) {
          const cell = cells[binding.columnIndex];
          if (cell == null) continue;
          const rawText = cell.text.trim();
          if (rawText === '' || rawText === '-' || rawText === '—') continue;

          const num = parseMoneyToken(rawText);
          if (num == null) {
            // Non-numeric value in a data column — could be blank/dash
            continue;
          }

          const originalValue = toCanonicalDecimal(num);
          const effectiveUnit = binding.printedUnit ?? unit;

          if (binding.valueKind === 'quantity') {
            quantities.push({
              identityNaturalKey: identity.naturalKey,
              ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
              columnBinding: binding,
              quantity: originalValue,
              columnIndex: binding.columnIndex,
              headerText: binding.headerText,
              page: page.page,
            });
          } else if (binding.valueKind === 'money' || binding.valueKind === 'unit_cost') {
            if (effectiveUnit == null) {
              omissions.push({
                page: page.page,
                rowIndex,
                columnIndex: binding.columnIndex,
                reason: 'missing printed unit for money value',
                rawText: rawText,
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
  }

  // Detect conflicts: same identity + FY with different values
  const fundingByKey = new Map<string, P1FundingValue[]>();
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
    quantities,
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
  // Sort each row's cells by columnIndex
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
  // Header rows contain FY or fiscal-year-like vocabulary AND are not data rows.
  // A data row's first cell might be "BLIN" (header label) vs a real BLIN code
  // like "9670A00005". Distinguish by checking if the row contains header
  // vocabulary words AND the first cell is not a valid long/short BLIN code
  // that we would extract as data.
  const hasHeaderVocab =
    /\b(?:fy|fiscal|year|budget|request|actual|enacted|base|oco|total|quantity|qty|cost|title)\b/i.test(
      text,
    );
  const firstCell = cells[0]?.text.trim() ?? '';
  // "BLIN", "Line", "Line Item" etc are header labels, not BLIN codes.
  // Real BLIN codes are 4+ chars of alnum. But "BLIN" (4 letters) matches
  // SHORT_LI_RE. Distinguish by checking if it's a known header label.
  const headerLabels = new Set(['blin', 'line', 'line item', 'li', 'pe', 'code']);
  const isHeaderLabel = headerLabels.has(firstCell.toLowerCase());
  const isDataCode = !isHeaderLabel && looksLikeBlin(firstCell);
  return hasHeaderVocab && !isDataCode;
}

function isTotalRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  return (
    /\b(?:total|subtotal|sum|grand total)\b/i.test(text) && !looksLikeBlin(cells[0]?.text ?? '')
  );
}

function looksLikeBlin(text: string): boolean {
  return LONG_BLIN_RE.test(text) || SHORT_LI_RE.test(text);
}

function detectBlinCode(text: string): string | null {
  // Try long-form BLIN first
  if (LONG_BLIN_RE.test(text)) return text;
  // Try short-form line number
  if (SHORT_LI_RE.test(text)) return text;
  // Try extracting from beginning of cell
  const match = /^([0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5})\b/.exec(text);
  if (match != null) return match[1] ?? null;
  const shortMatch = /^([A-Z0-9]{4,8})\b/.exec(text);
  if (shortMatch != null) return shortMatch[1] ?? null;
  return null;
}
