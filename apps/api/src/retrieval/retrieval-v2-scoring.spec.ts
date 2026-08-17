import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RetrievalScoringService } from './retrieval-scoring.service.js';
import type { RetrievalSourceAdapter } from './retrieval-source.adapter.js';
import type { RetrievalRecord, RetrievalRequest, RetrievalSourceResult } from './retrieval-v2.types.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';

const priorMode = process.env.RETRIEVAL_SCORING_MODE;

beforeEach(() => {
  process.env.RETRIEVAL_SCORING_MODE = 'apply';
});

afterEach(() => {
  if (priorMode === undefined) delete process.env.RETRIEVAL_SCORING_MODE;
  else process.env.RETRIEVAL_SCORING_MODE = priorMode;
});

const request: RetrievalRequest = {
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  query: 'robotics',
};

const makeRecord = (id: string, similarity: number): RetrievalRecord => ({
  domain: 'clients',
  recordId: id,
  payload: { name: id },
  provenance: { evidenceId: `e-${id}`, source: 'client' },
  retrievalSignals: { semanticSimilarity: similarity },
});

describe('RetrievalV2Service Phase 14 scoring boundary', () => {
  test('reorders retrieval priority without changing source coverage or provenance', async () => {
    const low = makeRecord('low', 0.2);
    const high = makeRecord('high', 0.9);
    const lowProvenance = low.provenance;
    const highProvenance = high.provenance;

    const sourceResult: RetrievalSourceResult = {
      domain: 'clients',
      records: [low, high],
      total: 2,
      returned: 2,
      hasMore: false,
      truncated: false,
      sourceStatus: 'healthy',
      recordsEvaluated: 2,
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      pagesRead: 1,
      paginationComplete: true,
      coverageComplete: true,
      stopReason: 'authoritative_page_complete',
    };
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: jest.fn(async () => sourceResult),
    };
    const catalog = new SemanticDataCatalogService();
    const planner = new RetrievalPlannerV2Service(catalog);
    const scoring = new RetrievalScoringService(catalog);
    const service = new RetrievalV2Service(planner, [adapter], undefined, undefined, scoring);

    const response = await service.retrieve(request);

    expect(response.records).toEqual([high, low]);
    expect(response.records[0]).toBe(high);
    expect(response.records[1]).toBe(low);
    expect(low.provenance).toBe(lowProvenance);
    expect(high.provenance).toBe(highProvenance);
    expect(response.coverage).toMatchObject({
      complete: true,
      paginationComplete: true,
      recordsReturned: 2,
      stopReason: 'complete',
    });
    expect(response.coverage.sources[0]).toMatchObject({
      sourceStatus: 'healthy',
      coverageComplete: true,
      returned: 2,
      stopReason: 'authoritative_page_complete',
    });
    expect(response.observability.scoring).toMatchObject({
      status: 'applied',
      algorithm: 'rrf',
      applied: true,
      signalsUsed: ['semantic_similarity'],
    });
  });
});
