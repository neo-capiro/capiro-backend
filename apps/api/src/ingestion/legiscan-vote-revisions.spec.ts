import { persistVoteRevision, voteNeedsRefresh, voteRevision } from './legiscan-vote-revisions.js';
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

it('clears only the exact frozen partial check after canonical revision and position writes', async () => {
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    stateBill: { findUnique: jest.fn(async () => ({ state: 'FL', legiscanBillId: 91 })) },
    stateRollCallVote: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    stateBillPublishedRecord: { createMany: jest.fn() },
    stateMemberVote: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  const db = {
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  await persistVoteRevision(db as any, 'FL', 'fl-2025-hb91', vote, {
    historical: true,
    providerBillId: 91,
    providerBillHash: 'parent-hash',
  });
  const calls = tx.$executeRaw.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
  expect(calls).toHaveLength(2);
  const clear = calls[1]!;
  expect(clear[0].join('?')).toContain("kind='vote' AND source_identity=?");
  expect(clear[0].join('?')).toContain(
    "state='partial' AND error_code='LEGISCAN_VOTE_DETAIL_INCOMPLETE'",
  );
  expect(clear.slice(1)).toEqual([
    voteRevision(vote).revisionHash,
    'parent-hash',
    'fl-2025-hb91',
    'fl-rc-17',
  ]);
  expect(tx.stateMemberVote.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
    tx.$executeRaw.mock.invocationCallOrder[1]!,
  );
});
