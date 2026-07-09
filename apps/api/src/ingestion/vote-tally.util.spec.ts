import { voteBucket, tallyFrom } from './vote-tally.util';

describe('voteBucket', () => {
  it('maps yea/aye/yes → yea', () => {
    for (const v of ['Yea', 'aye', 'YES']) expect(voteBucket(v)).toBe('yea');
  });
  it('maps nay/no → nay', () => {
    for (const v of ['Nay', 'no']) expect(voteBucket(v)).toBe('nay');
  });
  it('maps Present → present', () => {
    expect(voteBucket('Present')).toBe('present');
  });
  it('maps "Not Voting"/blank/null → notVoting', () => {
    for (const v of ['Not Voting', '', null, undefined]) expect(voteBucket(v)).toBe('notVoting');
  });
});

describe('tallyFrom', () => {
  it('computes overall + per-party lanes', () => {
    const t = tallyFrom([
      { cast: 'Yea', party: 'R' },
      { cast: 'Yea', party: 'R' },
      { cast: 'Nay', party: 'D' },
      { cast: 'Present', party: 'D' },
      { cast: 'Not Voting', party: 'I' },
    ]);
    expect({ yeas: t.yeas, nays: t.nays, present: t.present, notVoting: t.notVoting }).toEqual({
      yeas: 2,
      nays: 1,
      present: 1,
      notVoting: 1,
    });
    expect(t.partyTotals.R).toEqual({ yea: 2, nay: 0, present: 0, notVoting: 0 });
    expect(t.partyTotals.D).toEqual({ yea: 0, nay: 1, present: 1, notVoting: 0 });
    expect(t.partyTotals.I).toEqual({ yea: 0, nay: 0, present: 0, notVoting: 1 });
  });

  it('buckets missing party under "?"', () => {
    const t = tallyFrom([{ cast: 'Yea', party: null }]);
    expect(t.partyTotals['?']).toEqual({ yea: 1, nay: 0, present: 0, notVoting: 0 });
  });
});
