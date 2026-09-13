import { voteNeedsRefresh, voteRevision } from './legiscan-vote-revisions.js';
import type { LegiscanRollCall } from '../external/legiscan/legiscan.client.js';
const vote: LegiscanRollCall = {
  roll_call_id: 17,
  bill_id: 91,
  date: '2026-04-01',
  chamber: 'H',
  desc: 'Favorable recommendation',
  passed: 1,
  yea: 1,
  nay: 1,
  nv: 0,
  absent: 0,
  total: 2,
  votes: [
    { people_id: 1, vote_text: 'Yea' },
    { people_id: 2, vote_text: 'Nay' },
  ],
};
describe('immutable vote evidence', () => {
  it('detects same-total member swaps and preserves reorder idempotency', () => {
    const initial = voteRevision(vote);
    expect(voteRevision({ ...vote, votes: [...vote.votes!].reverse() }).revisionHash).toBe(
      initial.revisionHash,
    );
    expect(
      voteRevision({
        ...vote,
        votes: [
          { people_id: 1, vote_text: 'Nay' },
          { people_id: 2, vote_text: 'Yea' },
        ],
      }).revisionHash,
    ).not.toBe(initial.revisionHash);
    expect(initial.evidence.members[0]!.voteCast).toBe('Yea');
  });
  it.each([{ passed: 0 }, { desc: 'Adoption' }, { chamber: 'S' }])(
    'versions corrected motion/body/result %j',
    (change) => {
      expect(voteRevision({ ...vote, ...change }).revisionHash).not.toBe(
        voteRevision(vote).revisionHash,
      );
    },
  );
  it('retains exact supplied links, no invented date or vote link', () => {
    expect(voteRevision({ ...vote, date: undefined }).evidence).toMatchObject({
      date: null,
      url: null,
    });
    expect(
      voteRevision(vote, { stub: { roll_call_id: 17, state_link: 'https://example.gov/vote.pdf' } })
        .evidence.url,
    ).toBe('https://example.gov/vote.pdf');
  });
  it('rejects partial, duplicate, unrelated and inconsistent detail', () => {
    expect(() => voteRevision({ ...vote, votes: vote.votes!.slice(0, 1) })).toThrow('INCOMPLETE');
    expect(() => voteRevision({ ...vote, votes: [vote.votes![0]!, vote.votes![0]!] })).toThrow(
      'INCOMPLETE',
    );
    expect(() => voteRevision(vote, { providerBillId: 92 })).toThrow('BILL_MISMATCH');
    expect(() => voteRevision(vote, { stub: { roll_call_id: 18 } })).toThrow('ID_MISMATCH');
  });
  it('uses parent hash only for discovery, bounds rechecks by age, and dedupes unchanged votes', () => {
    const existing = {
      currentRevisionHash: 'vote-a',
      providerBillHash: 'bill-a',
      lastSyncedAt: new Date('2026-09-01'),
    };
    expect(voteNeedsRefresh(existing, 'bill-a', new Date('2026-09-02'))).toBe(false);
    expect(voteNeedsRefresh(existing, 'bill-b', new Date('2026-09-02'))).toBe(true);
    expect(voteNeedsRefresh(existing, 'bill-a', new Date('2026-09-09'))).toBe(true);
    expect(voteRevision(vote, { providerBillHash: 'a' }).revisionHash).toBe(
      voteRevision(vote, { providerBillHash: 'b' }).revisionHash,
    );
  });
});
