/**
 * p40-extractor-v1 — complete P-40 (Budget Line Item Justification) extraction
 * from Phase 3 normalized page results.
 *
 * Captures, where printed:
 *   1. Parent identity: appropriation/account, BLIN/line number, title,
 *      budget activity and subactivity, base/AP status.
 *   2. Resource summary: all FY quantities, net procurement/P-1 total,
 *      gross/weapon-system unit cost, recurring and nonrecurring cost
 *      categories, prior years, budget year, and FYDP columns.
 *   3. Narrative/detail: item description, program status, acquisition
 *      status, justification/rationale, production/delivery schedule,
 *      contractor/manufacturer names only when explicitly stated,
 *      explicit PE references.
 *   4. Secondary distribution: recipient/description, FY, quantity,
 *      obligation authority/funding, unit cost when printed, line-level
 *      page evidence.
 *
 * Arithmetic safety: quantity × gross unit cost = net procurement is NOT
 * universally enforced. Only run arithmetic when source labels define
 * equivalent scope. Otherwise report values independently.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  buildProcurementBlinIdentity,
  type ProcurementBlinIdentityV1,
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
} from '../column-semantics-v1.js';
import { parseMoneyToken } from '../../extractors/types.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface P40ParentIdentity {
  printedCode: string;
  title: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  budgetActivity?: string;
  budgetSubActivity?: string;
  advanceProcurement: boolean;
  identity: ProcurementBlinIdentityV1;
  referencedPeCodes: string[];
}

export interface P40ResourceSummaryValue {
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
}

export interface P40NarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  text: string;
  page: number;
}

export interface P40SecondaryDistributionLine {
  identityNaturalKey: string;
  recipient: string;
  description?: string;
  fiscalYear?: number;
  quantity?: string;
  funding?: string;
  fundingUnit?: PrintedUnitV1;
  unitCost?: string;
  page: number;
  rowIndex: number;
}

export interface P40ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface P40ExtractionResult {
  parentIdentity: P40ParentIdentity | null;
  resourceSummary: P40ResourceSummaryValue[];
  narratives: P40NarrativeSection[];
  secondaryDistribution: P40SecondaryDistributionLine[];
  omissions: P40ExtractionOmission[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  arithmeticCheckApplicable: boolean;
  arithmeticCheckResult?: { passed: boolean; expected: string; actual: string; tolerance: string };
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

const LONG_BLIN_RE = /^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}$/;
const SHORT_LI_RE = /^[A-Z0-9]{4,8}$/;
const ADVANCE_PROC_RE = /advance\s+procurement|\bAP\b|adv(?:ance)?\s+proc/i;
const BA_RE = /\bBA\s*(\d{2})\b/i;
const BSA_RE = /\bBSA\s*(\d{2})\b/i;
const PE_REF_RE = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/g;
const APPROP_RE = /\b(\d{4}[A-Z]{1,2}):\s*(.+?)(?:\s*\/|$)/i;
const LI_FOOTER_RE = /\bLI\s+([0-9][0-9A-Z]{8,11})\s*-\s*(.+)$/;

const RESOURCE_SUMMARY_RE = /resource\s+summary/i;
const NET_PROC_RE = /net\s+procurement|p-?1\s+total/i;
const GROSS_UNIT_COST_RE = /gross|weapon\s*system\s*unit\s*cost/i;
const QUANTITY_RE = /procurement\s+quantity|quantity\s*\(units/i;

const NARRATIVE_SECTIONS = [
  { pattern: /item\s*description/i, sectionType: 'item_description' },
  { pattern: /program\s*status/i, sectionType: 'program_status' },
  { pattern: /acquisition\s*status/i, sectionType: 'acquisition_status' },
  { pattern: /justification|rationale/i, sectionType: 'justification' },
  { pattern: /production\s*schedule|delivery\s*schedule/i, sectionType: 'production_schedule' },
  { pattern: /contractor|manufacturer/i, sectionType: 'contractor' },
];

const SECONDARY_DIST_RE = /secondary\s+distribution/i;

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractP40FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
}): P40ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const resourceSummary: P40ResourceSummaryValue[] = [];
  const narratives: P40NarrativeSection[] = [];
  const secondaryDistribution: P40SecondaryDistributionLine[] = [];
  const omissions: P40ExtractionOmission[] = [];
  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  let parentIdentity: P40ParentIdentity | null = null;

  for (const page of pages) {
    if (parentIdentity == null && page.text != null) {
      parentIdentity = detectParentIdentityFromText(
        page.text, page.page, page.printedPage, account, component,
      );
    }

    for (const table of page.tables) {
      if (unit == null && table.label != null) {
        const detected = detectPrintedUnit(table.label);
        if (detected != null) { unit = detected; unitSource = `table label: "${table.label}"`; }
      }
      if (unit == null && page.text != null) {
        const detected = detectPrintedUnit(page.text.slice(0, 2000));
        if (detected != null) { unit = detected; unitSource = 'page text'; }
      }

      const rows = groupCellsByRow(table);
      const tableText = rowsToText(rows);

      if (RESOURCE_SUMMARY_RE.test(tableText) || NET_PROC_RE.test(tableText) || GROSS_UNIT_COST_RE.test(tableText)) {
        const headerRow = findHeaderRow(rows);
        let headerBinding: HeaderBindingResultV1 | null = null;
        if (headerRow != null) {
          const headers = headerRow.map((cell, idx) => ({ columnIndex: idx, text: cell.text.trim() }));
          headerBinding = bindHeaders({ headers, cycleFiscalYear });
          allBindings = allBindings.concat(headerBinding.bindings);
        }
        if (headerBinding == null) {
          omissions.push({ page: page.page, reason: 'ambiguous header in Resource Summary table', rawText: `table ${table.tableIndex}` });
          continue;
        }
        if (parentIdentity == null) {
          parentIdentity = detectParentIdentityFromText(tableText, page.page, page.printedPage, account, component);
        }
        const identityKey = parentIdentity?.identity.naturalKey ?? 'UNKNOWN';

        for (const [rowIndex, cells] of rows) {
          if (isHeaderRow(cells)) continue;
          const rowLabel = cells[0]?.text.trim() ?? '';
          if (rowLabel.length === 0) continue;

          for (const binding of headerBinding.bindings) {
            const cell = cells[binding.columnIndex];
            if (cell == null) continue;
            const rawText = cell.text.trim();
            if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
            const num = parseMoneyToken(rawText);
            if (num == null) continue;

            const originalValue = toCanonicalDecimal(num);
            const effectiveUnit = binding.printedUnit ?? unit;

            if (binding.valueKind === 'quantity' || QUANTITY_RE.test(rowLabel)) {
              // Store quantity values with a placeholder unit
              const qtyUnit: PrintedUnitV1 = effectiveUnit ?? 'dollars';
              resourceSummary.push({
                identityNaturalKey: identityKey, rowLabel,
                ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
                columnBinding: binding, originalValue, originalUnit: qtyUnit,
                valueMillions: originalValue,
                columnIndex: binding.columnIndex, headerText: binding.headerText, page: page.page,
              });
            } else if (binding.valueKind === 'money' || binding.valueKind === 'unit_cost') {
              if (effectiveUnit == null) {
                omissions.push({ page: page.page, rowIndex, columnIndex: binding.columnIndex, reason: 'missing printed unit for money value', rawText });
                continue;
              }
              const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
              resourceSummary.push({
                identityNaturalKey: identityKey, rowLabel,
                ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
                columnBinding: binding, originalValue, originalUnit: effectiveUnit,
                valueMillions,
                columnIndex: binding.columnIndex, headerText: binding.headerText, page: page.page,
              });
            }
          }
        }
      }

      if (SECONDARY_DIST_RE.test(tableText)) {
        const identityKey = parentIdentity?.identity.naturalKey ?? 'UNKNOWN';
        const headerRow = findHeaderRow(rows);
        let headerBinding: HeaderBindingResultV1 | null = null;
        if (headerRow != null) {
          const headers = headerRow.map((cell, idx) => ({ columnIndex: idx, text: cell.text.trim() }));
          headerBinding = bindHeaders({ headers, cycleFiscalYear });
        }
        for (const [rowIndex, cells] of rows) {
          if (isHeaderRow(cells)) continue;
          if (isTotalRow(cells)) continue;
          const recipient = cells[0]?.text.trim() ?? '';
          if (recipient.length === 0) continue;
          const distLine: P40SecondaryDistributionLine = {
            identityNaturalKey: identityKey, recipient, page: page.page, rowIndex,
          };
          if (headerBinding != null) {
            for (const binding of headerBinding.bindings) {
              const cell = cells[binding.columnIndex];
              if (cell == null) continue;
              const rawText = cell.text.trim();
              if (rawText === '' || rawText === '-') continue;
              const num = parseMoneyToken(rawText);
              if (num == null) continue;
              if (binding.valueKind === 'quantity') {
                distLine.quantity = toCanonicalDecimal(num);
                if (binding.fiscalYear != null) distLine.fiscalYear = binding.fiscalYear;
              } else if (binding.valueKind === 'money') {
                const effectiveUnit = binding.printedUnit ?? unit;
                if (effectiveUnit != null) {
                  distLine.funding = toCanonicalDecimal(num);
                  distLine.fundingUnit = effectiveUnit;
                  if (binding.fiscalYear != null) distLine.fiscalYear = binding.fiscalYear;
                }
              }
            }
          }
          const desc = cells[1]?.text.trim();
          if (desc != null && desc.length > 0 && desc !== recipient) { distLine.description = desc; }
          secondaryDistribution.push(distLine);
        }
      }
    }

    if (page.text != null && parentIdentity != null) {
      const identityKey = parentIdentity.identity.naturalKey;
      for (const { pattern, sectionType } of NARRATIVE_SECTIONS) {
        const match = pattern.exec(page.text);
        if (match != null) {
          const startIdx = match.index + match[0].length;
          const nextSectionMatch = NARRATIVE_SECTIONS.find((s) => {
            if (s.sectionType === sectionType) return false;
            const m = s.pattern.exec(page.text!);
            return m != null && m.index > match.index;
          });
          const endIdx = nextSectionMatch != null
            ? nextSectionMatch.pattern.exec(page.text)!.index
            : Math.min(startIdx + 2000, page.text.length);
          const sectionText = page.text.slice(startIdx, endIdx).trim();
          if (sectionText.length > 0) {
            narratives.push({ identityNaturalKey: identityKey, sectionType, text: sectionText.slice(0, 1000), page: page.page });
          }
        }
      }
    }
  }

  let arithmeticCheckApplicable = false;
  let arithmeticCheckResult: P40ExtractionResult['arithmeticCheckResult'];
  if (parentIdentity != null) {
    const identityKey = parentIdentity.identity.naturalKey;
    const quantityValues = resourceSummary.filter((v) => v.identityNaturalKey === identityKey && (QUANTITY_RE.test(v.rowLabel) || v.columnBinding.valueKind === 'quantity'));
    const unitCostValues = resourceSummary.filter((v) => v.identityNaturalKey === identityKey && (GROSS_UNIT_COST_RE.test(v.rowLabel) || v.columnBinding.valueKind === 'unit_cost'));
    const netProcValues = resourceSummary.filter((v) => v.identityNaturalKey === identityKey && NET_PROC_RE.test(v.rowLabel));
    if (quantityValues.length > 0 && unitCostValues.length > 0 && netProcValues.length > 0) {
      const qty = quantityValues[0]!;
      const ucost = unitCostValues[0]!;
      const netProc = netProcValues[0]!;
      if (qty.fiscalYear === ucost.fiscalYear && ucost.fiscalYear === netProc.fiscalYear && qty.columnBinding.baseOcoStatus === netProc.columnBinding.baseOcoStatus) {
        arithmeticCheckApplicable = true;
        const qtyVal = parseFloat(qty.originalValue);
        const ucostDollars = parseFloat(convertUnit(ucost.originalValue, ucost.originalUnit, 'dollars'));
        const netProcDollars = parseFloat(convertUnit(netProc.originalValue, netProc.originalUnit, 'dollars'));
        const expected = qtyVal * ucostDollars;
        const actual = netProcDollars;
        const tolerance = Math.abs(actual) * 0.01;
        arithmeticCheckResult = { passed: Math.abs(expected - actual) <= tolerance, expected: expected.toString(), actual: actual.toString(), tolerance: tolerance.toString() };
      }
    }
  }

  return {
    parentIdentity, resourceSummary, narratives, secondaryDistribution, omissions,
    headerBinding: { bindings: allBindings, hasAmbiguousColumns: unresolvedColumnIndices.length > 0, unresolvedColumnIndices },
    unitResolution: { unit, source: unitSource },
    arithmeticCheckApplicable,
    ...(arithmeticCheckResult != null ? { arithmeticCheckResult } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function detectParentIdentityFromText(text: string, page: number, printedPage: string | undefined, account: string, component: BudgetComponentV1): P40ParentIdentity | null {
  const headerMatch = /\b([0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5})\s*\/\s*(.+)$/m.exec(text);
  if (headerMatch != null) {
    const code = headerMatch[1]!;
    const title = headerMatch[2]!.trim().split('\n')[0]!.trim();
    return buildParentIdentity(code, title, text, page, printedPage, account, component, 0);
  }
  const footerMatch = LI_FOOTER_RE.exec(text);
  if (footerMatch != null) {
    const code = footerMatch[1]!;
    const title = footerMatch[2]!.trim();
    return buildParentIdentity(code, title, text, page, printedPage, account, component, 0);
  }
  const appropMatch = APPROP_RE.exec(text);
  const shortMatch = /\bLI\s+([A-Z0-9]{4,8})\s*-\s*(.+)$/.exec(text);
  if (appropMatch != null && shortMatch != null) {
    const approp = appropMatch[1]!;
    const line = shortMatch[1]!;
    const title = shortMatch[2]!.trim();
    const code = `${approp}${line}`;
    return buildParentIdentity(code, title, text, page, printedPage, account, component, 0);
  }
  return null;
}

function buildParentIdentity(code: string, title: string, text: string, page: number, printedPage: string | undefined, account: string, component: BudgetComponentV1, tableIndex: number): P40ParentIdentity | null {
  const isAdvance = ADVANCE_PROC_RE.test(text);
  const baMatch = BA_RE.exec(text);
  const bsaMatch = BSA_RE.exec(text);
  const peRefs = Array.from(new Set(text.match(PE_REF_RE) ?? []));
  try {
    const identity = buildProcurementBlinIdentity({ code, account, component, advanceProcurement: isAdvance });
    return {
      printedCode: code, title, page,
      ...(printedPage != null ? { printedPage } : {}),
      tableIndex,
      ...(baMatch != null ? { budgetActivity: `BA ${baMatch[1]}` } : {}),
      ...(bsaMatch != null ? { budgetSubActivity: `BSA ${bsaMatch[1]}` } : {}),
      advanceProcurement: isAdvance, identity, referencedPeCodes: peRefs,
    };
  } catch { return null; }
}

function groupCellsByRow(table: ParsedTableV1): Map<number, Array<{ columnIndex: number; text: string }>> {
  const rows = new Map<number, Array<{ columnIndex: number; text: string }>>();
  for (const cell of table.cells) {
    const row = rows.get(cell.rowIndex) ?? [];
    row.push({ columnIndex: cell.columnIndex, text: cell.text });
    rows.set(cell.rowIndex, row);
  }
  for (const [, row] of rows) { row.sort((a, b) => a.columnIndex - b.columnIndex); }
  return new Map([...rows.entries()].sort((a, b) => a[0] - b[0]));
}

function rowsToText(rows: Map<number, Array<{ columnIndex: number; text: string }>>): string {
  const parts: string[] = [];
  for (const [, cells] of rows) { parts.push(cells.map((c) => c.text).join(' ')); }
  return parts.join('\n');
}

function findHeaderRow(rows: Map<number, Array<{ columnIndex: number; text: string }>>): Array<{ columnIndex: number; text: string }> | null {
  for (const [, cells] of rows) { if (isHeaderRow(cells)) return cells; }
  return null;
}

function isHeaderRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells.map((c) => c.text).join(' ').toLowerCase();
  const hasHeaderVocab = /\b(?:fy|fiscal|year|budget|request|actual|enacted|base|oco|ooc|total|quantity|qty|cost|prior|years)\b/i.test(text);
  const firstCell = cells[0]?.text.trim() ?? '';
  const headerLabels = new Set(['blin', 'line', 'title', 'code', 'pe', 'li', 'line item', 'resource', 'summary']);
  const isHeaderLabel = headerLabels.has(firstCell.toLowerCase());
  const isDataCode = !isHeaderLabel && (LONG_BLIN_RE.test(firstCell) || SHORT_LI_RE.test(firstCell));
  // A row with numeric data cells is a data row, not a header row.
  // Resource Summary data rows like "Procurement Quantity 8 -" contain
  // header vocabulary words ("quantity") but also numeric values.
  const hasNumericData = cells.some((c, idx) => idx > 0 && /^-?[\d,]+(?:\.\d+)?$/.test(c.text.trim()) || c.text.trim() === '-' || c.text.trim() === '\u2014');
  return hasHeaderVocab && !isDataCode && !hasNumericData;
}

function isTotalRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells.map((c) => c.text).join(' ').toLowerCase();
  return /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
}
