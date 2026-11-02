import { ForbiddenException } from '@nestjs/common';
import { PrivateSqlDbService, type PrivateSqlExecutionContext } from './private-sql-db.service.js';
import { gateSqlStatement, PRIVATE_RELATION_NAMES } from './sql-statement-gate.js';
import { CLIENT_MEETING_QUERY_RELATION } from '../../engagement/meeting-query-projection.js';
import { RESEARCH_PORTFOLIO_QUERY_RELATIONS } from '../../research-portfolios/research-portfolio-query-projections.js';
import { CLASSIC_OUTREACH_QUERY_RELATION } from '../../engagement/classic-outreach-query-projection.js';

const TENANT = '10000000-0000-4000-8000-000000000001',
  ACTOR = '10000000-0000-4000-8000-000000000002';
const CLIENT = '10000000-0000-4000-8000-000000000003';
const clock = 1793000000000;
function context(overrides: Partial<PrivateSqlExecutionContext> = {}): PrivateSqlExecutionContext {
  return {
    tenantId: TENANT,
    actorId: ACTOR,
    scopeKind: 'general',
    clientId: null,
    deadlineMs: clock + 30000,
    assertCurrent: jest.fn(async () => {}),
    ...overrides,
  } as PrivateSqlExecutionContext;
}
const gated = () =>
  gateSqlStatement(
    {
      sql: 'SELECT COUNT(*) AS count FROM client_objectives o WHERE o.id > $1',
      parameters: [CLIENT],
    },
    'client_records',
  );
const catalogRows = PRIVATE_RELATION_NAMES.flatMap((relation) =>
  (relation === 'client_meetings'
    ? CLIENT_MEETING_QUERY_RELATION.fields.map((field) => field.name)
    : ['id']
  ).map((column_name) => ({
    relation,
    relation_comment: null,
    column_name,
    column_type: 'uuid',
    typname: 'uuid',
    column_comment: null,
  })),
);

function fixture(admission: unknown = { rows: [{ allowed: true }] }) {
  const events: string[] = [];
  const answers: unknown[] = [
    admission,
    { rows: [{ allowed: true }] },
    { rows: catalogRows },
    { fields: [{ name: 'count', dataTypeID: 20 }], rows: [['9007199254740993']] },
    { rows: [{ oid: '20', typname: 'int8' }] },
  ];
  const queries: { text: string; values?: unknown[] }[] = [];
  const client = {
    query: jest.fn(
      async (input: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
        const text = typeof input === 'string' ? input : input.text;
        queries.push({ text, values: typeof input === 'string' ? values : input.values });
        if (text === 'BEGIN READ ONLY') events.push('begin');
        if (text === 'COMMIT') events.push('commit');
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|SELECT pg_catalog.set_config)/.test(text))
          return { rows: [], fields: [] };
        const next = answers.shift();
        if (next instanceof Error) throw next;
        if (Array.isArray((next as { fields?: unknown[] })?.fields)) events.push('data');
        return next;
      },
    ),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client), end: jest.fn(async () => {}) };
  const service = new PrivateSqlDbService();
  (service as unknown as { pool: unknown }).pool = pool;
  const authority = context({
    assertCurrent: jest.fn(async () => {
      events.push('current');
    }),
  });
  return { service, queries, answers, pool, events, authority };
}

describe('private SQL execution isolation (scripted transport; native role proof is the integration spec)', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(clock);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it.each(['research_portfolio', 'classic_outreach'] as const)(
    'binds %s context before SQL and describes only that domain from a shared catalog',
    async (source) => {
      const f = fixture();
      const extra = [
        ...RESEARCH_PORTFOLIO_QUERY_RELATIONS,
        CLASSIC_OUTREACH_QUERY_RELATION,
      ].flatMap((relation) =>
        relation.fields.map((field) => ({
          relation: relation.name,
          relation_comment: null,
          column_name: field.name,
          column_type: 'text',
          typname: 'text',
          column_comment: null,
        })),
      );
      f.answers[2] = { rows: [...catalogRows, ...extra] };
      const relation =
        source === 'research_portfolio' ? 'research_portfolios' : 'classic_outreach_records';
      const authority =
        source === 'research_portfolio'
          ? context({ scopeKind: source, researchPortfolioId: CLIENT })
          : context({ scopeKind: source, classicOutreachIds: [CLIENT] });
      const result = await f.service.runPrivateSql(
        gateSqlStatement({ sql: `SELECT COUNT(*) FROM ${relation}`, parameters: [] }, source),
        authority,
      );
      expect(result.surface.map((r) => r.name)).toEqual(
        source === 'research_portfolio'
          ? ['research_portfolios', 'research_portfolio_members']
          : ['classic_outreach_records'],
      );
      expect(f.queries[7]!.values).toEqual([
        'app.current_tenant',
        TENANT,
        'app.current_user',
        ACTOR,
        'app.meri_query_scope',
        source,
        'app.meri_query_client',
        '',
        'app.meri_query_portfolio',
        source === 'research_portfolio' ? CLIENT : '',
        'app.meri_query_classic_ids',
        source === 'classic_outreach' ? CLIENT : '',
      ]);
      expect(f.queries[11]!.text).toContain(`SELECT COUNT(*) FROM ${relation}`);
      // Same service, next domain: no cached Research metadata can cross into client records.
      f.answers.push(
        { rows: [{ allowed: true }] },
        { rows: [{ allowed: true }] },
        { rows: catalogRows },
      );
      expect((await f.service.describe(context())).map((r) => r.name)).toEqual([
        ...PRIVATE_RELATION_NAMES,
      ]);
    },
  );
  it('refuses source/context mismatch before pool access and missing strict catalog before model execution', async () => {
    const mismatch = fixture();
    await expect(
      mismatch.service.runPrivateSql(
        gated(),
        context({ scopeKind: 'research_portfolio', researchPortfolioId: CLIENT }),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(mismatch.pool.connect).not.toHaveBeenCalled();
    for (const invalid of [{ rows: [{ allowed: false }] }, { rows: [] }]) {
      const f = fixture();
      f.answers[1] = invalid;
      await expect(f.service.runPrivateSql(gated(), context())).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
      expect(f.events).not.toContain('data');
    }
    const absent = fixture();
    absent.answers[2] = { rows: catalogRows.filter((row) => row.relation !== 'client_meetings') };
    await expect(absent.service.runPrivateSql(gated(), context())).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(absent.events).not.toContain('data');
  });
  it('binds trusted scope locally, admits before SQL and rechecks outside the completed transaction', async () => {
    const f = fixture(),
      query = gated();
    const result = await f.service.runPrivateSql(query, f.authority);
    expect(result.rows).toEqual([{ count: '9007199254740993' }]);
    expect(result.columns).toEqual([
      { name: 'count', type: 'integer', pgType: 'int8', nullable: true },
    ]);
    expect(result.surface.map((item) => item.name)).toEqual([...PRIVATE_RELATION_NAMES]);
    expect(f.events).toEqual(['current', 'begin', 'data', 'commit', 'current']);
    expect(f.queries.map((q) => q.text).slice(0, 8)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL search_path = "meri_private"',
      "SET LOCAL statement_timeout = '8000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '10000ms'",
      "SET LOCAL timezone = 'UTC'",
      "SET LOCAL app.bypass_rls = 'off'",
      'SELECT pg_catalog.set_config($1, $2, true), pg_catalog.set_config($3, $4, true), pg_catalog.set_config($5, $6, true), pg_catalog.set_config($7, $8, true), pg_catalog.set_config($9, $10, true), pg_catalog.set_config($11, $12, true)',
    ]);
    expect(f.queries[7]!.values).toEqual([
      'app.current_tenant',
      TENANT,
      'app.current_user',
      ACTOR,
      'app.meri_query_scope',
      'general',
      'app.meri_query_client',
      '',
      'app.meri_query_portfolio',
      '',
      'app.meri_query_classic_ids',
      '',
    ]);
    expect(f.queries[8]!.values).toEqual(['capiro_private_query_ro', true]);
    expect(f.queries[11]).toEqual({ text: query.sql, values: [CLIENT, 201] });
  });
  it.each([
    [{ rows: [] }],
    [{ rows: [{ allowed: false }] }],
    [{ rows: [{ allowed: null }] }],
    [{ rows: [{ allowed: true }, { allowed: true }] }],
  ])('fails closed on role admission %j', async (admission) => {
    const f = fixture(admission);
    await expect(f.service.runPrivateSql(gated(), f.authority)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(f.events).not.toContain('data');
    expect(f.queries.map((q) => q.text)).toContain('ROLLBACK');
  });
  it('requires selected-client UUID and rejects missing/ambiguous context before DB work', async () => {
    for (const bad of [
      context({ clientId: CLIENT }),
      {
        ...context(),
        scopeKind: 'client',
        clientId: null,
      } as unknown as PrivateSqlExecutionContext,
      context({ tenantId: '' }),
      context({ actorId: 'not-an-actor' }),
      context({ assertCurrent: undefined }),
    ]) {
      const f = fixture();
      await expect(f.service.runPrivateSql(gated(), bad)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(f.pool.connect).not.toHaveBeenCalled();
    }
  });
  it('copies actor/client context before an awaited owner check', async () => {
    const f = fixture();
    const supplied = context({ scopeKind: 'client', clientId: CLIENT });
    (supplied as { assertCurrent(): Promise<void> }).assertCurrent = async () => {
      (supplied as { actorId: string }).actorId = '10000000-0000-4000-8000-000000000009';
      (supplied as { clientId: string }).clientId = '10000000-0000-4000-8000-000000000008';
    };
    await f.service.runPrivateSql(gated(), supplied);
    expect(f.queries[7]!.values).toEqual([
      'app.current_tenant',
      TENANT,
      'app.current_user',
      ACTOR,
      'app.meri_query_scope',
      'client',
      'app.meri_query_client',
      CLIENT,
      'app.meri_query_portfolio',
      '',
      'app.meri_query_classic_ids',
      '',
    ]);
  });
  it.each([1, 2])('withholds the result when current owner denies at check %i', async (at) => {
    const f = fixture();
    let checks = 0;
    const supplied = context({
      assertCurrent: async () => {
        if (++checks === at) throw new ForbiddenException('Access lost');
      },
    });
    await expect(f.service.runPrivateSql(gated(), supplied)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.events.includes('data')).toBe(at === 2);
  });
  it('describes the surface under the admitted context without dispatching model SQL', async () => {
    const f = fixture();
    expect((await f.service.describe(f.authority)).map((item) => item.name)).toEqual([
      ...PRIVATE_RELATION_NAMES,
    ]);
    expect(f.events).toEqual(['current', 'begin', 'commit', 'current']);
    expect(f.queries.some((q) => q.text.includes('client_objectives o'))).toBe(false);
  });
  it('caps statement time at the shorter request deadline and refuses expired work', async () => {
    const f = fixture();
    await f.service.runPrivateSql(gated(), context({ deadlineMs: clock + 125 }));
    expect(f.queries.map((q) => q.text)).toContain("SET LOCAL statement_timeout = '125ms'");
    const expired = fixture();
    await expect(
      expired.service.runPrivateSql(gated(), context({ deadlineMs: clock })),
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(expired.pool.connect).not.toHaveBeenCalled();
  });
  it.each([
    ['57014', 'QUERY_TIMEOUT', false],
    ['22P02', 'INVALID_QUERY', true],
    // Relation and permission errors are restated by translateDatabaseError; PostgreSQL's text never travels.
    ['42P01', 'UNKNOWN_RELATION', false],
    ['42501', 'UNKNOWN_RELATION', false],
    ['53300', 'SOURCE_UNAVAILABLE', false],
  ])(
    'translates private driver failure %s to %s (PostgreSQL message kept: %s)',
    async (code, expected, kept) => {
      const f = fixture();
      f.answers.splice(3, 2, Object.assign(new Error(`pg message ${code}`), { code }));
      const error = await f.service.runPrivateSql(gated(), f.authority).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: expected });
      expect(String((error as Error).message).includes('pg message')).toBe(kept);
    },
  );
  it('refuses connection configuration that is not the private reader', async () => {
    const service = new PrivateSqlDbService();
    const env = { ...process.env };
    try {
      Object.assign(process.env, {
        PRIVATE_QUERY_DB_HOST: 'h',
        PRIVATE_QUERY_DB_PORT: '5432',
        PRIVATE_QUERY_DB_USER: 'capiro_app',
        PRIVATE_QUERY_DB_PASSWORD: 'p',
        PRIVATE_QUERY_DB_NAME: 'capiro',
      });
      await expect(service.runPrivateSql(gated(), context())).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
    } finally {
      process.env = env;
    }
  });
});
