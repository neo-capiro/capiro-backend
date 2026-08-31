/**
 * Phase 10B-18 Part D/M — tests the shared pure bundle-completeness domain
 * functions from `@capiro/defense-domain` (no jest test infra lives in that
 * package itself; every other consumer tests its exports from an app that
 * already has jest configured, and this file follows that same pattern).
 */
import {
  armyRdteMemberKey,
  decideExpectedSourceStateOnDocumentArrivalV1,
  evaluateBundleCompletenessV1,
  type BundleMemberFactsV1,
} from '@capiro/defense-domain';

describe('evaluateBundleCompletenessV1 — Phase 10B-18 Part D', () => {
  it('reports no_bundle for the ~55 ordinary single-document families (no registered members)', () => {
    expect(evaluateBundleCompletenessV1([])).toBe('no_bundle');
  });

  it('reports partial when the Army FY24 R-2 corpus has only 1 of 10 required members verified', () => {
    const members: BundleMemberFactsV1[] = [
      { required: true, memberStatus: 'verified' },
      ...Array.from({ length: 9 }, () => ({ required: true, memberStatus: 'missing' as const })),
    ];
    expect(evaluateBundleCompletenessV1(members)).toBe('partial');
  });

  it('reports complete only when every required member is verified', () => {
    const members: BundleMemberFactsV1[] = Array.from({ length: 10 }, () => ({
      required: true,
      memberStatus: 'verified',
    }));
    expect(evaluateBundleCompletenessV1(members)).toBe('complete');
  });

  it('an optional missing member never blocks completeness', () => {
    const members: BundleMemberFactsV1[] = [
      { required: true, memberStatus: 'verified' },
      { required: false, memberStatus: 'missing' },
    ];
    expect(evaluateBundleCompletenessV1(members)).toBe('complete');
  });

  it('a required member merely "observed" (not yet verified) still blocks completeness', () => {
    const members: BundleMemberFactsV1[] = [{ required: true, memberStatus: 'observed' }];
    expect(evaluateBundleCompletenessV1(members)).toBe('partial');
  });
});

describe('decideExpectedSourceStateOnDocumentArrivalV1 — Phase 10B-18 Part D', () => {
  it('resolves no_bundle to published — byte-for-byte the pre-Phase-10B-18 behavior', () => {
    expect(decideExpectedSourceStateOnDocumentArrivalV1('no_bundle')).toBe('published');
  });

  it('resolves complete to published', () => {
    expect(decideExpectedSourceStateOnDocumentArrivalV1('complete')).toBe('published');
  });

  it('resolves partial to partially_published — Volume 1 BA1 alone must never claim the whole family', () => {
    expect(decideExpectedSourceStateOnDocumentArrivalV1('partial')).toBe('partially_published');
  });
});

describe('armyRdteMemberKey — deterministic, not filename-derived', () => {
  it('is stable for the same (volume, budgetActivity) pair', () => {
    expect(armyRdteMemberKey({ volume: '1', budgetActivity: '1' })).toBe('volume_1_ba_1');
    expect(armyRdteMemberKey({ volume: '2', budgetActivity: '4A' })).toBe('volume_2_ba_4A');
  });
});
