import { createMeriResultEnvelope } from '@capiro/shared';

describe('Meri result envelope contract', () => {
  it.each(['search', 'document', 'memory', 'legislative'] as const)(
    'retains a legacy payload and explicit unknown coverage for %s reads',
    (family) => {
      const legacy = { records: [{ id: 'r-1' }], generatedAt: '2026-09-25T10:00:00Z' };
      const envelope = createMeriResultEnvelope({
        outcome: 'succeeded',
        legacyPayload: legacy,
        sources: [{
          family,
          sourceId: `${family}-catalog`,
          availability: 'available',
          scope: { clientId: 'client-1' },
          // A payload generation timestamp must not silently become source freshness.
          coverage: { completeness: 'unknown' },
          provenance: [{ recordId: 'r-1', sourceVersion: 'rev-3', locator: 'page:2' }],
        }],
      });
      expect(envelope.legacyPayload).toBe(legacy);
      expect(envelope.sources[0]).toMatchObject({
        family,
        coverage: { completeness: 'unknown' },
        provenance: [{ recordId: 'r-1', sourceVersion: 'rev-3', locator: 'page:2' }],
      });
      expect(envelope.sources[0]).not.toHaveProperty('observedAt');
      expect(envelope.outcome).toBe('succeeded');
    },
  );

  it('keeps unavailability, truncation, and source failures explicit', () => {
    const envelope = createMeriResultEnvelope({
      outcome: 'partial',
      legacyPayload: { records: [] },
      sources: [{
        family: 'search',
        sourceId: 'federal-index',
        availability: 'unavailable',
        scope: { query: 'appropriations' },
        observedAt: null,
        coverage: { completeness: 'unknown' },
        provenance: [],
        failure: { code: 'upstream_timeout' },
      }],
      truncation: { truncated: true, reason: 'result_limit' },
      errors: [{ code: 'upstream_timeout' }],
    });
    const source = envelope.sources[0]!;
    expect(source.availability).toBe('unavailable');
    expect(source.coverage.completeness).toBe('unknown');
    expect(envelope.truncation).toEqual({ truncated: true, reason: 'result_limit' });
    expect(envelope.errors).toEqual([{ code: 'upstream_timeout' }]);
  });

  it('does not collapse distinct execution outcomes', () => {
    for (const outcome of ['blocked', 'needs_input', 'not_found_within_scope', 'unavailable'] as const) {
      const envelope = createMeriResultEnvelope({ outcome, legacyPayload: null, sources: [] });
      expect(envelope.outcome).toBe(outcome);
    }
  });
});
