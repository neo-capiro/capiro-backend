/**
 * r4-extractor-v1 — R-4/R-4A milestone and schedule-period extraction from
 * Phase 3 normalized page results.
 *
 * Workstream K (Phase 4 plan §16). For every R-4/R-4A milestone table on a
 * page, captures:
 *   - parent PE code (validated against isValidPeCode);
 *   - project code when printed on the milestone row or in a project header;
 *   - milestone type/title;
 *   - planned period, actual period where printed;
 *   - status, notes;
 *   - physical/printed page, table/row/column evidence;
 *   - schedule-period fidelity preserved exactly (no fabricated dates).
 *
 * Milestone assertions are emitted in the shape required by
 * milestoneAssertionV1Schema (assertionKind 'milestone').  Exact
 * plannedDate/actualDate are populated ONLY when the source provides an
 * exact date; quarter/year labels retain structured metadata and leave
 * exact dates absent.
 *
 * Pure module. Never invokes a parser, never writes to a database.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import {
  exactDateString,
  parseR4SchedulePeriod,
  type R4SchedulePeriodV1,
} from './r4-schedule-period-v1.js';

/* ------------------------------------------------------------------ */
/* Input context                                                       */
/* ------------------------------------------------------------------ */

/**
 * Pre-segmented R-4/R-4A page range for a single PE (or a document-level
 * pass when segmentation is not available).  The extractor never does its
 * own segmentation.
 */
export interface R4PeContextV1 {
  peCode: string;
  /** Inclusive physical-page range of this PE's R-4/R-4A section. */
  pageStart: number;
  pageEnd: number;
  /** Optional project code when the whole section is project-scoped. */
  projectCode?: string;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R4MilestoneV1 {
  parentPeCode: string;
  /** Present when the milestone row or section header names a project. */
  projectCode?: string;
  milestoneType: string;
  /** Structured planned period; exactDate only when source is exact. */
  plannedPeriod: R4SchedulePeriodV1;
  /** Structured actual period; present only when printed. */
  actualPeriod?: R4SchedulePeriodV1;
  status?: string;
  notes?: string;
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  /** Raw cell texts for downstream evidence/audit. */
  rawCells: Array<{ columnIndex: number; text: string }>;
}

export interface R4ExtractionOmission {
  peCode?: string;
  projectCode?: string;
  page: number;
  rowIndex?: number;
  reason: string;
  rawText: string;
}

export interface R4ExtractionResult {
  peCode: string;
  milestones: R4MilestoneV1[];
  omissions: R4ExtractionOmission[];
  /** True when at least one milestone table was detected in the range. */
  tableDetected: boolean;
}

/* ------------------------------------------------------------------ */
/* Manifest policy                                                     */
/* ------------------------------------------------------------------ */

export const R4_MANIFEST_POLICY_V1_VALUES = ['required', 'optional', 'not_applicable'] as const;
export type R4ManifestPolicyV1 = (typeof R4_MANIFEST_POLICY_V1_VALUES)[number];

export interface R4ManifestEntryV1 {
  policy: R4ManifestPolicyV1;
  /** Required when policy is 'not_applicable'. */
  reason?: string;
}

/**
 * Evaluate whether an R-4 document blocks cycle certification.
 *
 * - required:     missing extraction blocks certification.
 * - optional:     missing extraction does NOT block certification.
 * - not_applicable: missing extraction does NOT block certification when a
 *                 reason is recorded.
 */
export function evaluateR4ManifestPolicy(entry: R4ManifestEntryV1): {
  blocksCertification: boolean;
  reason?: string;
} {
  switch (entry.policy) {
    case 'required':
      return { blocksCertification: true };
    case 'optional':
      return { blocksCertification: false };
    case 'not_applicable':
      return {
        blocksCertification: false,
        ...(entry.reason != null ? { reason: entry.reason } : {}),
      };
  }
}

/* ------------------------------------------------------------------ */
/* Table detection                                                     */
/* ------------------------------------------------------------------ */

const R4_HEADER_RE = /\bR-4\b|\bRDT&E\s+Schedule\s+Profile\b/i;
const MILESTONE_HEADER_HINT_RE =
  /\b(milestone|event|planned|actual|date|status|notes?|schedule)\b/i;
const PE_CODE_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
const PROJECT_CODE_RE = /\bproject\s*(?:code)?\s*[:.\-]?\s*([A-Z0-9][A-Z0-9.\-]{0,11})\b/i;

interface R4DetectedRow {
  rowIndex: number;
  cells: Array<{ columnIndex: number; text: string }>;
}

interface R4DetectedTable {
  page: number;
  printedPage?: string;
  tableIndex: number;
  headerRowIndices: number[];
  rows: R4DetectedRow[];
  /** Column role map inferred from the header row. */
  columnRoles: Map<number, 'milestone' | 'planned' | 'actual' | 'status' | 'notes' | 'unknown'>;
}

function detectR4TablesOnPage(page: ParserPageResultV1): R4DetectedTable[] {
  const detected: R4DetectedTable[] = [];
  for (const table of page.tables) {
    const result = analyzeR4Table(page.page, page.printedPage, table);
    if (result != null) detected.push(result);
  }
  return detected;
}

function analyzeR4Table(
  page: number,
  printedPage: string | undefined,
  table: {
    tableIndex: number;
    cells: Array<{ rowIndex: number; columnIndex: number; text: string }>;
  },
): R4DetectedTable | null {
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
  const dataRows: R4DetectedRow[] = [];
  let columnRoles: Map<
    number,
    'milestone' | 'planned' | 'actual' | 'status' | 'notes' | 'unknown'
  > = new Map();

  for (const [rowIndex, cells] of rows) {
    const rowText = cells
      .map((c) => c.text)
      .join(' ')
      .trim();
    if (rowText === '') continue;

    /* Header row: contains milestone vocabulary, no obvious data payload,
     * AND the majority of cells match known header labels.  A data row that
     * happens to contain the word "milestone" (e.g. "Some Milestone") must
     * not be misclassified as a header. */
    const hasDateLike = cells.some((c) => {
      const t = c.text.trim();
      return (
        /\d{4}/.test(t) ||
        /\b(?:Q[1-4]|[1-4]Q)\b/i.test(t) ||
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(t)
      );
    });
    const headerLabelCount = cells.filter((c) => {
      const t = c.text.trim().toLowerCase();
      return (
        /\b(milestone|event|description|title)\b/.test(t) ||
        /\b(planned|target|scheduled)\b/.test(t) ||
        /\b(actual|completed|achieved)\b/.test(t) ||
        /\bstatus\b/.test(t) ||
        /\b(notes?|remarks?|comments?)\b/.test(t)
      );
    }).length;
    const isHeaderRow =
      MILESTONE_HEADER_HINT_RE.test(rowText) &&
      !hasDateLike &&
      headerLabelCount >= Math.max(2, Math.ceil(cells.length * 0.5));
    if (isHeaderRow) {
      headerRowIndices.push(rowIndex);
      /* Infer column roles from header labels. */
      for (const cell of cells) {
        const t = cell.text.trim().toLowerCase();
        let role: 'milestone' | 'planned' | 'actual' | 'status' | 'notes' | 'unknown' = 'unknown';
        if (/\b(milestone|event|description|title)\b/.test(t)) role = 'milestone';
        else if (/\b(planned|target|scheduled)\b/.test(t)) role = 'planned';
        else if (/\b(actual|completed|achieved)\b/.test(t)) role = 'actual';
        else if (/\bstatus\b/.test(t)) role = 'status';
        else if (/\b(notes?|remarks?|comments?)\b/.test(t)) role = 'notes';
        columnRoles.set(cell.columnIndex, role);
      }
      continue;
    }

    /* Data row: must have at least one non-empty cell. */
    dataRows.push({
      rowIndex,
      cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
    });
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
  };
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

export function extractR4Milestones(input: {
  pages: readonly ParserPageResultV1[];
  peContext: R4PeContextV1;
}): R4ExtractionResult {
  const { peContext } = input;
  const pages = input.pages.filter(
    (page) => page.page >= peContext.pageStart && page.page <= peContext.pageEnd,
  );

  const milestones: R4MilestoneV1[] = [];
  const omissions: R4ExtractionOmission[] = [];
  let tableDetected = false;

  for (const page of pages) {
    /* Skip pages that do not look like R-4/R-4A schedule pages. */
    const pageText = page.text ?? '';
    const blockTexts = page.blocks.map((b) => b.text);
    const isR4Page = R4_HEADER_RE.test(pageText) || blockTexts.some((t) => R4_HEADER_RE.test(t));
    if (!isR4Page) continue;

    const tables = detectR4TablesOnPage(page);
    if (tables.length > 0) tableDetected = true;

    for (const table of tables) {
      for (const row of table.rows) {
        const getCell = (role: string) =>
          row.cells.find((c) => table.columnRoles.get(c.columnIndex) === role);

        const milestoneCell = getCell('milestone') ?? row.cells[0];
        const plannedCell = getCell('planned');
        const actualCell = getCell('actual');
        const statusCell = getCell('status');
        const notesCell = getCell('notes');

        const milestoneType = milestoneCell?.text.trim() ?? '';
        if (milestoneType === '') {
          omissions.push({
            peCode: peContext.peCode,
            page: table.page,
            rowIndex: row.rowIndex,
            reason: 'missing_milestone_type',
            rawText: row.cells.map((c) => c.text).join(' | '),
          });
          continue;
        }

        /* Planned period is required; missing planned date is an omission. */
        if (plannedCell == null || plannedCell.text.trim() === '') {
          omissions.push({
            peCode: peContext.peCode,
            page: table.page,
            rowIndex: row.rowIndex,
            reason: 'missing_planned_date',
            rawText: milestoneType,
          });
          continue;
        }

        const plannedPeriod = parseR4SchedulePeriod(plannedCell.text);
        const actualPeriod =
          actualCell != null && actualCell.text.trim() !== ''
            ? parseR4SchedulePeriod(actualCell.text)
            : undefined;

        /* Project code: row-level cell wins, then section context. */
        let projectCode: string | undefined;
        const rowText = row.cells.map((c) => c.text).join(' ');
        const projMatch = PROJECT_CODE_RE.exec(rowText);
        if (projMatch?.[1] != null) {
          projectCode = projMatch[1];
        } else if (peContext.projectCode != null) {
          projectCode = peContext.projectCode;
        }

        milestones.push({
          parentPeCode: peContext.peCode,
          ...(projectCode != null ? { projectCode } : {}),
          milestoneType,
          plannedPeriod,
          ...(actualPeriod != null ? { actualPeriod } : {}),
          ...(statusCell != null && statusCell.text.trim() !== ''
            ? { status: statusCell.text.trim() }
            : {}),
          ...(notesCell != null && notesCell.text.trim() !== ''
            ? { notes: notesCell.text.trim() }
            : {}),
          page: table.page,
          ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
          tableIndex: table.tableIndex,
          rowIndex: row.rowIndex,
          rawCells: row.cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
        });
      }
    }
  }

  return { peCode: peContext.peCode, milestones, omissions, tableDetected };
}

/* ------------------------------------------------------------------ */
/* Assertion builder                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build milestone assertions in the exact shape of milestoneAssertionV1Schema.
 * Exact plannedDate/actualDate are populated ONLY when the source period is
 * an exact date; otherwise the structured period metadata is retained in
 * the milestone object and the exact-date fields are left absent.
 */
export function buildR4MilestoneAssertions(input: {
  milestones: readonly R4MilestoneV1[];
  assertionIdPrefix: string;
  sourceFactIdPrefix: string;
  evidenceIdPrefix: string;
}): Array<{
  assertionId: string;
  sourceFactIds: string[];
  evidenceIds: string[];
  confidence: number;
  assertionKind: 'milestone';
  parentPeCode: string;
  milestoneType: string;
  plannedDate?: string;
  actualDate?: string;
  status?: string;
  notes?: string;
}> {
  return input.milestones.map((m, i) => {
    const plannedDate = exactDateString(m.plannedPeriod);
    const actualDate = m.actualPeriod != null ? exactDateString(m.actualPeriod) : undefined;
    return {
      assertionId: `${input.assertionIdPrefix}_${i}`,
      sourceFactIds: [`${input.sourceFactIdPrefix}_${i}`],
      evidenceIds: [`${input.evidenceIdPrefix}_${i}`],
      confidence: Math.min(m.plannedPeriod.confidence, m.actualPeriod?.confidence ?? 1),
      assertionKind: 'milestone' as const,
      parentPeCode: m.parentPeCode,
      milestoneType: m.milestoneType,
      ...(plannedDate != null ? { plannedDate } : {}),
      ...(actualDate != null ? { actualDate } : {}),
      ...(m.status != null ? { status: m.status } : {}),
      ...(m.notes != null ? { notes: m.notes } : {}),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Convenience: extract from flat page list without pre-segmentation   */
/* ------------------------------------------------------------------ */

/**
 * Extract R-4 milestones from a flat list of pages by grouping contiguous
 * pages that share the same PE header.  Useful when Workstream E
 * segmentation is not yet available.
 */
export function extractR4MilestonesFromPages(input: {
  pages: readonly ParserPageResultV1[];
}): R4ExtractionResult[] {
  const groups = new Map<string, { peCode: string; pages: ParserPageResultV1[] }>();

  for (const page of input.pages) {
    const pageText = page.text ?? '';
    const blockTexts = page.blocks.map((b) => b.text);
    const isR4Page = R4_HEADER_RE.test(pageText) || blockTexts.some((t) => R4_HEADER_RE.test(t));
    if (!isR4Page) continue;

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

  const results: R4ExtractionResult[] = [];
  for (const group of groups.values()) {
    const pageStart = Math.min(...group.pages.map((p) => p.page));
    const pageEnd = Math.max(...group.pages.map((p) => p.page));
    results.push(
      extractR4Milestones({
        pages: group.pages,
        peContext: { peCode: group.peCode, pageStart, pageEnd },
      }),
    );
  }
  return results;
}
