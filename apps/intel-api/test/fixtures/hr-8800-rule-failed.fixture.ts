/**
 * H.R. 8800 failed-governing-rule fixture (Release R1, §0.4 / §5 edge case 2-3).
 *
 * The canonical truth-layer scenario: a target bill whose latest action says a
 * RULE was reported, a governing-rule link to the hres, a FAILED rule vote with an
 * exact tally, and NO recorded floor vote on the target bill itself. The dossier
 * must report the failed-rule outcome + tally, NEVER imply a "pending floor vote,"
 * and state the absence of a target-bill vote explicitly.
 *
 * `makeHr8800SourceData()` returns a fake shaped like the SourceDataRepository
 * surface the dossier service reads, so the truth spec can build a global dossier
 * with no DB.
 */
import type {
  SourceBillAction,
  SourceBillCommittee,
  SourceBillIdentity,
  SourceBillVote,
  SourceFiscalNote,
  SourceBillFreshness,
  SourceGoverningRule,
  SourceHearingForBill,
  SourceMemberVoteTally,
} from '../../src/sourcedata/source-data.repository.js';

export const HR_8800_ID = '119-hr-8800';
export const HR_8800_RULE_ID = '119-hres-1398';
export const HR_8800_RULE_VOTE_ID = 'house-119-1-240';
export const HR_8800_RULE_TALLY = '211-214';

export const hr8800Identity: SourceBillIdentity = {
  id: HR_8800_ID,
  congress: 119,
  billType: 'hr',
  billNumber: '8800',
  title: 'Border Security and Enforcement Appropriations Act, 2026',
  originChamber: 'House',
  sponsorName: 'Rep. Example (R-TX)',
  introducedDate: new Date('2026-03-04T00:00:00Z'),
  // Canonical, derived by the truth layer from the failed rule vote.
  status: 'rule_failed',
  statusAt: new Date('2026-06-18T21:30:00Z'),
  // Latest ACTION on the target bill only says a rule was reported — NOT that a
  // floor vote is pending.
  latestActionText:
    'Rule H. Res. 1398 providing for consideration reported to the House (H. Rept. 119-512).',
  latestActionDate: new Date('2026-06-17T00:00:00Z'),
  policyArea: 'Immigration',
  url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
  lastSyncedAt: new Date('2026-06-19T06:00:00Z'),
  updateDate: new Date('2026-06-18T22:00:00Z'),
  updateDateIncludingText: new Date('2026-06-18T22:00:00Z'),
};

export const hr8800Actions: SourceBillAction[] = [
  {
    id: 'a3',
    billId: HR_8800_ID,
    date: new Date('2026-06-17T00:00:00Z'),
    text: 'Rule H. Res. 1398 providing for consideration reported to the House (H. Rept. 119-512).',
    type: 'Floor',
    chamber: 'House',
  },
  {
    id: 'a2',
    billId: HR_8800_ID,
    date: new Date('2026-05-20T00:00:00Z'),
    text: 'Reported (Amended) by the Committee on Appropriations. H. Rept. 119-480.',
    type: 'Committee',
    chamber: 'House',
  },
  {
    id: 'a1',
    billId: HR_8800_ID,
    date: new Date('2026-03-04T00:00:00Z'),
    text: 'Introduced in House.',
    type: 'IntroReferral',
    chamber: 'House',
  },
];

/** The FAILED governing-rule vote on the hres (adoption rejected). */
export const hr8800GoverningRules: SourceGoverningRule[] = [
  {
    ruleBillId: HR_8800_RULE_ID,
    targetBillId: HR_8800_ID,
    voteId: HR_8800_RULE_VOTE_ID,
    chamber: 'house',
    rollNumber: 240,
    result: 'Failed',
    yeas: 211,
    nays: 214,
    question: 'On Agreeing to the Resolution (H. Res. 1398)',
    sourceUrl: 'https://clerk.house.gov/Votes/2026240',
    voteDate: new Date('2026-06-18T21:30:00Z'),
  },
];

/** Party split for the failed rule vote (sums to 211 yea / 214 nay). */
export const hr8800RuleMemberTallies: SourceMemberVoteTally[] = [
  { voteId: HR_8800_RULE_VOTE_ID, party: 'R', voteCast: 'Yea', count: 210 },
  { voteId: HR_8800_RULE_VOTE_ID, party: 'R', voteCast: 'Nay', count: 3 },
  { voteId: HR_8800_RULE_VOTE_ID, party: 'D', voteCast: 'Yea', count: 1 },
  { voteId: HR_8800_RULE_VOTE_ID, party: 'D', voteCast: 'Nay', count: 211 },
];

export const hr8800Freshness: SourceBillFreshness = {
  billId: HR_8800_ID,
  lastSyncedAt: hr8800Identity.lastSyncedAt,
  updateDate: hr8800Identity.updateDate,
  updateDateIncludingText: hr8800Identity.updateDateIncludingText,
  latestActionDate: hr8800Identity.latestActionDate,
};

/**
 * A fake matching the SourceDataRepository read surface the dossier service uses.
 * Cast to the concrete type at the call site so the spec constructs the real
 * BillDossierService with no DB. NO floor vote is returned for the target bill.
 */
export function makeHr8800SourceData() {
  return {
    getBillDossierIdentity: async (id: string): Promise<SourceBillIdentity | null> =>
      id === HR_8800_ID ? hr8800Identity : null,
    getBillActions: async (): Promise<SourceBillAction[]> => hr8800Actions,
    getBillVotes: async (): Promise<SourceBillVote[]> => [], // no recorded floor vote on the bill
    getGoverningRules: async (): Promise<SourceGoverningRule[]> => hr8800GoverningRules,
    getBillCommittees: async (): Promise<SourceBillCommittee[]> => [
      { committeeName: 'House Committee on Appropriations', committeeCode: 'hsap00', chamber: 'house' },
    ],
    getBillFiscalNotes: async (): Promise<SourceFiscalNote[]> => [],
    getBillSourceFreshness: async (): Promise<SourceBillFreshness | null> => hr8800Freshness,
    getUpcomingHearingsForBills: async (): Promise<SourceHearingForBill[]> => [],
    getBillMemberVoteSummary: async (voteIds: string[]): Promise<SourceMemberVoteTally[]> =>
      voteIds.includes(HR_8800_RULE_VOTE_ID) ? hr8800RuleMemberTallies : [],
  };
}
