import {
  ADVOCACY_SOURCE_NAMES,
  buildAdvocacyHistoryHealth,
  deriveAdvocacyFreshness,
} from './client-profile-fill-advocacy-health.js';

describe('Advocacy source freshness observation boundaries', () => {
  const now = new Date('2026-11-01T04:00:00.000Z');

  test.each([...ADVOCACY_SOURCE_NAMES, 'unknown-source'])(
    '%s refuses future success without changing exact-now or cadence boundaries',
    (source) => {
      expect(deriveAdvocacyFreshness(source, new Date(now.getTime() + 1).toISOString(), 24, now))
        .toBe('unknown');
      expect(deriveAdvocacyFreshness(source, now.toISOString(), 24, now)).toBe('fresh');
      const cycles = ['fara', 'federal_register', 'community_funding'].includes(source) ? 2 : 1;
      const boundary = now.getTime() - cycles * 24 * 60 * 60_000;
      expect(deriveAdvocacyFreshness(source, new Date(boundary).toISOString(), 24, now)).toBe('fresh');
      expect(deriveAdvocacyFreshness(source, new Date(boundary - 1).toISOString(), 24, now)).toBe('stale');
    },
  );

  test('an invalid observation clock cannot establish freshness', () => {
    expect(deriveAdvocacyFreshness('lda', now.toISOString(), 24, new Date('invalid'))).toBe('unknown');
  });

  test('future cursor evidence does not make completed history current or erase its provenance', () => {
    const future = new Date(now.getTime() + 1).toISOString();
    const cursor = {
      refreshedAt: future,
      backfill: {
        sources: Object.fromEntries(ADVOCACY_SOURCE_NAMES.map((source) => [source, {
          status: 'complete', availability: 'available', lastSuccessAt: future,
          completedAt: future, examined: 5, candidates: 2,
        }])),
      },
    };
    const original = JSON.stringify(cursor);
    const counts = { pending: 1, accepted: 2, rejected: 3 };
    const health = buildAdvocacyHistoryHealth(cursor, 24, null, counts, now);
    expect(health.overall).toBe('stale');
    expect(health.refreshedAt).toBe(future);
    expect(health.sources).toHaveLength(8);
    for (const source of health.sources) {
      expect(source).toMatchObject({
        status: 'complete', backfillStatus: 'complete', availability: 'available',
        freshness: 'unknown', lastSuccessAt: future, completedAt: future, examined: 5, candidates: 2,
      });
    }
    expect(health).toMatchObject({ pendingFindings: 1, acceptedFindings: 2, rejectedFindings: 3 });
    expect(JSON.stringify(cursor)).toBe(original);
    expect(buildAdvocacyHistoryHealth(cursor, 24, null, counts, new Date(future)).overall).toBe('current');
  });
});
