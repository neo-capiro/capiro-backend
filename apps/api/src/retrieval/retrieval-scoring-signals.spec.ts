import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalScoringService } from './retrieval-scoring.service.js';
import type { RetrievalRecord, RetrievalRequest } from './retrieval-v2.types.js';

const priorMode = process.env.RETRIEVAL_SCORING_MODE;
beforeEach(() => { process.env.RETRIEVAL_SCORING_MODE = 'apply'; });
afterEach(() => {
  if (priorMode === undefined) delete process.env.RETRIEVAL_SCORING_MODE;
  else process.env.RETRIEVAL_SCORING_MODE = priorMode;
});

const scorer = () => new RetrievalScoringService(new SemanticDataCatalogService());
const baseRequest = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 't1', userId: 'u1' },
  ...overrides,
});
const row = (id: string, overrides: Partial<RetrievalRecord> = {}): RetrievalRecord => ({
  domain: 'clients',
  recordId: id,
  payload: { name: id },
  ...overrides,
});

describe('RetrievalScoringService signal extraction', () => {
  test('derives typed exact lexical relevance without guessing arbitrary identifiers', () => {
    const other = row('other', { payload: { name: 'Other' } });
    const exact = row('exact', { payload: { name: 'RTX', exactMatchKind: 'canonical_name' } });
    const result = scorer().score(
      baseRequest({ exactLexical: { kind: 'canonical_name', value: 'RTX' } }),
      [other, exact],
    );

    expect(result.records).toEqual([exact, other]);
    expect(result.observability.signalsUsed).toEqual(['lexical_exactness']);
  });

  test('uses explicitly authorized client scope only as relevance, never authorization', () => {
    const unrelated = row('other', { payload: { clientId: 'client-2' } });
    const scoped = row('scoped', { payload: { thread: { clientId: 'client-1' } } });
    const result = scorer().score(
      baseRequest({ caller: { tenantId: 't1', userId: 'u1', clientIds: ['client-1'] } }),
      [unrelated, scoped],
    );

    expect(result.records).toEqual([scoped, unrelated]);
    expect(result.observability.signalsUsed).toEqual(['client_relevance']);
  });

  test('uses freshness for current lookup priority', () => {
    const old = row('old', { updatedAt: new Date('2024-01-01T00:00:00Z') });
    const fresh = row('fresh', { updatedAt: new Date('2026-01-01T00:00:00Z') });
    const result = scorer().score(baseRequest(), [old, fresh]);

    expect(result.records).toEqual([fresh, old]);
    expect(result.observability.signalsUsed).toEqual(['freshness']);
    expect(result.observability.scores.find((score) => score.recordId === 'fresh')?.components)
      .toEqual(expect.arrayContaining([expect.objectContaining({ signalClass: 'freshness' })]));
  });

  test('uses bitemporal valid-from/valid-until as validity rather than confidence', () => {
    const expired = row('expired', {
      domain: 'institutional_knowledge',
      payload: {
        validFrom: '2020-01-01T00:00:00.000Z',
        validUntil: '2024-01-01T00:00:00.000Z',
      },
    });
    const valid = row('valid', {
      domain: 'institutional_knowledge',
      payload: { validFrom: '2020-01-01T00:00:00.000Z', validUntil: null },
    });
    const result = scorer().score(
      baseRequest({
        queryClass: 'temporal_state',
        requestedDomains: ['institutional_knowledge'],
        asOf: new Date('2025-01-01T00:00:00Z'),
      }),
      [expired, valid],
    );

    expect(result.records).toEqual([valid, expired]);
    expect(result.observability.signalsUsed).toEqual(['temporal_validity']);
    const component = result.observability.scores
      .find((score) => score.recordId === 'valid')
      ?.components.find((item) => item.signal === 'temporal_validity');
    expect(component).toMatchObject({ signalClass: 'validity', rawValue: 1 });
  });

  test('accepts a provider-neutral semantic score hint without coupling to an embedding vendor', () => {
    const lower = row('lower', { retrievalSignals: { semanticSimilarity: 0.4 } });
    const higher = row('higher', { retrievalSignals: { semanticSimilarity: 0.8 } });
    const result = scorer().score(baseRequest(), [lower, higher]);

    expect(result.records).toEqual([higher, lower]);
    expect(result.observability.signalsUsed).toEqual(['semantic_similarity']);
  });
});
