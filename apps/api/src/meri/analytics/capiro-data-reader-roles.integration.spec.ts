import { AnalyticsDbService } from './analytics-db.service.js';
import { asRole, FIXTURE, prepareReaderFixture, type ReaderFixture } from './capiro-data-reader.fixture.js';
import { PrivateSqlDbService, type PrivateSqlExecutionContext } from './private-sql-db.service.js';
import { createPrivateSqlQueries } from './private-sql-query.js';
import { describeCapiroData, queryCapiroData } from './public-sql-query.js';
import { gateSqlStatement, PRIVATE_RELATION_NAMES, PUBLIC_RELATION_NAMES } from './sql-statement-gate.js';

/**
 * Proof that the database, not application code, enforces the properties the
 * old SQL compiler duplicated. Each case logs in as the actual reader role
 * (capiro_analytics_ro or capiro_private_query_ro), inside the same READ
 * ONLY transaction settings the transport uses, and records which SQLSTATE
 * PostgreSQL answers with.
 *
 * Needs a disposable database: CAPIRO_DATA_TEST_DATABASE_URL (superuser or
 * migration owner, for example postgresql://capiro:capiro@localhost:5432/capiro
 * from docker-compose, or an initdb cluster). Skipped when unset. See
 * capiro-data-reader.fixture.ts for what it builds and replays.
 */
const adminUrl = process.env.CAPIRO_DATA_TEST_DATABASE_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

const PUBLIC = { searchPath: 'meri_public' } as const;
const contextA = {
  'app.current_tenant': FIXTURE.tenantA,
  'app.current_user': FIXTURE.actorA,
  'app.meri_query_scope': 'general',
  'app.meri_query_client': '',
};
const PRIVATE = { searchPath: 'meri_private', context: contextA } as const;
const code = (result: Awaited<ReturnType<typeof asRole>>) => ('code' in result ? result.code : 'OK');

describeDatabase('capiro data reader roles: database-enforced properties', () => {
  jest.setTimeout(180_000);
  let fixture: ReaderFixture;
  let pub: string, priv: string, adminRole: string;
  beforeAll(async () => {
    fixture = await prepareReaderFixture(adminUrl!);
    pub = fixture.readerUrl('capiro_analytics_ro');
    priv = fixture.readerUrl('capiro_private_query_ro');
    adminRole = new URL(adminUrl!).username;
  });

  describe('(a) writes and DDL', () => {
    it.each([
      ["INSERT INTO public.congress_bill (id, congress, bill_type, bill_number, title) VALUES ('x', 1, 'hr', '1', 't')", '25006'],
      ["UPDATE public.congress_bill SET title = 'x'", '25006'],
      ['DELETE FROM public.congress_bill', '25006'],
      ['CREATE TABLE public.scratch (id int)', '25006'],
      ['TRUNCATE public.congress_bill', '25006'],
      ['SELECT id INTO TEMP copied FROM congress_bills', '25006'],
      ['SELECT id FROM congress_bills FOR UPDATE', '42501'],
    ])('public reader: %s -> %s', async (sql, sqlstate) => {
      expect(code(await asRole(pub, PUBLIC, sql))).toBe(sqlstate);
    });
    it.each([
      ["INSERT INTO public.clients (id, tenant_id, name, updated_at) VALUES ('a0000000-0000-4000-8000-000000000099', 'a0000000-0000-4000-8000-000000000001', 'x', now())", '25006'],
      ["UPDATE public.client_objectives SET outcome = 'x'", '25006'],
      ['DELETE FROM public.client_objectives', '25006'],
      ['CREATE TABLE meri_private.scratch (id int)', '25006'],
      ['TRUNCATE public.client_objectives', '25006'],
      ['SELECT id FROM client_objectives FOR UPDATE', '42501'],
    ])('private reader: %s -> %s', async (sql, sqlstate) => {
      expect(code(await asRole(priv, PRIVATE, sql))).toBe(sqlstate);
    });
    it('outside a read-only transaction the grants still refuse writes (42501)', async () => {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: pub });
      await client.connect();
      try {
        await expect(client.query("INSERT INTO public.congress_bill (id, congress, bill_type, bill_number, title) VALUES ('x', 1, 'hr', '1', 't')")).rejects.toMatchObject({ code: '42501' });
        await expect(client.query('CREATE TABLE public.scratch (id int)')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    });
  });

  describe('(a) unpublished relations, other schemas, catalogs and search_path', () => {
    it.each([
      ['SELECT id FROM public.clients', '42501'],
      ['SELECT pe_code FROM public.program_element', '42501'],
      ['SELECT pe_code FROM program_element', '42P01'],
      ['SELECT id FROM clients', '42P01'],
      ['SELECT client_id FROM meri_private.client_profiles', '42501'],
      ['SELECT client_id FROM client_profiles', '42P01'],
      ['SELECT * FROM meri_private.visible_clients', '42501'],
      ['SELECT rolname FROM pg_roles', 'OK'],
      ["SELECT usename FROM pg_catalog.pg_user WHERE passwd <> ''", 'OK'],
    ])('public reader: %s -> %s', async (sql, sqlstate) => {
      expect(code(await asRole(pub, PUBLIC, sql))).toBe(sqlstate);
    });
    it('public reader keeps the raw congress_bill grant only for query_global_data', async () => {
      expect(code(await asRole(pub, PUBLIC, 'SELECT id FROM public.congress_bill'))).toBe('OK');
    });
    it.each([
      ['SELECT * FROM visible_clients', '42501'],
      ['SELECT * FROM meri_private.visible_clients', '42501'],
      ['SELECT id FROM public.clients', '42501'],
      ['SELECT id FROM clients', '42P01'],
      ['SELECT id FROM public.congress_bill', '42501'],
      ['SELECT id FROM meri_public.congress_bills', '42501'],
      ['SELECT id FROM congress_bills', '42P01'],
      ['SELECT metadata_jsonb FROM client_activity', '42703'],
    ])('private reader: %s -> %s', async (sql, sqlstate) => {
      expect(code(await asRole(priv, PRIVATE, sql))).toBe(sqlstate);
    });
    it('(c) the two sources cannot be mixed because neither role can see the other schema', async () => {
      expect(code(await asRole(pub, PUBLIC, 'SELECT b.id FROM congress_bills b JOIN meri_private.client_tracked_bills t ON t.bill_id = b.id'))).toBe('42501');
      expect(code(await asRole(priv, PRIVATE, 'SELECT t.id FROM client_tracked_bills t JOIN meri_public.congress_bills b ON b.id = t.bill_id'))).toBe('42501');
    });
  });

  describe('(a) role switching and session control', () => {
    it.each([
      ['SET ROLE %s', '42501'],
      ["SELECT set_config('role', '%s', true)", '42501'],
      ['SET SESSION AUTHORIZATION %s', '42501'],
    ])('public reader: %s -> %s', async (template, sqlstate) => {
      expect(code(await asRole(pub, PUBLIC, template.replace('%s', adminRole)))).toBe(sqlstate);
    });
    it.each([
      ['SET ROLE %s', '42501'],
      ["SELECT set_config('role', '%s', true)", '42501'],
      ['SET ROLE capiro_private_projection_owner', '42501'],
    ])('private reader: %s -> %s', async (template, sqlstate) => {
      expect(code(await asRole(priv, PRIVATE, template.replace('%s', adminRole)))).toBe(sqlstate);
    });
    it('multiple commands in one prepared statement are refused by the protocol (42601)', async () => {
      expect(code(await asRole(pub, PUBLIC, 'SELECT 1; SELECT 2'))).toBe('42601');
      expect(code(await asRole(priv, PRIVATE, 'SELECT 1; DELETE FROM public.clients'))).toBe('42601');
    });
    it('pg_sleep(20) is cancelled by statement_timeout (57014) in about a second at 1000ms', async () => {
      const started = Date.now();
      expect(code(await asRole(pub, { ...PUBLIC, statementTimeoutMs: 1000 }, 'SELECT pg_sleep(20)'))).toBe('57014');
      expect(Date.now() - started).toBeLessThan(8000);
      expect(code(await asRole(priv, { ...PRIVATE, statementTimeoutMs: 1000 }, 'SELECT pg_sleep(20)'))).toBe('57014');
    });
    it('the role-level timeouts from the migration hold without SET LOCAL', async () => {
      const { Client } = await import('pg');
      const client = new Client({ connectionString: pub });
      await client.connect();
      try {
        const settings = await client.query<{ name: string; setting: string }>(
          "SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout') ORDER BY name",
        );
        expect(settings.rows).toEqual([
          { name: 'idle_in_transaction_session_timeout', setting: '10000' },
          { name: 'lock_timeout', setting: '3000' },
          { name: 'statement_timeout', setting: '10000' },
        ]);
      } finally {
        await client.end();
      }
    });
  });

  describe('(a) cross-tenant rows under the transaction-local context', () => {
    const objectives = 'SELECT id FROM client_objectives ORDER BY id';
    it('general scope shows only the actor tenant and only unwalled or granted clients', async () => {
      const result = await asRole(priv, PRIVATE, objectives);
      expect(result).toEqual({ rows: [{ id: FIXTURE.objectiveA1 }] });
    });
    it('a selected client narrows to that client; another tenant context shows nothing for this actor', async () => {
      expect(await asRole(priv, { searchPath: 'meri_private', context: { ...contextA, 'app.meri_query_scope': 'client', 'app.meri_query_client': FIXTURE.clientA1 } }, objectives)).toEqual({
        rows: [{ id: FIXTURE.objectiveA1 }],
      });
      expect(await asRole(priv, { searchPath: 'meri_private', context: { ...contextA, 'app.current_tenant': FIXTURE.tenantB } }, objectives)).toEqual({ rows: [] });
    });
    it('missing or malformed context never means General', async () => {
      expect(await asRole(priv, { searchPath: 'meri_private' }, objectives)).toEqual({ rows: [] });
      expect(await asRole(priv, { searchPath: 'meri_private', context: { ...contextA, 'app.current_tenant': 'not-a-uuid' } }, objectives)).toEqual({ rows: [] });
      expect(await asRole(priv, { searchPath: 'meri_private', context: { ...contextA, 'app.meri_query_scope': 'client' } }, objectives)).toEqual({ rows: [] });
    });
    it('(b) PostgreSQL lets any role set a custom GUC inside a SELECT, so set_config in model SQL is for the gate', async () => {
      // Documented finding: this is why BLOCKED_FUNCTIONS includes set_config. The database alone does not stop it.
      const result = await asRole(
        priv,
        PRIVATE,
        `WITH switched AS (SELECT set_config('app.current_tenant', $1, true) AS t, set_config('app.current_user', $2, true) AS u)
         SELECT o.id FROM switched, client_objectives o`,
        [FIXTURE.tenantB, FIXTURE.actorB],
      );
      expect(result).toEqual({ rows: [{ id: FIXTURE.objectiveB1 }] });
      expect(() => gateSqlStatement({ sql: "SELECT set_config('app.current_tenant', $1, true)", parameters: [FIXTURE.tenantB] }, 'client_records')).toThrow(
        'set_config is not available to query_capiro_data.',
      );
    });
  });

  describe('the published surface is the role surface', () => {
    it('public reader sees exactly the gate vocabulary in meri_public, with comments', async () => {
      const result = await asRole(
        pub,
        PUBLIC,
        "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'meri_public' AND has_table_privilege(c.oid, 'SELECT') ORDER BY 1",
      );
      expect('rows' in result && result.rows.map((row) => row.name).sort()).toEqual([...PUBLIC_RELATION_NAMES].sort());
    });
    it('private reader sees exactly the gate vocabulary in meri_private; visible_clients is excluded', async () => {
      const result = await asRole(
        priv,
        PRIVATE,
        "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'meri_private' AND has_table_privilege(c.oid, 'SELECT') ORDER BY 1",
      );
      expect('rows' in result && result.rows.map((row) => row.name).sort()).toEqual([...PRIVATE_RELATION_NAMES].sort());
    });
    it('neither reader holds a write, reference or trigger privilege on any relation', async () => {
      const probe = `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%'
        AND (has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES'))`;
      expect(await asRole(pub, PUBLIC, probe)).toEqual({ rows: [{ n: 0 }] });
      expect(await asRole(priv, PRIVATE, probe)).toEqual({ rows: [{ n: 0 }] });
    });
  });

  describe('services end to end on the real readers', () => {
    const analytics = new AnalyticsDbService();
    const privateDb = new PrivateSqlDbService();
    const context = (overrides: Partial<PrivateSqlExecutionContext> = {}): PrivateSqlExecutionContext =>
      ({ tenantId: FIXTURE.tenantA, actorId: FIXTURE.actorA, scopeKind: 'general', clientId: null, deadlineMs: Date.now() + 30_000, assertCurrent: async () => {}, ...overrides }) as PrivateSqlExecutionContext;
    beforeAll(() => fixture.bindServiceEnv());
    afterAll(async () => {
      await analytics.onModuleDestroy();
      await privateDb.onModuleDestroy();
    });

    it('describes the public surface from pg_catalog with types, enumerations, keys and grain', async () => {
      const result = await describeCapiroData({ relations: ['congress_bills', 'program_element_budget_positions'] }, analytics);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected metadata');
      const [bills, positions] = result.relations;
      expect(bills).toMatchObject({ name: 'congress_bills', primaryKey: ['id'], grain: 'One row per (id).' });
      expect(bills!.fields.find((f) => f.name === 'congress')).toMatchObject({ type: 'integer', pgType: 'integer', nullable: false });
      expect(bills!.fields.find((f) => f.name === 'bill_type')?.enum).toEqual(['hr', 's', 'hjres', 'sjres', 'hres', 'sres', 'hconres', 'sconres']);
      expect(bills!.relationships).toEqual([{ fields: ['sponsor_bioguide_id'], referencedRelation: 'congress_members', referencedFields: ['bioguide_id'], cardinality: 'many_to_one', integrity: 'soft' }]);
      expect(positions!.fields.find((f) => f.name === 'amount')).toMatchObject({ type: 'decimal', pgType: 'numeric(14,2)', unit: 'value_kind dependent' });
      expect(positions!.coverage.limitations.length).toBeGreaterThan(1);
      expect(JSON.stringify(result)).not.toContain('"table"');
    });
    it('executes ordinary read-only SQL verbatim and returns exact text values', async () => {
      const result = await queryCapiroData(
        {
          sql: `SELECT b.congress, COUNT(*) FILTER (WHERE b.status = 'enacted') AS enacted,
                  (SELECT SUM(p.amount) FROM program_element_budget_positions p WHERE p.asserted_fy = $1::int AND b.congress = 119) AS total,
                  MAX(b.update_date) AS latest
                FROM congress_bills b WHERE b.bill_type IN ('hr', 's') GROUP BY b.congress ORDER BY b.congress DESC NULLS LAST`,
          parameters: [2026],
          rowLimit: 5,
        },
        analytics,
      );
      expect(result).toMatchObject({
        ok: true,
        rowCount: 2,
        rowLimitReached: false,
        relationsUsed: ['congress_bills', 'program_element_budget_positions'],
        columns: [
          { name: 'congress', type: 'integer', pgType: 'int4' },
          { name: 'enacted', type: 'integer', pgType: 'int8' },
          { name: 'total', type: 'decimal', pgType: 'numeric' },
          { name: 'latest', type: 'timestamp', pgType: 'timestamptz' },
        ],
        coverage: { sqlLimit: null, relations: [{ name: 'congress_bills' }, { name: 'program_element_budget_positions' }] },
      });
      if (!result.ok || !('rows' in result)) throw new Error('expected rows');
      expect(result.rows[0]).toEqual({ congress: '119', enacted: '1', total: '123456789024.84', latest: '2025-01-04 01:02:03.123456+00' });
      expect(result.rows[1]).toEqual({ congress: '118', enacted: '0', total: null, latest: null });
    });
    it('returns the PostgreSQL error with position, hint and nearest names', async () => {
      const unknownColumn = await queryCapiroData({ sql: 'SELECT b.titel FROM congress_bills b', parameters: [] }, analytics);
      expect(unknownColumn).toMatchObject({ ok: false, error: { code: 'UNKNOWN_FIELD', sqlstate: '42703', position: 8, candidates: ['title', 'quantity'] } });
      if (unknownColumn.ok) throw new Error('expected refusal');
      expect(unknownColumn.error.message).toBe('column b.titel does not exist');
      const unknownRelation = await queryCapiroData({ sql: 'SELECT 1 FROM congress_bill', parameters: [] }, analytics);
      expect(unknownRelation).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42P01', position: 15, candidates: ['congress_bills', 'congress_bill_cosponsors', 'congress_bill_subjects'] } });
      const unpublished = await queryCapiroData({ sql: 'SELECT id FROM public.clients', parameters: [] }, analytics);
      expect(unpublished).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42501', message: 'permission denied for table clients' } });
      const badCast = await queryCapiroData({ sql: 'SELECT $1::int AS n', parameters: ['abc'] }, analytics);
      expect(badCast).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY', sqlstate: '22P02' } });
      const timeout = await queryCapiroData({ sql: "SELECT pg_catalog.pg_sleep(20)", parameters: [] }, analytics);
      expect(timeout).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SQL' } });
    });
    it('caps rows with the outer LIMIT wrapper and reports the model LIMIT as coverage', async () => {
      const capped = await queryCapiroData({ sql: 'SELECT id FROM congress_bills ORDER BY id', parameters: [], rowLimit: 2 }, analytics);
      expect(capped).toMatchObject({ ok: true, rowCount: 2, rowLimitReached: true, coverage: { sqlLimit: null } });
      const own = await queryCapiroData({ sql: 'SELECT id FROM congress_bills ORDER BY id LIMIT 1', parameters: [], rowLimit: 2 }, analytics);
      expect(own).toMatchObject({ ok: true, rowCount: 1, rowLimitReached: false, coverage: { sqlLimit: 1 } });
    });
    it('private describe and query run under the admitted context and the reader role', async () => {
      const queries = createPrivateSqlQueries(privateDb);
      const described = await queries.describe({ relations: ['client_objectives'] }, context());
      expect(described).toMatchObject({ version: '0.3.0', ok: true, scope: { kind: 'client_records', clientId: null } });
      if (!described.ok || !('relations' in described)) throw new Error('expected metadata');
      expect(described.relations[0]!.fields.map((f) => f.name)).toContain('readiness_is_ready');
      expect(described.relations[0]!.fields.find((f) => f.name === 'ask_type')?.enum).toEqual(['funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose']);
      const rows = await queries.query({ sql: 'SELECT o.id, o.readiness_is_ready FROM client_objectives o ORDER BY o.id', parameters: [] }, context());
      expect(rows).toMatchObject({ ok: true, rows: [{ id: FIXTURE.objectiveA1, readiness_is_ready: false }], relationsUsed: ['client_objectives'] });
      const narrowed = await queries.query({ sql: 'SELECT count(*) AS n FROM client_objectives', parameters: [] }, context({ scopeKind: 'client', clientId: FIXTURE.clientA2Walled }));
      expect(narrowed).toMatchObject({ ok: true, rows: [{ n: '0' }] });
      const leak = await queries.query({ sql: 'SELECT * FROM visible_clients', parameters: [] }, context());
      expect(leak).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42501' } });
      const mixed = await queries.query({ sql: 'SELECT id FROM congress_bills', parameters: [] }, context());
      expect(mixed).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', message: 'congress_bills belongs to the public source; one query reads one source.' } });
    });
  });
});
