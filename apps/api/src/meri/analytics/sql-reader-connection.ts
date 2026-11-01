import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { nearestNames, SqlQueryError, type GatedSqlStatement } from './sql-statement-gate.js';

/**
 * Shared transport for the two isolated reader roles behind query_capiro_data.
 *
 * Everything here is fixed server configuration: the reader identity, the
 * read-only transaction, search_path, timeouts and the transaction-local
 * context. The model's statement is the only variable input and it is sent
 * verbatim (inside the gate's LIMIT wrapper) over the extended protocol, so
 * PostgreSQL decides what the role may read and reports its own errors.
 */
export interface ReaderConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
}

const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;

/** Composes a reader connection from its own discrete env vars; never from DATABASE_URL or another role's credentials. */
export function readerConfigFromEnv(prefix: string, expectedUser: string, tool: string): ReaderConnectionConfig {
  const env = process.env;
  const keys = ['HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'].map((key) => `${prefix}_${key}`);
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0)
    throw new Error(`${tool} requires ${missing.join(', ')}; this path never falls back to DATABASE_URL or any other credential.`);
  const [host, port, user, password, database] = keys.map((key) => env[key] as string);
  if (password === '***') throw new Error(`Refusing to build ${prefix}_PASSWORD from a masked placeholder.`);
  const sslmode = env[`${prefix}_SSLMODE`] ?? 'require';
  if (
    /[\s/?#@]/.test(host!) ||
    !/^\d+$/.test(port!) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    user !== expectedUser ||
    !/^[a-zA-Z0-9_-]+$/.test(database!) ||
    !(SSL_MODES as readonly string[]).includes(sslmode)
  )
    throw new Error(`${tool} reader connection must use ${expectedUser} with a plain host, numeric port, simple database name and a known ${prefix}_SSLMODE.`);
  return { host: host!, port: Number(port), user: user!, password: password!, database: database!, sslmode: sslmode as ReaderConnectionConfig['sslmode'] };
}

/** Prisma-style URL for the same connection, used only by the legacy QuerySpec path. */
export function readerUrl(config: ReaderConnectionConfig, schema: string): string {
  return `postgresql://${config.user}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}?schema=${schema}&sslmode=${config.sslmode}&connection_limit=3`;
}

/** Every value arrives as PostgreSQL text so exact numerics and microsecond timestamps survive; booleans become booleans. */
const textTypes = {
  getTypeParser: (oid: number) => (oid === 16 ? (value: string) => value === 't' : (value: string) => value),
};

export function createReaderPool(config: ReaderConnectionConfig): Pool {
  const ssl: PoolConfig['ssl'] =
    config.sslmode === 'disable' ? false : { rejectUnauthorized: config.sslmode === 'verify-ca' || config.sslmode === 'verify-full' };
  return new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    types: textTypes as PoolConfig['types'],
    application_name: 'meri_query_capiro_data',
  });
}

export interface ReadTransactionSettings {
  /** The only role this transport may run as; checked on the server, not only in configuration. */
  role: string;
  searchPath: string;
  statementTimeoutMs: number;
  /** Fixed transaction-local context set before the first query (client-record scope). */
  context?: { bypassRlsOff: true; settings: Record<string, string> };
}

const unavailable = () => new SqlQueryError('SOURCE_UNAVAILABLE', 'Data is currently unavailable.');

/**
 * Runs `work` inside one READ ONLY transaction with fixed session settings. The
 * admission row proves the connection really is the isolated reader; the grant
 * surface itself is the database's and is proven by the integration spec.
 */
export async function withReadOnlyTransaction<T>(
  pool: Pool,
  settings: ReadTransactionSettings,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw unavailable();
  }
  let broken = false;
  try {
    await client.query('BEGIN READ ONLY');
    // search_path and timeouts are server settings; identifiers are fixed constants, never request data.
    await client.query(`SET LOCAL search_path = ${quoteIdentifier(settings.searchPath)}`);
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(settings.statementTimeoutMs))}ms'`);
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
    await client.query("SET LOCAL timezone = 'UTC'");
    if (settings.context) {
      await client.query("SET LOCAL app.bypass_rls = 'off'");
      const entries = Object.entries(settings.context.settings);
      await client.query(
        `SELECT ${entries.map((_, i) => `pg_catalog.set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(', ')}`,
        entries.flat(),
      );
    }
    const admission = await client.query<{ allowed: boolean }>(
      `SELECT (
        current_user = $1 AND session_user = $1
        AND pg_catalog.current_setting('transaction_read_only') = 'on'
        AND ($2::boolean = false OR pg_catalog.current_setting('app.bypass_rls', true) = 'off')
        AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
      ) AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
      [settings.role, Boolean(settings.context)],
    );
    if (admission.rows.length !== 1 || admission.rows[0]?.allowed !== true) throw unavailable();
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    broken = isConnectionFailure(error);
    if (!broken) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release(broken ? new Error('reader connection discarded') : undefined);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Driver/server failures after which the pooled connection must not be reused. Gate and admission refusals leave it healthy. */
function isConnectionFailure(error: unknown): boolean {
  if (error instanceof SqlQueryError) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (/^(08|57P|XX)/.test(code) || /^E[A-Z]+$/.test(code));
}

export type SqlColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp';
export type SqlResultRow = Record<string, string | boolean | null>;
export interface SqlResultColumn {
  name: string;
  type: SqlColumnType;
  /** PostgreSQL type name as the catalog reports it. */
  pgType: string;
  /** Unknown for computed output; published relation columns carry their declared nullability in describe. */
  nullable: boolean;
}

function classify(typname: string): SqlColumnType {
  switch (typname) {
    case 'int2':
    case 'int4':
    case 'int8':
    case 'oid':
      return 'integer';
    case 'numeric':
    case 'float4':
    case 'float8':
    case 'money':
      return 'decimal';
    case 'bool':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
    case 'timestamptz':
      return 'timestamp';
    default:
      return 'string';
  }
}

/** Executes the gated statement and returns text rows with catalog-typed columns. Duplicate output names are suffixed. */
export async function executeGatedStatement(
  client: PoolClient,
  gated: GatedSqlStatement,
): Promise<{ columns: SqlResultColumn[]; rows: SqlResultRow[] }> {
  const result = await client.query<unknown[]>({ text: gated.sql, values: gated.params, rowMode: 'array' });
  const oids = [...new Set(result.fields.map((field) => field.dataTypeID))];
  const types = new Map<number, string>();
  if (oids.length) {
    const named = await client.query<{ oid: string; typname: string }>(
      'SELECT t.oid::text AS oid, t.typname FROM pg_catalog.pg_type t WHERE t.oid = ANY($1::oid[])',
      [oids],
    );
    for (const row of named.rows) types.set(Number(row.oid), row.typname);
  }
  const seen = new Map<string, number>();
  const columns: SqlResultColumn[] = result.fields.map((field) => {
    const count = (seen.get(field.name) ?? 0) + 1;
    seen.set(field.name, count);
    const typname = types.get(field.dataTypeID) ?? `oid:${field.dataTypeID}`;
    return { name: count === 1 ? field.name : `${field.name}_${count}`, type: classify(typname), pgType: typname, nullable: true };
  });
  const rows = result.rows.map((values) => {
    const row: SqlResultRow = {};
    columns.forEach((column, i) => {
      const value = values[i];
      row[column.name] = value === null || value === undefined ? null : typeof value === 'boolean' ? value : String(value);
    });
    return row;
  });
  return { columns, rows };
}

export interface PublishedColumn {
  name: string;
  type: SqlColumnType;
  pgType: string;
  nullable: boolean;
  description: string;
  unit?: string;
  enum?: string[];
}
export interface PublishedRelationship {
  fields: string[];
  referencedRelation: string;
  referencedFields: string[];
  cardinality: 'many_to_one';
  integrity: 'enforced' | 'soft';
}
export interface PublishedRelation {
  name: string;
  description: string;
  grain: string;
  fields: PublishedColumn[];
  primaryKey: string[];
  relationships: PublishedRelationship[];
  coverage: { basis: string; limitations: string[] };
  freshness: { field: string | null; sourceAsOf: null; sourceVersion: null };
}

function metadata(comment: string | null): Record<string, unknown> {
  if (!comment) return {};
  if (comment.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(comment);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* plain text comment */
    }
  }
  return { description: comment };
}
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/**
 * Reads the published surface as the reader role sees it: relations it may
 * SELECT in the source schema, their catalog types and the JSON metadata the
 * migration stored as view/column comments.
 */
export async function readPublishedSurface(
  client: PoolClient,
  schema: string,
  basis: string,
  order: readonly string[],
): Promise<PublishedRelation[]> {
  const result = await client.query<{
    relation: string;
    relation_comment: string | null;
    column_name: string;
    column_type: string;
    typname: string;
    column_comment: string | null;
  }>(
    `SELECT c.relname AS relation, pg_catalog.obj_description(c.oid, 'pg_class') AS relation_comment,
      a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type, t.typname,
      pg_catalog.col_description(c.oid, a.attnum) AS column_comment
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = $1 AND c.relkind IN ('v', 'r', 'p', 'm')
      AND pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
    ORDER BY c.relname, a.attnum`,
    [schema],
  );
  const relations = new Map<string, PublishedRelation>();
  for (const row of result.rows) {
    let relation = relations.get(row.relation);
    if (!relation) {
      const meta = metadata(row.relation_comment);
      relation = {
        name: row.relation,
        description: text(meta.description),
        grain: text(meta.grain),
        fields: [],
        primaryKey: strings(meta.primaryKey),
        relationships: (Array.isArray(meta.relationships) ? meta.relationships : [])
          .filter((link): link is Record<string, unknown> => !!link && typeof link === 'object')
          .map((link) => ({
            fields: strings(link.fields),
            referencedRelation: text(link.referencedRelation),
            referencedFields: strings(link.referencedFields),
            cardinality: 'many_to_one' as const,
            integrity: link.integrity === 'soft' ? ('soft' as const) : ('enforced' as const),
          })),
        coverage: { basis, limitations: strings(meta.limitations) },
        freshness: { field: typeof meta.freshnessField === 'string' ? meta.freshnessField : null, sourceAsOf: null, sourceVersion: null },
      };
      relations.set(row.relation, relation);
    }
    const meta = metadata(row.column_comment);
    const column: PublishedColumn = {
      name: row.column_name,
      type: classify(row.typname),
      pgType: row.column_type,
      nullable: meta.nullable !== false,
      description: text(meta.description),
    };
    if (typeof meta.unit === 'string') column.unit = meta.unit;
    if (Array.isArray(meta.enum) && meta.enum.length) column.enum = strings(meta.enum);
    relation.fields.push(column);
  }
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index < 0 ? order.length : index;
  };
  return [...relations.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** Maps a driver failure to the refusal envelope: PostgreSQL's own diagnostics for the model's mistakes, fixed text otherwise. */
export function translateDatabaseError(
  error: unknown,
  gated: Pick<GatedSqlStatement, 'prefixLength'> | null,
  surface: readonly PublishedRelation[],
): SqlQueryError {
  if (error instanceof SqlQueryError) return error;
  const failure = error as { code?: unknown; message?: unknown; position?: unknown; hint?: unknown } | null;
  const sqlstate = typeof failure?.code === 'string' && /^[0-9A-Z]{5}$/.test(failure.code) ? failure.code : null;
  if (!sqlstate) return unavailable();
  const message = typeof failure?.message === 'string' ? failure.message : 'Query failed.';
  const detail: { sqlstate: string; position?: number; hint?: string; candidates?: string[] } = { sqlstate };
  const reported = Number(failure?.position);
  if (gated && Number.isInteger(reported) && reported > gated.prefixLength) detail.position = reported - gated.prefixLength;
  if (typeof failure?.hint === 'string' && failure.hint) detail.hint = failure.hint;
  if (sqlstate === '57014' || sqlstate === '55P03')
    return new SqlQueryError('QUERY_TIMEOUT', 'The query exceeded its execution time limit. Narrow the query.', detail);
  if (['42P01', '3F000', '42501'].includes(sqlstate)) {
    // PostgreSQL's own text would confirm whether an unpublished table or schema exists ("permission denied for table
    // clients"). The model only needs to know that the name it wrote is not published here; the SQLSTATE still travels.
    const named = /(?:relation|table|view|schema) "?([A-Za-z0-9_.]+)"?/.exec(message)?.[1]?.split('.').pop();
    const published = named !== undefined && surface.some((relation) => relation.name === named);
    const candidates = named && !published ? nearestNames(named, surface.map((relation) => relation.name)) : [];
    if (candidates.length) detail.candidates = candidates;
    const text = published
      ? `Only a read-only SELECT is permitted on ${named}; locking and write clauses are refused.`
      : named
        ? `${named} is not published in this source; use only the relations describe_capiro_data lists.`
        : 'The statement named a relation or schema that is not published in this source; use only the relations describe_capiro_data lists.';
    return new SqlQueryError('UNKNOWN_RELATION', text, detail);
  }
  if (sqlstate === '42703') {
    const named = /column "?([A-Za-z0-9_.]+)"? does not exist/.exec(message)?.[1]?.split('.').pop();
    const columns = [...new Set(surface.flatMap((relation) => relation.fields.map((field) => field.name)))];
    const candidates = named ? nearestNames(named, columns) : [];
    if (candidates.length) detail.candidates = candidates;
    return new SqlQueryError('UNKNOWN_FIELD', message, detail);
  }
  if (/^(53|08|57|58|XX|F0|HV|3B|40)/.test(sqlstate)) return new SqlQueryError('SOURCE_UNAVAILABLE', 'Data is currently unavailable.', { sqlstate });
  return new SqlQueryError('INVALID_QUERY', message, detail);
}
