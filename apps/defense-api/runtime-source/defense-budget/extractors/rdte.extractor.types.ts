/**
 * Normalized parsed-page/table shapes shared by the LlamaParse adapter and the extractors.
 * Kept in its own module to avoid circular imports between the adapter and the extractors.
 */
export interface ParsedTable {
  label?: string;
  header?: string[];
  /** Body rows as string cells (header separated out into `header`). */
  rows: string[][];
}

export interface ParsedPage {
  /** 1-based physical PDF page. */
  pdfPage: number;
  printedPage?: string;
  /** Markdown for the page (heading/PE-context detection, narrative capture). */
  markdown: string;
  tables: ParsedTable[];
}
