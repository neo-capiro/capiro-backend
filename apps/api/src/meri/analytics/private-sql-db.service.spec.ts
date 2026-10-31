import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  PrivateSqlDbService,
  capturePrivateSqlContext,
  type PrivateSqlExecutionContext,
} from './private-sql-db.service.js';
import { RESEARCH_PORTFOLIO_QUERY_RELATIONS } from '../../research-portfolios/research-portfolio-query-projections.js';
import { CLASSIC_OUTREACH_QUERY_RELATION } from '../../engagement/classic-outreach-query-projection.js';
import { compileScopedSql } from './sql-query-compiler.js';

jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
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
const compiled = () =>
  compileScopedSql(
    {
      sql: 'SELECT COUNT(*) AS count FROM client_objectives o WHERE o.id>$1',
      parameters: [CLIENT],
    },
    [
      {
        name: 'client_objectives',
        schema: 'meri_private',
        table: 'client_objectives',
        fields: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            description: 'Synthetic fixture ID',
            parameterType: 'UUID',
          },
        ],
        primaryKey: ['id'],
        relationships: [],
      },
    ],
  );
function fixture(admission: unknown = [{ allowed: true }]) {
  const events: string[] = [];
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce(admission)
      .mockImplementation(async () => {
        events.push('data');
        return [{ count: '9007199254740993' }];
      }),
  };
  const client = {
    $transaction: jest.fn(async (run: (connection: typeof tx) => unknown) => {
      events.push('begin');
      const out = await run(tx);
      events.push('commit');
      return out;
    }),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PrivateSqlDbService();
  (service as unknown as { client: unknown }).client = client;
  const authority = context({
    assertCurrent: jest.fn(async () => {
      events.push('current');
    }),
  });
  return { service, tx, client, events, authority };
}

describe('private SQL execution isolation (mock transport; native role proof remains separate)', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(clock);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('binds trusted scope locally, admits before SQL and rechecks outside the completed transaction', async () => {
    const f = fixture(),
      query = compiled();
    expect(await f.service.runPrivateSql(query, f.authority)).toEqual([
      { count: '9007199254740993' },
    ]);
    expect(f.events).toEqual(['current', 'begin', 'data', 'commit', 'current']);
    expect(f.tx.$executeRawUnsafe.mock.calls[0]).toEqual(['SET TRANSACTION READ ONLY']);
    expect(f.tx.$executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('set_config'))).toEqual([
      expect.stringContaining("set_config('app.meri_query_scope', $3, true)"),
      TENANT,
      ACTOR,
      'general',
      '',
      '',
      '',
    ]);
    expect(f.tx.$queryRawUnsafe).toHaveBeenLastCalledWith(query.sql, CLIENT);
    expect(f.tx.$queryRawUnsafe.mock.calls[0][0]).toContain('capiro_private_query_ro');
    expect(f.tx.$queryRawUnsafe.mock.calls[0][0]).toContain('has_any_column_privilege');
  });
  it.each(
    [[], [{ allowed: false }], [{ allowed: null }], [{ allowed: true }, { allowed: true }]].map(
      (admission) => ({ admission }),
    ),
  )('fails closed on role/view/grant admission $admission', async ({ admission }) => {
    const f = fixture(admission);
    await expect(f.service.runPrivateSql(compiled(), f.authority)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain('data');
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
      await expect(f.service.runPrivateSql(compiled(), bad)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(f.client.$transaction).not.toHaveBeenCalled();
    }
  });
  it('copies actor/client context before an awaited owner check', async () => {
    const f = fixture();
    const supplied = context({ scopeKind: 'client', clientId: CLIENT });
    (supplied as { assertCurrent(): Promise<void> }).assertCurrent = async () => {
      (supplied as { actorId: string }).actorId = '10000000-0000-4000-8000-000000000009';
      (supplied as { clientId: string }).clientId = '10000000-0000-4000-8000-000000000008';
    };
    await f.service.runPrivateSql(compiled(), supplied);
    expect(
      f.tx.$executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('set_config'))?.slice(1),
    ).toEqual([TENANT, ACTOR, 'client', CLIENT, '', '']);
  });
  it.each([1, 2])('withholds the result when current owner denies at check %i', async (at) => {
    const f = fixture();
    let checks = 0;
    const supplied = context({
      assertCurrent: async () => {
        if (++checks === at) throw new ForbiddenException('Access lost');
      },
    });
    await expect(f.service.runPrivateSql(compiled(), supplied)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.events.includes('data')).toBe(at === 2);
  });
  it('checks view availability for discovery without dispatching model SQL', async () => {
    const f = fixture();
    await expect(f.service.assertAvailable(f.authority)).resolves.toBeUndefined();
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['current', 'begin', 'commit', 'current']);
  });
  it('caps transaction/statement time at the shorter request deadline and refuses expired work', async () => {
    const f = fixture();
    await f.service.runPrivateSql(compiled(), context({ deadlineMs: clock + 125 }));
    expect(f.client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 125,
      maxWait: 125,
    });
    expect(f.tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL statement_timeout = '125ms'");
    const expired = fixture();
    await expect(
      expired.service.runPrivateSql(compiled(), context({ deadlineMs: clock })),
    ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    expect(expired.client.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['57014', 'QUERY_TIMEOUT'],
    ['22P02', 'INVALID_QUERY'],
    ['42P08', 'INVALID_QUERY'],
    ['42P18', 'INVALID_QUERY'],
    ['42501', 'SOURCE_UNAVAILABLE'],
  ])('sanitizes private driver failure %s', async (code, expected) => {
    const f = fixture();
    f.tx.$queryRawUnsafe
      .mockReset()
      .mockRejectedValue({ code: 'P2010', meta: { code, message: 'secret SQL and credentials' } });
    const error = await f.service.runPrivateSql(compiled(), f.authority).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: expected });
    expect(String(error)).not.toContain('secret');
  });
  it('refuses a lossy numeric driver value rather than fabricating an exact count', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe
      .mockReset()
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValue([{ count: 9007199254740992 }]);
    await expect(f.service.runPrivateSql(compiled(), f.authority)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
  });

  it('binds the captured Research portfolio and clears Classic IDs while preserving currentness', async () => {
    const f = fixture();
    const query = compileScopedSql(
      { sql: 'SELECT COUNT(*) AS count FROM research_portfolios', parameters: [] },
      RESEARCH_PORTFOLIO_QUERY_RELATIONS,
    );
    await f.service.runPrivateSql(
      query,
      context({ scopeKind: 'research_portfolio', clientId: null, researchPortfolioId: CLIENT }),
    );
    expect(
      f.tx.$executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('set_config'))?.slice(1),
    ).toEqual([TENANT, ACTOR, 'research_portfolio', '', CLIENT, '']);
    expect(f.events).toEqual(['begin', 'data', 'commit']);
  });
  it.each([0, 1, 100])(
    'binds a complete immutable Classic set of %i IDs before execution',
    async (size) => {
      const ids = Array.from(
        { length: size },
        (_, i) => '20000000-0000-4000-8000-' + String(i).padStart(12, '0'),
      );
      const originalIds = [...ids];
      const f = fixture();
      const query = compileScopedSql(
        { sql: 'SELECT COUNT(*) AS count FROM classic_outreach_records', parameters: [] },
        [CLASSIC_OUTREACH_QUERY_RELATION],
        { classic_outreach_records: ids },
      );
      const supplied = context({
        scopeKind: 'classic_outreach',
        clientId: CLIENT,
        classicOutreachIds: ids,
        assertCurrent: async () => {
          ids.splice(0, ids.length, ACTOR);
        },
      });
      await f.service.runPrivateSql(query, supplied);
      expect(
        f.tx.$executeRawUnsafe.mock.calls.find(([sql]) => sql.includes('set_config'))?.slice(1),
      ).toEqual([TENANT, ACTOR, 'classic_outreach', CLIENT, '', originalIds.join(',')]);
      expect(f.tx.$queryRawUnsafe).toHaveBeenLastCalledWith(query.sql, ...query.params);
    },
  );
  it('freezes copied Classic IDs and does not convert missing authority to the empty set', () => {
    const ids = [CLIENT];
    const captured = capturePrivateSqlContext(
      context({ scopeKind: 'classic_outreach', clientId: null, classicOutreachIds: ids }),
    );
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured.scopeKind !== 'classic_outreach') throw new Error('expected Classic');
    expect(Object.isFrozen(captured.classicOutreachIds)).toBe(true);
    ids[0] = ACTOR;
    expect(captured.classicOutreachIds).toEqual([CLIENT]);
  });
  it.each([
    { scopeKind: 'research_portfolio', clientId: null },
    { scopeKind: 'research_portfolio', clientId: CLIENT, researchPortfolioId: CLIENT },
    { scopeKind: 'research_portfolio', clientId: null, researchPortfolioId: 'not-a-uuid' },
    {
      scopeKind: 'research_portfolio',
      clientId: null,
      researchPortfolioId: CLIENT,
      classicOutreachIds: [],
    },
    { scopeKind: 'general', clientId: null, researchPortfolioId: CLIENT },
    { scopeKind: 'client', clientId: CLIENT, classicOutreachIds: [] },
    { scopeKind: 'classic_outreach', clientId: null },
    { scopeKind: 'classic_outreach', clientId: 'invalid', classicOutreachIds: [] },
    { scopeKind: 'classic_outreach', clientId: null, classicOutreachIds: [CLIENT, CLIENT] },
    {
      scopeKind: 'classic_outreach',
      clientId: null,
      classicOutreachIds: ['abcdefab-0000-4000-8000-000000000001'.toUpperCase()],
    },
    { scopeKind: 'classic_outreach', clientId: null, classicOutreachIds: ['bad,ids'] },
    { scopeKind: 'classic_outreach', clientId: null, classicOutreachIds: new Array(1) },
    {
      scopeKind: 'classic_outreach',
      clientId: null,
      classicOutreachIds: Array.from(
        { length: 101 },
        (_, i) => '20000000-0000-4000-8000-' + String(i).padStart(12, '0'),
      ),
    },
    {
      scopeKind: 'classic_outreach',
      clientId: null,
      classicOutreachIds: [],
      researchPortfolioId: CLIENT,
    },
  ])(
    'refuses malformed or ambiguous domain authority before opening a transaction %#',
    async (selectors) => {
      const f = fixture();
      await expect(
        f.service.assertAvailable({ ...context(), ...selectors } as PrivateSqlExecutionContext),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.client.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects cross-source compiled relations before currentness or DB work', async () => {
    const queries = [
      compiled(),
      compileScopedSql(
        { sql: 'SELECT COUNT(*) AS count FROM research_portfolios', parameters: [] },
        RESEARCH_PORTFOLIO_QUERY_RELATIONS,
      ),
      compileScopedSql(
        { sql: 'SELECT COUNT(*) AS count FROM classic_outreach_records', parameters: [] },
        [CLASSIC_OUTREACH_QUERY_RELATION],
        { classic_outreach_records: [] },
      ),
    ];
    const contexts = [
      context(),
      context({ scopeKind: 'research_portfolio', researchPortfolioId: CLIENT }),
      context({ scopeKind: 'classic_outreach', classicOutreachIds: [] }),
    ];
    for (let i = 0; i < queries.length; i++)
      for (let j = 0; j < contexts.length; j++)
        if (i !== j) {
          const f = fixture(),
            supplied = contexts[j]!;
          await expect(f.service.runPrivateSql(queries[i]!, supplied)).rejects.toMatchObject({
            code: 'SOURCE_UNAVAILABLE',
          });
          expect(supplied.assertCurrent).not.toHaveBeenCalled();
          expect(f.client.$transaction).not.toHaveBeenCalled();
        }
  });
  it('clears domain GUCs explicitly across reused transport transactions for every scope', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockReset().mockResolvedValue([{ allowed: true }]);
    for (const supplied of [
      context({ scopeKind: 'research_portfolio', researchPortfolioId: CLIENT }),
      context({ scopeKind: 'classic_outreach', classicOutreachIds: [CLIENT] }),
      context({ scopeKind: 'client', clientId: CLIENT }),
      context(),
    ])
      await f.service.assertAvailable(supplied);
    const bindings = f.tx.$executeRawUnsafe.mock.calls
      .filter(([sql]) => sql.includes('set_config'))
      .map((call) => call.slice(1));
    expect(bindings).toEqual([
      [TENANT, ACTOR, 'research_portfolio', '', CLIENT, ''],
      [TENANT, ACTOR, 'classic_outreach', '', '', CLIENT],
      [TENANT, ACTOR, 'client', CLIENT, '', ''],
      [TENANT, ACTOR, 'general', '', '', ''],
    ]);
  });
  it('requires the coupled exact expanded catalog and minimal owner column privileges', async () => {
    const f = fixture();
    await f.service.assertAvailable(f.authority);
    const admission = f.tx.$queryRawUnsafe.mock.calls[0][0];
    expect(admission).toContain('(SELECT count(*) FROM views) = 19');
    expect(admission).toContain('(SELECT count(*) FROM sources) = 23');
    expect(admission).toContain('source_columns (table_name, columns)');
    expect(admission).toContain('pg_catalog.cardinality(expected.columns)');
    expect(admission).toContain('NOT a.attname = ANY(expected.columns)');
    expect(admission).toContain("relname <> 'visible_clients'");
    expect(admission).toContain('s.relforcerowsecurity');
  });

  it('owns and closes only its separate lazy client', async () => {
    const f = fixture();
    await f.service.onModuleDestroy();
    await f.service.onModuleDestroy();
    expect(f.client.$disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('private credential separation', () => {
  const keys = ['HOST', 'PORT', 'USER', 'PASSWORD', 'NAME', 'SSLMODE'].map(
    (k) => `PRIVATE_QUERY_DB_${k}`,
  );
  let saved: (string | undefined)[];
  beforeEach(() => {
    saved = keys.map((k) => process.env[k]);
    keys.forEach((k) => delete process.env[k]);
    (PrismaClient as unknown as jest.Mock).mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(clock);
  });
  afterEach(() => {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
    jest.restoreAllMocks();
  });
  it('does not fall back to an application/public URL or construct a client when private config is absent', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://capiro_app:synthetic@invalid:5432/capiro';
    try {
      await expect(new PrivateSqlDbService().assertAvailable(context())).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE',
      });
      expect(PrismaClient).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
  it.each([
    ['USER', 'capiro_app'],
    ['PASSWORD', '***'],
    ['PORT', '5432/other'],
    ['HOST', 'host?user=capiro_app'],
  ])('refuses invalid dedicated %s before connecting', async (key, value) => {
    Object.assign(process.env, {
      PRIVATE_QUERY_DB_HOST: 'private-db',
      PRIVATE_QUERY_DB_PORT: '5432',
      PRIVATE_QUERY_DB_USER: 'capiro_private_query_ro',
      PRIVATE_QUERY_DB_PASSWORD: 'synthetic',
      PRIVATE_QUERY_DB_NAME: 'capiro',
    });
    process.env[`PRIVATE_QUERY_DB_${key}`] = value;
    await expect(new PrivateSqlDbService().assertAvailable(context())).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(PrismaClient).not.toHaveBeenCalled();
  });
});
