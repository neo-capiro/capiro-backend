import type { BillDossierService } from './bill-dossier.service.js';
import { NotFoundException } from '@nestjs/common';
import {
  humanizeStateBillKey,
  stateBillStatusLabel,
  stateBillReplacement,
  isStateBillKey,
} from '@capiro/shared';
import type {
  StateSourceDataRepository,
  SourceStateBill,
  SourceMovedCompanion,
} from '../sourcedata/state-source-data.repository.js';
import type {
  BillDossierResponse,
  BillVote,
  FundingBlock,
  LatestAction,
  LegislativeMilestone,
  DossierSeverity,
} from './bill-dossier.types.js';
import { emptyFunding, STATE_FUNDING_UNSUPPORTED } from './bill-dossier-funding-empty.js';
import { NO_TARGET_VOTE, DAY_MS, toIso, capitalize } from './bill-dossier-presentation.js';
import { buildActionMilestones } from './bill-dossier-actions.js';

export interface BillDossierStatePorts {
  kpiOwner(): BillDossierService;
}

export class BillDossierState {
  constructor(
    private readonly stateSource: StateSourceDataRepository,
    private readonly ports: BillDossierStatePorts,
  ) {}

  async buildStateCore(billId: string): Promise<BillDossierResponse> {
    const b = await this.stateSource.getStateBillById(billId);

    if (!b) throw new NotFoundException('BILL_NOT_FOUND');

    const [actionsAsc, votesRows, companions] = await Promise.all([
      this.stateSource.getStateBillActionsByIds([billId]),
      this.stateSource.getStateVotesForBills([billId], true),
      this.stateSource.getMovedCompanions([billId]),
    ]);

    // getStateBillActionsByIds returns ORDER BY date ASC → reverse for newest-first.
    const actions = [...actionsAsc].reverse();

    const votes: BillVote[] = votesRows.map((v) => ({
      id: v.id ?? `${billId}:unresolved-vote-identity`,
      label: v.motion ?? `${capitalize(v.chamber)} vote`,
      target: 'passage',
      chamber: v.chamber,
      date: toIso(v.date),
      result: v.passed === null ? null : v.passed ? 'Passed' : 'Failed',
      resultSev: v.passed === null ? 'neutral' : v.passed ? 'success' : 'critical',
      tally: `${v.yeas}-${v.nays}`,
      party: null, // per-party breakdown is not surfaced on the state rail
      note: null,
    }));

    const noVote = votes.length === 0 ? NO_TARGET_VOTE : null;

    const replacement = stateBillReplacement(b.latestActionText);

    // Read repair while the scheduled derivation backfills persisted statuses.
    const status =
      replacement && !['enacted', 'vetoed', 'veto_overridden'].includes(b.status ?? '')
        ? 'superseded'
        : b.status;

    const statusLabel = status ? stateBillStatusLabel(status) : 'Status unavailable';

    const latest: LatestAction = { text: b.latestActionText, date: toIso(b.latestActionDate) };

    const milestones = buildActionMilestones(actions, 10);

    const bill = this.projectIdentity(b, status, statusLabel);

    const funding = emptyFunding(STATE_FUNDING_UNSUPPORTED);

    return this.assembleState(
      bill,
      b,
      latest,
      statusLabel,
      votes,
      milestones,
      noVote,
      funding,
      companions,
      replacement,
    );
  }

  private projectIdentity(b: SourceStateBill, status: string | null, statusLabel: string) {
    const bill = {
      id: b.id,
      num: humanizeStateBillKey(b.id),
      title: b.title ?? b.identifier,
      chamber: null,
      type: null,
      congress: null,
      sponsor: b.sponsorName,
      sponsorLegislatorId: b.sponsorLegislatorId ?? null,
      introduced: null,
      statusLabel,
      statusSev: 'neutral' as DossierSeverity,
      statusAt: toIso(status === 'superseded' ? b.latestActionDate : b.statusAt),
      stage: status,
      jurisdiction: b.state?.toUpperCase() ?? b.id.split('-')[0]?.toUpperCase() ?? null,
      isState: true,
      url: b.stateUrl ?? b.url,
    };

    return bill;
  }

  private assembleState(
    bill: BillDossierResponse['bill'],
    b: SourceStateBill,
    latest: LatestAction,
    statusLabel: string,
    votes: BillVote[],
    milestones: LegislativeMilestone[],
    noVote: string | null,
    funding: FundingBlock,
    companions: SourceMovedCompanion[],
    replacement: ReturnType<typeof stateBillReplacement>,
  ): BillDossierResponse {
    return {
      bill,
      latest,
      context: null,
      tracking: null,
      kpis: this.ports
        .kpiOwner()
        ['buildKpis'](statusLabel, bill.statusAt, bill.stage, latest, votes, null, funding),
      overview: {
        whatChanged: b.latestActionText
          ? {
              origin: 'official',
              text: b.latestActionText,
              asOf: toIso(b.latestActionDate),
              source: 'LegiScan',
              sourceUrl: bill.url,
            }
          : null,
        whyItMatters: null,
        officialNextStep: null,
        analystOutlook: null,
      },
      milestones,
      votes,
      governingRules: [], // federal-only concept; hidden for state bills
      noVote,
      funding,
      relatedVehicles: companions
        .filter((c) => c.relatedBillKey)
        .map((c) => ({
          billId: c.relatedBillKey as string,
          num: isStateBillKey(c.relatedBillKey as string)
            ? humanizeStateBillKey(c.relatedBillKey as string)
            : (c.relatedDisplay ?? (c.relatedBillKey as string)),
          title: c.relatedDisplay,
          role: `${c.linkType}${c.relatedStatus ? ` · ${stateBillStatusLabel(c.relatedStatus)}` : ''}${replacement?.chapter && replacement.billNumber === humanizeStateBillKey(c.relatedBillKey as string).replace(/^FL /, '') ? ` · Chapter ${replacement.chapter}` : ''}`,
        })),
      hearings: [],
      alerts: [],
      matchedTopics: [],
      recommendedActions: [],
      provenance: this.projectProvenance(b, bill),
    };
  }

  private projectProvenance(
    b: SourceStateBill,
    bill: BillDossierResponse['bill'],
  ): BillDossierResponse['provenance'] {
    return {
      lastSyncedAt: toIso(b.syncedAt ?? null),
      sourceCheckedAt: toIso(b.sourceCheckedAt ?? null),
      sourceCheckAttemptedAt: toIso(b.sourceCheckAttemptedAt ?? null),
      sourceCheckStatus: b.sourceCheckStatus ?? 'unknown',
      sourceCheckReason:
        b.sourceCheckError ??
        (b.sourceCheckedAt ? null : 'No successful source check has been recorded'),
      documentDate: toIso(b.textDate),
      sources: [
        {
          label: 'LegiScan',
          as: toIso(b.sourceCheckedAt ?? null),
          origin: 'official',
          fresh:
            b.sourceCheckStatus === 'success' &&
            Boolean(b.sourceCheckedAt) &&
            Date.now() >= b.sourceCheckedAt!.getTime() &&
            Date.now() - b.sourceCheckedAt!.getTime() < DAY_MS,
          url: bill.url,
        },
      ],
    };
  }
}
