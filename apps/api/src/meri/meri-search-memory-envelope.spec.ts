import { envelopeSearchMemoryResult } from './meri-search-memory-envelope.js';

function payload(source: Record<string, unknown>, returned = 2) {
  return {
    tool: 'search_memory',
    generatedAt: '2026-09-25T12:00:00.000Z',
    coverage: {
      requestedDomains: ['institutional_knowledge'],
      complete: source.coverageComplete === true,
      sources: [{
        domain: 'institutional_knowledge',
        sourceStatus: 'healthy',
        returned,
        total: returned,
        hasMore: false,
        truncated: false,
        paginationComplete: true,
        coverageComplete: true,
        lastSyncAt: null,
        stopReason: 'complete',
        ...source,
      }],
    },
    results: Array.from({ length: returned }, (_, index) => ({ id: `memory-${index}` })),
  };
}

describe('search_memory result-envelope adapter', () => {
  it('wraps the exact legacy payload and maps proven complete source coverage', () => {
    const legacy = payload({ coverageComplete: true });
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.legacyPayload).toBe(legacy);
    expect(envelope.outcome).toBe('succeeded');
    expect(envelope.sources[0]).toMatchObject({
      family: 'memory',
      sourceId: 'institutional_knowledge',
      availability: 'available',
      scope: { domain: 'institutional_knowledge' },
      coverage: { completeness: 'complete', returnedCount: 2, matchedCount: 2 },
      observedAt: null,
    });
  });

  it('reports partial coverage and preserves source cursor continuation', () => {
    const legacy = payload({
      sourceStatus: 'degraded',
      coverageComplete: false,
      paginationComplete: false,
      hasMore: true,
      nextCursor: 'cursor-next',
      stopReason: 'retrieval_deadline_reached',
    });
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy', cursor: 'cursor-prev' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.truncation).toEqual({ truncated: true, reason: 'retrieval_deadline_reached' });
    expect(envelope.sources[0]?.scope).toMatchObject({ continuationRequested: true });
    expect(envelope.sources[0]?.coverage).toMatchObject({
      completeness: 'partial',
      continuation: { hasMore: true, cursor: 'cursor-next' },
    });
  });

  it.each([
    ['unavailable', 'unavailable'],
    ['unauthorized', 'blocked'],
  ] as const)('maps source status %s as %s without inspecting legacy error strings', (status, expected) => {
    const legacy = payload({ sourceStatus: status, coverageComplete: false, stopReason: 'source_unavailable' }, 0);
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'secret query' });
    expect(envelope.outcome).toBe(expected);
    expect(envelope.sources[0]?.availability).toBe(expected);
    expect(envelope.sources[0]?.coverage.completeness).toBe('unknown');
    expect(envelope.errors).toEqual([{ code: expected === 'blocked' ? 'authorization_unavailable' : 'source_unavailable' }]);
  });

  it('uses not_found_within_scope only for a complete empty search and keeps the declared client scope', () => {
    const legacy = payload({ coverageComplete: true }, 0);
    const envelope = envelopeSearchMemoryResult(legacy, {
      query: 'policy',
      clientId: 'client-a',
      memoryItemId: 'memory-a',
    });
    expect(envelope.outcome).toBe('not_found_within_scope');
    expect(envelope.sources[0]?.scope).toEqual({
      domain: 'institutional_knowledge',
      clientId: 'client-a',
      memoryItemId: 'memory-a',
    });
  });

  it.each([
    ['missing matched count', { total: undefined }],
    ['nonzero matched count', { total: 1 }],
  ])('does not claim absence with %s', (_case, sourceOverride) => {
    const legacy = payload({ coverageComplete: true, ...sourceOverride }, 0);
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
  });

  it('does not claim complete coverage when returned counts disagree with displayed results', () => {
    const legacy = payload({ coverageComplete: true }, 0);
    legacy.results.push({ id: 'unexpected-memory' });
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
  });

  it('does not claim a complete empty search when the displayed results list is missing', () => {
    const legacy = { ...payload({ coverageComplete: true }, 0), results: null };
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]?.coverage.completeness).toBe('partial');
  });

  it('does not infer source unavailability or expose arbitrary stop-reason text', () => {
    const legacy = payload({
      sourceStatus: 'future_status: upstream says SECRET_DETAIL',
      coverageComplete: false,
      stopReason: 'provider said SECRET_DETAIL while reading account 123',
    });
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'unknown',
      coverage: { completeness: 'unknown' },
    });
    expect(envelope.sources[0]?.failure).toBeUndefined();
    expect(envelope.truncation).toEqual({ truncated: false });
    expect(JSON.stringify({ sources: envelope.sources, truncation: envelope.truncation, errors: envelope.errors }))
      .not.toContain('SECRET_DETAIL');
  });

  it('does not turn generatedAt into source freshness and marks absent source coverage unknown', () => {
    const legacy = { tool: 'search_memory', generatedAt: '2026-09-25T12:00:00.000Z', coverage: { sources: [] } };
    const envelope = envelopeSearchMemoryResult(legacy, { query: 'policy' });
    expect(envelope.outcome).toBe('partial');
    expect(envelope.sources[0]).toMatchObject({
      availability: 'not_queried',
      observedAt: null,
      coverage: { completeness: 'unknown' },
    });
  });
});
