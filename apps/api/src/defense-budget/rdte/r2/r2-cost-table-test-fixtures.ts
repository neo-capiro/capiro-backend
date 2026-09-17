/**
 * r2-cost-table-test-fixtures — shared synthetic-fixture builders for the
 * R-2 cost-table extractor specs in this directory
 * (r2-cost-table-extractor-v1.spec.ts, r2-continuing-and-prior-years-marker.spec.ts).
 *
 * Extracted so both specs build a `ParsedTableV1`/`ParserPageResultV1` the
 * same way instead of each maintaining its own copy that can silently drift
 * out of sync. Not a `.spec.ts` file itself -- it has no `describe`/`it`
 * blocks, so importing it never registers or re-runs another file's tests.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';

export type Cell = { rowIndex: number; columnIndex: number; text: string };

export function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return { tableIndex, rowCount, columnCount, cells, warnings: [] };
}

export function makePage(
  tables: ParsedTableV1[],
  page: number,
  text?: string,
  printedPage?: string,
): ParserPageResultV1 {
  return {
    page,
    ...(text != null ? { text } : {}),
    ...(printedPage != null ? { printedPage } : {}),
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}
