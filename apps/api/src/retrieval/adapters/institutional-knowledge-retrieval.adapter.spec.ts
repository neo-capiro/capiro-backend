import type { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import type { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type {
  TemporalKnowledgeGraphEdge,
  TemporalKnowledgeGraphPartition,
} from '../../knowledge/graph/temporal-knowledge-graph.types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import { InstitutionalKnowledgeRetrievalAdapter } from './institutional-knowledge-retrieval.adapter.js';

// These tests supply the graph/transaction ports; their unrelated service
// dependency graphs are not part of the canonical recall contract.
jest.mock('../../knowledge/graph/temporal-knowledge-graph.service.js', () => ({
  TemporalKnowledgeGraphService: jest.fn(),
}));
jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: jest.fn() }));

const partition: TemporalKnowledgeGraphPartition = {
  sensitivity: 'client_confidential',
  accessScope: { kind: 'client' },
  clientRefs: [{ type: 'client', id: 'client-1' }],
};

const edge: TemporalKnowledgeGraphEdge = {
  depth: 1,
  srcCanonicalEntityId: '11111111-1111-4111-8111-111111111111',
  dstCanonicalEntityId: '22222222-2222-4222-8222-222222222222',
  edgeType: 'works_with',
  confidence: 0.9,
  observedAt: new Date('2026-08-16T12:00:00.000Z'),
  validFrom: new Date('2026-08-01T00:00:00.000Z'),
  validUntil: null,
  assertionId: 'assertion-1',
  eventId: 'event-1',
  evidence: {
    id: 'evidence-1',
    sourceType: 'mail',
    sourceId: 'message-1',
    contentHash: 'abc123',
    startOffset: 4,
    endOffset: 19,
  },
  sensitivity: 'client_confidential',
  clientRefKeys: ['client:client-1'],
};

const historyRequest = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'relationship_history',
  requestedDomains: ['institutional_knowledge'],
  caller: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    graphPartitions: [partition],
  },
  canonicalEntityIds: [edge.srcCanonicalEntityId],
  windowStart: new Date('2026-08-01T00:00:00.000Z'),
  windowEnd: new Date('2026-08-17T00:00:00.000Z'),
  observedThrough: new Date('2026-08-16T23:59:59.000Z'),
  edgeTypes: ['works_with'],
  ...overrides,
});

const memoryRequest = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['institutional_knowledge'],
  caller: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    authorizedClientIds: [],
  },
  query: 'nickname',
  ...overrides,
});

function setup(
  options: {
    memories?: Array<{
      id: string;
      key: string;
      value: string;
      scope: string;
      clientId: string | null;
      ownerUserId: string | null;
      updatedAt: Date;
    }>;
    governed?: Array<Record<string, unknown>>;
    semanticScores?: Array<{ id: string; score: number }>;
    wallAllowed?: boolean;
    embed?: () => Promise<number[]>;
  } = {},
) {
  const walkAsOf = jest.fn().mockResolvedValue([edge]);
  const relationHistory = jest.fn().mockResolvedValue([edge]);
  const graph = { walkAsOf, relationHistory } as unknown as TemporalKnowledgeGraphService;
  const clioMemoryFindMany = jest.fn().mockResolvedValue(options.memories ?? []);
  const queryRawUnsafe = jest.fn().mockResolvedValue([{ allowed: options.wallAllowed !== false }]);
  const canonical =
    options.governed ??
    (options.memories ?? []).map((row) => ({
      ...row,
      tenantId: 'tenant-1',
      type: 'user-profile',
      slug: `canonical:${row.id}`,
      sections: [{ key: 'memory', heading: 'Memory', body: row.value }],
      visibility: row.scope === 'user_private' ? 'user' : 'tenant',
      memoryClass:
        row.scope === 'client'
          ? 'client_steering'
          : row.scope === 'firm'
            ? 'institutional_authoritative'
            : 'user_preference',
      authority:
        row.scope === 'client'
          ? 'client_approved'
          : row.scope === 'firm'
            ? 'firm_approved'
            : 'user_asserted',
      status: 'active',
      legacyStatus: 'active',
      sourceType: 'user_message',
      sourceId: 'message-1',
      sourceContentHash: 'canonical-hash',
      sourceVersion: 'candidate:approved',
      approvedByUserId: 'reviewer-1',
      approvedAt: new Date('2026-08-18T09:00:00Z'),
    }));
  const semanticById = new Map(
    (options.semanticScores ?? []).map((entry, index) => [
      entry.id,
      {
        semanticScore: entry.score,
        semanticRank: index + 1,
        embeddingContentHash: 'projection-hash',
      },
    ]),
  );
  const queryRaw = jest.fn(async (query: { text?: string }) =>
    query.text?.includes('mi.sections_jsonb AS sections')
      ? canonical.map((row) => ({ ...row, ...semanticById.get(String(row.id)) }))
      : [],
  );
  const tx = {
    clioMemory: { findMany: clioMemoryFindMany },
    $queryRawUnsafe: queryRawUnsafe,
    $queryRaw: queryRaw,
  };
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, fn: (value: unknown) => Promise<unknown>) => fn(tx),
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  const embeddingProvider = {
    metadata: {
      provider: 'test',
      model: 'test-memory-model',
      modelVersion: '1',
      dimensions: 1024,
    },
    embed: jest.fn(options.embed ?? (async () => Array<number>(1024).fill(0.1))),
    embedBatch: jest.fn(),
  } as unknown as EmbeddingProvider;
  const adapter = new InstitutionalKnowledgeRetrievalAdapter(graph, prisma, embeddingProvider);
  const dataset = new SemanticDataCatalogService().get('institutional_knowledge');
  return {
    adapter,
    dataset,
    walkAsOf,
    relationHistory,
    clioMemoryFindMany,
    queryRawUnsafe,
    queryRaw,
    withTenantUser,
    embeddingProvider,
  };
}

describe('InstitutionalKnowledgeRetrievalAdapter', () => {
  it('forwards the exact authorized Phase 8 graph partition and temporal cutoffs', async () => {
    const { adapter, dataset, relationHistory } = setup();
    const request = historyRequest();

    const result = await adapter.retrieve(dataset, request);

    expect(relationHistory).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      canonicalEntityId: edge.srcCanonicalEntityId,
      partition,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      observedThrough: request.observedThrough,
      edgeTypes: ['works_with'],
      rowBudget: 100,
      direction: 'both',
    });
    expect(result.sourceStatus).toBe('healthy');
    expect(result.coverageComplete).toBe(true);
  });

  it('preserves assertion/event/evidence provenance in the retrieval record', async () => {
    const { adapter, dataset } = setup();

    const result = await adapter.retrieve(dataset, historyRequest());

    expect(result.records[0]).toMatchObject({
      recordId: `assertion-1:${edge.srcCanonicalEntityId}:${edge.dstCanonicalEntityId}`,
      canonicalEntityIds: [edge.srcCanonicalEntityId, edge.dstCanonicalEntityId],
      provenance: {
        assertionId: 'assertion-1',
        eventId: 'event-1',
        evidenceId: 'evidence-1',
        contentHash: 'abc123',
        startOffset: 4,
        endOffset: 19,
      },
    });
  });

  it('fails closed without an already-authorized graph partition', async () => {
    const { adapter, dataset, relationHistory } = setup();

    const result = await adapter.retrieve(
      dataset,
      historyRequest({ caller: { tenantId: 'tenant-1', userId: 'user-1' } }),
    );

    expect(relationHistory).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      paginationComplete: false,
      stopReason: 'authorized_graph_partition_required',
    });
  });

  it('marks a bounded graph history result incomplete when the row budget is reached', async () => {
    const { adapter, dataset } = setup();

    const result = await adapter.retrieve(dataset, historyRequest({ pageSize: 1 }));

    expect(result).toMatchObject({
      returned: 1,
      hasMore: true,
      truncated: true,
      sourceStatus: 'degraded',
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'bounded_graph_row_budget_reached',
    });
  });

  it('uses walkAsOf for temporal state, keeps the exact partition, and never claims exhaustive coverage', async () => {
    const { adapter, dataset, walkAsOf } = setup();
    const asOf = new Date('2026-08-16T12:00:00.000Z');

    const result = await adapter.retrieve(
      dataset,
      historyRequest({
        queryClass: 'temporal_state',
        asOf,
        windowStart: undefined,
        windowEnd: undefined,
        observedThrough: undefined,
      }),
    );

    expect(walkAsOf).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        canonicalEntityId: edge.srcCanonicalEntityId,
        partition,
        asOf,
        direction: 'both',
      }),
    );
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      truncated: true,
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'bounded_graph_walk_no_exhaustive_proof',
    });
  });

  it('can prove a healthy empty governed-memory scan complete', async () => {
    const { adapter, dataset, clioMemoryFindMany, queryRaw } = setup({ memories: [] });

    const result = await adapter.retrieve(dataset, memoryRequest());

    expect(clioMemoryFindMany).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalled();
    expect(result).toMatchObject({
      records: [],
      returned: 0,
      sourceStatus: 'healthy',
      paginationComplete: true,
      coverageComplete: true,
      stopReason: 'governed_memory_scan_complete',
    });
  });

  it('returns governed memory through institutional knowledge with explicit provenance', async () => {
    const { adapter, dataset } = setup({
      memories: [
        {
          id: 'memory-1',
          key: 'nickname',
          value: 'Neo prefers to be called Neo',
          scope: 'user_private',
          clientId: null,
          ownerUserId: 'user-1',
          updatedAt: new Date('2026-08-18T10:00:00.000Z'),
        },
      ],
    });

    const result = await adapter.retrieve(dataset, memoryRequest());

    expect(result.records[0]).toMatchObject({
      domain: 'institutional_knowledge',
      recordId: 'memory-1',
      payload: {
        sourceKind: 'governed_memory',
        key: 'nickname',
        value: 'Neo prefers to be called Neo',
        scope: 'user_private',
      },
      provenance: {
        source: 'memory_items',
        recordId: 'memory-1',
        contentHash: 'canonical-hash',
        sourceVersion: 'candidate:approved',
      },
    });
    expect(result.coverageComplete).toBe(true);
  });

  it('fails closed before querying memory when requested client scope exceeds the authorization envelope', async () => {
    const { adapter, dataset, withTenantUser } = setup();

    const result = await adapter.retrieve(
      dataset,
      memoryRequest({
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          clientIds: ['client-1'],
          authorizedClientIds: [],
        },
      }),
    );

    expect(withTenantUser).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      stopReason: 'requested_client_scope_not_authorized',
    });
  });

  it('fails closed when the ethical wall denies a requested client memory scan', async () => {
    const { adapter, dataset, clioMemoryFindMany, queryRawUnsafe } = setup({ wallAllowed: false });

    const result = await adapter.retrieve(
      dataset,
      memoryRequest({
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          clientIds: ['client-1'],
          authorizedClientIds: ['client-1'],
        },
      }),
    );

    expect(queryRawUnsafe).toHaveBeenCalled();
    expect(clioMemoryFindMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      stopReason: 'requested_client_scope_failed_ethical_wall',
    });
  });

  it('keeps lexical recall but marks coverage degraded when semantic projection is unavailable', async () => {
    const { adapter, dataset } = setup({
      memories: [
        {
          id: 'memory-1',
          key: 'nickname',
          value: 'Neo',
          scope: 'user_private',
          clientId: null,
          ownerUserId: 'user-1',
          updatedAt: new Date('2026-08-18T10:00:00.000Z'),
        },
      ],
      embed: async () => {
        throw new Error('provider unavailable');
      },
    });

    const result = await adapter.retrieve(
      dataset,
      memoryRequest({ queryClass: 'semantic_recall' }),
    );

    expect(result.records).toHaveLength(1);
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'governed_memory_semantic_projection_incomplete',
    });
  });

  // Regression: one governed-memory row with no semantic embedding must NOT
  // poison coverage. Live 2026-08-23: 427/428 clio_memory rows had a
  // memory_items embedding; the 1 unmatched row made semanticMissing=true,
  // degrading the source and blocking Outreach V3 draft generation
  // (MESSAGE_PLAN_INVALID on a CONTEXT_PLANE_INCOMPLETE packet).
  it('does not degrade coverage when only a sparse row lacks a semantic embedding', async () => {
    const { adapter, dataset } = setup({
      semanticScores: [{ id: 'memory-1', score: 0.92 }],
      memories: [
        {
          id: 'memory-1',
          key: 'nickname',
          value: 'Neo prefers to be called Neo',
          scope: 'user_private',
          clientId: null,
          ownerUserId: 'user-1',
          updatedAt: new Date('2026-08-18T10:00:00.000Z'),
        },
        {
          id: 'memory-2',
          key: 'legacy',
          value: 'A legacy row with no embedding projection',
          scope: 'user_private',
          clientId: null,
          ownerUserId: 'user-1',
          updatedAt: new Date('2026-08-17T10:00:00.000Z'),
        },
      ],
      // Embedding provider works fine.
      embed: async () => Array<number>(1024).fill(0.1),
    });
    // Only memory-1 has an embedding score; memory-2 has none.

    const result = await adapter.retrieve(
      dataset,
      memoryRequest({ queryClass: 'semantic_recall' }),
    );

    expect(result.records).toHaveLength(2);
    expect(result).toMatchObject({
      sourceStatus: 'healthy',
      coverageComplete: true,
      stopReason: 'governed_memory_scan_complete',
    });
  });
});

function approved(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-approved',
    tenantId: 'tenant-1',
    key: 'Government funding constraint',
    sections: [
      {
        key: 'constraint',
        heading: 'Constraint',
        body: 'Do not pursue earmarks before client approval.',
      },
    ],
    type: 'client-compass',
    slug: 'canonical-memory',
    visibility: 'tenant',
    clientId: 'client-1',
    ownerUserId: null,
    scope: 'client',
    memoryClass: 'client_steering',
    authority: 'client_approved',
    status: 'active',
    legacyStatus: 'active',
    sourceType: 'approved_document_edit',
    sourceId: 'source-1',
    sourceContentHash: 'hash-1',
    sourceVersion: 'candidate:1',
    approvedByUserId: 'reviewer-1',
    approvedAt: new Date('2026-08-20T10:00:00Z'),
    updatedAt: new Date('2026-08-20T10:00:00Z'),
    ...overrides,
  };
}

const selectedClientRequest = () =>
  memoryRequest({
    caller: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      clientIds: ['client-1'],
      authorizedClientIds: ['client-1'],
    },
  });

describe('canonical institutional recall governance', () => {
  it('recalls an older approved MA510 candidate beyond 500 newer eligible rows', async () => {
    const newer = Array.from({ length: 500 }, (_, index) =>
      approved({
        id: `newer-${index}`,
        key: `Routine update ${index}`,
        sections: [{ key: 'memory', heading: 'Memory', body: `Routine update ${index}` }],
        updatedAt: new Date(2026, 7, 20, 0, index),
      }),
    );
    const ma510 = approved({
      id: 'MA510',
      key: 'Aster demonstration policy',
      sections: [
        {
          key: 'memory',
          heading: 'Memory',
          body: 'The autonomous maritime demo requires an approved safety review.',
        },
      ],
      updatedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const { adapter, dataset, queryRaw } = setup({ governed: [...newer, ma510] });

    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      query: 'What did we approve about the autonomous maritime demo?',
    });

    expect(result.records[0]).toMatchObject({ recordId: 'MA510' });
    const candidateSql = queryRaw.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(candidateSql.text.indexOf('governed_status')).toBeLessThan(
      candidateSql.text.indexOf('lexical_candidates AS'),
    );
    expect(candidateSql.text.indexOf('lexical_candidates AS')).toBeLessThan(
      candidateSql.text.indexOf('LIMIT'),
    );
    expect(candidateSql.values).toEqual(expect.arrayContaining(['autonomous', 'maritime', 'demo']));
  });

  it('reads canonical approved content without a Clio projection or embedding', async () => {
    const { adapter, dataset, clioMemoryFindMany, queryRaw } = setup({ governed: [approved()] });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(clioMemoryFindMany).not.toHaveBeenCalled();
    expect(queryRaw.mock.calls[0]![0].text).toContain('FROM memory_items mi');
    expect(queryRaw.mock.calls[0]![0].text).toContain("mi.status = 'active'");
    expect(queryRaw.mock.calls[0]![0].text).toContain(
      "mi.visibility = 'tenant' OR mi.owner_user_id",
    );
    expect(result.records[0]).toMatchObject({
      recordId: 'memory-approved',
      payload: {
        value: 'Do not pursue earmarks before client approval.',
        sections: [
          {
            key: 'constraint',
            heading: 'Constraint',
            characters: 'Do not pursue earmarks before client approval.'.length,
          },
        ],
        governance: { authority: 'client_approved', approvedByUserId: 'reviewer-1' },
      },
      provenance: {
        source: 'memory_items',
        sourceId: 'source-1',
        contentHash: 'hash-1',
        sourceVersion: 'candidate:1',
      },
    });
  });

  it.each([
    { status: 'revoked' },
    { status: 'superseded' },
    { status: 'pending_review' },
    { legacyStatus: 'revoked' },
    { approvedByUserId: null },
    { memoryClass: 'legacy_unclassified' },
    { memoryClass: 'unknown' },
    { tenantId: 'other-tenant' },
    { clientId: 'other-client' },
    { visibility: 'user', ownerUserId: 'other-user' },
    { scope: 'user_private', ownerUserId: 'other-user' },
    { validUntil: new Date('2020-01-01') },
    { expiresAt: new Date('2020-01-01') },
    { effectiveFrom: new Date('2999-01-01') },
    { sensitivity: 'restricted' },
    { status: 'conflicted', conflictStatus: 'open', controllingItemId: 'other-memory' },
  ])('withholds ineligible canonical content %j', async (override) => {
    const { adapter, dataset } = setup({ governed: [approved(override)] });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result.records).toEqual([]);
  });

  it('retains stale approved facts with explicit review metadata', async () => {
    const { adapter, dataset } = setup({
      governed: [approved({ status: 'stale', reviewDueAt: new Date('2020-01-01') })],
    });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result.records[0]?.payload.governance).toMatchObject({ status: 'stale', stale: true });
  });

  it('admits only the designated controlling claim of an unresolved conflict', async () => {
    const { adapter, dataset } = setup({
      governed: [
        approved({
          status: 'conflicted',
          conflictStatus: 'controlling',
          controllingItemId: 'memory-approved',
        }),
      ],
    });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result.records[0]?.payload.governance).toMatchObject({
      status: 'conflicted',
      controllingItemId: 'memory-approved',
    });
  });

  it('rechecks revocation and the ethical wall when a continuation is read', async () => {
    const { adapter, dataset, queryRaw, queryRawUnsafe } = setup({
      governed: [approved(), approved({ id: 'memory-next' })],
    });
    const request = { ...selectedClientRequest(), pageSize: 1 };
    const first = await adapter.retrieve(dataset, request);
    expect(first.nextCursor).toMatch(/^memory:v3:1:[a-f0-9]{64}$/);
    queryRaw.mockResolvedValue([
      approved({ status: 'revoked' }),
      approved({ id: 'memory-next', status: 'revoked' }),
    ]);
    const revoked = await adapter.retrieve(dataset, request, first.nextCursor);
    expect(revoked.records).toEqual([]);
    queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    const denied = await adapter.retrieve(dataset, request, first.nextCursor);
    expect(denied.sourceStatus).toBe('unauthorized');
    expect(denied.records).toEqual([]);
  });

  it('withholds pending, superseded, revoked, cross-tenant, cross-client and private rows on continuation', async () => {
    const rows = [
      approved({ id: 'first', key: 'alpha' }),
      approved({ id: 'second', key: 'beta', updatedAt: new Date('2026-08-19T10:00:00Z') }),
      approved({ id: 'pending', status: 'pending_review' }),
      approved({ id: 'superseded', status: 'superseded' }),
      approved({ id: 'revoked', status: 'revoked' }),
      approved({ id: 'other-tenant', tenantId: 'tenant-2' }),
      approved({ id: 'other-client', clientId: 'client-2' }),
      approved({ id: 'other-private', visibility: 'user', ownerUserId: 'user-2' }),
    ];
    const { adapter, dataset } = setup({ governed: rows });
    const request = { ...selectedClientRequest(), query: '', pageSize: 1 };

    const first = await adapter.retrieve(dataset, request);
    const second = await adapter.retrieve(dataset, request, first.nextCursor);

    expect([...first.records, ...second.records].map((record) => record.recordId).sort()).toEqual([
      'first',
      'second',
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.coverageComplete).toBe(true);
  });

  it('marks the safety cap incomplete instead of claiming all memory was searched', async () => {
    const { adapter, dataset } = setup({
      governed: Array.from({ length: 501 }, (_, i) => approved({ id: `memory-${i}` })),
    });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result).toMatchObject({
      truncated: true,
      coverageComplete: false,
      sourceStatus: 'degraded',
      stopReason: 'governed_memory_safety_cap_reached',
    });
  });
});

describe('canonical memory semantic fallback status', () => {
  it('reports query-wide embedding-index failure as degraded, while retaining approved lexical evidence', async () => {
    const { adapter, dataset, queryRaw, withTenantUser } = setup({ governed: [approved()] });
    queryRaw.mockImplementation(async (query) => {
      if (query.text?.includes('<=>')) throw new Error('embedding index unavailable');
      return [approved()];
    });
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      queryClass: 'semantic_recall',
    });
    expect(result.records).toHaveLength(1);
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'governed_memory_semantic_projection_incomplete',
    });
    expect(withTenantUser).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1]![0].text).not.toContain('<=>');
  });

  it('treats an empty provider vector as unavailable semantic projection', async () => {
    const { adapter, dataset } = setup({ governed: [approved()], embed: async () => [] });
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      queryClass: 'semantic_recall',
    });
    expect(result.records).toHaveLength(1);
    expect(result.sourceStatus).toBe('degraded');
  });

  it('rejects a non-1024 provider vector before SQL and uses a lexical transaction', async () => {
    const { adapter, dataset, queryRaw, withTenantUser } = setup({
      governed: [approved()],
      embed: async () => Array<number>(1023).fill(0.1),
    });
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      queryClass: 'semantic_recall',
    });
    expect(result).toMatchObject({ returned: 1, sourceStatus: 'degraded' });
    expect(withTenantUser).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]![0].text).not.toContain('<=>');
  });

  it('selects one exact embedding model in the governed candidate query and has no MIN/map rescore', async () => {
    const { adapter, dataset, queryRaw } = setup({
      governed: [approved()],
      semanticScores: [{ id: 'memory-approved', score: 0.91 }],
    });
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      queryClass: 'semantic_recall',
    });
    const sql = queryRaw.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(sql.text).toContain('ce.model =');
    expect(sql.text).not.toContain('MIN(ce.embedding');
    expect(sql.values).toContain('test-memory-model');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(result.records[0]?.retrievalSignals).toEqual({ semanticSimilarity: 0.91 });
  });
});

describe('canonical memory exact row narrowing', () => {
  it('uses the canonical UUID in the same governed/wall-filtered SQL before the row cap', async () => {
    const { adapter, dataset, queryRaw } = setup({ governed: [approved()] });
    const itemId = '11111111-1111-4111-8111-111111111111';
    await adapter.retrieve(dataset, { ...selectedClientRequest(), memoryItemId: itemId });
    const sql = queryRaw.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(sql.text).toContain('AND mi.id =');
    expect(sql.text).toContain('mi.governed_status');
    expect(sql.values).toContain(itemId);
  });
});

describe('Phase 3 fact content and bounded recall', () => {
  const fact = (id: string, body: string) =>
    approved({
      id,
      key: `learning-signal:crm.fill_with_meri:crm_finding_accepted:${id}`,
      sourceType: 'learning_signal_capture',
      sourceId: `signal-${id}`,
      sourceRef: `client_profile_fill_finding:${id}`,
      sourceExcerpt: body,
      sections: [{ key: 'memory', heading: 'Memory', body }],
    });

  it('returns actual approved capability, person and facility facts across every page with exact lineage', async () => {
    const rows = [
      fact('capability', 'name: FortressHUMS; description: UH-72 vibration monitoring'),
      fact('person', 'name: Dana Chen; role: VP of government affairs'),
      fact('facility', 'name: Orlando integration laboratory; city: Orlando; state: FL'),
      approved({ id: 'pending', status: 'pending_review' }),
      approved({ id: 'revoked', status: 'revoked' }),
      approved({ id: 'withdrawn', status: 'withdrawn' }),
      approved({ id: 'rejected', status: 'rejected' }),
      approved({ id: 'superseded', status: 'superseded' }),
    ];
    const { adapter, dataset } = setup({ governed: rows });
    const request = { ...selectedClientRequest(), pageSize: 1 };
    const found = [];
    let cursor: string | undefined;
    let result;
    do {
      result = await adapter.retrieve(dataset, request, cursor);
      found.push(...result.records);
      cursor = result.nextCursor;
    } while (cursor);
    expect(found).toHaveLength(3);
    expect(found.map((record) => record.payload.value).join(' ')).toContain(
      'UH-72 vibration monitoring',
    );
    expect(found.map((record) => record.payload.value).join(' ')).toContain('Dana Chen');
    expect(found.map((record) => record.payload.value).join(' ')).toContain(
      'Orlando integration laboratory',
    );
    for (const record of found) {
      expect(record.payload).toMatchObject({ contentStatus: 'available', clientId: 'client-1' });
      expect(record.payload.title).not.toContain('learning-signal:');
      expect(record.provenance).toMatchObject({
        sourceType: 'learning_signal_capture',
        sourceVersion: 'candidate:1',
      });
    }
    expect(result).toMatchObject({ total: 3, coverageComplete: true });
  });

  it('identifies the observed legacy learning JSON without inventing or replacing the approved body', async () => {
    const value = JSON.stringify({
      summary: 'crm_finding_accepted on crm.fill_with_meri, proposed layer client-steering.',
      proposedMemoryClass: 'client_steering',
      proposedMemoryAuthority: 'analyst_verified',
      proposedConfidence: 0.55,
      hasNote: false,
      reasons: [],
      sourceKind: 'capability',
      sourceSystem: 'client_document',
      note: 'Review the referenced evidence objects for full context before approving.',
    });
    const { adapter, dataset } = setup({ governed: [fact('legacy', value)] });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result.records[0]?.payload).toMatchObject({ value, contentStatus: 'metadata_only' });
    expect(result.records[0]?.payload.contentLimitation).toContain(
      'original source must be reviewed',
    );
    expect(result.records[0]?.payload.governance).toMatchObject({ status: 'active' });
  });

  it('retains a fact-bearing note in a structured learning record rather than declaring it metadata-only', async () => {
    const value = JSON.stringify({
      summary: 'crm_finding_accepted on crm.fill_with_meri',
      sourceKind: 'facility',
      note: 'Orlando integration laboratory operates in Florida.',
    });
    const { adapter, dataset } = setup({ governed: [fact('facility-note', value)] });
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result.records[0]?.payload).toMatchObject({
      value,
      contentStatus: 'available',
      contentLimitation: null,
    });
  });

  it('rejects a stale or cross-scope result cursor rather than skipping or mixing changed items', async () => {
    const { adapter, dataset, queryRaw } = setup({
      governed: [approved(), approved({ id: 'second' })],
    });
    const first = await adapter.retrieve(dataset, { ...selectedClientRequest(), pageSize: 1 });
    queryRaw.mockResolvedValue([
      approved({ id: 'new-first' }),
      approved(),
      approved({ id: 'second' }),
    ]);
    const next = await adapter.retrieve(
      dataset,
      { ...selectedClientRequest(), pageSize: 1 },
      first.nextCursor,
    );
    expect(next).toMatchObject({
      records: [],
      coverageComplete: false,
      stopReason: 'governed_memory_changed_restart_search',
    });
  });

  it.each(['source_hash', 'embedding_model', 'authorization_envelope'] as const)(
    'binds continuation cursors to %s',
    async (change) => {
      const rows = [approved(), approved({ id: 'second' })];
      const { adapter, dataset, queryRaw, embeddingProvider } = setup({ governed: rows });
      const firstRequest = { ...selectedClientRequest(), pageSize: 1 };
      const first = await adapter.retrieve(dataset, firstRequest);

      if (change === 'source_hash') {
        queryRaw.mockResolvedValue([
          approved({ sourceContentHash: 'changed-hash' }),
          approved({ id: 'second' }),
        ]);
      } else if (change === 'embedding_model') {
        (embeddingProvider.metadata as { model: string }).model = 'replacement-memory-model';
      }
      const nextRequest =
        change === 'authorization_envelope'
          ? {
              ...firstRequest,
              caller: {
                ...firstRequest.caller,
                authorizedClientIds: ['client-1', 'client-2'],
              },
            }
          : firstRequest;
      const next = await adapter.retrieve(dataset, nextRequest, first.nextCursor);

      expect(next).toMatchObject({
        records: [],
        coverageComplete: false,
        stopReason: 'governed_memory_changed_restart_search',
      });
    },
  );

  it('bounds a hung embedding provider before opening the fresh authorized transaction', async () => {
    jest.useFakeTimers();
    try {
      const { adapter, dataset, withTenantUser } = setup({
        governed: [approved()],
        embed: () => new Promise(() => {}),
      });
      const pending = adapter.retrieve(dataset, {
        ...selectedClientRequest(),
        queryClass: 'semantic_recall',
      });
      await jest.advanceTimersByTimeAsync(1_999);
      expect(withTenantUser).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(withTenantUser).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        returned: 1,
        sourceStatus: 'degraded',
        coverageComplete: false,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rechecks canonical eligibility after an aborted semantic transaction and discloses lexical-only recovery', async () => {
    const { adapter, dataset, withTenantUser } = setup({ governed: [approved()] });
    const original = withTenantUser.getMockImplementation()!;
    withTenantUser.mockImplementationOnce(async (tenant, user, callback) => {
      await original(tenant, user, callback);
      throw new Error('transaction was aborted');
    });
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      queryClass: 'semantic_recall',
    });
    expect(withTenantUser).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      returned: 1,
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'governed_memory_semantic_projection_incomplete',
    });
  });

  it('reports canonical read failure distinctly without raw exception details or an empty-success claim', async () => {
    const { adapter, dataset, queryRaw } = setup();
    queryRaw.mockRejectedValue(new Error('secret SQL connection string'));
    const result = await adapter.retrieve(dataset, selectedClientRequest());
    expect(result).toMatchObject({
      sourceStatus: 'error',
      records: [],
      coverageComplete: false,
      stopReason: 'governed_memory_canonical_read_failed',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects a non-UUID exact selector before SQL or provider work', async () => {
    const { adapter, dataset, withTenantUser, embeddingProvider } = setup();
    const result = await adapter.retrieve(dataset, {
      ...selectedClientRequest(),
      memoryItemId: 'learning-signal:wrong',
    });
    expect(result.stopReason).toBe('invalid_memory_item_id');
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(embeddingProvider.embed).not.toHaveBeenCalled();
  });
});
