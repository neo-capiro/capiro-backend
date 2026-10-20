import { harness, installHooks } from './fixtures/bill-dossier-ownership/harness.js';
import {
  action,
  billId,
  identity,
  kpi,
  now,
  rule,
  vote,
} from './fixtures/bill-dossier-ownership/rows.js';

installHooks();

it('preserves duplicate vote IDs in the one batched tally read and keeps rule/procedural/passage targets distinct', async () => {
  const h = harness({
    results: {
      getBillVotes: [
        vote({ id: 'shared' }),
        vote({ id: 'procedural', question: 'On Motion to Reconsider', result: 'Failed' }),
      ],
      getGoverningRules: [
        rule({ voteId: 'shared' }),
        rule({ voteId: null, ruleBillId: '119-hres-2' }),
      ],
      getBillMemberVoteSummary: [
        { voteId: 'shared', party: ' R ', voteCast: 'Yea', count: 10 },
        { voteId: 'shared', party: 'Republican', voteCast: 'Aye', count: 2 },
        { voteId: 'shared', party: 'D', voteCast: 'No', count: 7 },
        { voteId: 'shared', party: 'I', voteCast: 'Yea', count: 50 },
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(h.callsOf('getBillMemberVoteSummary')).toHaveLength(1);
  expect(h.callsOf('getBillMemberVoteSummary')[0]!.args).toEqual([
    ['shared', 'procedural', 'shared'],
  ]);
  expect(result.votes.map((row) => [row.id, row.target])).toEqual([
    ['shared', 'rule'],
    ['rule:119-hres-2', 'rule'],
    ['shared', 'passage'],
    ['procedural', 'procedural'],
  ]);
  expect(result.votes[0]!.party).toEqual({ gopYea: 12, gopNay: 0, demYea: 0, demNay: 7 });
  expect(result.votes[2]!.party).toBe(result.votes[0]!.party);
});

it('includes rule votes with an ID but no recorded result and never promotes them to target passage', async () => {
  const h = harness({
    results: { getGoverningRules: [rule({ result: null, yeas: null, nays: null })] },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.votes[0]).toMatchObject({
    id: 'rule-vote',
    target: 'rule',
    result: null,
    tally: '0-0',
  });
  expect(result.noVote).toBe('No roll call vote has been recorded on this bill.');
  expect(kpi(result, 'latest_vote').value).toBe('0-0');
});

it('groups same-day same-chamber passage rows by tally and retains every underlying source ID', async () => {
  const h = harness({
    results: {
      getBillActions: [
        action({ id: 'detailed', text: 'Passed House on passage, 230-200, Roll No. 10.' }),
        action({ id: 'summary', text: 'Passed/Agreed to in House: 230-200.' }),
        action({
          id: 'other-chamber',
          text: 'Passed Senate on passage, 230-200, Roll No. 10.',
          chamber: 'Senate',
        }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.milestones).toHaveLength(2);
  expect(result.milestones[0]).toMatchObject({
    label: 'Passed House',
    sourceIds: ['detailed', 'summary'],
    sourceCount: 2,
    detail: 'On passage · 230–200 · Roll no. 10',
  });
  expect(result.milestones[1]).toMatchObject({
    label: 'Passed Senate',
    sourceIds: ['other-chamber'],
    sourceCount: 1,
  });
});

it('keeps chamber-scoped roll numbers and receipt events separate from historical passage outcomes', async () => {
  const h = harness({
    results: {
      getBillActions: [
        action({ id: 'house', text: 'Motion rejected, Roll No. 8.', chamber: 'House' }),
        action({ id: 'senate', text: 'Motion rejected, Roll No. 8.', chamber: 'Senate' }),
        action({
          id: 'receipt',
          text: 'Received in the Senate after the House passed the bill.',
          chamber: 'Senate',
        }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.milestones).toHaveLength(3);
  expect(result.milestones[0]!.sourceIds).toEqual(['house']);
  expect(result.milestones[1]!.sourceIds).toEqual(['senate']);
  expect(result.milestones[2]).toMatchObject({
    label: 'Received in House',
    outcome: null,
    outcomeSev: 'neutral',
  });
});

it('derives passed-chamber status from the latest successful passage vote rather than later procedural votes', async () => {
  const earlier = new Date('2026-10-12T12:00:00.000Z');
  const h = harness({
    results: {
      getBillDossierIdentity: identity({
        status: 'passed_chamber',
        originChamber: 'House',
        statusAt: now,
      }),
      getBillVotes: [
        vote({ id: 'passage', chamber: 'senate', voteDate: earlier }),
        vote({
          id: 'procedure',
          question: 'On Motion to Recommit',
          result: 'Failed',
          voteDate: now,
        }),
      ],
    },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.bill.statusLabel).toBe('Passed Senate');
  expect(result.bill.statusAt).toBe(earlier.toISOString());
  expect(result.bill.stage).toBe('passed_chamber');
});

it('does not replace another canonical stage with display passage even when successful votes are present', async () => {
  const h = harness({
    results: { getBillDossierIdentity: identity({ status: 'enacted' }), getBillVotes: [vote()] },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.bill.stage).toBe('enacted');
  expect(result.bill.statusLabel).not.toBe('Passed House');
  expect(result.bill.statusAt).toBe(now.toISOString());
});

it('caps public hearings locally at twenty while preserving duplicate catalog rows', async () => {
  const h = harness({
    results: {
      getUpcomingHearingsForBills: Array.from({ length: 21 }, () => ({
        hearingId: 'one',
        title: null,
        committeeName: 'Committee',
        date: now,
      })),
    },
  });
  const result = await h.service.getGlobalDossier(billId);
  expect(result.hearings).toHaveLength(20);
  expect(result.hearings.every((row) => row.id === 'one')).toBe(true);
});

it('propagates a tally source failure without returning partial votes or a client context', async () => {
  const error = new Error('tallies unavailable');
  const h = harness({ errors: { getBillMemberVoteSummary: error } });
  await expect(h.service.getGlobalDossier(billId)).rejects.toBe(error);
  expect(h.callsOf('getBillMemberVoteSummary')[0]!.args).toEqual([[]]);
  expect(h.transactions).toHaveLength(0);
});
