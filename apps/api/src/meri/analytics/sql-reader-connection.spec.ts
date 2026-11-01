import type { Pool, PoolClient } from 'pg';
import {
  createReaderPool,
  executeGatedStatement,
  readerConfigFromEnv,
  readPublishedSurface,
  translateDatabaseError,
  withReadOnlyTransaction,
  type PublishedRelation,
} from './sql-reader-connection.js';
import { gateSqlStatement, SqlQueryError } from './sql-statement-gate.js';

/** A scripted client: `SET`/`BEGIN`/`COMMIT` succeed; other statements answer from the queue. */
function fakeClient(answers: Array<unknown>) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (input: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const text = typeof input === 'string' ? input : input.text;
      queries.push({ text, values: typeof input === 'string' ? values : input.values });
      if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(text)) return { rows: [], fields: [] };
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? { rows: [], fields: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  return { client: client as unknown as PoolClient, pool, queries, release: client.release };
}
const admitted = { rows: [{ allowed: true }] };

describe('reader transport', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  it('composes a reader connection only from its own env and only for the expected role', () => {
    Object.assign(process.env, { X_HOST: 'reader', X_PORT: '5432', X_USER: 'capiro_analytics_ro', X_PASSWORD: 'p', X_NAME: 'capiro' });
    expect(readerConfigFromEnv('X', 'capiro_analytics_ro', 'tool')).toEqual({ host: 'reader', port: 5432, user: 'capiro_analytics_ro', password: 'p', database: 'capiro', sslmode: 'require' });
    process.env.X_USER = 'capiro_app';
    expect(() => readerConfigFromEnv('X', 'capiro_analytics_ro', 'tool')).toThrow(/must use capiro_analytics_ro/);
    process.env.X_USER = 'capiro_analytics_ro';
    process.env.X_SSLMODE = 'allow';
    expect(() => readerConfigFromEnv('X', 'capiro_analytics_ro', 'tool')).toThrow(/X_SSLMODE/);
    delete process.env.X_SSLMODE;
    process.env.X_PASSWORD = '***';
    expect(() => readerConfigFromEnv('X', 'capiro_analytics_ro', 'tool')).toThrow(/masked placeholder/);
    delete process.env.X_HOST;
    delete process.env.X_NAME;
    expect(() => readerConfigFromEnv('X', 'capiro_analytics_ro', 'tool')).toThrow(/tool requires X_HOST, X_NAME; this path never falls back to DATABASE_URL/);
  });
  it('builds a small pool whose values arrive as text except booleans', async () => {
    const pool = createReaderPool({ host: 'h', port: 1, user: 'u', password: 'p', database: 'd', sslmode: 'verify-full' });
    const options = (pool as unknown as { options: { max: number; ssl: unknown; types: { getTypeParser(oid: number): (v: string) => unknown } } }).options;
    expect(options.max).toBe(3);
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    expect(options.types.getTypeParser(1700)('9007199254740993.01')).toBe('9007199254740993.01');
    expect(options.types.getTypeParser(16)('t')).toBe(true);
    await pool.end();
  });
  it('fixes the transaction settings in order, binds context before admission and commits', async () => {
    const { pool, queries, release } = fakeClient([{ rows: [] }, admitted, { rows: [{ ok: 1 }] }]);
    const result = await withReadOnlyTransaction(
      pool,
      { role: 'capiro_private_query_ro', searchPath: 'meri_private', statementTimeoutMs: 1234, context: { bypassRlsOff: true, settings: { 'app.current_tenant': 't', 'app.current_user': 'u' } } },
      async (client) => (await client.query('SELECT 1')).rows,
    );
    expect(result).toEqual([{ ok: 1 }]);
    expect(queries.map((q) => q.text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL search_path = "meri_private"',
      "SET LOCAL statement_timeout = '1234ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '10000ms'",
      "SET LOCAL timezone = 'UTC'",
      "SET LOCAL app.bypass_rls = 'off'",
      'SELECT pg_catalog.set_config($1, $2, true), pg_catalog.set_config($3, $4, true)',
      expect.stringContaining('current_user = $1 AND session_user = $1'),
      'SELECT 1',
      'COMMIT',
    ]);
    expect(queries[7]!.values).toEqual(['app.current_tenant', 't', 'app.current_user', 'u']);
    expect(queries[8]!.values).toEqual(['capiro_private_query_ro', true]);
    expect(release).toHaveBeenCalledWith(undefined);
  });
  it('fails closed on a bad admission row, rolls back on failure and discards broken connections', async () => {
    const denied = fakeClient([{ rows: [{ allowed: false }] }]);
    await expect(withReadOnlyTransaction(denied.pool, { role: 'r', searchPath: 's', statementTimeoutMs: 1 }, async () => 'data')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(denied.queries.map((q) => q.text)).toContain('ROLLBACK');
    expect(denied.queries.map((q) => q.text)).not.toContain('COMMIT');
    const failing = fakeClient([admitted, Object.assign(new Error('boom'), { code: '42703' })]);
    await expect(withReadOnlyTransaction(failing.pool, { role: 'r', searchPath: 's', statementTimeoutMs: 1 }, async (client) => client.query('SELECT x'))).rejects.toMatchObject({ code: '42703' });
    expect(failing.queries.map((q) => q.text)).toContain('ROLLBACK');
    expect(failing.release).toHaveBeenCalledWith(undefined);
    const broken = fakeClient([admitted, Object.assign(new Error('gone'), { code: '08006' })]);
    await expect(withReadOnlyTransaction(broken.pool, { role: 'r', searchPath: 's', statementTimeoutMs: 1 }, async (client) => client.query('SELECT x'))).rejects.toMatchObject({ code: '08006' });
    expect(broken.release).toHaveBeenCalledWith(expect.any(Error));
    const unreachable = { connect: jest.fn(async () => { throw new Error("ECONNREFUSED"); }) } as unknown as Pool;
    await expect(withReadOnlyTransaction(unreachable, { role: 'r', searchPath: 's', statementTimeoutMs: 1 }, async () => 'x')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('executes the gated statement in array mode and types columns from pg_type, suffixing duplicates', async () => {
    const gated = gateSqlStatement({ sql: 'SELECT b.id, s.id, b.congress, b.last_synced_at, b.ok FROM congress_bills b', parameters: [] }, 'public');
    const { client, queries } = fakeClient([
      { fields: [{ name: 'id', dataTypeID: 25 }, { name: 'id', dataTypeID: 25 }, { name: 'congress', dataTypeID: 23 }, { name: 'last_synced_at', dataTypeID: 1184 }, { name: 'ok', dataTypeID: 16 }], rows: [['a', 'b', '119', '2026-01-01 00:00:00.123456+00', true], ['c', null, null, null, false]] },
      { rows: [{ oid: '25', typname: 'text' }, { oid: '23', typname: 'int4' }, { oid: '1184', typname: 'timestamptz' }, { oid: '16', typname: 'bool' }] },
    ]);
    const result = await executeGatedStatement(client, gated);
    expect(queries[0]).toEqual({ text: gated.sql, values: [201] });
    expect(result.columns).toEqual([
      { name: 'id', type: 'string', pgType: 'text', nullable: true },
      { name: 'id_2', type: 'string', pgType: 'text', nullable: true },
      { name: 'congress', type: 'integer', pgType: 'int4', nullable: true },
      { name: 'last_synced_at', type: 'timestamp', pgType: 'timestamptz', nullable: true },
      { name: 'ok', type: 'boolean', pgType: 'bool', nullable: true },
    ]);
    expect(result.rows).toEqual([
      { id: 'a', id_2: 'b', congress: '119', last_synced_at: '2026-01-01 00:00:00.123456+00', ok: true },
      { id: 'c', id_2: null, congress: null, last_synced_at: null, ok: false },
    ]);
  });
  it('reads the published surface from the catalog rows and JSON comments in published order', async () => {
    const row = (relation: string, column: string, typname: string, relationComment: string | null, columnComment: string | null) => ({
      relation,
      relation_comment: relationComment,
      column_name: column,
      column_type: typname === 'int4' ? 'integer' : typname,
      typname,
      column_comment: columnComment,
    });
    const viewMeta = JSON.stringify({
      description: 'Bills',
      grain: 'One row per (id).',
      primaryKey: ['id'],
      relationships: [{ fields: ['sponsor'], referencedRelation: 'congress_members', referencedFields: ['bioguide_id'], cardinality: 'many_to_one', integrity: 'soft' }],
      limitations: ['Published metadata does not establish freshness.'],
      freshnessField: 'last_synced_at',
    });
    const { client } = fakeClient([
      {
        rows: [
          row('zeta_extra', 'id', 'text', 'Plain comment', null),
          row('congress_bills', 'id', 'text', viewMeta, JSON.stringify({ description: 'Bill id', nullable: false })),
          row('congress_bills', 'congress', 'int4', viewMeta, JSON.stringify({ description: 'Congress', nullable: false, enum: ['118', '119'], unit: 'ordinal' })),
          row('congress_bills', 'policy_area', 'text', viewMeta, '{not json'),
          row('congress_members', 'bioguide_id', 'text', null, null),
        ],
      },
    ]);
    const surface = await readPublishedSurface(client, 'meri_public', 'ingested_public_records', ['congress_bills', 'congress_members']);
    expect(surface.map((relation) => relation.name)).toEqual(['congress_bills', 'congress_members', 'zeta_extra']);
    expect(surface[0]).toEqual({
      name: 'congress_bills',
      description: 'Bills',
      grain: 'One row per (id).',
      primaryKey: ['id'],
      relationships: [{ fields: ['sponsor'], referencedRelation: 'congress_members', referencedFields: ['bioguide_id'], cardinality: 'many_to_one', integrity: 'soft' }],
      coverage: { basis: 'ingested_public_records', limitations: ['Published metadata does not establish freshness.'] },
      freshness: { field: 'last_synced_at', sourceAsOf: null, sourceVersion: null },
      fields: [
        { name: 'id', type: 'string', pgType: 'text', nullable: false, description: 'Bill id' },
        { name: 'congress', type: 'integer', pgType: 'integer', nullable: false, description: 'Congress', unit: 'ordinal', enum: ['118', '119'] },
        { name: 'policy_area', type: 'string', pgType: 'text', nullable: true, description: '{not json' },
      ],
    });
    expect(surface[2]).toMatchObject({ description: 'Plain comment', grain: '', primaryKey: [], relationships: [], coverage: { limitations: [] } });
    expect(surface[1]!.fields[0]).toMatchObject({ description: '', nullable: true });
  });
  describe('error translation', () => {
    const surface: PublishedRelation[] = [
      { name: 'congress_bills', description: '', grain: '', fields: [{ name: 'title', type: 'string', pgType: 'text', nullable: true, description: '' }], primaryKey: [], relationships: [], coverage: { basis: 'b', limitations: [] }, freshness: { field: null, sourceAsOf: null, sourceVersion: null } },
      { name: 'congress_members', description: '', grain: '', fields: [{ name: 'full_name', type: 'string', pgType: 'text', nullable: true, description: '' }], primaryKey: [], relationships: [], coverage: { basis: 'b', limitations: [] }, freshness: { field: null, sourceAsOf: null, sourceVersion: null } },
    ];
    const gated = { prefixLength: 16 };
    const pgError = (code: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });
    it.each([
      [pgError('42703', 'column b.titel does not exist', { position: '24', hint: 'Perhaps you meant "b.title".' }), { code: 'UNKNOWN_FIELD', message: 'column b.titel does not exist', position: 8, hint: 'Perhaps you meant "b.title".', sqlstate: '42703', candidates: ['title'] }],
      [pgError('42P01', 'relation "congress_bill" does not exist', { position: '31' }), { code: 'UNKNOWN_RELATION', message: 'congress_bill is not published in this source; use only the relations describe_capiro_data lists.', position: 15, sqlstate: '42P01', candidates: ['congress_bills', 'congress_members'] }],
      // Permission and schema errors never echo PostgreSQL's text: it would confirm that an unpublished object exists.
      [pgError('42501', 'permission denied for table clients'), { code: 'UNKNOWN_RELATION', message: 'clients is not published in this source; use only the relations describe_capiro_data lists.', sqlstate: '42501' }],
      [pgError('42501', 'permission denied for schema secret_schema'), { code: 'UNKNOWN_RELATION', message: 'secret_schema is not published in this source; use only the relations describe_capiro_data lists.', sqlstate: '42501' }],
      [pgError('42501', 'permission denied for table congress_bills'), { code: 'UNKNOWN_RELATION', message: 'Only a read-only SELECT is permitted on congress_bills; locking and write clauses are refused.', sqlstate: '42501' }],
      [pgError('42501', 'permission denied'), { code: 'UNKNOWN_RELATION', message: 'The statement named a relation or schema that is not published in this source; use only the relations describe_capiro_data lists.', sqlstate: '42501' }],
      [pgError('3F000', 'schema "meri_private" does not exist'), { code: 'UNKNOWN_RELATION', message: 'meri_private is not published in this source; use only the relations describe_capiro_data lists.', sqlstate: '3F000' }],
      [pgError('57014', 'canceling statement due to statement timeout'), { code: 'QUERY_TIMEOUT', sqlstate: '57014' }],
      [pgError('55P03', 'could not obtain lock'), { code: 'QUERY_TIMEOUT', sqlstate: '55P03' }],
      [pgError('22P02', 'invalid input syntax for type integer: "abc"', { position: '8' }), { code: 'INVALID_QUERY', message: 'invalid input syntax for type integer: "abc"', sqlstate: '22P02' }],
      [pgError('25006', 'cannot execute INSERT in a read-only transaction'), { code: 'INVALID_QUERY', sqlstate: '25006' }],
      [pgError('42601', 'syntax error at or near ")"', { position: '3' }), { code: 'INVALID_QUERY', sqlstate: '42601' }],
      [pgError('53200', 'out of memory'), { code: 'SOURCE_UNAVAILABLE', message: 'Data is currently unavailable.', sqlstate: '53200' }],
      [pgError('08006', 'connection failure'), { code: 'SOURCE_UNAVAILABLE', sqlstate: '08006' }],
      [Object.assign(new Error('connect ECONNREFUSED secret-host:5432'), { code: 'ECONNREFUSED' }), { code: 'SOURCE_UNAVAILABLE', message: 'Data is currently unavailable.' }],
      [new Error('secret connection string'), { code: 'SOURCE_UNAVAILABLE', message: 'Data is currently unavailable.' }],
    ])('maps %o', (error, expected) => {
      const translated = translateDatabaseError(error, gated, surface);
      expect(translated).toBeInstanceOf(SqlQueryError);
      expect(translated.toEnvelope()).toMatchObject(expected);
      expect(JSON.stringify(translated.toEnvelope())).not.toContain('secret connection');
      expect(JSON.stringify(translated.toEnvelope())).not.toMatch(/permission denied|schema .* does not exist|relation .* does not exist/);
    });
    it('leaves a position inside the wrapper prefix out and passes gate errors through', () => {
      expect(translateDatabaseError(pgError('42601', 'syntax error', { position: '3' }), gated, surface).toEnvelope()).not.toHaveProperty('position');
      const own = new SqlQueryError('OUTPUT_LIMIT', 'too big');
      expect(translateDatabaseError(own, gated, surface)).toBe(own);
    });
  });
});
