/**
 * p21-extractor-v1 — P-21 (Production/Delivery Schedule) extraction from
 * Phase 3 normalized page results.
 *
 * Captures, where printed:
 *   1. Explicit parent BLIN reference (from manifest or exhibit text).
 *      Fuzzy title matching is PROHIBITED. When no explicit parent is found
 *      the result is a blocking omission — never an empty success.
 *   2. Schedule periods: planned quantities and deliveries by FY/quarter.
 *   3. Program / acquisition status narrative.
 *   4. Explanatory narrative sections.
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
import {
  buildProcurementBlinIdentity,
  type ProcurementBlinIdentityV1,
} from '../identity-v1.js';
import {
  detectPrintedUnit,
  toCanonicalDecimal,
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

export interface P21ParentReference {
  printedCode: string;
  source: 'manifest' | 'exhibit_text';
  exhibitSnippet?: string;
  page: number;
  identity: ProcurementBlinIdentityV1;
}

export interface P21ScheduleEntry {
  identityNaturalKey: string;
  periodLabel: string;
  fiscalYear?: number;
  quantity?: string;
  deliveries?: string;
  cumulative?: string;
  page: number;
  rowIndex: number;
}

export interface P21NarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  text: string;
  page: number;
}

export interface P21ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface P21ExtractionConflict {
  identityNaturalKey: string;
  periodLabel: string;
  pages: number[];
  reason: string;
}

export interface P21ExtractionResult {
  parentReference: P21ParentReference | null;
  schedule: P21ScheduleEntry[];
  narratives: P21NarrativeSection[];
  omissions: P21ExtractionOmission[];
  conflicts: P21ExtractionConflict[];
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

const PRODUCTION_SCHEDULE_RE = /production\s*schedule|delivery\s*schedule|schedule\s*of\s*deliver/i;

const QUANTITY_RE = /\b(?:qty|quantity|units)\b/i;
const DELIVERIES_RE = /\bdeliver/i;
const CUMULATIVE_RE = /\bcumulative\b/i;

const PERIOD_FY_RE = /\bFY\s*(\d{4})\b/i;
const PERIOD_QUARTER_RE = /\b([1-4])Q\s*(?:FY\s*)?(\d{4})\b/i;
const PERIOD_MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{4})\b/i;

const NARRATIVE_SECTIONS = [
  { pattern: /program\s*status/i, sectionType: 'program_status' },
  { pattern: /acquisition\s*status/i, sectionType: 'acquisition_status' },
  { pattern: /justification|rationale|explanation/i, sectionType: 'rationale' },
  { pattern: /production\s*schedule|delivery\s*schedule/i, sectionType: 'production_schedule' },
];

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractP21FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
  parentBlinCode?: string;
}): P21ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const schedule: P21ScheduleEntry[] = [];
  const narratives: P21NarrativeSection[] = [];
  const omissions: P21ExtractionOmission[] = [];
  const conflicts: P21ExtractionConflict[] = [];
  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  let parentReference: P21ParentReference | null = null;
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
      parentReference = detectParentFromExhibitText(
        page.text,
        page.page,
        account,
        component,
      );
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

      if (!PRODUCTION_SCHEDULE_RE.test(tableText)) {
        continue;
      }

      recognizedLayout = true;

      const identityKey = parentReference?.identity.naturalKey ?? 'UNKNOWN';

      const headerRow = findHeaderRow(rows);
      let headerBinding: HeaderBindingResultV1 | null = null;
      const headerTexts = new Map<number, string>();
      if (headerRow != null) {
        const headers = headerRow.map((cell, idx) => ({
          columnIndex: idx,
          text: cell.text.trim(),
        }));
        for (const h of headers) {
          headerTexts.set(h.columnIndex, h.text);
        }
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
        const rowLabel = cells[0]?.text.trim() ?? '';
        if (rowLabel.length === 0) continue;

        const periodLabel = extractPeriodLabel(rowLabel) ?? rowLabel;
        const fyFromLabel = extractFiscalYear(rowLabel) ?? headerBinding?.bindings.find(
          (b) => b.fiscalYear != null,
        )?.fiscalYear;

        const entry: P21ScheduleEntry = {
          identityNaturalKey: identityKey,
          periodLabel,
          ...(fyFromLabel != null ? { fiscalYear: fyFromLabel } : {}),
          page: page.page,
          rowIndex,
        };

        // Check each cell by its column header text directly — not all
        // schedule columns (Deliveries, Cumulative) are classified by
        // bindHeaders, so we match header text directly.
        for (const cell of cells) {
          if (cell.columnIndex === 0) continue;
          const rawText = cell.text.trim();
          if (rawText === '' || rawText === '-' || rawText === '\u2014') continue;
          const colHeader = headerTexts.get(cell.columnIndex) ?? '';
          const binding = headerBinding?.bindings.find(
            (b) => b.columnIndex === cell.columnIndex,
          );

          if (QUANTITY_RE.test(colHeader) || QUANTITY_RE.test(rowLabel)) {
            const num = parseMoneyToken(rawText);
            if (num != null) {
              entry.quantity = toCanonicalDecimal(num);
              if (binding?.fiscalYear != null && entry.fiscalYear == null) {
                entry.fiscalYear = binding.fiscalYear;
              }
            }
          } else if (DELIVERIES_RE.test(colHeader)) {
            const num = parseMoneyToken(rawText);
            if (num != null) {
              entry.deliveries = toCanonicalDecimal(num);
            }
          } else if (CUMULATIVE_RE.test(colHeader)) {
            const num = parseMoneyToken(rawText);
            if (num != null) {
              entry.cumulative = toCanonicalDecimal(num);
            }
          }
        }

        schedule.push(entry);
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
          const endIdx = nextSectionMatch != null
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

  /* Duplicate schedule periods → conflict. */
  const scheduleByKey = new Map<string, P21ScheduleEntry[]>();
  for (const entry of schedule) {
    const key = `${entry.identityNaturalKey}|${entry.periodLabel}|${entry.fiscalYear ?? 'none'}`;
    const list = scheduleByKey.get(key) ?? [];
    list.push(entry);
    scheduleByKey.set(key, list);
  }
  for (const [, list] of scheduleByKey) {
    if (list.length <= 1) continue;
    const first = list[0]!;
    conflicts.push({
      identityNaturalKey: first.identityNaturalKey,
      periodLabel: first.periodLabel,
      pages: list.map((e) => e.page),
      reason: 'duplicate schedule period',
    });
  }

  /* Blocking omission when no parent reference was found. */
  if (parentReference == null) {
    omissions.push({
      page: pages[0]?.page ?? 1,
      reason:
        'missing explicit parent BLIN reference — fuzzy title matching is prohibited',
      rawText: 'no manifest parentBlinCode and no explicit LI/BLIN in exhibit text',
    });
  }

  /* Blocking omission when no recognized layout was found. */
  if (!recognizedLayout) {
    omissions.push({
      page: pages[0]?.page ?? 1,
      reason:
        'unsupported layout — no recognized Production/Delivery Schedule table',
      rawText: `pages: ${pages.map((p) => p.page).join(',')}`,
    });
  }

  return {
    parentReference,
    schedule,
    narratives,
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
): P21ParentReference | null {
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
): P21ParentReference | null {
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
      ...(source === 'exhibit_text'
        ? { exhibitSnippet: text.slice(0, 200) }
        : {}),
      page,
      identity,
    };
  } catch {
    return null;
  }
}

function extractPeriodLabel(rowLabel: string): string | null {
  if (PERIOD_QUARTER_RE.test(rowLabel)) return rowLabel.trim();
  if (PERIOD_MONTH_RE.test(rowLabel)) return rowLabel.trim();
  const fyMatch = PERIOD_FY_RE.exec(rowLabel);
  if (fyMatch != null) return `FY ${fyMatch[1]!}`;
  return null;
}

function extractFiscalYear(rowLabel: string): number | null {
  const qMatch = PERIOD_QUARTER_RE.exec(rowLabel);
  if (qMatch != null) {
    const year = Number.parseInt(qMatch[2] ?? '', 10);
    if (year >= 1900 && year <= 2200) return year;
  }
  const mMatch = PERIOD_MONTH_RE.exec(rowLabel);
  if (mMatch != null) {
    const year = Number.parseInt(mMatch[2] ?? '', 10);
    if (year >= 1900 && year <= 2200) return year;
  }
  const fyMatch = PERIOD_FY_RE.exec(rowLabel);
  if (fyMatch != null) {
    const year = Number.parseInt(fyMatch[1] ?? '', 10);
    if (year >= 1900 && year <= 2200) return year;
  }
  return null;
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

function isHeaderRow(
  cells: Array<{ columnIndex: number; text: string }>,
): boolean {
  const text = cells.map((c) => c.text).join(' ').toLowerCase();
  const hasHeaderVocab = /\b(?:fy|fiscal|year|budget|quantity|qty|deliver|cumulative|period|quarter|units)\b/i.test(
    text,
  );
  const firstCell = cells[0]?.text.trim() ?? '';
  const headerLabels = new Set([
    'blin',
    'line',
    'title',
    'code',
    'pe',
    'li',
    'line item',
    'period',
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

function isTotalRow(
  cells: Array<{ columnIndex: number; text: string }>,
): boolean {
  const text = cells.map((c) => c.text).join(' ').toLowerCase();
  return /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
}
