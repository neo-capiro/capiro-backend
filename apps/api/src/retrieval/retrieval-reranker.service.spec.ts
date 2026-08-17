import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { RerankingProvider } from '../reranking/reranking-provider.js';
import type { RetrievalRecord, RetrievalRequest } from './retrieval-v2.types.js';
import { RetrievalRerankerService, recordToRerankPassage } from './retrieval-reranker.service.js';

const request = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'semantic_recall',
  requestedDomains: ['clients', 'mail'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  query: 'autonomous ground systems',
  ...overrides,
});

const makeRecord = (
  domain: RetrievalRecord['domain'],
  recordId: string,
  text: string,
): RetrievalRecord => ({
  domain,
  recordId,
  payload: { text },
  provenance: { source: `${domain}:${recordId}`, evidenceId: `e-${recordId}` },
});

function provider(): RerankingProvider {
  return {
    metadata: { provider: 'test-reranker', model: 'test-model', apiVersion: 'test-v1' },
    rerank: jest.fn(async () => ({
      rankings: [
        { index: 1, score: 7.5 },
        { index: 0, score: 2.5 },
      ],
    })),
  };
}

const priorEnabled = process.env.RETRIEVAL_RERANK_ENABLED;
const priorCap = process.env.RETRIEVAL_RERANK_MAX_CANDIDATES;

beforeEach(() => {
  process.env.RETRIEVAL_RERANK_ENABLED = 'true';
  delete process.env.RETRIEVAL_RERANK_MAX_CANDIDATES;
});

afterEach(() => {
  if (priorEnabled === undefined) delete process.env.RETRIEVAL_RERANK_ENABLED;
  else process.env.RETRIEVAL_RERANK_ENABLED = priorEnabled;
  if (priorCap === undefined) delete process.env.RETRIEVAL_RERANK_MAX_CANDIDATES;
  else process.env.RETRIEVAL_RERANK_MAX_CANDIDATES = priorCap;
});

describe('RetrievalRerankerService', () => {
  test('reorders the exact same records and preserves payload/provenance identity', async () => {
    const p = provider();
    const service = new RetrievalRerankerService(p);
    const a = makeRecord('clients', 'a', 'general robotics profile');
    const b = makeRecord('mail', 'b', 'autonomous ground systems fielding discussion');
    const aPayload = a.payload;
    const aProvenance = a.provenance;
    const bPayload = b.payload;
    const bProvenance = b.provenance;

    const result = await service.rerank(request(), [a, b]);

    expect(result.records).toEqual([b, a]);
    expect(result.records[0]).toBe(b);
    expect(result.records[1]).toBe(a);
    expect(a.payload).toBe(aPayload);
    expect(a.provenance).toBe(aProvenance);
    expect(b.payload).toBe(bPayload);
    expect(b.provenance).toBe(bProvenance);
    expect(result.observability).toMatchObject({
      status: 'applied',
      provider: 'test-reranker',
      model: 'test-model',
      candidateCount: 2,
      rerankedCount: 2,
      scores: [
        { domain: 'clients', recordId: 'a', originalRank: 1, finalRank: 2, score: 2.5 },
        { domain: 'mail', recordId: 'b', originalRank: 2, finalRank: 1, score: 7.5 },
      ],
    });
    expect(p.rerank).toHaveBeenCalledWith({
      query: 'autonomous ground systems',
      passages: [recordToRerankPassage(a), recordToRerankPassage(b)],
    });
  });

  test('falls back to baseline order when the provider fails', async () => {
    const p: RerankingProvider = {
      metadata: { provider: 'test-reranker', model: 'test-model', apiVersion: 'test-v1' },
      rerank: jest.fn(async () => {
        throw new Error('provider exploded with secret internals');
      }),
    };
    const service = new RetrievalRerankerService(p);
    const rows = [makeRecord('clients', 'a', 'alpha'), makeRecord('mail', 'b', 'beta')];

    const result = await service.rerank(request(), rows);

    expect(result.records).toEqual(rows);
    expect(result.observability).toMatchObject({
      status: 'fallback',
      fallbackReason: 'reranker_execution_failed',
      rerankedCount: 0,
      scores: [],
    });
    expect(JSON.stringify(result.observability)).not.toContain('secret internals');
  });

  test('never partially reranks when the candidate safety cap is exceeded', async () => {
    process.env.RETRIEVAL_RERANK_MAX_CANDIDATES = '2';
    const p = provider();
    const service = new RetrievalRerankerService(p);
    const rows = [
      makeRecord('clients', 'a', 'alpha'),
      makeRecord('mail', 'b', 'beta'),
      makeRecord('mail', 'c', 'gamma'),
    ];

    const result = await service.rerank(request(), rows);

    expect(result.records).toEqual(rows);
    expect(result.observability).toMatchObject({
      status: 'fallback',
      fallbackReason: 'candidate_safety_cap_exceeded',
      candidateCount: 3,
      rerankedCount: 0,
    });
    expect(p.rerank).not.toHaveBeenCalled();
  });

  test('stays dark unless explicitly enabled', async () => {
    process.env.RETRIEVAL_RERANK_ENABLED = 'false';
    const p = provider();
    const service = new RetrievalRerankerService(p);
    const rows = [makeRecord('clients', 'a', 'alpha'), makeRecord('mail', 'b', 'beta')];

    const result = await service.rerank(request(), rows);

    expect(result.records).toEqual(rows);
    expect(result.observability).toMatchObject({
      status: 'disabled',
      fallbackReason: 'reranking_disabled',
    });
    expect(p.rerank).not.toHaveBeenCalled();
  });

  test('uses exact lexical value as the relevance query when no free-text query is present', async () => {
    const p = provider();
    const service = new RetrievalRerankerService(p);
    const rows = [makeRecord('clients', 'a', 'alpha'), makeRecord('clients', 'b', 'beta')];

    await service.rerank(
      request({
        queryClass: 'lookup',
        requestedDomains: ['clients'],
        query: undefined,
        exactLexical: { kind: 'canonical_name', value: 'RTX' },
      }),
      rows,
    );

    expect(p.rerank).toHaveBeenCalledWith(expect.objectContaining({ query: 'RTX' }));
  });
});
