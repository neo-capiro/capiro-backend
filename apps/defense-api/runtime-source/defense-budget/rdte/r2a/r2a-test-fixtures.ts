/**
 * r2a-test-fixtures — shared synthetic-fixture builders for the R-2A specs
 * in this directory (r2a-pe-exhibit-boundary-regression.spec.ts,
 * r2a-suppressed-project-footnote-self-match.spec.ts).
 *
 * Extracted so both specs build a `LayoutBlockV1`/cost-table `ParsedTableV1`
 * the same way instead of each maintaining its own copy that can silently
 * drift out of sync. Not a `.spec.ts` file itself -- it has no
 * `describe`/`it` blocks, so importing it never registers or re-runs
 * another file's tests.
 */
import type { LayoutBlockV1 } from '../../parser-router/parser-runtime-contract-v1.js';

export function makeBlock(
  blockIndex: number,
  blockType: LayoutBlockV1['blockType'],
  text: string,
): LayoutBlockV1 {
  return { blockIndex, blockType, text };
}

/** The real R-2/R-2A cost-table header row, confirmed against the FY2024
 * Army RDT&E Vol 1 BA2 document. */
export const COST_HEADER = [
  'COST ($ in Millions)',
  'Prior\nYears',
  'FY 2022',
  'FY 2023',
  'FY 2024\nBase',
  'FY 2024\nOCO',
  'FY 2024\nTotal',
  'FY 2025',
  'FY 2026',
  'FY 2027',
  'FY 2028',
  'Cost To\nComplete',
  'Total\nCost',
];
