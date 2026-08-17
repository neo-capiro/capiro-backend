import type { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type {
  TemporalKnowledgeGraphEdge,
  TemporalKnowledgeGraphPartition,
} from '../../knowledge/graph/temporal-knowledge-graph.types.js';
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

function setup() {
  const walkAsOf = jest.fn().mockResolvedValue([edge]);
  const relationHistory = jest.fn().mockResolvedValue([edge]);
  const graph = { walkAsOf, relationHistory } as unknown as TemporalKnowledgeGraphService;
  const adapter = new InstitutionalKnowledgeRetrievalAdapter(graph);
  const dataset = new SemanticDataCatalogService().get('institutional_knowledge');
  return { adapter, dataset, walkAsOf, relationHistory };
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
});
