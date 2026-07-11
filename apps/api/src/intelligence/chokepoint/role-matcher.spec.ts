import { normalizeRoleTitle, matchesRole, billStatusRank } from '@capiro/shared';

/**
 * W4.1 — the single shared committee-role matcher + federal rank accessor that
 * chokepoint.service.ts AND meri-tools.service.ts's get_committee_roster now
 * both consume (replacing per-site FEDERAL_*_TITLES sets and /^chair$/i regexes
 * that diverged and missed Chairwoman / Co-Chair). Because both call sites go
 * through THESE functions, pinning them here pins the "both tools resolve the
 * SAME chair for the same title" invariant the blueprint requires.
 */
describe('normalizeRoleTitle (W4.1 shared committee-role matcher)', () => {
  it('resolves every chair variant to "chair"', () => {
    for (const t of [
      'Chair',
      'Chairman',
      'Chairwoman',
      'Chairperson',
      'Co-Chair',
      'Co-Chairman',
      'cochair',
      'co chair',
      'CHAIR',
      '  chair  ',
    ]) {
      expect(normalizeRoleTitle(t)).toBe('chair');
    }
  });

  it('resolves every vice-chair variant to "viceChair" (never "chair")', () => {
    for (const t of ['Vice Chair', 'Vice-Chair', 'Vice Chairman', 'Vice Chairwoman', 'vice-chair']) {
      expect(normalizeRoleTitle(t)).toBe('viceChair');
    }
  });

  it('resolves ranking-member variants to "rankingMember"', () => {
    for (const t of ['Ranking Member', 'Ranking', 'ranking member']) {
      expect(normalizeRoleTitle(t)).toBe('rankingMember');
    }
  });

  it('returns null for non-leadership roles and empty/undefined input', () => {
    for (const t of ['Member', 'Vice President', '', '   ', null, undefined, 'Clerk']) {
      expect(normalizeRoleTitle(t)).toBeNull();
    }
  });

  it('matchesRole is anchored — "Vice Chair" matches viceChair, NOT chair', () => {
    expect(matchesRole('Vice Chair', 'viceChair')).toBe(true);
    expect(matchesRole('Vice Chair', 'chair')).toBe(false);
    // REGRESSION: the pre-W4.1 Set(['Chair','Chairman']) would report chair:null
    // for a real "Chairwoman"/"Co-Chair" chair — the exact bug this closes.
    expect(matchesRole('Chairwoman', 'chair')).toBe(true);
    expect(matchesRole('Co-Chair', 'chair')).toBe(true);
  });
});

describe('billStatusRank (W4.1 shared federal rank accessor)', () => {
  it('ranks the federal status vocabulary so committee-advancement compares against "reported"', () => {
    expect(billStatusRank('introduced')).toBeLessThan(billStatusRank('reported'));
    expect(billStatusRank('committee')).toBeLessThan(billStatusRank('reported'));
    expect(billStatusRank('reported')).toBeGreaterThanOrEqual(billStatusRank('reported'));
    expect(billStatusRank('passed_chamber')).toBeGreaterThan(billStatusRank('reported'));
    expect(billStatusRank('enacted')).toBeGreaterThan(billStatusRank('reported'));
  });

  it('an unknown/null status ranks 0 (below everything) — never throws', () => {
    expect(billStatusRank(null)).toBe(0);
    expect(billStatusRank(undefined)).toBe(0);
    expect(billStatusRank('not-a-real-status')).toBe(0);
  });
});
