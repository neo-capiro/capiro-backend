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

function setup(options: {
  memories?: Array<{
    id: string;
    key: string;
    value: string;
    scope: string;
    clientId: string | null;
    ownerUserId: string | null;
    updatedAt: Date;
  }>;
  wallAllowed?: boolean;
  embed?: () => Promise<number[]>;
} = {}) {
  const walkAsOf = jest.fn().mockResolvedValue([edge]);
  const relationHistory = jest.fn().mockResolvedValue([edge]);
  const graph = { walkAsOf, relationHistory } as unknown as TemporalKnowledgeGraphService;
  const clioMemoryFindMany = jest.fn().mockResolvedValue(options.memories ?? []);
  const queryRawUnsafe = jest
    .fn()
    .mockResolvedValue([{ allowed: options.wallAllowed !== false }]);
  const queryRaw = jest.fn().mockResolvedValue([]);
  const tx = {
    clioMemory: { findMany: clioMemoryFindMany },
    $queryRawUnsafe: queryRawUnsafe,
    $queryRaw: queryRaw,
  };
  const withTenantUser = jest.fn(
    async (_tenantId: string, _userId: string, fn: (value: unknown) => Promise<unknown>) =>
      fn(tx),
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  const embeddingProvider = {
    embed: jest.fn(options.embed ?? (async () => [0.1, 0.2, 0.3])),
  } as unknown as EmbeddingProvider;
  const adapter = new InstitutionalKnowledgeRetrievalAdapter(
    graph,
    prisma,
    embeddingProvider,
  );
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
    const { adapter, dataset, clioMemoryFindMany } = setup({ memories: [] });

    const result = await adapter.retrieve(dataset, memoryRequest());

    expect(clioMemoryFindMany).toHaveBeenCalled();
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
      provenance: { source: 'clio_memory', recordId: 'memory-1' },
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
    const { adapter, dataset, queryRaw } = setup({
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
      embed: async () => [0.1, 0.2, 0.3],
    });
    // Only memory-1 has an embedding score; memory-2 has none.
    queryRaw.mockResolvedValue([{ slug: 'clio:memory-1', score: 0.92 }]);

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
