import type { AnalyticsDbService } from './analytics-db.service.js';
import { PUBLIC_SQL_LIMITS, PUBLIC_SQL_RELATIONS, publicSqlRelation } from './public-sql-registry.js';
import { compilePublicSql, PublicSqlError } from './sql-query-compiler.js';

const version = '0.1.0' as const;
function failure(error: unknown, generatedAt: string) {
  const known = error instanceof PublicSqlError ? error : new PublicSqlError('SOURCE_UNAVAILABLE', 'Public data is currently unavailable.');
  return { version, generatedAt, ok: false as const, error: { code: known.code, message: known.message } };
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

export function describeCapiroData(input: unknown) {
  const generatedAt = new Date().toISOString();
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'relations'))
      throw new PublicSqlError('INVALID_QUERY', 'Use an optional list of published relation names.');
    const names = (input as { relations?: unknown }).relations;
    if (names !== undefined && (!Array.isArray(names) || !names.length || names.length > 8 ||
      new Set(names).size !== names.length || names.some((name) => typeof name !== 'string' || !publicSqlRelation(name))))
      throw new PublicSqlError('UNKNOWN_RELATION', 'Use unique relation names published by describe_capiro_data.');
    const relations = PUBLIC_SQL_RELATIONS.filter((r) => names === undefined || (names as string[]).includes(r.name))
      .map(({ table: _table, predicate: _predicate, ...published }) => ({ ...published,
        fields: published.fields.map(({ parameterType: _parameterType, ...field }) => field) }));
    const result = { version, generatedAt, ok: true as const, relations, limits: PUBLIC_SQL_LIMITS };
    if (bytes(result) > PUBLIC_SQL_LIMITS.maxOutputBytes) throw new PublicSqlError('OUTPUT_LIMIT', 'Public metadata exceeds the output budget.');
    return result;
  } catch (error) { return failure(error, generatedAt); }
}

/** Thin native-tool seam; execution remains inside the dedicated analytics DB owner. */
export async function queryCapiroData(input: unknown, db: Pick<AnalyticsDbService, 'runPublicSql'>) {
  const generatedAt = new Date().toISOString();
  try {
    const compiled = compilePublicSql(input);
    const fetched = await db.runPublicSql(compiled);
    const rowLimitReached = fetched.length > compiled.rowLimit;
    const candidates = fetched.slice(0, compiled.rowLimit);
    const rows: typeof fetched = [];
    const result = { version, generatedAt, ok: true as const, columns: compiled.columns, rows,
      rowCount: rows.length, relationsUsed: compiled.relationsUsed, rowLimitReached, byteTruncated: false,
      limits: { rowLimit: compiled.rowLimit, maxOutputBytes: PUBLIC_SQL_LIMITS.maxOutputBytes },
      coverage: { basis: 'query_bounded' as const, sourceUniverseComplete: false as const, sqlLimit: compiled.sqlLimit,
        relations: compiled.relationsUsed.map((name) => ({ name, sourceAsOf: null, sourceVersion: null,
          limitations: publicSqlRelation(name)!.coverage.limitations })) } };
    // Reserve the largest row-count spelling and false (one byte longer than true).
    // Each row is encoded once, never repeatedly stringify a large shrinking result.
    const envelopeBytes = bytes({ ...result, rowCount: compiled.rowLimit });
    let usedBytes = envelopeBytes;
    for (const row of candidates) {
      const rowBytes = bytes(row) + (rows.length ? 1 : 0);
      if (usedBytes + rowBytes > PUBLIC_SQL_LIMITS.maxOutputBytes) { result.byteTruncated = true; break; }
      rows.push(row); usedBytes += rowBytes;
    }
    result.rowCount = rows.length;
    if (bytes(result) > PUBLIC_SQL_LIMITS.maxOutputBytes) throw new PublicSqlError('OUTPUT_LIMIT', 'Query metadata exceeds the output budget.');
    return result;
  } catch (error) { return failure(error, generatedAt); }
}
