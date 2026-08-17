import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { SemanticDataCatalogService } from './data-catalog/semantic-data-catalog.service.js';
import { RetrievalScoringService } from './retrieval-scoring.service.js';
import type { RetrievalRecord, RetrievalRequest } from './retrieval-v2.types.js';

const priorMode = process.env.RETRIEVAL_SCORING_MODE;
const priorK = process.env.RETRIEVAL_RRF_K;

beforeEach(() => {
  process.env.RETRIEVAL_SCORING_MODE = 'shadow';
  delete process.env.RETRIEVAL_RRF_K;
});

afterEach(() => {
  if (priorMode === undefined) delete process.env.RETRIEVAL_SCORING_MODE;
  else process.env.RETRIEVAL_SCORING_MODE = priorMode;
  if (priorK === undefined) delete process.env.RETRIEVAL_RRF_K;
  else process.env.RETRIEVAL_RRF_K = priorK;
});

const request = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  query: 'robotics',
  ...overrides,
});

const record = (id: string, overrides: Partial<RetrievalRecord> = {}): RetrievalRecord => ({
  domain: 'clients',
  recordId: id,
  payload: { name: id },
  provenance: { source: 'test', id },
  ...overrides,
});

function service(): RetrievalScoringService {
  return new RetrievalScoringService(new SemanticDataCatalogService());
}

describe('RetrievalScoringService', () => {
  test('uses RRF over ordinal signal ranks and remains shadow-only by default', () => {
    const a = record('a', { retrievalSignals: { semanticSimilarity: 0.9 } });
    const b = record('b', {
      retrievalSignals: { semanticSimilarity: 0.8, entityMatchConfidence: 0.99 },
    });
    const c = record('c', { retrievalSignals: { semanticSimilarity: 0.7 } });

    const result = service().score(request(), [a, b, c]);

    expect(result.records).toEqual([a, b, c]);
    expect(result.observability).toMatchObject({
      status: 'shadow',
      algorithm: 'rrf',
      rrfK: 60,
      applied: false,
      signalsUsed: ['semantic_similarity', 'entity_match_confidence'],
    });
    const bTrace = result.observability.scores.find((score) => score.recordId === 'b');
    expect(bTrace?.proposedRank).toBe(1);
    expect(bTrace?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: 'semantic_similarity', signalClass: 'relevance' }),
        expect.objectContaining({ signal: 'entity_match_confidence', signalClass: 'confidence' }),
      ]),
    );
  });

  test('applies the proposed RRF order only when explicitly enabled', () => {
    process.env.RETRIEVAL_SCORING_MODE = 'apply';
    const a = record('a', { retrievalSignals: { semanticSimilarity: 0.9 } });
    const b = record('b', {
      retrievalSignals: { semanticSimilarity: 0.8, entityMatchConfidence: 0.99 },
    });
    const c = record('c', { retrievalSignals: { semanticSimilarity: 0.7 } });

    const result = service().score(request(), [a, b, c]);

    expect(result.records).toEqual([b, a, c]);
    expect(result.observability).toMatchObject({ status: 'applied', applied: true });
  });

  test('keeps source authority as a separately labeled ordinal signal, not confidence', () => {
    process.env.RETRIEVAL_SCORING_MODE = 'apply';
    const knowledge = record('knowledge', {
      domain: 'institutional_knowledge',
      payload: { canonicalEntityId: 'entity-1' },
    });
    const client = record('client', { domain: 'clients' });

    const result = service().score(
      request({ requestedDomains: ['institutional_knowledge', 'clients'] }),
      [knowledge, client],
    );

    expect(result.records).toEqual([client, knowledge]);
    expect(result.observability.signalsUsed).toEqual(['source_authority']);
    const clientAuthority = result.observability.scores
      .find((score) => score.recordId === 'client')
      ?.components.find((component) => component.signal === 'source_authority');
    expect(clientAuthority).toMatchObject({ signalClass: 'authority' });
  });

  test('uses graph depth for relationship relevance without treating edge confidence as entity confidence', () => {
    process.env.RETRIEVAL_SCORING_MODE = 'apply';
    const depthTwo = record('edge-2', {
      domain: 'institutional_knowledge',
      payload: { depth: 2, confidence: 0.99, edgeType: 'works_for' },
    });
    const depthOne = record('edge-1', {
      domain: 'institutional_knowledge',
      payload: { depth: 1, confidence: 0.1, edgeType: 'works_for' },
    });

    const result = service().score(
      request({ queryClass: 'relationship_history', requestedDomains: ['institutional_knowledge'] }),
      [depthTwo, depthOne],
    );

    expect(result.records).toEqual([depthOne, depthTwo]);
    expect(result.observability.signalsUsed).toEqual(['graph_relationship_relevance']);
    expect(result.observability.signalsUsed).not.toContain('entity_match_confidence');
  });

  test('does not apply freshness as a ranking signal to historical-state queries', () => {
    process.env.RETRIEVAL_SCORING_MODE = 'apply';
    const old = record('old', { updatedAt: new Date('2020-01-01T00:00:00Z') });
    const recent = record('recent', { updatedAt: new Date('2026-01-01T00:00:00Z') });

    const result = service().score(request({ queryClass: 'entity_history' }), [old, recent]);

    expect(result.records).toEqual([old, recent]);
    expect(result.observability.signalsUsed).not.toContain('freshness');
    expect(result.observability.applied).toBe(false);
  });

  test('does not invent semantic similarity when no retrieval rail supplied it', () => {
    const a = record('a');
    const b = record('b');

    const result = service().score(request(), [a, b]);

    expect(result.observability.signalsUsed).not.toContain('semantic_similarity');
  });
});
