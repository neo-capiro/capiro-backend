import { classifyVoteResult } from '@capiro/shared';
import type { SourceMemberVoteTally } from '../sourcedata/source-data.repository.js';
import type { BillVote, VotePartyBreakdown, DossierSeverity } from './bill-dossier.types.js';
import { toIso, byDateDesc, DAY_MS } from './bill-dossier-presentation.js';
import {
  isPassageActionText,
  readableChamber,
  chamberFromAction,
  type ActionMilestoneSource,
} from './bill-dossier-actions.js';

export function buildPartyMap(rows: SourceMemberVoteTally[]): Map<string, VotePartyBreakdown> {
  const m = new Map<string, VotePartyBreakdown>();
  for (const r of rows) {
    const p = m.get(r.voteId) ?? { gopYea: 0, gopNay: 0, demYea: 0, demNay: 0 };
    const party = (r.party ?? '').trim().toUpperCase();
    const yea = /^(yea|aye|yes)/i.test(r.voteCast);
    const nay = /^(nay|no)/i.test(r.voteCast);
    if (party.startsWith('R')) {
      if (yea) p.gopYea += r.count;
      else if (nay) p.gopNay += r.count;
    } else if (party.startsWith('D')) {
      if (yea) p.demYea += r.count;
      else if (nay) p.demNay += r.count;
    }
    m.set(r.voteId, p);
  }
  return m;
}

export function isPassageVoteQuestion(question: string | null | undefined): boolean {
  const q = (question ?? '').toLowerCase();
  return /on passage|passage of the bill|suspend the rules and pass|suspend the rules and agree|third reading|to concur|concur in the senate amendment|on agreeing to the resolution|on agreeing to the (conference|senate|house) amendment/.test(
    q,
  );
}

export function federalStatusPresentation(input: {
  status: string | null;
  fallbackLabel: string;
  fallbackAt: string | null;
  originChamber: string | null;
  actions: ActionMilestoneSource[];
  votes: BillVote[];
}): { label: string; at: string | null } {
  if (input.status !== 'passed_chamber') {
    return { label: input.fallbackLabel, at: input.fallbackAt };
  }

  const vote = input.votes
    .filter((v) => v.target === 'passage' && sevForResult(v.result) === 'success')
    .sort(byDateDesc)[0];
  const passageAction = input.actions.find(
    (action) => isPassageActionText(action.text) && !isFailedResult(action.text),
  );
  const chamber =
    readableChamber(vote?.chamber) ??
    (passageAction
      ? chamberFromAction(passageAction.text, passageAction.chamber)
      : readableChamber(input.originChamber));
  return {
    label: chamber ? `Passed ${chamber}` : input.fallbackLabel,
    at: vote?.date ?? toIso(passageAction?.date) ?? input.fallbackAt,
  };
}

export function isFailedResult(result: string | null): boolean {
  return classifyVoteResult(result) === 'fail';
}

export function sevForResult(result: string | null): DossierSeverity {
  const classified = classifyVoteResult(result);
  if (classified === 'pass') return 'success';
  if (classified === 'fail') return 'critical';
  return 'neutral';
}

export function sevForStatus(status: string | null): DossierSeverity {
  switch (status) {
    case 'enacted':
    case 'passed_chamber':
      return 'success';
    case 'rule_failed':
    case 'failed':
    case 'vetoed':
      return 'critical';
    case 'floor':
    case 'resolving':
    case 'to_president':
      return 'accent';
    case 'reported':
    case 'rule_pending':
      return 'notable';
    default:
      return 'neutral';
  }
}

export function officialNextStepText(status: string | null, ruleFailed: boolean): string {
  if (
    status === 'rule_failed' ||
    (ruleFailed &&
      !['passed_chamber', 'resolving', 'to_president', 'enacted', 'vetoed', 'failed'].includes(
        status ?? '',
      ))
  ) {
    return 'The governing rule failed; the measure is stalled pending a new rule or an alternative path to the floor.';
  }
  switch (status) {
    case 'enacted':
      return 'Enacted into law. No further legislative action is pending.';
    case 'vetoed':
      return 'Vetoed. Any further action requires a veto-override vote.';
    case 'to_president':
      return 'Cleared Congress; awaiting presidential action.';
    case 'passed_chamber':
      return 'Passed one chamber; awaiting action in the other chamber.';
    case 'resolving':
      return 'Chambers are resolving differences (conference or amendment exchange).';
    case 'reported':
      return 'Reported from committee; awaiting floor scheduling.';
    case 'committee':
      return 'Referred to committee; awaiting committee action.';
    case 'introduced':
      return 'Introduced; awaiting committee referral.';
    case 'failed':
      return 'Failed; no further action is scheduled.';
    default:
      return 'Awaiting the next recorded official action.';
  }
}

export function isFresh(
  sourceChangeTs: Date | null,
  lastSyncedAt: Date | null | undefined,
): boolean {
  if (!lastSyncedAt) return false;
  if (sourceChangeTs) return lastSyncedAt.getTime() >= sourceChangeTs.getTime();
  return Date.now() - lastSyncedAt.getTime() < 7 * DAY_MS;
}
