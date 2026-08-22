/**
 * Small RFC-4180-style CSV reader for bounded District Nexus imports.
 *
 * The API already caps files at 5 MB / 500 records, so a synchronous parser is
 * appropriate here. Keeping this local avoids adding an undeclared runtime
 * dependency to the API image. It supports UTF-8 BOMs, quoted commas/newlines,
 * escaped quotes and CRLF. Ragged rows are tolerated: missing cells become an
 * empty string and excess cells are ignored because they have no header.
 */
export function parseCsvRecords(input: Buffer | string): Array<Record<string, string>> {
  const source = (Buffer.isBuffer(input) ? input.toString('utf8') : input).replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    row.push(field.trim());
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((value) => value.length > 0)) rows.push(row);
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      if (source[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return [];

  const headers = rows[0]!.map((value) => value.trim());
  if (headers.every((header) => !header)) throw new Error('CSV header row is empty');

  return rows.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (!header) return;
      record[header] = values[column] ?? '';
    });
    return record;
  });
}
