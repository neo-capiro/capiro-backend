import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { RerankingProvider } from '../reranking/reranking-provider.js';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RetrievalRerankerService } from './retrieval-reranker.service.js';
import type { RetrievalSourceAdapter } from './retrieval-source.adapter.js';
import type { RetrievalRecord, RetrievalRequest, RetrievalSourceResult } from './retrieval-v2.types.js';
import { RetrievalV2Service } from './retrieval-v2.service.js';

const priorEnabled = process.env.RETRIEVAL_RERANK_ENABLED;

beforeEach(() => {
  process.env.RETRIEVAL_RERANK_ENABLED = 'true';
});

afterEach(() => {
  if (priorEnabled === undefined) delete process.env.RETRIEVAL_RERANK_ENABLED;
  else process.env.RETRIEVAL_RERANK_ENABLED = priorEnabled;
});

const makeRecord = (id: string): RetrievalRecord => ({
  domain: 'clients',
  recordId: id,
  payload: { name: id },
  provenance: { evidenceId: `e-${id}`, source: 'client' },
});

const request: RetrievalRequest = {
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  query: 'best match',
};

describe('RetrievalV2Service Phase 13 reranking boundary', () => {
  test('reorders candidates but cannot upgrade degraded/incomplete coverage or rewrite provenance', async () => {
    const a = makeRecord('a');
    const b = makeRecord('b');
    const aProvenance = a.provenance;
    const bProvenance = b.provenance;
    const sourceResult: RetrievalSourceResult = {
      domain: 'clients',
      records: [a, b],
      returned: 2,
      hasMore: true,
      nextCursor: 'next',
      truncated: true,
      sourceStatus: 'degraded',
      recordsEvaluated: 2,
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      pagesRead: 1,
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'page_boundary_reached',
    };
    const adapter: RetrievalSourceAdapter = {
      key: 'core-prisma',
      domains: ['clients'],
      retrieve: jest.fn(async () => sourceResult),
    };
    const provider: RerankingProvider = {
      metadata: { provider: 'nvidia-nim', model: 'test-model', apiVersion: 'v1/ranking' },
      rerank: jest.fn(async () => ({
        rankings: [
          { index: 1, score: 9 },
          { index: 0, score: 2 },
        ],
      })),
    };
    const planner = new RetrievalPlannerV2Service(new SemanticDataCatalogService());
    const reranker = new RetrievalRerankerService(provider);
    const service = new RetrievalV2Service(planner, [adapter], undefined, reranker);

    const response = await service.retrieve(request);

    expect(response.records).toEqual([b, a]);
    expect(a.provenance).toBe(aProvenance);
    expect(b.provenance).toBe(bProvenance);
    expect(response.coverage).toMatchObject({
      complete: false,
      paginationComplete: false,
      unavailableSources: [],
    });
    expect(response.coverage.sources[0]).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      hasMore: true,
      stopReason: 'page_boundary_reached',
    });
    expect(response.observability).toMatchObject({
      coverageComplete: false,
      reranking: {
        status: 'applied',
        provider: 'nvidia-nim',
        model: 'test-model',
        candidateCount: 2,
        rerankedCount: 2,
      },
    });
  });
});
