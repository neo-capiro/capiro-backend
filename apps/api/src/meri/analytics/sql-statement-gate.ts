import { Parser } from 'node-sql-parser';

/**
 * The statement gate for Meri's query_capiro_data.
 *
 * PostgreSQL enforces everything the reader roles' grants, security-barrier
 * views, RLS context and transaction settings can enforce: writes, DDL, other
 * schemas and catalogs, unpublished relations and columns, cross-tenant rows,
 * statement time, lock waits, idle transactions, search_path and role
 * switching (see capiro-data-reader-roles.integration.spec.ts). This gate only
 * implements what the database cannot decide for a single pass-through
 * statement, plus the product rules that stay:
 *
 *   (b) exactly one statement; SELECT or WITH ... SELECT only (no transaction
 *       control, SET, SHOW, COPY, LISTEN, EXPLAIN, no data-modifying CTE or
 *       SELECT INTO); no administrative functions a read-only role can still
 *       call (set_config, pg_sleep, pg_terminate_backend, advisory locks,
 *       ...); contiguous $1..$n parameters that match the bound values; the
 *       row limit applied as an outer `SELECT * FROM (<sql>) q LIMIT $n`
 *       wrapper; byte caps on input.
 *   (c) public and client-record relations are never mixed in one query.
 *
 * The model's SQL text is passed through verbatim inside the wrapper; nothing
 * is regenerated. node-sql-parser confirms statement type and reads the
 * model's own LIMIT for coverage when it can parse the statement; the lexical
 * scan below is the rule, so PostgreSQL syntax the parser does not know still
 * runs and PostgreSQL reports its own errors with positions.
 */
export type SqlQueryErrorCode =
  | 'INVALID_QUERY'
  | 'UNSUPPORTED_SQL'
  | 'UNKNOWN_RELATION'
  | 'UNKNOWN_FIELD'
  | 'PARAMETER_MISMATCH'
  | 'SOURCE_UNAVAILABLE'
  | 'QUERY_TIMEOUT'
  | 'OUTPUT_LIMIT';

/** PostgreSQL's own diagnostics travel in the refusal envelope; the gate's own refusals carry only code/message. */
export interface SqlQueryErrorDetail {
  /** 1-based character offset into the model's SQL, when PostgreSQL reported one. */
  position?: number;
  hint?: string;
  sqlstate?: string;
  /** Nearest published relation/column names, when cheap to compute. */
  candidates?: string[];
}
export class SqlQueryError extends Error {
  readonly detail: SqlQueryErrorDetail;
  constructor(readonly code: SqlQueryErrorCode, message: string, detail: SqlQueryErrorDetail = {}) {
    super(message);
    this.detail = detail;
  }
  toEnvelope() {
    return { code: this.code, message: this.message, ...this.detail };
  }
}

export type SqlParameter = string | number | boolean | null;
export type SqlSource = 'public' | 'client_records' | 'research_portfolio' | 'classic_outreach';

export const SQL_QUERY_LIMITS = Object.freeze({
  defaultRowLimit: 200,
  maxRowLimit: 1000,
  maxOutputBytes: 262144,
  maxSqlBytes: 16384,
  maxParameters: 64,
  maxParameterBytes: 32768,
});

/** Published relation names per source: the vocabulary of the source-mixing rule, not an access list.
 * capiro-data-reader-roles.integration.spec.ts asserts they equal the reader roles' actual surface. */
export const PUBLIC_RELATION_NAMES = Object.freeze([
  'congress_bills',
  'congress_bill_subjects',
  'congress_bill_cosponsors',
  'congress_members',
  'program_elements',
  'program_element_projects',
  'program_element_budget_positions',
  'program_element_project_budget_positions',
] as const);
export const PRIVATE_RELATION_NAMES = Object.freeze([
  'client_objectives',
  'client_activity',
  'client_team_roster',
  'client_account_owners',
  'client_targets',
  'client_profiles',
  'client_profile_codes',
  'client_people',
  'client_contacts',
  'client_engagement_tasks',
  'client_action_items',
  'client_tracked_bills',
  'client_outreach_campaigns',
  'client_campaign_recipients',
  'client_meetings',
] as const);
export const RESEARCH_RELATION_NAMES = Object.freeze(['research_portfolios', 'research_portfolio_members'] as const);
export const CLASSIC_RELATION_NAMES = Object.freeze(['classic_outreach_records'] as const);
export const SOURCE_RELATIONS: Readonly<Record<SqlSource, readonly string[]>> = Object.freeze({
  public: PUBLIC_RELATION_NAMES, client_records: PRIVATE_RELATION_NAMES,
  research_portfolio: RESEARCH_RELATION_NAMES, classic_outreach: CLASSIC_RELATION_NAMES,
});
export const SOURCE_SCHEMAS: Readonly<Record<SqlSource, string>> = Object.freeze({
  public: 'meri_public',
  client_records: 'meri_private',
  research_portfolio: 'meri_private',
  classic_outreach: 'meri_private',
});

/** Statement keywords that can only start a data-modifying statement or a SELECT INTO. */
const BLOCKED_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge', 'into']);
/** Functions a read-only role can still call whose effect is outside the result set. */
const BLOCKED_FUNCTIONS = new Set([
  'set_config',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_advisory_lock',
  'pg_advisory_lock_shared',
  'pg_advisory_xact_lock',
  'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock',
  'pg_try_advisory_lock_shared',
  'pg_try_advisory_xact_lock',
  'pg_try_advisory_xact_lock_shared',
  'pg_advisory_unlock',
  'pg_advisory_unlock_all',
  'pg_advisory_unlock_shared',
  'pg_notify',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_logical_emit_message',
  'pg_export_snapshot',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'lo_get',
  'lo_put',
  'lo_create',
  'lo_creat',
  'lo_unlink',
  'lo_open',
  'lo_from_bytea',
  'loread',
  'lowrite',
  'dblink',
  'dblink_connect',
  'dblink_exec',
]);

/** Describe the same restrictions used below; no second policy list. */
export function sqlGrammarDescriptor() {
  return {
    version: 'postgresql-select/1' as const,
    statements: ['SELECT', 'WITH_SELECT'] as const,
    parameterStyle: 'dollar-numbered-contiguous' as const,
    blockedKeywords: [...BLOCKED_KEYWORDS],
    blockedFunctions: [...BLOCKED_FUNCTIONS],
    // The execution gate uses exact names, not wildcard or prefix rules.
    blockedFunctionPatterns: [] as string[],
    sourceMixing: false as const,
  };
}

export interface GatedSqlStatement {
  readonly source: SqlSource;
  /** The wrapped statement actually sent: `SELECT * FROM (<model sql>) AS q LIMIT $n`. */
  sql: string;
  /** Model parameters followed by the wrapper's `rowLimit + 1` sentinel bound. */
  params: SqlParameter[];
  rowLimit: number;
  /** The model's own top-level LIMIT when the parser could read it; null otherwise. */
  sqlLimit: number | null;
  /** Published relations named in the statement, in published order. */
  relationsUsed: string[];
  /** Characters the wrapper adds before the model's SQL; PostgreSQL positions are shifted back by this. */
  prefixLength: number;
}

interface Token {
  kind: 'word' | 'quoted' | 'param' | 'punct' | 'literal';
  value: string;
  depth: number;
  /** Offset into the original SQL. */
  at: number;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

function fail(code: SqlQueryErrorCode, message: string): never {
  throw new SqlQueryError(code, message);
}

/** Lexes PostgreSQL text just far enough to see statement boundaries, words, parameters and nesting. */
function scan(sql: string): { tokens: Token[]; statements: number; trailingSemicolon: number | null } {
  const tokens: Token[] = [];
  let depth = 0,
    statements = 0,
    trailingSemicolon: number | null = null,
    sawToken = false;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!,
      next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      let level = 1;
      i += 2;
      while (i < sql.length && level > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          level++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          level--;
          i += 2;
        } else i++;
      }
      if (level > 0) fail('UNSUPPORTED_SQL', 'Unterminated block comment.');
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || ((c === 'E' || c === 'e') && next === "'" && !(i > 0 && WORD_PART.test(sql[i - 1]!)))) {
      const escaped = c !== "'";
      const start = i;
      i += escaped ? 2 : 1;
      for (;;) {
        if (i >= sql.length) fail('UNSUPPORTED_SQL', 'Unterminated string literal.');
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ kind: 'literal', value: sql.slice(start, i), depth, at: start });
      sawToken = true;
      trailingSemicolon = null;
      continue;
    }
    if (c === '$') {
      const param = /^\$(\d+)/.exec(sql.slice(i));
      if (param) {
        tokens.push({ kind: 'param', value: param[1]!, depth, at: i });
        i += param[0].length;
        sawToken = true;
        trailingSemicolon = null;
        continue;
      }
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) fail('UNSUPPORTED_SQL', 'Unterminated dollar-quoted string.');
        tokens.push({ kind: 'literal', value: sql.slice(i, end + tag[0].length), depth, at: i });
        i = end + tag[0].length;
        sawToken = true;
        trailingSemicolon = null;
        continue;
      }
    }
    if (c === '"') {
      const start = i;
      i++;
      let value = '';
      for (;;) {
        if (i >= sql.length) fail('UNSUPPORTED_SQL', 'Unterminated quoted identifier.');
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += sql[i];
        i++;
      }
      tokens.push({ kind: 'quoted', value, depth, at: start });
      sawToken = true;
      trailingSemicolon = null;
      continue;
    }
    if (WORD_START.test(c)) {
      const start = i;
      while (i < sql.length && WORD_PART.test(sql[i]!)) i++;
      tokens.push({ kind: 'word', value: sql.slice(start, i).toLowerCase(), depth, at: start });
      sawToken = true;
      trailingSemicolon = null;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      const start = i;
      while (i < sql.length && /[0-9A-Za-z_.]/.test(sql[i]!)) i++;
      tokens.push({ kind: 'literal', value: sql.slice(start, i), depth, at: start });
      sawToken = true;
      trailingSemicolon = null;
      continue;
    }
    if (c === ';') {
      if (sawToken) {
        statements++;
        trailingSemicolon = i;
      } else if (trailingSemicolon === null) trailingSemicolon = i;
      sawToken = false;
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth < 0) fail('UNSUPPORTED_SQL', 'Unbalanced parentheses.');
    }
    tokens.push({ kind: 'punct', value: c, depth: c === ')' ? depth + 1 : depth, at: i });
    sawToken = true;
    if (c !== ';') trailingSemicolon = null;
    i++;
  }
  if (depth !== 0) fail('UNSUPPORTED_SQL', 'Unbalanced parentheses.');
  if (sawToken) statements++;
  return { tokens, statements, trailingSemicolon };
}

const parser = new Parser();
const dialect = { database: 'Postgresql' };

/** Best-effort statement type and LIMIT from node-sql-parser; unparsable PostgreSQL falls through to the database. */
function parsed(sql: string): { sqlLimit: number | null } {
  let ast: unknown;
  try {
    ast = parser.astify(sql, dialect);
  } catch {
    return { sqlLimit: null };
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) fail('UNSUPPORTED_SQL', 'Exactly one SELECT statement is required.');
  const statement = statements[0] as Record<string, unknown>;
  if (statement.type !== 'select') fail('UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.');
  for (const cte of (statement.with as { stmt?: { ast?: { type?: unknown }; type?: unknown } }[] | null) ?? []) {
    const type = cte.stmt?.ast?.type ?? cte.stmt?.type;
    if (type !== undefined && type !== 'select') fail('UNSUPPORTED_SQL', 'Common table expressions must be SELECT statements.');
  }
  const into = statement.into as { position?: unknown } | undefined;
  if (into?.position) fail('UNSUPPORTED_SQL', 'SELECT INTO is not supported.');
  const limit = statement.limit as { seperator?: string; value?: { type?: string; value?: unknown }[] } | null;
  const values = limit?.value ?? [];
  const candidate = limit?.seperator === 'offset' && values.length === 2 ? values[0] : values.length === 1 ? values[0] : undefined;
  if (candidate?.type === 'number' && Number.isInteger(candidate.value) && Number(candidate.value) >= 0) return { sqlLimit: Number(candidate.value) };
  return { sqlLimit: null };
}

/** Admits the request shape and returns the wrapped statement; throws SqlQueryError with the gate's own codes. */
export function gateSqlStatement(input: unknown, source: SqlSource): GatedSqlStatement {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['sql', 'parameters', 'rowLimit'].includes(key)))
    fail('INVALID_QUERY', 'Supply sql, parameters and an optional rowLimit.');
  const request = input as { sql?: unknown; parameters?: unknown; rowLimit?: unknown };
  if (typeof request.sql !== 'string' || !request.sql.trim() || Buffer.byteLength(request.sql, 'utf8') > SQL_QUERY_LIMITS.maxSqlBytes)
    fail('INVALID_QUERY', `SQL must contain 1 to ${SQL_QUERY_LIMITS.maxSqlBytes} UTF-8 bytes.`);
  if (
    !Array.isArray(request.parameters) ||
    request.parameters.length > SQL_QUERY_LIMITS.maxParameters ||
    request.parameters.some(
      (p) => p !== null && typeof p !== 'string' && typeof p !== 'boolean' && !(typeof p === 'number' && Number.isFinite(p) && Math.abs(p) <= Number.MAX_SAFE_INTEGER),
    ) ||
    Buffer.byteLength(JSON.stringify(request.parameters), 'utf8') > SQL_QUERY_LIMITS.maxParameterBytes
  )
    fail(
      'PARAMETER_MISMATCH',
      `Bind at most ${SQL_QUERY_LIMITS.maxParameters} scalar parameters within ${SQL_QUERY_LIMITS.maxParameterBytes} UTF-8 bytes; use strings for exact decimal/int64 values.`,
    );
  const rowLimit = request.rowLimit ?? SQL_QUERY_LIMITS.defaultRowLimit;
  if (!Number.isInteger(rowLimit) || Number(rowLimit) < 1 || Number(rowLimit) > SQL_QUERY_LIMITS.maxRowLimit)
    fail('INVALID_QUERY', `rowLimit must be an integer from 1 to ${SQL_QUERY_LIMITS.maxRowLimit}.`);
  const parameters = request.parameters as SqlParameter[];

  const { tokens, statements, trailingSemicolon } = scan(request.sql);
  if (statements !== 1) fail('UNSUPPORTED_SQL', 'Exactly one SELECT statement is required.');
  const first = tokens.find((token) => !(token.kind === 'punct' && token.value === '('));
  if (!first || first.kind !== 'word' || !['select', 'with'].includes(first.value))
    fail('UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'word' && BLOCKED_KEYWORDS.has(token.value))
      fail('UNSUPPORTED_SQL', `${token.value.toUpperCase()} is not part of a read-only SELECT.`);
    if ((token.kind === 'word' || token.kind === 'quoted') && BLOCKED_FUNCTIONS.has(token.value.toLowerCase()) && tokens[i + 1]?.value === '(')
      fail('UNSUPPORTED_SQL', `${token.value} is not available to query_capiro_data.`);
  }
  const referenced = new Set(tokens.filter((token) => token.kind === 'param').map((token) => Number(token.value)));
  if (referenced.size !== parameters.length || parameters.some((_, i) => !referenced.has(i + 1)))
    fail('PARAMETER_MISMATCH', 'Every supplied parameter must be referenced, consecutively from $1.');

  const own = SOURCE_RELATIONS[source];
  if (!own) fail('INVALID_QUERY', 'Unknown SQL source.');
  const foreign = Object.entries(SOURCE_RELATIONS).filter(([name]) => name !== source).flatMap(([, relations]) => relations);
  const foreignSchemas = [...new Set(Object.values(SOURCE_SCHEMAS))].filter(schema => schema !== SOURCE_SCHEMAS[source]);
  const names = tokens.filter((token) => token.kind === 'word' || token.kind === 'quoted').map((token) => token.value);
  const mixed = names.find((name) => foreign.includes(name) || foreignSchemas.includes(name));
  if (mixed) {
    const owner = Object.entries(SOURCE_RELATIONS).find(([name, relations]) => name !== source && relations.includes(mixed))?.[0]
      ?? Object.entries(SOURCE_SCHEMAS).find(([name, schema]) => name !== source && schema === mixed)?.[0];
    fail('UNKNOWN_RELATION', `${mixed} belongs to the ${owner} source; one query reads one source.`);
  }
  const relationsUsed = own.filter((name) => names.includes(name));

  const body = trailingSemicolon === null ? request.sql : request.sql.slice(0, trailingSemicolon);
  const { sqlLimit } = parsed(body);
  const prefix = 'SELECT * FROM (\n';
  return {
    source,
    sql: `${prefix}${body}\n) AS q LIMIT $${parameters.length + 1}`,
    params: [...parameters, Number(rowLimit) + 1],
    rowLimit: Number(rowLimit),
    sqlLimit,
    relationsUsed,
    prefixLength: prefix.length,
  };
}

/** Cheap nearest-name suggestions for PostgreSQL's undefined relation/column errors. */
export function nearestNames(target: string, published: readonly string[], limit = 3): string[] {
  const bigrams = (value: string) => {
    const set = new Set<string>();
    for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
    return set;
  };
  const wanted = bigrams(target.toLowerCase());
  return published
    .map((name) => {
      const have = bigrams(name.toLowerCase());
      let shared = 0;
      for (const gram of wanted) if (have.has(gram)) shared++;
      return { name, score: (2 * shared) / (wanted.size + have.size || 1) };
    })
    .filter((entry) => entry.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}
