// Plain-text extraction for .xlsx workbooks (client-profile documents used as
// outreach/AI context). Uses exceljs (already a dependency). Legacy binary .xls
// (BIFF) is NOT supported by exceljs; CSV is handled by the plain-text path.

export function isSpreadsheetAttachment(fileName: string, contentType: string): boolean {
  return (
    /\.xlsx$/i.test(fileName) ||
    contentType.toLowerCase() ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

/** exceljs cell value → text (handles formula results, hyperlinks, rich text, dates). */
export function xlsxCellToText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
    }
    if ('result' in o) return xlsxCellToText(o.result); // formula → computed result
    if (typeof o.text === 'string') return o.text; // hyperlink
  }
  return '';
}

/**
 * Plain-text rendering of an .xlsx workbook (every sheet, tab-joined rows).
 * Bounded per sheet + overall so a huge sheet can't blow memory or the
 * response. exceljs is lazy-loaded — it's heavy at import time.
 */
export async function extractXlsxText(buffer: Buffer): Promise<string> {
  const ExcelJS = await import('exceljs');
  const wb = new (ExcelJS.default ?? ExcelJS).Workbook();
  // @types/node's generic Buffer<ArrayBufferLike> isn't assignable to exceljs's
  // stricter load() param; cast to exactly the type xlsx.load declares.
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const MAX_ROWS_PER_SHEET = 5000;
  const parts: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS_PER_SHEET) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(xlsxCellToText(cell.value)));
      if (cells.some((c) => c.trim())) rows.push(cells.join('\t'));
    });
    if (rows.length) parts.push(`# ${sheet.name}\n${rows.join('\n')}`);
  });
  return parts.join('\n\n').slice(0, 200_000).trim();
}
