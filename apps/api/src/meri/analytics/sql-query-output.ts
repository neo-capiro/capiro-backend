import type { PublicSqlColumn } from './public-sql-registry.js';
import { PublicSqlError } from './sql-query-compiler.js';

export type SqlResultRow = Record<string, string | boolean | null>;

/** Numeric cells were cast to text in PostgreSQL; never recover precision from JS numbers. */
export function normalizeSqlRow(
  row: Record<string, unknown>,
  columns: readonly PublicSqlColumn[],
): SqlResultRow {
  const out: SqlResultRow = {};
  if (Object.keys(row).length !== columns.length)
    throw new PublicSqlError('SOURCE_UNAVAILABLE', 'Unexpected public query result.');
  for (const column of columns) {
    const value = row[column.name];
    if (value === null && column.nullable) {
      out[column.name] = null;
      continue;
    }
    if (column.type === 'boolean' && typeof value === 'boolean') {
      out[column.name] = value;
      continue;
    }
    if (
      (column.type === 'date' || column.type === 'timestamp') &&
      value instanceof Date &&
      Number.isFinite(value.getTime())
    ) {
      out[column.name] =
        column.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
      continue;
    }
    if (
      typeof value === 'string' &&
      (column.type === 'string' ||
        (column.type === 'integer' && /^-?\d+$/.test(value)) ||
        (column.type === 'decimal' && /^-?\d+(?:\.\d+)?$/.test(value)))
    ) {
      out[column.name] = value;
      continue;
    }
    throw new PublicSqlError('SOURCE_UNAVAILABLE', 'Unexpected public query result type.');
  }
  return out;
}

/** Both query owners supply their complete envelope so scope/coverage consume the same byte budget. */
export function packSqlRows(
  result: { rows: SqlResultRow[]; rowCount: number; byteTruncated: boolean },
  candidates: readonly SqlResultRow[],
  rowLimit: number,
  maxOutputBytes: number,
): void {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  // Reserve the largest row-count spelling and false (one byte longer than true).
  let usedBytes = bytes({ ...result, rowCount: rowLimit });
  for (const row of candidates) {
    const rowBytes = bytes(row) + (result.rows.length ? 1 : 0);
    if (usedBytes + rowBytes > maxOutputBytes) {
      result.byteTruncated = true;
      break;
    }
    result.rows.push(row);
    usedBytes += rowBytes;
  }
  result.rowCount = result.rows.length;
  if (bytes(result) > maxOutputBytes)
    throw new PublicSqlError('OUTPUT_LIMIT', 'Query metadata exceeds the output budget.');
}
