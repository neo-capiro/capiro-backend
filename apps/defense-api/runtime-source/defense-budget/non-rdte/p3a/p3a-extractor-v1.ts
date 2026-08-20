/**
 * p3a-extractor-v1 — P-3A (Individual Modification or Related Line Detail)
 * extraction from Phase 3 normalized page results.
 *
 * Captures, where printed:
 *   1. Explicit parent BLIN reference (from manifest or exhibit text).
 *      Fuzzy title matching is PROHIBITED. When no explicit parent is found
 *      the result is a blocking omission — never an empty success.
 *   2. Modification / configuration description.
 *   3. Explanatory narrative sections.
 *
 * Unrecognized table layouts become a blocking omission or review route,
 * not an empty success.
 *
 * All identities are PROCUREMENT_BLIN, never RDTE_PE.
 * All numeric values use exact decimal strings (toCanonicalDecimal).
 * No magnitude-based unit inference. No title-based natural key.
 * No fabricated funding amount from narrative text.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database, never imports ProgramElementWriterService or any canonical
 * writer.
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

export interface P3aParentReference {
  printedCode: string;
  source: 'manifest' | 'exhibit_text';
  exhibitSnippet?: string;
  page: number;
  identity: ProcurementBlinIdentityV1;
}

export interface P3aModificationEntry {
  identityNaturalKey: string;
  /** Modification label / identifier as printed. */
  label: string;
  /** Full description text. */
  description: string;
  page: number;
  rowIndex: number;
}

export interface P3aNarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  text: string;
  page: number;
}

export interface P3aFundingValue {
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

export interface P3aExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface P3aExtractionConflict {
  identityNaturalKey: string;
  label: string;
  pages: number[];
  reason: string;
}

export interface P3aExtractionResult {
  parentReference: P3aParentReference | null;
  modifications: P3aModificationEntry[];
  narratives: P3aNarrativeSection[];
  funding: P3aFundingValue[];
  omissions: P3aExtractionOmission[];
  conflicts: P3aExtractionConflict[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  recognizedLayout: boolean;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

const LONG_BLIN_RE = /^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}$/;
const SHORT_LI_RE = /^[A-Z0-9]{4,8}$/;
const ADVANCE_PROC_RE = /advance\s+procurement|\bAP\b|adv(?:ance)?\s+proc/i;

const EXPLICIT_PARENT_RE =
  /(?:^|\n)\s*(?:LI|BLIN|Line\s*Item|P-?40\s*Line)\s*[:#]?\s*([0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5})\b/i;
const EXPLICIT_PARENT_SHORT_RE =
  /(?:^|\n)\s*(?:LI|BLIN|Line\s*Item|P-?40\s*Line)\s*[:#]?\s*([A-Z0-9]{4,8})\s*[-:/]/i;

const MODIFICATION_RE = /modification|configuration|config\s*change|related\s*line/i;
const NARRATIVE_RE = /narrative|justification|rationale|description|explanation/i;

const NARRATIVE_SECTIONS = [
  { pattern: /justification|rationale|explanation/i, sectionType: 'rationale' },
  {
    pattern: /modification\s*description|configuration\s*description/i,
    sectionType: 'modification_description',
  },
  { pattern: /program\s*status/i, sectionType: 'program_status' },
  { pattern: /acquisition\s*status/i, sectionType: 'acquisition_status' },
];

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractP3aFromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
  parentBlinCode?: string;
}): P3aExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const modifications: P3aModificationEntry[] = [];
  const narratives: P3aNarrativeSection[] = [];
  const funding: P3aFundingValue[] = [];
  const omissions: P3aExtractionOmission[] = [];
  const conflicts: P3aExtractionConflict[] = [];
  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  let parentReference: P3aParentReference | null = null;
  let recognizedLayout = false;

  /* Resolve parent reference from manifest first. */
  if (input.parentBlinCode != null && input.parentBlinCode.trim().length > 0) {
    const code = input.parentBlinCode.trim();
    const isAdvance = ADVANCE_PROC_RE.test(code);
    try {
      const identity = buildProcurementBlinIdentity({
        code,
        account,
        component,
        advanceProcurement: isAdvance,
      });
      parentReference = {
        printedCode: code,
        source: 'manifest',
        page: pages[0]?.page ?? 1,
        identity,
      };
    } catch {
      omissions.push({
        page: pages[0]?.page ?? 1,
        reason: 'invalid parent BLIN code from manifest — missing account or component',
        rawText: code,
      });
    }
  }

  for (const page of pages) {
    if (parentReference == null && page.text != null) {
      parentReference = detectParentFromExhibitText(page.text, page.page, account, component);
    }

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

      const isModification = MODIFICATION_RE.test(tableText);

      if (!isModification) {
        continue;
      }

      recognizedLayout = true;

      const identityKey = parentReference?.identity.naturalKey ?? 'UNKNOWN';

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

      for (const [rowIndex, cells] of rows) {
        if (isHeaderRow(cells)) continue;
        if (isTotalRow(cells)) continue;
        const label = cells[0]?.text.trim() ?? '';
        if (label.length === 0) continue;

        const description = cells
          .slice(1)
          .map((c) => c.text)
          .join(' ')
          .trim();

        if (description.length > 0) {
          modifications.push({
            identityNaturalKey: identityKey,
            label,
            description: `${label}: ${description}`.slice(0, 1000),
            page: page.page,
            rowIndex,
          });
        }

        /* Numeric funding values, when header binding succeeded. */
        if (headerBinding != null) {
          for (const binding of headerBinding.bindings) {
            const cell = cells[binding.columnIndex];
            if (cell == null) continue;
            const rawText = cell.text.trim();
            if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
            const num = parseMoneyToken(rawText);
            if (num == null) continue;

            const originalValue = toCanonicalDecimal(num);
            const effectiveUnit = binding.printedUnit ?? unit;

            if (binding.valueKind === 'money' || binding.valueKind === 'unit_cost') {
              if (effectiveUnit == null) {
                omissions.push({
                  page: page.page,
                  rowIndex,
                  columnIndex: binding.columnIndex,
                  reason: 'missing printed unit for money value',
                  rawText,
                });
                continue;
              }
              const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
              funding.push({
                identityNaturalKey: identityKey,
                rowLabel: label,
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

    /* Narrative sections from page text. */
    if (page.text != null && parentReference != null) {
      const identityKey = parentReference.identity.naturalKey;
      for (const { pattern, sectionType } of NARRATIVE_SECTIONS) {
        const match = pattern.exec(page.text);
        if (match != null) {
          const startIdx = match.index + match[0].length;
          const nextSectionMatch = NARRATIVE_SECTIONS.find((s) => {
            if (s.sectionType === sectionType) return false;
            const m = s.pattern.exec(page.text!);
            return m != null && m.index > match.index;
          });
          const endIdx =
            nextSectionMatch != null
              ? nextSectionMatch.pattern.exec(page.text)!.index
              : Math.min(startIdx + 2000, page.text.length);
          const sectionText = page.text.slice(startIdx, endIdx).trim();
          if (sectionText.length > 0) {
            narratives.push({
              identityNaturalKey: identityKey,
              sectionType,
              text: sectionText.slice(0, 1000),
              page: page.page,
            });
          }
        }
      }
    }
  }

  /* Duplicate modification labels → conflict. */
  const modByKey = new Map<string, P3aModificationEntry[]>();
  for (const mod of modifications) {
    const key = `${mod.identityNaturalKey}|${mod.label}`;
    const list = modByKey.get(key) ?? [];
    list.push(mod);
    modByKey.set(key, list);
  }
  for (const [, list] of modByKey) {
    if (list.length <= 1) continue;
    const first = list[0]!;
    conflicts.push({
      identityNaturalKey: first.identityNaturalKey,
      label: first.label,
      pages: list.map((m) => m.page),
      reason: 'duplicate modification label',
    });
  }

  /* Blocking omission when no parent reference was found. */
  if (parentReference == null) {
    omissions.push({
      page: pages[0]?.page ?? 1,
      reason: 'missing explicit parent BLIN reference — fuzzy title matching is prohibited',
      rawText: 'no manifest parentBlinCode and no explicit LI/BLIN in exhibit text',
    });
  }

  /* Blocking omission when no recognized layout was found. */
  if (!recognizedLayout) {
    omissions.push({
      page: pages[0]?.page ?? 1,
      reason: 'unsupported layout — no recognized Modification/Configuration table',
      rawText: `pages: ${pages.map((p) => p.page).join(',')}`,
    });
  }

  return {
    parentReference,
    modifications,
    narratives,
    funding,
    omissions,
    conflicts,
    headerBinding: {
      bindings: allBindings,
      hasAmbiguousColumns: unresolvedColumnIndices.length > 0,
      unresolvedColumnIndices,
    },
    unitResolution: { unit, source: unitSource },
    recognizedLayout,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function detectParentFromExhibitText(
  text: string,
  page: number,
  account: string,
  component: BudgetComponentV1,
): P3aParentReference | null {
  const longMatch = EXPLICIT_PARENT_RE.exec(text);
  if (longMatch != null) {
    const code = longMatch[1]!;
    return buildParentRef(code, text, page, account, component, 'exhibit_text');
  }
  const shortMatch = EXPLICIT_PARENT_SHORT_RE.exec(text);
  if (shortMatch != null) {
    const code = shortMatch[1]!;
    return buildParentRef(code, text, page, account, component, 'exhibit_text');
  }
  return null;
}

function buildParentRef(
  code: string,
  text: string,
  page: number,
  account: string,
  component: BudgetComponentV1,
  source: 'manifest' | 'exhibit_text',
): P3aParentReference | null {
  const isAdvance = ADVANCE_PROC_RE.test(text);
  try {
    const identity = buildProcurementBlinIdentity({
      code,
      account,
      component,
      advanceProcurement: isAdvance,
    });
    return {
      printedCode: code,
      source,
      ...(source === 'exhibit_text' ? { exhibitSnippet: text.slice(0, 200) } : {}),
      page,
      identity,
    };
  } catch {
    return null;
  }
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

function rowsToText(rows: Map<number, Array<{ columnIndex: number; text: string }>>): string {
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
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  const hasHeaderVocab = /\b(?:fy|fiscal|year|budget|cost|amount|total)\b/i.test(text);
  const firstCell = cells[0]?.text.trim() ?? '';
  const headerLabels = new Set([
    'blin',
    'line',
    'title',
    'code',
    'pe',
    'li',
    'line item',
    'modification',
    'configuration',
    'description',
  ]);
  const isHeaderLabel = headerLabels.has(firstCell.toLowerCase());
  const isDataCode =
    !isHeaderLabel && (LONG_BLIN_RE.test(firstCell) || SHORT_LI_RE.test(firstCell));
  const hasNumericData = cells.some(
    (c, idx) =>
      idx > 0 &&
      (/^-?[\d,]+(?:\.\d+)?$/.test(c.text.trim()) ||
        c.text.trim() === '-' ||
        c.text.trim() === '\u2014'),
  );
  return hasHeaderVocab && !isDataCode && !hasNumericData;
}

function isTotalRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  return /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
}
