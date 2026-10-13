import { ServiceUnavailableException } from '@nestjs/common';
import {
  clientId,
  deniedId,
  deferred,
  graphOptions,
  harness,
  installHooks,
  tenantId,
  userId,
  walkRow,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

it('defaults to disabled and performs only the tenant settings read', async () => {
  const h = harness();
  await expect(h.service.getKnowledgeGraph(clientId, tenantId)).rejects.toBeInstanceOf(
    ServiceUnavailableException,
  );
  expect(h.calls.map((call) => call.operation)).toEqual(['settings']);
  expect(h.calls[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [{ where: { id: tenantId }, select: { settings: true } }],
  });
  expect(h.transactions).toEqual([{ id: 1, tenantId, options: undefined, outcome: 'commit' }]);
});

it.each([
  ['off overrides enabled env', 'off', 'cache', graphOptions],
  ['false overrides enabled env', false, 'cache', graphOptions],
  ['legacy overrides cache env', 'scoped', 'legacy', graphOptions],
  ['false traversal overrides cache env', 'scoped', false, graphOptions],
  ['env source remains legacy', 'scoped', undefined, { envIntelGraphOn: true }],
  ['unknown tenant values use disabled env', 'unknown', 'unknown', {}],
] as const)('rejects graph access when %s', async (_name, graph, traversal, opts) => {
  const h = harness({
    results: {
      settings: {
        settings: { clioFeatureFlags: { kgIntelGraph: graph, kgTraversalSource: traversal } },
      },
    },
  });
  const failure = h.service.getKnowledgeGraph(clientId, tenantId, opts);
  await expect(failure).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining('requires KG_INTEL_GRAPH/kgIntelGraph=scoped'),
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['settings']);
});

it.each([
  ['scoped/cache tenant overrides disabled env', 'scoped', 'cache', {}],
  ['boolean tenant overrides disabled env', true, true, {}],
  ['unknown flags use enabled env', 'unknown', 'unknown', graphOptions],
  ['missing flags use enabled env', undefined, undefined, graphOptions],
] as const)('permits graph access when %s', async (_name, graph, traversal, opts) => {
  const h = harness({
    results: {
      settings: {
        settings: { clioFeatureFlags: { kgIntelGraph: graph, kgTraversalSource: traversal } },
      },
    },
  });
  await expect(h.service.getKnowledgeGraph(clientId, tenantId, opts)).resolves.toEqual({
    nodes: [
      {
        id: `client:${clientId}`,
        type: 'client',
        label: 'Acme',
        metadata: { sectorTag: 'energy' },
      },
    ],
    edges: [],
    resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
  });
  expect(h.callsOf('walk')).toHaveLength(1);
});

it.each([new Error('settings offline'), 'settings string failure'])(
  'uses env gates and warns after settings failure %s',
  async (error) => {
    const h = harness({ errors: { settings: error } });
    await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
    expect(h.warnings).toEqual([
      `kg intel-graph settings read failed for tenant ${tenantId}; resolving gates from env: ${error instanceof Error ? error.message : error}`,
    ]);
    expect(h.transactions[0]!.outcome).toBe('rollback');
    expect(h.callsOf('walk')).toHaveLength(1);
  },
);

it('fails toward disabled env after a settings read error', async () => {
  const h = harness({ errors: { settings: new Error('unavailable') } });
  await expect(h.service.getKnowledgeGraph(clientId, tenantId)).rejects.toMatchObject({
    status: 503,
  });
  expect(h.calls).toHaveLength(1);
  expect(h.warnings[0]).toContain('unavailable');
});

it('launches client, mappings and bounded walk eagerly with exact tenant-pinned operands', async () => {
  const client = deferred<unknown>();
  const mappings = deferred<unknown>();
  const h = harness({ results: { client: client.promise, mappings: mappings.promise } });
  const pending = h.service.getKnowledgeGraph(clientId, tenantId, {
    ...graphOptions,
    viewerUserId: userId,
  });
  await h.started('walk');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'settings',
    'client',
    'mappings',
    'timeout',
    'denied',
    'walk',
  ]);
  expect(h.callsOf('client')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [
      { where: { id: clientId, tenantId }, select: { id: true, name: true, sectorTag: true } },
    ],
  });
  expect(h.callsOf('mappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [{ where: { clientId }, orderBy: { confidence: 'desc' } }],
  });
  expect(h.callsOf('denied')[0]!.args.slice(1)).toEqual([tenantId, userId]);
  client.resolve(null);
  mappings.resolve([]);
  const result = await pending;
  expect(result.nodes[0]).toEqual({
    id: `client:${clientId}`,
    type: 'client',
    label: clientId,
    metadata: { sectorTag: null },
  });
});

it.each([undefined, null])(
  'passes unidentified graph viewer %s as null to the real wall reader',
  async (viewerUserId) => {
    const h = harness();
    await h.service.getKnowledgeGraph(clientId, tenantId, { ...graphOptions, viewerUserId });
    expect(h.callsOf('denied')[0]!.args.slice(1)).toEqual([tenantId, null]);
  },
);

it('sets a ten-second local timeout before wall reads and bounded walk inside one thirty-second tenant transaction', async () => {
  const rows = [walkRow()];
  const h = harness({ results: { denied: [{ id: deniedId }, { id: userId }], walk: rows } });
  const result = await h.subject.walkClientGraph(tenantId, clientId, userId);
  expect(result).toBe(rows);
  expect(h.events).toEqual(['tenant.begin', 'timeout', 'denied', 'walk', 'tenant.commit']);
  expect(h.transactions).toEqual([
    { id: 1, tenantId, options: { timeoutMs: 30_000 }, outcome: 'commit' },
  ]);
  expect(h.calls.map((call) => [call.scope, call.tenantId, call.transaction])).toEqual([
    ['tenant', tenantId, 1],
    ['tenant', tenantId, 1],
    ['tenant', tenantId, 1],
  ]);
  expect(h.callsOf('timeout')[0]!.args).toEqual(["SET LOCAL statement_timeout = '10s'"]);
  const wall = h.callsOf('denied')[0]!;
  expect(String(wall.args[0]).replace(/\s+/g, ' ').trim()).toBe(
    'SELECT c.id FROM clients c WHERE c.tenant_id = $1::uuid AND c.memory_wall AND ($2::uuid IS NULL OR NOT EXISTS ( SELECT 1 FROM client_memory_access a WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id AND a.user_id = $2::uuid))',
  );
  expect(wall.args.slice(1)).toEqual([tenantId, userId]);
  const query = h.callsOf('walk')[0]!.query!;
  expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
    `SELECT depth, src_kind, src_id, dst_kind, dst_id, edge_type, confidence, source, observed_at, tenant_id FROM kg_walk_bounded( ?::uuid, '{${deniedId},${userId}}'::uuid[], 'client', ?, 2, NULL::text[], 25, 500, 'both')`,
  );
  expect(query.values).toEqual([tenantId, clientId]);
});

it('uses the canonical empty UUID array and null viewer for a direct unidentified walk', async () => {
  const h = harness();
  await h.subject.walkClientGraph(tenantId, clientId, null);
  expect(h.callsOf('walk')[0]!.query!.sql).toContain("'{}'::uuid[]");
  expect(h.callsOf('denied')[0]!.args.slice(1)).toEqual([tenantId, null]);
});

it('rejects a malformed denied UUID before any graph query and rolls back the wall transaction', async () => {
  const h = harness({ results: { denied: [{ id: 'not-a-uuid' }] } });
  await expect(h.subject.walkClientGraph(tenantId, clientId, null)).rejects.toThrow(
    'toUuidArrayLiteral: not a uuid: not-a-uuid',
  );
  expect(h.calls.map((call) => call.operation)).toEqual(['timeout', 'denied']);
  expect(h.transactions[0]!.outcome).toBe('rollback');
});

it.each([
  ['timeout', ['timeout']],
  ['denied', ['timeout', 'denied']],
  ['walk', ['timeout', 'denied', 'walk']],
] as const)(
  'propagates direct %s I/O failure without running later transaction operations',
  async (operation, expected) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.subject.walkClientGraph(tenantId, clientId, userId)).rejects.toBe(error);
    expect(h.calls.map((call) => call.operation)).toEqual(expected);
    expect(h.transactions[0]!.outcome).toBe('rollback');
  },
);

it.each(['timeout', 'denied', 'walk'] as const)(
  'degrades a %s walk failure to client and mappings while warning',
  async (operation) => {
    const h = harness({
      errors: { [operation]: new Error(`${operation} failed`) },
      results: { mappings: [{ confirmed: true, confidence: 0.73 }] },
    });
    const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
    expect(result.edges).toEqual([]);
    expect(result.nodes).toHaveLength(1);
    expect(result.resolutionQuality).toEqual({
      avgConfidence: 73,
      confirmedCount: 1,
      unconfirmedCount: 0,
    });
    expect(h.warnings).toEqual([
      `kg_walk_bounded failed for client ${clientId}; rendering client+mappings only: ${operation} failed`,
    ]);
    expect(h.transactions.find((tx) => tx.options)?.outcome).toBe('rollback');
  },
);

it('degrades UUID validation failures through the graph endpoint without querying the walk', async () => {
  const h = harness({ results: { denied: [{ id: 'bad' }] } });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.edges).toEqual([]);
  expect(h.callsOf('walk')).toHaveLength(0);
  expect(h.warnings[0]).toContain('toUuidArrayLiteral: not a uuid: bad');
});

it.each(['client', 'mappings'] as const)(
  'keeps %s read failures fatal rather than using the walk fallback',
  async (operation) => {
    const error = new Error(`${operation} denied`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).rejects.toBe(error);
    expect(h.callsOf('timeout')).toHaveLength(1);
    expect(h.warnings).toEqual([]);
  },
);
