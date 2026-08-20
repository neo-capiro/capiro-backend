/**
 * Procurement (P-1/P-5/P-40) and O&M (O-1/OP-5) extractor.
 *
 * CRITICAL IDENTITY RULES (defense-budget-document-ingestion.md):
 *   - A procurement exhibit produces a PROCUREMENT_BLIN, NEVER a PE — even when a P-40
 *     narrative references PE codes. Those references are recorded as `referencedPeCodes`
 *     cross-refs on the BLIN line, not as new PE lines.
 *   - BLIN identity must include account + component + FY context so identical line
 *     numbers across accounts/years never collapse. Base-procurement vs advance-
 *     procurement lines for the same item stay DISTINCT.
 *   - O&M produces OM_SAG lines (budget activity / activity group / sub-activity group).
 *   - Quantities are integers; dollars are exact decimals with the printed unit.
 */
import {
  classifyLineKind,
  detectUnit,
  parseMoneyToken,
  type ExhibitType,
  type ExtractionResult,
  type LineAssertion,
  type LineKind,
  type ValueProvenance,
  type YearValueAssertion,
} from './types.js';
import type { ParsedPage, ParsedTable } from './rdte.extractor.types.js';
export type { ParsedPage, ParsedTable } from './rdte.extractor.types.js';

export interface ProcurementExtractInput {
  exhibit: Extract<ExhibitType, 'P-1' | 'P-5' | 'P-40' | 'O-1' | 'OP-5'>;
  /** e.g. "Aircraft Procurement, Army" or "O&M, Army" — part of BLIN/SAG identity. */
  account: string;
  component: string | null;
  pages: ParsedPage[];
}

const PE_REF_RE = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/g;
const FY_HEADER = /20(\d{2})/i;
// BLIN line numbers: 1-4 digits, optionally with a letter suffix; or a P-1 line item code.
const BLIN_CELL = /^([0-9]{1,4}[A-Z]?)\b/;
const ADVANCE_PROC_RE = /advance\s+procurement|\bAP\b|adv(?:ance)?\s+proc/i;

function mapFyColumns(header: string[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  header?.forEach((h, i) => {
    const m = FY_HEADER.exec(h.trim());
    if (m) out.set(i, 2000 + Number(m[1]));
  });
  return out;
}

function isQuantityColumn(label: string | undefined): boolean {
  if (!label) return false;
  return /qty|quantity|units/i.test(label);
}

export function extractProcurementOrOm(input: ProcurementExtractInput): ExtractionResult {
  const lineKind: LineKind = classifyLineKind(input.exhibit);
  const lineAssertions: LineAssertion[] = [];
  const yearValues: YearValueAssertion[] = [];
  const warnings: string[] = [];

  for (const page of input.pages) {
    for (const table of page.tables) {
      const unit = detectUnit(table.label);
      const fyCols = mapFyColumns(table.header);

      for (const row of table.rows) {
        const first = (row[0] ?? '').trim();
        const codeMatch = BLIN_CELL.exec(first);
        if (!codeMatch) continue;
        const rawCode = codeMatch[1]!;
        const title = (row[1] ?? '').trim() || first.replace(rawCode, '').trim();

        // Distinguish base vs advance procurement so they never collapse.
        const rowText = row.join(' ');
        const isAdvance = ADVANCE_PROC_RE.test(rowText);
        // Composite identity code: account-scoped, base/AP-tagged.
        const code = `${rawCode}${isAdvance ? '-AP' : ''}`;

        const prov = (colLabel: string): ValueProvenance => ({
          pdfPage: page.pdfPage,
          printedPage: page.printedPage,
          exhibit: input.exhibit,
          tableLabel: table.label,
          rowLabel: first,
          colLabel,
          derivation: 'direct',
          extractionMethod: 'llamaparse',
          confidence: 0.9,
        });

        // PE references in a P-40 are cross-refs, not PE lines.
        const referenced =
          lineKind === 'PROCUREMENT_BLIN' ? Array.from(new Set(rowText.match(PE_REF_RE) ?? [])) : [];

        lineAssertions.push({
          lineKind,
          code,
          title: title || '(untitled)',
          account: input.account,
          component: input.component ?? undefined,
          referencedPeCodes: referenced.length > 0 ? referenced : undefined,
          provenance: prov('title'),
        });

        for (const [colIdx, fy] of Array.from(fyCols)) {
          const raw = row[colIdx];
          const num = parseMoneyToken(raw);
          if (num == null) continue;
          const qtyCol = isQuantityColumn(table.header?.[colIdx]);
          yearValues.push({
            lineKind,
            code,
            account: input.account,
            component: input.component ?? undefined,
            fy,
            fieldName: qtyCol ? 'quantity' : 'request',
            ...(qtyCol ? { quantity: Math.trunc(num) } : { money: { value: num, unit } }),
            provenance: prov(`FY${fy}${qtyCol ? ' qty' : ''}`),
          });
        }
      }
    }
  }

  return { lineAssertions, yearValues, warnings };
}
