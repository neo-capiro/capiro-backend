import { computeDesiredCommittees } from './normalize-state-committees';

describe('computeDesiredCommittees', () => {
  it('builds the "<state>-<chamber>-<slug(name)>" id for each named entry', () => {
    const result = computeDesiredCommittees('VA', 'lower', [
      { name: 'Courts of Justice', role: 'chair' },
      { name: 'Rules', role: 'member' },
    ]);

    expect(result).toEqual([
      {
        committeeId: 'VA-lower-courts-of-justice',
        name: 'Courts of Justice',
        role: 'chair',
        openstates: null,
      },
      {
        committeeId: 'VA-lower-rules',
        name: 'Rules',
        role: 'member',
        openstates: null,
      },
    ]);
  });

  it('drops entries with a blank/missing name rather than producing a garbage id', () => {
    const result = computeDesiredCommittees('VA', 'lower', [
      { name: '', role: 'chair' },
      { role: 'member' },
      { name: '   ', role: 'member' },
    ]);
    expect(result).toEqual([]);
  });

  it('treats a missing role as null', () => {
    const result = computeDesiredCommittees('VA', 'lower', [{ name: 'Rules' }]);
    expect(result).toEqual([
      { committeeId: 'VA-lower-rules', name: 'Rules', role: null, openstates: null },
    ]);
  });

  it('dedupes a committee listed twice into one entry', () => {
    const result = computeDesiredCommittees('VA', 'lower', [
      { name: 'Rules', role: 'chair' },
      { name: 'Rules', role: 'chair' },
    ]);
    expect(result).toEqual([
      { committeeId: 'VA-lower-rules', name: 'Rules', role: 'chair', openstates: null },
    ]);
  });

  it('returns an empty list for a legislator with no committees — the exact input that must PRUNE, not skip, existing membership rows', () => {
    // This is the shrink/loss case the reconciliation loop in main() relies on:
    // an empty desired list means deleteMany's `notIn: []` matches (and removes)
    // every existing state_committee_membership row for that legislator.
    expect(computeDesiredCommittees('VA', 'lower', [])).toEqual([]);
  });

  it('same committee name in different chambers produces two distinct ids (documented joint-committee limitation)', () => {
    const lower = computeDesiredCommittees('VA', 'lower', [{ name: 'Courts of Justice' }]);
    const upper = computeDesiredCommittees('VA', 'upper', [{ name: 'Courts of Justice' }]);
    expect(lower).toHaveLength(1);
    expect(upper).toHaveLength(1);
    expect(lower[0]?.committeeId).not.toBe(upper[0]?.committeeId);
  });

  it('carries OpenStates identity and provenance into the normalized committee', () => {
    const openstates = {
      id: 'ocd-organization/fl-rules',
      classification: 'committee',
      parentId: null,
      links: [{ url: 'https://www.flsenate.gov/Committees/Show/RC' }],
      sources: [{ url: 'https://openstates.org/fl/committees/FLC000100/' }],
      extras: { code: 'RC' },
    };

    expect(
      computeDesiredCommittees('FL', 'upper', [{ name: 'Rules', role: 'Chair', openstates }]),
    ).toEqual([
      {
        committeeId: 'FL-upper-rules',
        name: 'Rules',
        role: 'Chair',
        openstates,
      },
    ]);
  });
});
