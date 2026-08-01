/**
 * RDT&E extractor (R-1 / R-2 / R-2A / R-3).
 *
 * Handles the TWO real J-book table structures (validated against FY2027 Army RDT&E Vol 1
 * and FY2027 Comptroller R-1 LlamaParse output):
 *
 *  (A) Catalog / R-1 / table-of-contents tables — the PE code is IN a row cell. Real R-1
 *      tables put Line No in col 0 and Program Element Number in col 1, e.g.
 *      `| 1 | 0601102A | Defense Research Sciences | 01 | U | 290,464 | ... |`.
 *      Older fixtures put the PE in col 0: `| 0602308A | Advanced Technology | ... |`.
 *
 *  (B) R-2 / R-2A COST tables — the PE code is NOT in the table; it sits in a preceding
 *      heading (`PE 0601601A / Artificial Intelligence...`). The cost row is labelled
 *      "Total Program Element". We track CURRENT PE CONTEXT while walking the page.
 *
 * INDEPENDENCE: every value row is its own assertion; no last-wins collapsing. IDENTITY:
 * R-series only => RDTE_PE. Invalid codes are quarantined to warnings, never coerced.
 */
import {
  classifyLineKind,
  detectUnit,
  isValidPeCode,
  parseMoneyToken,
  type ExhibitType,
  type ExtractionResult,
  type LineAssertion,
  type Money,
  type PerformerRole,
  type ValueProvenance,
  type YearValueAssertion,
} from './types.js';
import type { ParsedPage, ParsedTable } from './rdte.extractor.types.js';

export type { ParsedPage, ParsedTable } from './rdte.extractor.types.js';

export interface RdteExtractInput {
  exhibit: Extract<ExhibitType, 'R-1' | 'R-2' | 'R-2A' | 'R-3'>;
  component: string | null;
  pages: ParsedPage[];
  /** FY columns the source presents; used only as a fallback when headers lack FY labels. */
  fyColumns: number[];
}

/** Money field on PE-year that this extractor may emit. */
export type RdteMoneyField =
  | 'request'
  | 'enacted'
  | 'executed'
  | 'reprogrammed'
  | 'ndaaConference'
  | 'conference';

interface FyColBinding {
  fy: number;
  fieldName: RdteMoneyField;
}

// Detection is looser than validation so the quarantine path is reachable for OCR-mangled codes.
const CODE_TOKEN = /([0-9]{6,}[A-Z0-9]*)/;
const CODE_CELL = /^([0-9]{6,}[A-Z0-9]*)/;
// PE context from headings: "PE 0601601A / Title", "PE 0601601A:", "PE 0601275A ...".
const PE_CONTEXT_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/;
// Cost tables carry these column labels.
const COST_TABLE_HINT = /cost\s*\(\$|prior years|cost to complete|total cost|total program element/i;
const FY_ANY = /(?:FY\s*)?20(\d{2})/i;
const TOTAL_HINT = /\btotal\b/i;
const BASE_OR_OOC = /\b(base|oco|ooc|mandatory|discretionary|pl)\b/i;
const PE_HEADER_HINT = /program\s*element|pe\s*number|pe\s*#|element\s*number|^pe$/i;
const TITLE_HEADER_HINT = /^(item|title|program(\s*element)?\s*title|nomenclature|description)$/i;
const LINE_NO_HINT = /line\s*(no|num|#)|^\s*#\s*$/i;

/**
 * Map header column index -> { fy, fieldName }.
 * Multi-column FYs (Base/OOC/Total, Discretionary/Mandatory/Total) collapse to ONE
 * binding per (fy, fieldName), preferring Total then plain over split columns.
 */
export function mapFyFieldColumns(
  header: string[] | undefined,
  fallback: number[],
): Map<number, FyColBinding> {
  const out = new Map<number, FyColBinding>();
  if (!header || header.length === 0) {
    fallback.forEach((fy, i) => out.set(i, { fy, fieldName: 'request' }));
    return out;
  }

  type Cand = { idx: number; label: string; fieldName: RdteMoneyField; score: number };
  const groups = new Map<string, Cand[]>();

  header.forEach((h, i) => {
    const label = h.trim();
    const m = FY_ANY.exec(label);
    if (!m) return;
    const fy = 2000 + Number(m[1]);
    const fieldName = classifyFyHeaderField(label);
    if (!fieldName) return;
    const score = scoreFyHeader(label, fieldName);
    const key = `${fy}::${fieldName}`;
    const arr = groups.get(key) ?? [];
    arr.push({ idx: i, label, fieldName, score });
    groups.set(key, arr);
  });

  for (const [key, cands] of Array.from(groups)) {
    cands.sort((a, b) => b.score - a.score);
    const chosen = cands[0]!;
    const fy = Number(key.split('::')[0]);
    out.set(chosen.idx, { fy, fieldName: chosen.fieldName });
  }
  return out;
}

/** Classify a FY-bearing header into a PE-year money field, or null to skip. */
export function classifyFyHeaderField(label: string): RdteMoneyField | null {
  const l = label.toLowerCase();
  if (/spend\s*plan/.test(l)) return null;
  if (/\b(base|oco|ooc)\b/.test(l) && !TOTAL_HINT.test(l)) return null;
  if (/mandatory\s+request/.test(l)) return null;
  if (/actual/.test(l)) return 'executed';
  if (/enacted/.test(l)) return 'enacted';
  if (/reprogramm/.test(l)) return 'reprogrammed';
  if (/ndaa/.test(l) && /conference/.test(l)) return 'ndaaConference';
  if (/conference/.test(l) && !/ndaa/.test(l)) return 'conference';
  if (/request/.test(l) || TOTAL_HINT.test(l)) return 'request';
  return 'request';
}

function scoreFyHeader(label: string, fieldName: RdteMoneyField): number {
  const l = label.toLowerCase();
  let s = 0;
  if (TOTAL_HINT.test(l)) s += 10;
  if (fieldName === 'request' && /request/.test(l)) s += 5;
  if (fieldName === 'enacted' && /enacted/.test(l)) s += 5;
  if (fieldName === 'executed' && /actual/.test(l)) s += 5;
  if (BASE_OR_OOC.test(l) && !TOTAL_HINT.test(l)) s -= 5;
  if (/discretionary/.test(l) && TOTAL_HINT.test(l)) s += 2;
  return s;
}

function mapFyColumns(header: string[] | undefined, fallback: number[]): Map<number, number> {
  const rich = mapFyFieldColumns(header, fallback);
  const out = new Map<number, number>();
  for (const [idx, b] of Array.from(rich)) out.set(idx, b.fy);
  return out;
}

function isCostTable(table: ParsedTable): boolean {
  const hay = `${table.label ?? ''} ${(table.header ?? []).join(' ')}`;
  return COST_TABLE_HINT.test(hay);
}

function headerIndex(header: string[] | undefined, pred: (h: string) => boolean): number {
  if (!header) return -1;
  return header.findIndex((h) => pred(h.trim()));
}

/** Find a PE code token in any cell; prefer a column whose header looks like PE number. */
export function findPeCodeInRow(
  row: string[],
  header?: string[],
): { code: string; col: number } | null {
  const peCol = headerIndex(header, (h) => PE_HEADER_HINT.test(h));
  const order: number[] = [];
  if (peCol >= 0) order.push(peCol);
  for (let i = 0; i < row.length; i++) if (i !== peCol) order.push(i);

  for (const i of order) {
    const cell = (row[i] ?? '').trim();
    if (!cell) continue;
    const whole = CODE_CELL.exec(cell);
    const token = whole?.[1] ?? CODE_TOKEN.exec(cell)?.[1];
    if (!token) continue;
    if (isValidPeCode(token)) return { code: token, col: i };
    if (/^[0-9]{6,}[A-Z0-9]*$/.test(token)) return { code: token, col: i };
  }
  return null;
}

function titleFromRow(row: string[], peCol: number, header?: string[]): string {
  const titleCol = headerIndex(header, (h) => TITLE_HEADER_HINT.test(h));
  if (titleCol >= 0 && titleCol !== peCol) {
    const t = (row[titleCol] ?? '').trim();
    if (t) return t;
  }
  for (let i = 0; i < row.length; i++) {
    if (i === peCol) continue;
    const h = (header?.[i] ?? '').trim();
    if (h && LINE_NO_HINT.test(h)) continue;
    if (h && /^(act|sec|ba|s&t|budget\s*activity)$/i.test(h)) continue;
    if (h && FY_ANY.test(h)) continue;
    const cell = (row[i] ?? '').trim();
    if (!cell) continue;
    if (CODE_CELL.test(cell)) continue;
    if (/^\d+$/.test(cell)) continue;
    return cell;
  }
  return '';
}

function unitForPage(page: ParsedPage, table: ParsedTable): Money['unit'] {
  const hay = [table.label ?? '', (table.header ?? []).join(' '), page.markdown ?? ''].join(' ');
  return detectUnit(hay);
}

export function extractRdte(input: RdteExtractInput): ExtractionResult {
  const lineKind = classifyLineKind(input.exhibit);
  const lineAssertions: LineAssertion[] = [];
  const yearValues: YearValueAssertion[] = [];
  const warnings: string[] = [];
  const seenLine = new Set<string>();

  for (const page of input.pages) {
    const ctx = PE_CONTEXT_RE.exec(page.markdown);
    const contextPe = ctx && isValidPeCode(ctx[1]!) ? ctx[1]! : null;

    for (const table of page.tables) {
      const unit = unitForPage(page, table);
      const fyBindings = mapFyFieldColumns(table.header, input.fyColumns);
      const fyCols = mapFyColumns(table.header, input.fyColumns);
      const costTable = isCostTable(table);

      for (const row of table.rows) {
        const first = (row[0] ?? '').trim();
        const peHit = findPeCodeInRow(row, table.header);

        if (peHit) {
          const { code, col } = peHit;
          if (!isValidPeCode(code)) {
            warnings.push(`quarantined invalid PE code "${code}" on pdf p.${page.pdfPage}`);
            continue;
          }
          const title = titleFromRow(row, col, table.header);
          emitLine(code, title, page, table, first || code);
          emitFyValues(code, row, fyBindings, unit, page, table, first || code);
          continue;
        }

        if (costTable && contextPe && /total program element|^total\b/i.test(first)) {
          emitLine(contextPe, `PE ${contextPe}`, page, table, first);
          const costBindings = new Map<number, FyColBinding>();
          for (const [idx, fy] of Array.from(fyCols)) {
            costBindings.set(idx, { fy, fieldName: 'request' });
          }
          const bindings = fyBindings.size > 0 ? fyBindings : costBindings;
          emitFyValues(contextPe, row, bindings, unit, page, table, first);
        }
      }
    }
  }

  function emitLine(code: string, title: string, page: ParsedPage, table: ParsedTable, rowLabel: string): void {
    const key = `${code}`;
    if (seenLine.has(key)) return;
    seenLine.add(key);
    const line: LineAssertion = {
      lineKind,
      code,
      title: title || '(untitled)',
      component: input.component ?? undefined,
      provenance: prov(page, table, rowLabel, 'title'),
    };
    if (input.exhibit === 'R-3') {
      line.performerRole = 'PERFORMING_ACTIVITY' as PerformerRole;
    }
    lineAssertions.push(line);
  }

  function emitFyValues(
    code: string,
    row: string[],
    fyBindings: Map<number, FyColBinding>,
    unit: Money['unit'],
    page: ParsedPage,
    table: ParsedTable,
    rowLabel: string,
  ): void {
    for (const [colIdx, binding] of Array.from(fyBindings)) {
      const raw = row[colIdx];
      const val = parseMoneyToken(raw);
      if (val == null) continue;
      yearValues.push({
        lineKind,
        code,
        component: input.component ?? undefined,
        fy: binding.fy,
        fieldName: binding.fieldName,
        money: { value: val, unit },
        provenance: prov(page, table, rowLabel, `FY${binding.fy}:${binding.fieldName}`),
      });
    }
  }

  function prov(page: ParsedPage, table: ParsedTable, rowLabel: string, colLabel: string): ValueProvenance {
    return {
      pdfPage: page.pdfPage,
      printedPage: page.printedPage,
      exhibit: input.exhibit,
      tableLabel: table.label,
      rowLabel,
      colLabel,
      derivation: 'direct',
      extractionMethod: 'llamaparse',
      confidence: 0.9,
    };
  }

  return { lineAssertions, yearValues, warnings };
}
