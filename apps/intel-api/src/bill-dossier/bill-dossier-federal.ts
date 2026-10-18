import { NotFoundException } from '@nestjs/common';
import { billStatusLabel, humanizeBillId } from '@capiro/shared';
import type {
  SourceDataRepository,
  SourceBillIdentity,
  SourceBillAction,
  SourceBillVote,
  SourceGoverningRule,
  SourceBillFreshness,
  SourceFiscalNote,
  SourceHearingForBill,
} from '../sourcedata/source-data.repository.js';
import type {
  BillDossierResponse,
  BillVote,
  LatestAction,
  LegislativeMilestone,
  DossierSeverity,
  GoverningRule,
  DossierOverview,
  SourceRef,
  VotePartyBreakdown,
} from './bill-dossier.types.js';
import type { BillDossierService, DossierOptions } from './bill-dossier.service.js';
import { noFunding, type LoadedFunding } from './bill-dossier-funding.js';
import { FUNDING_UNAVAILABLE } from './bill-dossier-funding-empty.js';
import {
  MAX_ACTIONS,
  MAX_VOTES,
  MAX_FISCAL_NOTES,
  MAX_HEARINGS,
  NO_TARGET_VOTE,
  toIso,
  capitalize,
  byDateDesc,
} from './bill-dossier-presentation.js';
import { buildActionMilestones, type ActionMilestoneSource } from './bill-dossier-actions.js';
import {
  buildPartyMap,
  isPassageVoteQuestion,
  federalStatusPresentation,
  isFailedResult,
  sevForResult,
  sevForStatus,
  officialNextStepText,
  isFresh,
} from './bill-dossier-vote-status.js';

export interface BillDossierFederalPorts {
  loadFunding(billId: string): Promise<LoadedFunding>;
  buildFederalMilestones(
    actions: ActionMilestoneSource[],
    ruleRows: SourceGoverningRule[],
  ): LegislativeMilestone[];
  ruleVoteToBillVote(r: SourceGoverningRule, party: Map<string, VotePartyBreakdown>): BillVote;
  passageVoteToBillVote(v: SourceBillVote, party: Map<string, VotePartyBreakdown>): BillVote;
  kpiOwner(): BillDossierService;
}

export class BillDossierFederal {
  constructor(
    private readonly sourceData: SourceDataRepository,
    private readonly ports: BillDossierFederalPorts,
  ) {}

  async buildFederalCore(billId: string, opts: DossierOptions): Promise<BillDossierResponse> {
    const identity = await this.sourceData.getBillDossierIdentity(billId);

    if (!identity) throw new NotFoundException('BILL_NOT_FOUND');

    const [actions, billVoteRows, ruleRows, committees, fiscalNotes, freshness, upcoming] =
      await Promise.all([
        this.sourceData.getBillActions(billId, MAX_ACTIONS),
        this.sourceData.getBillVotes(billId, MAX_VOTES),
        this.sourceData.getGoverningRules(billId),
        this.sourceData.getBillCommittees(billId),
        this.sourceData.getBillFiscalNotes(billId, MAX_FISCAL_NOTES),
        this.sourceData.getBillSourceFreshness(billId),
        this.sourceData.getUpcomingHearingsForBills([billId]),
      ]);

    // Funding (R3 §3.6) — only when `defense_funding_intel` is on for the tenant.
    // Runs alongside the reads above rather than after them; when the flag is off no
    // funding query is issued at all.
    const funding = opts.funding
      ? await this.ports.loadFunding(billId)
      : noFunding(FUNDING_UNAVAILABLE);

    // Batched member-vote tallies for every vote id in one query (no N+1).
    const voteIds = [
      ...billVoteRows.map((v) => v.id),
      ...ruleRows.map((r) => r.voteId).filter((x): x is string => Boolean(x)),
    ];

    const tallies = await this.sourceData.getBillMemberVoteSummary(voteIds);

    const partyByVote = buildPartyMap(tallies);

    const { ruleVotes, billVotes, passageVotes, votes, noVote, ruleFailed, governingRules } =
      this.projectVotes(billVoteRows, ruleRows, partyByVote);

    const latest: LatestAction = {
      text: identity.latestActionText,
      date: toIso(identity.latestActionDate),
    };

    const milestones = this.ports.buildFederalMilestones(actions, ruleRows);

    const { statusPresentation, statusLabel, statusSev } = this.projectStatus(
      identity,
      actions,
      billVotes,
    );

    const sources = this.projectSources(identity, freshness, fiscalNotes);

    const overview = this.projectOverview(identity, statusPresentation, ruleFailed);

    const bill = this.projectIdentity(identity, statusLabel, statusSev, statusPresentation);

    return this.assembleFederal(
      bill,
      latest,
      statusLabel,
      votes,
      funding,
      overview,
      milestones,
      governingRules,
      noVote,
      upcoming,
      freshness,
      identity,
      sources,
    );
  }

  buildFederalMilestones(
    actions: Array<{
      id: string;
      date: Date;
      text: string;
      type: string | null;
      chamber: string | null;
    }>,
    ruleRows: SourceGoverningRule[],
  ): LegislativeMilestone[] {
    const fromActions = buildActionMilestones(actions, 10);
    const failedRules: LegislativeMilestone[] = ruleRows
      .filter((r) => isFailedResult(r.result))
      .map((r) => ({
        date: toIso(r.voteDate),
        label: `Governing rule ${humanizeBillId(r.ruleBillId)} failed`,
        detail: r.question,
        state: 'failed' as const,
        sev: 'critical' as DossierSeverity,
        outcome: 'Failed',
        outcomeSev: 'critical' as DossierSeverity,
        sourceIds: [r.voteId ?? `rule:${r.ruleBillId}`],
        sourceCount: 1,
      }));
    return [...failedRules, ...fromActions].sort(byDateDesc);
  }

  ruleVoteToBillVote(r: SourceGoverningRule, party: Map<string, VotePartyBreakdown>): BillVote {
    return {
      id: r.voteId ?? `rule:${r.ruleBillId}`,
      label: `Governing rule ${humanizeBillId(r.ruleBillId)}`,
      target: 'rule',
      chamber: r.chamber,
      date: toIso(r.voteDate),
      result: r.result,
      resultSev: sevForResult(r.result),
      tally: `${r.yeas ?? 0}-${r.nays ?? 0}`,
      party: r.voteId ? (party.get(r.voteId) ?? null) : null,
      note: null,
    };
  }

  passageVoteToBillVote(v: SourceBillVote, party: Map<string, VotePartyBreakdown>): BillVote {
    const passage = isPassageVoteQuestion(v.question);
    return {
      id: v.id,
      label: v.question ?? `${capitalize(v.chamber)} ${passage ? 'passage' : 'procedural'} vote`,
      target: passage ? 'passage' : 'procedural',
      chamber: v.chamber,
      date: toIso(v.voteDate),
      result: v.result,
      resultSev: sevForResult(v.result),
      tally: `${v.yeas}-${v.nays}`,
      party: party.get(v.id) ?? null,
      note: null,
    };
  }

  private projectVotes(
    billVoteRows: SourceBillVote[],
    ruleRows: SourceGoverningRule[],
    partyByVote: Map<string, VotePartyBreakdown>,
  ) {
    const ruleVotes: BillVote[] = ruleRows
      .filter((r) => r.result || r.voteId)
      .map((r) => this.ports.ruleVoteToBillVote(r, partyByVote));

    const billVotes: BillVote[] = billVoteRows.map((v) =>
      this.ports.passageVoteToBillVote(v, partyByVote),
    );

    const passageVotes = billVotes.filter((v) => v.target === 'passage');

    const votes = [...ruleVotes, ...billVotes].sort(byDateDesc);

    const noVote = passageVotes.length === 0 ? NO_TARGET_VOTE : null;

    const ruleFailed = ruleRows.some((r) => isFailedResult(r.result));

    const governingRules: GoverningRule[] = ruleRows.map((r) => ({
      id: r.voteId ?? r.ruleBillId,
      label: humanizeBillId(r.ruleBillId),
      desc: r.question,
      result: r.result,
      resultSev: sevForResult(r.result),
      tally: `${r.yeas ?? 0}-${r.nays ?? 0}`,
      date: toIso(r.voteDate),
      controls: true,
      note: isFailedResult(r.result)
        ? 'The rule failed; the underlying measure did not reach a floor vote.'
        : null,
    }));

    return { ruleVotes, billVotes, passageVotes, votes, noVote, ruleFailed, governingRules };
  }

  private projectStatus(
    identity: SourceBillIdentity,
    actions: SourceBillAction[],
    billVotes: BillVote[],
  ) {
    const canonicalStatusLabel = billStatusLabel(identity.status);

    const statusPresentation = federalStatusPresentation({
      status: identity.status,
      fallbackLabel: canonicalStatusLabel,
      fallbackAt: toIso(identity.statusAt),
      originChamber: identity.originChamber,
      actions,
      votes: billVotes,
    });

    const statusLabel = statusPresentation.label;

    const statusSev = sevForStatus(identity.status);

    return { canonicalStatusLabel, statusPresentation, statusLabel, statusSev };
  }

  private projectSources(
    identity: SourceBillIdentity,
    freshness: SourceBillFreshness | null,
    fiscalNotes: SourceFiscalNote[],
  ) {
    const sources: SourceRef[] = [];

    const changeTs = freshness?.updateDateIncludingText ?? freshness?.updateDate ?? null;

    sources.push({
      label: 'Congress.gov',
      as: toIso(changeTs),
      origin: 'official',
      fresh: isFresh(changeTs, freshness?.lastSyncedAt ?? identity.lastSyncedAt),
      url: identity.url,
    });

    for (const f of fiscalNotes) {
      sources.push({
        label: 'CBO cost estimate',
        as: toIso(f.pubDate),
        origin: 'official',
        fresh: true,
        url: f.cboUrl,
      });
    }

    return sources;
  }

  private projectOverview(
    identity: SourceBillIdentity,
    statusPresentation: ReturnType<typeof federalStatusPresentation>,
    ruleFailed: boolean,
  ) {
    const overview: DossierOverview = {
      whatChanged: identity.latestActionText
        ? {
            origin: 'official',
            text: identity.latestActionText,
            asOf: toIso(identity.latestActionDate),
            source: 'Congress.gov',
            sourceUrl: identity.url,
          }
        : null,
      whyItMatters: null,
      officialNextStep: {
        // This is deterministic procedural guidance derived from the canonical
        // status, not an officially scheduled event.
        origin: 'derived',
        text: officialNextStepText(identity.status, ruleFailed),
        asOf: statusPresentation.at,
        source: 'Capiro status model',
      },
      analystOutlook: null,
    };

    return overview;
  }

  private projectIdentity(
    identity: SourceBillIdentity,
    statusLabel: string,
    statusSev: DossierSeverity,
    statusPresentation: ReturnType<typeof federalStatusPresentation>,
  ) {
    const bill = {
      id: identity.id,
      num: humanizeBillId(identity.id),
      title: identity.title ?? identity.id,
      chamber: identity.originChamber,
      type: identity.billType,
      congress: identity.congress,
      sponsor: identity.sponsorName,
      introduced: toIso(identity.introducedDate),
      statusLabel,
      statusSev,
      statusAt: statusPresentation.at,
      stage: identity.status,
      jurisdiction: 'US',
      isState: false,
      url: identity.url,
    };

    return bill;
  }

  private assembleFederal(
    bill: BillDossierResponse['bill'],
    latest: LatestAction,
    statusLabel: string,
    votes: BillVote[],
    funding: LoadedFunding,
    overview: DossierOverview,
    milestones: LegislativeMilestone[],
    governingRules: GoverningRule[],
    noVote: string | null,
    upcoming: SourceHearingForBill[],
    freshness: SourceBillFreshness | null,
    identity: SourceBillIdentity,
    sources: SourceRef[],
  ): BillDossierResponse {
    return {
      bill,
      latest,
      context: null,
      tracking: null,
      kpis: this.ports
        .kpiOwner()
        ['buildKpis'](statusLabel, bill.statusAt, bill.stage, latest, votes, null, funding.block),
      overview,
      milestones,
      votes,
      governingRules,
      noVote,
      funding: funding.block,
      relatedVehicles: funding.relatedVehicles,
      hearings: upcoming.slice(0, MAX_HEARINGS).map((h) => ({
        id: h.hearingId,
        title: h.title,
        committee: h.committeeName,
        date: toIso(h.date),
        mentions: [],
      })),
      alerts: [],
      matchedTopics: [],
      recommendedActions: [],
      provenance: {
        lastSyncedAt: toIso(freshness?.lastSyncedAt ?? identity.lastSyncedAt),
        sources,
      },
    };
  }
}
