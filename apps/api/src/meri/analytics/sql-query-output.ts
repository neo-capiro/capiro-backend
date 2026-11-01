import type { PublishedRelation, SqlResultColumn, SqlResultRow } from './sql-reader-connection.js';
import { SQL_QUERY_LIMITS, SqlQueryError, type GatedSqlStatement } from './sql-statement-gate.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Both query owners supply their complete envelope so scope/coverage consume the same byte budget. */
export function packSqlRows(
  result: { rows: SqlResultRow[]; rowCount: number; byteTruncated: boolean },
  candidates: readonly SqlResultRow[],
  rowLimit: number,
  maxOutputBytes: number,
): void {
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
  if (bytes(result) > maxOutputBytes) throw new SqlQueryError('OUTPUT_LIMIT', 'Query metadata exceeds the output budget.');
}

/** The successful query envelope shared by the public and client-record sources (fields only ever added). */
export function queryEnvelope<Head extends Record<string, unknown>>(
  head: Head,
  gated: GatedSqlStatement,
  fetched: { columns: SqlResultColumn[]; rows: SqlResultRow[] },
  surface: readonly PublishedRelation[],
) {
  const rows: SqlResultRow[] = [];
  const result = {
    ...head,
    ok: true as const,
    columns: fetched.columns,
    rows,
    rowCount: 0,
    relationsUsed: gated.relationsUsed,
    rowLimitReached: fetched.rows.length > gated.rowLimit,
    byteTruncated: false,
    limits: { rowLimit: gated.rowLimit, maxOutputBytes: SQL_QUERY_LIMITS.maxOutputBytes },
    coverage: {
      basis: 'query_bounded' as const,
      sourceUniverseComplete: false as const,
      sqlLimit: gated.sqlLimit,
      relations: gated.relationsUsed.map((name) => ({
        name,
        sourceAsOf: null,
        sourceVersion: null,
        limitations: surface.find((relation) => relation.name === name)?.coverage.limitations ?? [],
      })),
    },
  };
  packSqlRows(result, fetched.rows.slice(0, gated.rowLimit), gated.rowLimit, SQL_QUERY_LIMITS.maxOutputBytes);
  if (result.byteTruncated && !result.rows.length && fetched.rows.length)
    throw new SqlQueryError('OUTPUT_LIMIT', 'One result row exceeds the output budget. Select fewer fields.');
  return result;
}

/** The describe envelope: the surface as the reader role sees it, optionally narrowed to named relations. */
export function describeEnvelope<Head extends Record<string, unknown>>(head: Head, input: unknown, surface: readonly PublishedRelation[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'relations'))
    throw new SqlQueryError('INVALID_QUERY', 'Use an optional list of published relation names.');
  const names = (input as { relations?: unknown }).relations;
  if (names !== undefined) {
    if (!Array.isArray(names) || !names.length || names.length > surface.length || new Set(names).size !== names.length || names.some((name) => typeof name !== 'string'))
      throw new SqlQueryError('UNKNOWN_RELATION', 'Use unique relation names published by describe_capiro_data.');
    const unknown = (names as string[]).find((name) => !surface.some((relation) => relation.name === name));
    if (unknown)
      throw new SqlQueryError('UNKNOWN_RELATION', `${unknown} is not a published relation.`, {
        candidates: surface.map((relation) => relation.name).filter((name) => name.includes(unknown) || unknown.includes(name)).slice(0, 3),
      });
  }
  const relations = surface.filter((relation) => names === undefined || (names as string[]).includes(relation.name));
  const result = { ...head, ok: true as const, relations, limits: SQL_QUERY_LIMITS };
  if (bytes(result) > SQL_QUERY_LIMITS.maxOutputBytes) throw new SqlQueryError('OUTPUT_LIMIT', 'Published metadata exceeds the output budget.');
  return result;
}
