/**
 * r1-table-detector — detect R-1 PE tables and PE rows inside Phase 3
 * normalized page results.
 *
 * Pure module. Consumes parser outputs; never invokes a parser.
 */
import type {
  ParsedTableV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import type { R1RowContextV1 } from './r1-text-row-reconstructor-v1.js';

export interface R1DetectedRow {
  page: number;
  printedPage?: string;
  tableIndex: number;
  rowIndex: number;
  peCode: string;
  title: string;
  cells: Array<{ columnIndex: number; text: string }>;
  /**
   * Optional row-level context (budget activity, section heading,
   * component, ...) supplied by a text-reconstruction caller (see
   * `R1RowContextV1`). Absent for structural-table pages, where no such
   * side channel exists today -- behavior for those pages is unchanged.
   */
  rowContext?: R1RowContextV1;
}

export interface R1DetectedTable {
  page: number;
  printedPage?: string;
  tableIndex: number;
  headerRowIndices: number[];
  peRows: R1DetectedRow[];
  /** Rows that look like repeated headers (metadata, not PE rows). */
  repeatedHeaderRowIndices: number[];
  /** Rows with unresolved column alignment. */
  unresolvedRowIndices: number[];
}

const PE_CODE_CELL_RE = /^[0-9]{7}[A-Z][A-Z0-9]*$/;
const HEADER_HINT_RE =
  /\b(pe|program\s*element|title|fy|fiscal|year|budget|request|actual|enacted|base|oco|total|cost)\b/i;

/**
 * Detect R-1 tables on one page.
 *
 * A table is an R-1 candidate when it has at least one row whose first
 * cell matches the PE code pattern AND at least one header row containing
 * fiscal/title vocabulary.
 */
export function detectR1TablesOnPage(
  page: ParserPageResultV1,
  rowContextByRowIndex?: ReadonlyMap<number, R1RowContextV1>,
): R1DetectedTable[] {
  const detected: R1DetectedTable[] = [];

  for (const table of page.tables) {
    const tableResult = analyzeR1Table(
      page.page,
      page.printedPage ?? undefined,
      table,
      rowContextByRowIndex,
    );
    if (tableResult != null) {
      detected.push(tableResult);
    }
  }

  return detected;
}

function analyzeR1Table(
  page: number,
  printedPage: string | undefined,
  table: ParsedTableV1,
  rowContextByRowIndex?: ReadonlyMap<number, R1RowContextV1>,
): R1DetectedTable | null {
  const rows = groupCellsByRow(table);
  const headerRowIndices: number[] = [];
  const repeatedHeaderRowIndices: number[] = [];
  const peRows: R1DetectedRow[] = [];
  const unresolvedRowIndices: number[] = [];

  let headerSeen = false;
  for (const [rowIndex, cells] of rows) {
    const firstText = cells[0]?.text.trim() ?? '';
    const rowText = cells.map((c) => c.text).join(' ');

    /* PE row: first cell is a valid PE code. */
    if (PE_CODE_CELL_RE.test(firstText) && isValidPeCode(firstText)) {
      const title = cells[1]?.text.trim() ?? '';
      const rowContext = rowContextByRowIndex?.get(rowIndex);
      peRows.push({
        page,
        printedPage,
        tableIndex: table.tableIndex,
        rowIndex,
        peCode: firstText,
        title,
        cells: cells.map((c) => ({ columnIndex: c.columnIndex, text: c.text })),
        ...(rowContext != null ? { rowContext } : {}),
      });
      continue;
    }

    /* Header row: contains fiscal/title vocabulary and no PE code. */
    if (HEADER_HINT_RE.test(rowText) && !PE_CODE_CELL_RE.test(firstText)) {
      if (!headerSeen) {
        headerRowIndices.push(rowIndex);
        headerSeen = true;
      } else {
        repeatedHeaderRowIndices.push(rowIndex);
      }
      continue;
    }

    /* Rows with content but no PE code and not a header: unresolved. */
    if (cells.length > 0 && rowText.trim().length > 0) {
      unresolvedRowIndices.push(rowIndex);
    }
  }

  if (peRows.length === 0 && headerRowIndices.length === 0) {
    return null;
  }

  return {
    page,
    printedPage,
    tableIndex: table.tableIndex,
    headerRowIndices,
    peRows,
    repeatedHeaderRowIndices,
    unresolvedRowIndices,
  };
}

function groupCellsByRow(
  table: ParsedTableV1,
): Array<[number, Array<{ columnIndex: number; text: string }>]> {
  const byRow = new Map<number, Array<{ columnIndex: number; text: string }>>();
  for (const cell of table.cells) {
    const existing = byRow.get(cell.rowIndex) ?? [];
    existing.push({ columnIndex: cell.columnIndex, text: cell.text });
    byRow.set(cell.rowIndex, existing);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rowIndex, cells]) => [rowIndex, cells.sort((a, b) => a.columnIndex - b.columnIndex)]);
}
