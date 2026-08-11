import {
  danglingManagerIds,
  inferPlacementFromTitle,
  levelRank,
  wouldCreateCycle,
} from './client-hierarchy.helpers.js';

describe('inferPlacementFromTitle', () => {
  it.each([
    ['Chief Executive Officer', 'executive'],
    ['CEO', 'executive'],
    ['President & Founder', 'executive'],
    ['Chief Financial Officer', 'c_suite'],
    ['CGAO', 'c_suite'],
    ['Executive Vice President', 'senior_leadership'],
    ['SVP, Policy', 'senior_leadership'],
    ['VP Government Affairs', 'leadership'],
    ['Director, Federal Affairs', 'leadership'],
    ['Government Relations Manager', 'management'],
    ['Senior Manager', 'management'],
    ['Policy Analyst', 'team'],
    ['Regulatory Counsel', 'team'],
  ])('places %s at %s', (title, level) => {
    const result = inferPlacementFromTitle(title);
    expect(result.level).toBe(level);
    expect(result.reviewRequired).toBe(false);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('flags a missing title for review instead of guessing', () => {
    for (const value of [null, undefined, '', '   ']) {
      const result = inferPlacementFromTitle(value);
      expect(result.level).toBeNull();
      expect(result.reviewRequired).toBe(true);
    }
  });

  it('flags an unmatched title for review rather than defaulting to team', () => {
    // The whole point: "not recognised" and "junior" are different facts.
    const result = inferPlacementFromTitle('Chief Vibes Wrangler, Third Floor');
    expect(result.level).toBeNull();
    expect(result.reviewRequired).toBe(true);
  });

  it('takes the senior reading of an ambiguous title but asks for review', () => {
    const result = inferPlacementFromTitle('VP and Senior Analyst');
    expect(result.level).toBe('leadership');
    expect(result.reviewRequired).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('does not treat an adjacent-band compound title as ambiguous', () => {
    // Director + Manager are one band apart; that reads as a normal title.
    const result = inferPlacementFromTitle('Director / Program Manager');
    expect(result.level).toBe('leadership');
    expect(result.reviewRequired).toBe(false);
  });

  it('is punctuation and case insensitive', () => {
    expect(inferPlacementFromTitle('v.p., government affairs').level).toBe('leadership');
  });

  it('orders levels most senior first', () => {
    expect(levelRank('executive')).toBeLessThan(levelRank('c_suite'));
    expect(levelRank('management')).toBeLessThan(levelRank('team'));
  });
});

describe('wouldCreateCycle', () => {
  //  a <- b <- c
  const people = [
    { id: 'a', reportsToPersonId: null },
    { id: 'b', reportsToPersonId: 'a' },
    { id: 'c', reportsToPersonId: 'b' },
    { id: 'loner', reportsToPersonId: null },
  ];

  it('rejects self-reporting', () => {
    expect(wouldCreateCycle(people, 'b', 'b')).toBe(true);
  });

  it('rejects a direct two-node loop', () => {
    expect(wouldCreateCycle(people, 'a', 'b')).toBe(true);
  });

  it('rejects a longer loop', () => {
    // a reporting to c would close a -> b -> c -> a.
    expect(wouldCreateCycle(people, 'a', 'c')).toBe(true);
  });

  it('allows a legitimate placement', () => {
    expect(wouldCreateCycle(people, 'loner', 'c')).toBe(false);
    expect(wouldCreateCycle(people, 'c', 'a')).toBe(false);
  });

  it('allows clearing the manager', () => {
    expect(wouldCreateCycle(people, 'c', null)).toBe(false);
  });

  it('refuses to extend data that already contains a cycle', () => {
    const broken = [
      { id: 'x', reportsToPersonId: 'y' },
      { id: 'y', reportsToPersonId: 'x' },
      { id: 'z', reportsToPersonId: null },
    ];
    expect(wouldCreateCycle(broken, 'z', 'x')).toBe(true);
  });
});

describe('danglingManagerIds', () => {
  it('finds a reports-to pointing at a deleted person', () => {
    const people = [
      { id: 'a', reportsToPersonId: 'ghost' },
      { id: 'b', reportsToPersonId: 'a' },
    ];
    expect(danglingManagerIds(people)).toEqual(['ghost']);
  });

  it('returns nothing for a sound roster', () => {
    expect(
      danglingManagerIds([
        { id: 'a', reportsToPersonId: null },
        { id: 'b', reportsToPersonId: 'a' },
      ]),
    ).toEqual([]);
  });
});
