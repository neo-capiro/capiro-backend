/**
 * p5-extractor-v1 — P-5/P-5A (Cost Analysis and Production Schedule)
 * extraction from Phase 3 normalized page results.
 *
 * Captures, where printed:
 *   1. Explicit parent BLIN reference (from manifest or exhibit text).
 *      Fuzzy title matching is PROHIBITED. When no explicit parent is found
 *      the result is a blocking omission — never an empty success.
 *   2. Cost categories: recurring and nonrecurring cost breakdowns by FY.
 *   3. Schedule periods: planned quantities and deliveries by FY/quarter.
 *   4. Configuration / modifications descriptions.
 *   5. Program / acquisition status narrative.
 *   6. Explanatory narrative sections.
 *
 * Unrecognized table layouts become a blocking omission or review route,
 * not an empty success.
 *
 * All identities are PROCUREMENT_BLIN, never RDTE_PE.
 * All numeric values use exact decimal strings (toCanonicalDecimal).
 * No magnitude-based unit inference. No title-based natural key.
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

/** Explicit parent BLIN reference. Source is either the manifest or the
 *  exhibit text — never a fuzzy title match. */
export interface P5ParentReference {
  printedCode: string;
  /** Where the parent reference was found. */
  source: 'manifest' | 'exhibit_text';
  /** The exhibit text snippet that contained the explicit reference, when
   *  source is 'exhibit_text'. */
  exhibitSnippet?: string;
  page: number;
  identity: ProcurementBlinIdentityV1;
}

export interface P5CostCategoryValue {
  identityNaturalKey: string;
  /** 'recurring' | 'nonrecurring' | 'total' | other source-defined label. */
  costCategory: string;
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

export interface P5ScheduleEntry {
  identityNaturalKey: string;
  /** Period label as printed (e.g. "FY 2027", "1Q FY 2027", "Oct 2027"). */
  periodLabel: string;
  fiscalYear?: number;
  /** Planned quantity for the period, when printed. */
  quantity?: string;
  /** Deliveries for the period, when printed. */
  deliveries?: string;
  /** Cumulative quantity, when printed. */
  cumulative?: string;
  page: number;
  rowIndex: number;
}

export interface P5NarrativeSection {
  identityNaturalKey: string;
  sectionType: string;
  text: string;
  page: number;
}

export interface P5ModificationEntry {
  identityNaturalKey: string;
  description: string;
  page: number;
  rowIndex: number;
}

export interface P5ExtractionOmission {
  page: number;
  rowIndex?: number;
  columnIndex?: number;
  reason: string;
  rawText: string;
}

export interface P5ExtractionConflict {
  identityNaturalKey: string;
  periodLabel: string;
  pages: number[];
  reason: string;
}

export interface P5ExtractionResult {
  parentReference: P5ParentReference | null;
  costCategories: P5CostCategoryValue[];
  schedule: P5ScheduleEntry[];
  narratives: P5NarrativeSection[];
  modifications: P5ModificationEntry[];
  omissions: P5ExtractionOmission[];
  conflicts: P5ExtractionConflict[];
  headerBinding: HeaderBindingResultV1;
  unitResolution: { unit: PrintedUnitV1 | undefined; source: string };
  /** True when at least one recognized table layout was processed. */
  recognizedLayout: boolean;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

const LONG_BLIN_RE = /^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5}$/;
const SHORT_LI_RE = /^[A-Z0-9]{4,8}$/;
const ADVANCE_PROC_RE = /advance\s+procurement|\bAP\b|adv(?:ance)?\s+proc/i;

/** Explicit parent BLIN reference in exhibit text.
 *  Accepted forms:
 *    "LI 9670A00005 - MQ-1 UAV"
 *    "BLIN: 9670A00005"
 *    "Line Item: 9670A00005 / MQ-1 UAV"
 *    "P-40 Line: 9670A00005"
 *  Fuzzy title-only matching is PROHIBITED. */
const EXPLICIT_PARENT_RE =
  /(?:^|\n)\s*(?:LI|BLIN|Line\s*Item|P-?40\s*Line)\s*[:#]?\s*([0-9]{4}[A-Z]{1,2}[0-9A-Z]{4,5})\b/i;

const EXPLICIT_PARENT_SHORT_RE =
  /(?:^|\n)\s*(?:LI|BLIN|Line\s*Item|P-?40\s*Line)\s*[:#]?\s*([A-Z0-9]{4,8})\s*[-:/]/i;

const COST_ANALYSIS_RE = /cost\s*analysis|recurring.*nonrecurring|non[- ]?recurring/i;
const PRODUCTION_SCHEDULE_RE = /production\s*schedule|delivery\s*schedule|schedule\s*of\s*deliver/i;
const MODIFICATION_RE = /modification|configuration|config\s*change/i;

const RECURRING_RE = /\brecurring\b/i;
const NONRECURRING_RE = /\bnon[- ]?recurring\b/i;
const TOTAL_RE = /\btotal\b/i;
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
  { pattern: /configuration|modification/i, sectionType: 'configuration' },
];

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractP5FromPages(input: {
  pages: readonly ParserPageResultV1[];
  cycleFiscalYear: number;
  account: string;
  component: BudgetComponentV1;
  /** Optional explicit parent BLIN code from the manifest. When supplied,
   *  this is the authoritative parent reference and no exhibit-text scan
   *  is needed. When omitted, the extractor scans exhibit text for an
   *  explicit LI/BLIN reference. */
  parentBlinCode?: string;
}): P5ExtractionResult {
  const { pages, cycleFiscalYear, account, component } = input;

  const costCategories: P5CostCategoryValue[] = [];
  const schedule: P5ScheduleEntry[] = [];
  const narratives: P5NarrativeSection[] = [];
  const modifications: P5ModificationEntry[] = [];
  const omissions: P5ExtractionOmission[] = [];
  const conflicts: P5ExtractionConflict[] = [];
  let allBindings: ColumnBindingV1[] = [];
  const unresolvedColumnIndices: number[] = [];

  let unit: PrintedUnitV1 | undefined;
  let unitSource = 'not detected';
  let parentReference: P5ParentReference | null = null;
  let recognizedLayout = false;

  /* Resolve parent reference from manifest first (authoritative). */
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
    /* If no manifest parent, scan exhibit text for an explicit reference. */
    if (parentReference == null && page.text != null) {
      parentReference = detectParentFromExhibitText(page.text, page.page, account, component);
    }

    /* Detect printed unit from page text or table labels. */
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

      const isCostAnalysis = COST_ANALYSIS_RE.test(tableText);
      const isProductionSchedule = PRODUCTION_SCHEDULE_RE.test(tableText);
      const isModification = MODIFICATION_RE.test(tableText);

      if (!isCostAnalysis && !isProductionSchedule && !isModification) {
        // Not a recognized P-5/P-5A layout. Skip — but track that we saw
        // an unrecognized table. If NO table on ANY page is recognized,
        // we emit a blocking omission at the end.
        continue;
      }

      recognizedLayout = true;

      const identityKey = parentReference?.identity.naturalKey ?? 'UNKNOWN';

      if (isCostAnalysis) {
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
          omissions.push({
            page: page.page,
            reason: 'ambiguous header in Cost Analysis table — could not bind FY columns',
            rawText: `table ${table.tableIndex}`,
          });
          continue;
        }

        for (const [rowIndex, cells] of rows) {
          if (isHeaderRow(cells)) continue;
          if (isTotalRow(cells)) continue;
          const rowLabel = cells[0]?.text.trim() ?? '';
          if (rowLabel.length === 0) continue;

          const costCategory = classifyCostCategory(rowLabel);

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
              // Quantity row in cost analysis — record as schedule quantity.
              schedule.push({
                identityNaturalKey: identityKey,
                periodLabel: binding.headerText,
                ...(binding.fiscalYear != null ? { fiscalYear: binding.fiscalYear } : {}),
                quantity: originalValue,
                page: page.page,
                rowIndex,
              });
            } else if (binding.valueKind === 'money' || binding.valueKind === 'unit_cost') {
              if (effectiveUnit == null) {
                omissions.push({
                  page: page.page,
                  rowIndex,
                  columnIndex: binding.columnIndex,
                  reason: 'missing printed unit for cost category money value',
                  rawText,
                });
                continue;
              }
              const valueMillions = convertUnit(originalValue, effectiveUnit, 'millions');
              costCategories.push({
                identityNaturalKey: identityKey,
                costCategory,
                rowLabel,
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

      if (isProductionSchedule) {
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
        }
        for (const [rowIndex, cells] of rows) {
          if (isHeaderRow(cells)) continue;
          if (isTotalRow(cells)) continue;
          const rowLabel = cells[0]?.text.trim() ?? '';
          if (rowLabel.length === 0) continue;

          const periodLabel = extractPeriodLabel(rowLabel) ?? rowLabel;
          const fyFromLabel =
            extractFiscalYear(rowLabel) ??
            headerBinding?.bindings.find((b) => b.fiscalYear != null)?.fiscalYear;

          const entry: P5ScheduleEntry = {
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
            const binding = headerBinding?.bindings.find((b) => b.columnIndex === cell.columnIndex);

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

          // If the row label itself contains a period and no binding
          // captured a quantity/deliveries, still record the period.
          schedule.push(entry);
        }
      }

      if (isModification) {
        for (const [rowIndex, cells] of rows) {
          if (isHeaderRow(cells)) continue;
          if (isTotalRow(cells)) continue;
          const rowLabel = cells[0]?.text.trim() ?? '';
          if (rowLabel.length === 0) continue;
          const description = cells
            .slice(1)
            .map((c) => c.text)
            .join(' ')
            .trim();
          if (description.length === 0) continue;
          modifications.push({
            identityNaturalKey: parentReference?.identity.naturalKey ?? 'UNKNOWN',
            description: `${rowLabel}: ${description}`.slice(0, 1000),
            page: page.page,
            rowIndex,
          });
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

  /* Duplicate schedule periods → warning/conflict. */
  const scheduleByKey = new Map<string, P5ScheduleEntry[]>();
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
      reason: 'missing explicit parent BLIN reference — fuzzy title matching is prohibited',
      rawText: 'no manifest parentBlinCode and no explicit LI/BLIN in exhibit text',
    });
  }

  /* Blocking omission when no recognized layout was found. */
  if (!recognizedLayout) {
    omissions.push({
      page: pages[0]?.page ?? 1,
      reason:
        'unsupported layout — no recognized Cost Analysis, Production Schedule, or Modification table',
      rawText: `pages: ${pages.map((p) => p.page).join(',')}`,
    });
  }

  return {
    parentReference,
    costCategories,
    schedule,
    narratives,
    modifications,
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
): P5ParentReference | null {
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
): P5ParentReference | null {
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

function classifyCostCategory(rowLabel: string): string {
  if (NONRECURRING_RE.test(rowLabel)) return 'nonrecurring';
  if (RECURRING_RE.test(rowLabel)) return 'recurring';
  if (TOTAL_RE.test(rowLabel)) return 'total';
  return 'other';
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
  const hasHeaderVocab =
    /\b(?:fy|fiscal|year|budget|quantity|qty|cost|recurring|nonrecurring|total|deliver|cumulative|period|quarter)\b/i.test(
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
    'resource',
    'summary',
    'category',
    'cost category',
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

function isTotalRow(cells: Array<{ columnIndex: number; text: string }>): boolean {
  const text = cells
    .map((c) => c.text)
    .join(' ')
    .toLowerCase();
  return /\b(?:total|subtotal|sum|grand total)\b/i.test(text);
}
