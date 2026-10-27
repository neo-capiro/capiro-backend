import { PUBLIC_SQL_LIMITS } from './public-sql-registry.js';
import {
  compileScopedSql,
  PublicSqlError,
  type SqlCompilerRelation,
} from './sql-query-compiler.js';
import { packSqlRows, type SqlResultRow } from './sql-query-output.js';
import {
  capturePrivateSqlContext,
  PRIVATE_SQL_VIEW_NAMES,
  type PrivateSqlDbService,
  type PrivateSqlExecutionContext,
} from './private-sql-db.service.js';

/** Domain owner supplies these two reviewed projections; slice A does not invent their fields. */
export interface PrivateSqlRelation extends SqlCompilerRelation {
  readonly name: (typeof PRIVATE_SQL_VIEW_NAMES)[number];
  readonly schema: 'meri_private';
  readonly table: (typeof PRIVATE_SQL_VIEW_NAMES)[number];
  readonly predicate?: never;
  readonly description: string;
  readonly grain: string;
  readonly coverage: {
    readonly basis: 'authorized_client_records';
    readonly limitations: readonly string[];
  };
  readonly freshness: {
    readonly field: string | null;
    readonly sourceAsOf: null;
    readonly sourceVersion: null;
  };
}
type Db = Pick<PrivateSqlDbService, 'assertAvailable' | 'runPrivateSql'>;
const version = '0.2.0' as const;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z_][a-z0-9_]{0,62}$/.test(value) &&
  !value.startsWith('__capiro') &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

function captureRegistry(supplied: readonly PrivateSqlRelation[]): readonly PrivateSqlRelation[] {
  const invalid = () => {
    throw new TypeError('Invalid private projection registry');
  };
  let relations: PrivateSqlRelation[];
  try {
    relations = JSON.parse(JSON.stringify(supplied)) as PrivateSqlRelation[];
  } catch {
    return invalid();
  }
  if (
    !Array.isArray(relations) ||
    relations.length !== 2 ||
    new Set(relations.map((r) => r.name)).size !== 2
  )
    invalid();
  for (const r of relations) {
    if (
      !r ||
      !PRIVATE_SQL_VIEW_NAMES.includes(r.name) ||
      r.schema !== 'meri_private' ||
      r.table !== r.name ||
      Object.hasOwn(r, 'predicate') ||
      typeof r.description !== 'string' ||
      typeof r.grain !== 'string' ||
      !Array.isArray(r.fields) ||
      !r.fields.length ||
      new Set(r.fields.map((f) => f.name)).size !== r.fields.length ||
      r.fields.some(
        (f) =>
          !identifier(f.name) ||
          !['string', 'integer', 'decimal', 'boolean', 'date', 'timestamp'].includes(f.type) ||
          typeof f.nullable !== 'boolean' ||
          typeof f.description !== 'string' ||
          (f.unit !== undefined && typeof f.unit !== 'string') ||
          (f.parameterType !== undefined && (f.parameterType !== 'UUID' || f.type !== 'string')),
      )
    )
      invalid();
    const fields = new Set(r.fields.map((f) => f.name));
    if (
      !Array.isArray(r.primaryKey) ||
      !r.primaryKey.length ||
      r.primaryKey.some((f) => !fields.has(f)) ||
      !Array.isArray(r.relationships) ||
      r.relationships.some(
        (j) =>
          !Array.isArray(j.fields) ||
          !j.fields.length ||
          !Array.isArray(j.referencedFields) ||
          j.fields.length !== j.referencedFields.length ||
          j.fields.some((f: unknown) => typeof f !== 'string' || !fields.has(f)) ||
          !identifier(j.referencedRelation) ||
          j.referencedFields.some((f: unknown) => !identifier(f)) ||
          j.cardinality !== 'many_to_one' ||
          !['enforced', 'soft'].includes(j.integrity),
      ) ||
      r.coverage?.basis !== 'authorized_client_records' ||
      !Array.isArray(r.coverage.limitations) ||
      r.coverage.limitations.some((v) => typeof v !== 'string') ||
      !r.freshness ||
      (r.freshness.field !== null && !fields.has(r.freshness.field)) ||
      r.freshness.sourceAsOf !== null ||
      r.freshness.sourceVersion !== null
    )
      invalid();
  }
  return immutable(PRIVATE_SQL_VIEW_NAMES.map((name) => relations.find((r) => r.name === name)!));
}

function failure(error: unknown, generatedAt: string) {
  // Current-owner denial/cancellation is transport authority, never a successful empty SQL page.
  if (!(error instanceof PublicSqlError)) throw error;
  return {
    version,
    generatedAt,
    ok: false as const,
    error: { code: error.code, message: error.message },
  };
}

/** One immutable server composition. There is no append/register operation or request-selected connection. */
export function createPrivateSqlQueries(descriptors: readonly PrivateSqlRelation[], db: Db) {
  const registry = captureRegistry(descriptors);
  return Object.freeze({
    async describe(input: unknown, supplied: PrivateSqlExecutionContext) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some((k) => k !== 'relations')
        )
          throw new PublicSqlError(
            'INVALID_QUERY',
            'Use an optional list of published relation names.',
          );
        const names = (input as { relations?: unknown }).relations;
        if (
          names !== undefined &&
          (!Array.isArray(names) ||
            !names.length ||
            names.length > 2 ||
            new Set(names).size !== names.length ||
            names.some((name) => !registry.some((r) => r.name === name)))
        )
          throw new PublicSqlError(
            'UNKNOWN_RELATION',
            'Use unique relation names published by describe_capiro_data.',
          );
        await db.assertAvailable(context);
        const relations = registry
          .filter((r) => names === undefined || (names as string[]).includes(r.name))
          .map(({ schema: _schema, table: _table, ...published }) => ({
            ...published,
            fields: published.fields.map(({ parameterType: _parameterType, ...field }) => field),
          }));
        const result = {
          version,
          generatedAt,
          ok: true as const,
          scope: { kind: 'client_records' as const, clientId: context.clientId },
          relations,
          limits: PUBLIC_SQL_LIMITS,
        };
        if (bytes(result) > PUBLIC_SQL_LIMITS.maxOutputBytes)
          throw new PublicSqlError('OUTPUT_LIMIT', 'Private metadata exceeds the output budget.');
        return result;
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
    async query(input: unknown, supplied: PrivateSqlExecutionContext) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        const compiled = compileScopedSql(input, registry),
          fetched = await db.runPrivateSql(compiled, context);
        const rows: SqlResultRow[] = [];
        const result = {
          version,
          generatedAt,
          ok: true as const,
          scope: { kind: 'client_records' as const, clientId: context.clientId },
          columns: compiled.columns,
          rows,
          rowCount: 0,
          relationsUsed: compiled.relationsUsed,
          rowLimitReached: fetched.length > compiled.rowLimit,
          byteTruncated: false,
          limits: { rowLimit: compiled.rowLimit, maxOutputBytes: PUBLIC_SQL_LIMITS.maxOutputBytes },
          coverage: {
            basis: 'query_bounded' as const,
            sourceUniverseComplete: false as const,
            sqlLimit: compiled.sqlLimit,
            relations: compiled.relationsUsed.map((name) => ({
              name,
              sourceAsOf: null,
              sourceVersion: null,
              limitations: registry.find((r) => r.name === name)!.coverage.limitations,
            })),
          },
        };
        packSqlRows(
          result,
          fetched.slice(0, compiled.rowLimit),
          compiled.rowLimit,
          PUBLIC_SQL_LIMITS.maxOutputBytes,
        );
        if (result.byteTruncated && !result.rows.length && fetched.length)
          throw new PublicSqlError(
            'OUTPUT_LIMIT',
            'One result row exceeds the output budget. Select fewer fields.',
          );
        return result;
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
  });
}
