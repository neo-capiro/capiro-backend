/**
 * RDT&E extractor (R-1 / R-2 / R-2A / R-3).
 *
 * Handles the TWO real J-book table structures (validated against FY2027 Army RDT&E Vol 1):
 *
 *  (A) Catalog / R-1 / table-of-contents tables — the PE code is IN a row cell, e.g.
 *      `| 1 | 0601102A Defense Research Sciences | ... |` or `| 0602146A / AT7 | Title |`.
 *
 *  (B) R-2 / R-2A COST tables — the PE code is NOT in the table; it sits in a preceding
 *      heading (`PE 0601601A / Artificial Intelligence...` or an appropriation row
 *      `PE 0601275A / ...`). The cost row is labelled "Total Program Element". We therefore
 *      track the CURRENT PE CONTEXT while walking the page markdown and attribute cost-table
 *      FY values to it.
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

// Detection is looser than validation so the quarantine path is reachable for OCR-mangled codes.
const CODE_CELL = /^([0-9]{6,}[A-Z0-9]*)/;
// PE context from headings: "PE 0601601A / Title", "PE 0601601A:", "PE 0601275A ...".
const PE_CONTEXT_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/;
// Cost tables carry these column labels.
const COST_TABLE_HINT = /cost\s*\(\$|prior years|cost to complete|total cost|total program element/i;
const FY_ANY = /(?:FY\s*)?20(\d{2})/i;
const TOTAL_HINT = /total/i;
const BASE_OR_OOC = /\b(base|oco|ooc|mandatory|discretionary|pl)\b/i;

/**
 * Map header column index -> FY, deduping multi-column FYs (Base/OOC/Total) by preferring
 * the "Total" column for each FY, else the first non-Base/OOC column. This yields ONE
 * request value per FY (the budget-year total), never a collision.
 */
function mapFyColumns(header: string[] | undefined, fallback: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!header) {
    // No header labels — attribute the fallback FYs to the trailing numeric columns in order.
    fallback.forEach((fy, i) => out.set(i, fy));
    return out;
  }
  // Collect candidate columns per FY, then pick the best one.
  const byFy = new Map<number, Array<{ idx: number; label: string }>>();
  header.forEach((h, i) => {
    const m = FY_ANY.exec(h.trim());
    if (!m) return;
    const fy = 2000 + Number(m[1]);
    const arr = byFy.get(fy) ?? [];
    arr.push({ idx: i, label: h.trim() });
    byFy.set(fy, arr);
  });
  for (const [fy, cands] of Array.from(byFy)) {
    // Prefer an explicit "Total" column; else the first column that is NOT a Base/OOC/PL split.
    const total = cands.find((c) => TOTAL_HINT.test(c.label));
    const plain = cands.find((c) => !BASE_OR_OOC.test(c.label));
    const chosen = total ?? plain ?? cands[0]!;
    out.set(chosen.idx, fy);
  }
  return out;
}

function isCostTable(table: ParsedTable): boolean {
  const hay = `${table.label ?? ''} ${(table.header ?? []).join(' ')}`;
  return COST_TABLE_HINT.test(hay);
}

export function extractRdte(input: RdteExtractInput): ExtractionResult {
  const lineKind = classifyLineKind(input.exhibit);
  const lineAssertions: LineAssertion[] = [];
  const yearValues: YearValueAssertion[] = [];
  const warnings: string[] = [];
  const seenLine = new Set<string>();

  for (const page of input.pages) {
    // Establish the PE context for this page from its headings (structure B).
    const ctx = PE_CONTEXT_RE.exec(page.markdown);
    const contextPe = ctx && isValidPeCode(ctx[1]!) ? ctx[1]! : null;

    for (const table of page.tables) {
      const unit = detectUnit(table.label ?? (table.header ?? []).join(' '));
      const fyCols = mapFyColumns(table.header, input.fyColumns);
      const costTable = isCostTable(table);

      for (const row of table.rows) {
        const first = (row[0] ?? '').trim();
        const codeMatch = CODE_CELL.exec(first);

        // ---- Structure A: PE code in the row's first cell (catalog / R-1 / ToC) ----
        if (codeMatch) {
          const code = codeMatch[1]!;
          if (!isValidPeCode(code)) {
            warnings.push(`quarantined invalid PE code "${code}" on pdf p.${page.pdfPage}`);
            continue;
          }
          const title = (row[1] ?? first.replace(code, '').trim()).trim();
          emitLine(code, title, page, table, first);
          emitFyValues(code, row, fyCols, unit, page, table, first);
          continue;
        }

        // ---- Structure B: cost-table funding row attributed to the PE context ----
        if (costTable && contextPe && /total program element|^total\b/i.test(first)) {
          emitLine(contextPe, `PE ${contextPe}`, page, table, first);
          emitFyValues(contextPe, row, fyCols, unit, page, table, first);
        }
      }
    }
  }

  function emitLine(code: string, title: string, page: ParsedPage, table: ParsedTable, rowLabel: string): void {
    const key = `${code}`;
    if (seenLine.has(key)) return; // one catalog line per PE per document (independent values still flow)
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
    fyCols: Map<number, number>,
    unit: Money['unit'],
    page: ParsedPage,
    table: ParsedTable,
    rowLabel: string,
  ): void {
    for (const [colIdx, fy] of Array.from(fyCols)) {
      const raw = row[colIdx];
      const val = parseMoneyToken(raw);
      if (val == null) continue;
      yearValues.push({
        lineKind,
        code,
        component: input.component ?? undefined,
        fy,
        fieldName: 'request',
        money: { value: val, unit },
        provenance: prov(page, table, rowLabel, `FY${fy}`),
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
