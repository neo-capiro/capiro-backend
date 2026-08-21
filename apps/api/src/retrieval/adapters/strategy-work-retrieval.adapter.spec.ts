import { StrategyWorkRetrievalAdapter } from './strategy-work-retrieval.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const dataset = {
  domain: 'strategies_work',
  label: 'Strategies and Work',
  description: 'Strategy state',
  entityKinds: ['strategy'],
  sourceKind: 'live_structured',
  authority: 'tenant_system_of_record',
  tenantScope: 'tenant_private',
  temporalSemantics: 'current state',
  supportedQueryClasses: ['lookup'],
  queryCapabilities: {
    exactFiltering: true,
    dateRange: true,
    pagination: true,
    exhaustiveScan: true,
    temporalHistory: false,
  },
  adapterKey: 'strategies-work',
  freshnessDescription: 'database state',
} as const;

function request(overrides: Record<string, unknown> = {}) {
  return {
    queryClass: 'lookup',
    requestedDomains: ['strategies_work'],
    caller: {
      tenantId: TENANT,
      userId: USER,
      authorizedClientIds: [CLIENT],
      clientIds: [CLIENT],
    },
    pageSize: 50,
    ...overrides,
  } as never;
}

function harness(opts: { visible?: boolean; rows?: unknown[] } = {}) {
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue(
        opts.visible === false ? [] : [{ id: CLIENT }],
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue(opts.rows ?? []),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  };
  return {
    adapter: new StrategyWorkRetrievalAdapter(prisma as never),
    prisma,
    tx,
  };
}

describe('StrategyWorkRetrievalAdapter', () => {
  test('requires an explicit client subject inside the security envelope', async () => {
    const h = harness();
    const result = await h.adapter.retrieve(
      dataset as never,
      request({
        caller: {
          tenantId: TENANT,
          userId: USER,
          authorizedClientIds: [CLIENT],
          clientIds: [],
        },
      }),
    );
    expect(result.sourceStatus).toBe('unauthorized');
    expect(result.stopReason).toBe('client_subject_required');
    expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
  });

  test('rejects a requested client outside the caller envelope', async () => {
    const h = harness();
    const result = await h.adapter.retrieve(
      dataset as never,
      request({
        caller: {
          tenantId: TENANT,
          userId: USER,
          authorizedClientIds: [],
          clientIds: [CLIENT],
        },
      }),
    );
    expect(result.sourceStatus).toBe('unauthorized');
    expect(result.stopReason).toBe('client_outside_security_envelope');
    expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
  });

  test('rechecks current CRM status and ethical-wall access before reading sp_*', async () => {
    const h = harness({ visible: false });
    const result = await h.adapter.retrieve(dataset as never, request());
    expect(result.sourceStatus).toBe('unauthorized');
    expect(result.stopReason).toBe('client_wall_or_status_denied');
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [CLIENT] },
          status: { not: 'archived' },
        }),
      }),
    );
  });

  test('projects active Strategy/Steward rows with source provenance and no write authority', async () => {
    const updatedAt = new Date('2026-08-20T12:00:00.000Z');
    const h = harness({
      rows: [
        {
          recordKey: 'strategy:s1',
          recordId: 's1',
          recordKind: 'strategy',
          clientId: CLIENT,
          updatedAt,
          payload: {
            kind: 'strategy',
            id: 's1',
            clientId: CLIENT,
            title: 'FY27 plan',
            nodes: [],
          },
        },
        {
          recordKey: 'fact:f1',
          recordId: 'f1',
          recordKind: 'context_fact',
          clientId: CLIENT,
          updatedAt,
          payload: {
            kind: 'context_fact',
            id: 'f1',
            fact: 'Approved objective',
            sourceRef: 'heading:Goal',
          },
        },
      ],
    });

    const result = await h.adapter.retrieve(dataset as never, request());
    expect(result.sourceStatus).toBe('healthy');
    expect(result.coverageComplete).toBe(true);
    expect(result.paginationComplete).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      domain: 'strategies_work',
      recordId: 'strategy:s1',
      provenance: {
        adapter: 'strategies-work',
        sourceTable: 'sp_strategy/sp_node',
        tenantId: TENANT,
        clientId: CLIENT,
      },
    });
    expect(result.records[1]).toMatchObject({
      recordId: 'context_fact:f1',
      provenance: { sourceTable: 'sp_context_fact' },
    });
    expect(result.lastSyncAt).toEqual(updatedAt);
  });

  test('zero rows are complete only after the authoritative query actually runs', async () => {
    const h = harness({ rows: [] });
    const result = await h.adapter.retrieve(dataset as never, request());
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.records).toEqual([]);
    expect(result.sourceStatus).toBe('healthy');
    expect(result.coverageComplete).toBe(true);
    expect(result.stopReason).toBe('complete');
  });

  test('unsupported query classes never touch Strategy tables', async () => {
    const h = harness();
    const result = await h.adapter.retrieve(
      dataset as never,
      request({ queryClass: 'semantic_recall' }),
    );
    expect(result.sourceStatus).toBe('unsupported');
    expect(result.coverageComplete).toBe(false);
    expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
  });

  test('pagination reports an incomplete source rather than pretending the first page is exhaustive', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      recordKey: `strategy:s${index}`,
      recordId: `s${index}`,
      recordKind: 'strategy',
      clientId: CLIENT,
      updatedAt: new Date('2026-08-20T12:00:00.000Z'),
      payload: { kind: 'strategy', id: `s${index}` },
    }));
    const h = harness({ rows });
    const result = await h.adapter.retrieve(
      dataset as never,
      request({ pageSize: 2 }),
    );
    expect(result.records).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.paginationComplete).toBe(false);
    expect(result.coverageComplete).toBe(false);
    expect(result.nextCursor).toBe('strategy:s1');
  });
});
