import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EXPECTED_MILESTONE_TYPE_LABELS,
  billStatusLabel,
  classifyVoteResult,
  humanizeBillId,
  humanizeStateBillKey,
  stateBillStatusLabel,
  stateBillReplacement,
  isStateBillKey,
  type ExpectedConfidenceLevel,
  type ExpectedMilestoneType,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SourceDataRepository,
  type SourceBillPeImpact,
  type SourceBillProvision,
  type SourceBillVote,
  type SourceFundingPosition,
  type SourceGoverningRule,
  type SourceMemberVoteTally,
  type SourceParentPackage,
  type SourceRelatedVehicle,
} from '../sourcedata/source-data.repository.js';
import { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';
import { mapCombinedAlertsToHearings } from '../linking/bill-hearings.service.js';
import type {
  BillContext,
  BillDossierResponse,
  BillHearingView,
  BillKpi,
  BillVote,
  ContextAlertView,
  DossierOverview,
  DossierSeverity,
  ExpectedMilestone,
  FundingAmountTreatment,
  FundingBlock,
  FundingComparison,
  FundingPositionView,
  FundingProvision,
  FundingVehicleContext,
  GoverningRule,
  LatestAction,
  LegislativeMilestone,
  MatchedTopic,
  ProgramElementImpact,
  RecommendedActionView,
  RelatedVehicle,
  SourceRef,
  VotePartyBreakdown,
} from './bill-dossier.types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

/** R1 result caps (plan §1.2). */
const MAX_ACTIONS = 50;
const MAX_VOTES = 25;
const MAX_ALERTS = 50;
const MAX_HEARINGS = 20;
const MAX_MENTIONS_PER_HEARING = 10;
const MAX_RECOMMENDED_ACTIONS = 10;
const MAX_FISCAL_NOTES = 10;

/** R3 funding caps (plan §3.5). */
const MAX_FUNDING_POSITIONS = 50;
const MAX_PE_IMPACTS = 100;
const MAX_RELATED_VEHICLES = 25;
const MAX_PROVISIONS = 50;

const NO_TARGET_VOTE = 'No roll call vote has been recorded on this bill.';
const FUNDING_UNAVAILABLE =
  'Funding intelligence is not yet enabled for this vehicle. No $0 is shown unless a source states zero.';
const FUNDING_NO_DATA =
  'No reviewed funding positions are linked to this bill yet. No $0 is shown unless a source states zero.';
const STATE_FUNDING_UNSUPPORTED =
  'State funding data is not available. No $0 is shown unless a source states zero.';
/**
 * Funding IS linked to the bill (program-element impacts exist) but no reviewed
 * position row does, so there is no amount to show. Distinct from
 * FUNDING_NO_DATA, which means nothing at all is linked (LW-QA-021).
 */
const FUNDING_NO_PRIMARY_POSITION =
  'Program-element links are available, but no reviewed funding position can be shown. No $0 is shown unless a source states zero.';
const FUNDING_TABLES_PENDING =
  'Funding tables are available; amounts await verification.';
const OVERRIDE_RECONCILIATION_GUARDRAIL =
  'Official provisions explicitly change table amounts, but those overrides have not been numerically reconciled. No topline amount or comparison is shown until verification is complete.';
/** Explicit analyst attestation stored on a VERIFIED position note. */
const OVERRIDE_RECONCILIATION_MARKER = '[overrides-reconciled]';
const NO_REQUEST_COMPARISON =
  "No President's request figure on the same fiscal year and the same funding scope is available to compare against.";
const NO_OFFICIAL_ACTION = 'No dated official action has been recorded on this bill.';
const NO_EXPECTED_MILESTONE =
  'An expected next step cannot be verified from the current official status.';
/** Shown whenever positions span more than one measurement basis. */
const SCOPE_GUARDRAIL =
  'This bill carries figures on more than one funding scope. Amounts are only compared within the same fiscal year and the same scope, so no cross-scope delta is shown.';

/** Per-request switches resolved by the controller from the tenant's feature flags. */
export interface DossierOptions {
  /** `defense_funding_intel` — when false, no funding query runs at all (§3.6). */
  funding?: boolean;
}

/**
 * The funding read's output: the response block plus the pieces other sections of
 * the dossier need (related vehicles for the Overview tab, and the primary position
 * + request delta for the KPI strip).
 */
interface LoadedFunding {
  block: FundingBlock;
  relatedVehicles: RelatedVehicle[];
}

/** A funding-free result carrying a grounded reason. Never a $0 row. */
function noFunding(status: string): LoadedFunding {
  return { block: emptyFunding(status), relatedVehicles: [] };
}

/**
 * Bill 360 dossier read model (plan §1.2 + §1.5).
 *
 * Composes a bill dossier from GLOBAL public bill facts (federal via
 * SourceDataRepository, state via StateSourceDataRepository) and — on the client
 * route only — that tenant/client's tracking context (intel_tracked_bill,
 * intel_alert). Both carry FORCE ROW LEVEL SECURITY scoped to tenant_id
 * (`20260706010000_intel_full_rls_hold`); every client read additionally
 * filters explicitly by tenantId (+ clientId) inside prisma.withTenant.
 *
 * The service is READ-ONLY toward apps/api-owned tables (it only reads through the
 * repositories) and never recomputes or overwrites the canonical bill status — an
 * analyst outlook is surfaced with origin='analyst' and never mutates the status.
 * Independent reads run in parallel (Promise.all); member-vote tallies are fetched
 * in ONE batched query (no N+1). Funding is an explicit "not yet available" empty
 * state until R3 (defense_funding_intel).
 */
@Injectable()
export class BillDossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceData: SourceDataRepository,
    private readonly stateSource: StateSourceDataRepository,
  ) {}

  /** Public/official dossier — no client context (context/tracking null, alerts empty). */
  async getGlobalDossier(billId: string, opts: DossierOptions = {}): Promise<BillDossierResponse> {
    const id = (billId ?? '').trim();
    if (!id) throw new BadRequestException('BILL_NOT_FOUND');
    return isStateBillKey(id) ? this.buildStateCore(id) : this.buildFederalCore(id, opts);
  }

  async getSourceRecords(billId: string, section: string, cursor?: string) {
    if (!isStateBillKey(billId) || !(await this.stateSource.getStateBillById(billId)))
      throw new NotFoundException('STATE_BILL_NOT_FOUND');
    if (!['history', 'documents', 'votes'].includes(section))
      throw new BadRequestException('INVALID_RECORD_SECTION');
    let offset = 0;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          c.billId !== billId ||
          c.section !== section ||
          !Number.isSafeInteger(c.offset) ||
          c.offset < 0
        )
          throw new Error();
        offset = c.offset;
      } catch {
        throw new BadRequestException('INVALID_RECORD_CURSOR');
      }
    }
    const page = await this.stateSource.getRecordPage(
      billId,
      section as 'history' | 'documents' | 'votes',
      offset,
    );
    return {
      ...page,
      nextCursor:
        offset + page.rows.length < page.total
          ? Buffer.from(
              JSON.stringify({ billId, section, offset: offset + page.rows.length }),
            ).toString('base64url')
          : null,
      availability: page.total ? 'available' : 'unavailable',
      reason: page.total ? null : 'No records have been ingested for this section',
      // Metadata rail: the prior clause "document full text is not indexed" was a
      // universal false claim — retained provider document text IS indexed and
      // searchable through Research (17 documents extracted; S0032 versions
      // compared there). This endpoint only serves metadata + original source
      // links; point at Research for retained text without claiming absence.
      // Source incompleteness is still surfaced per-section via `reason`.
      coverage: 'Provider metadata and original source links; retained document text is available through Research',
    };
  }

  async getStateVoteMembers(billId: string, voteId: string) {
    if (!isStateBillKey(billId)) throw new NotFoundException();
    return this.stateSource.getVoteMembers(billId, voteId);
  }

  /** Public dossier + the given tenant/client's tracking context, alerts, and analyst outlook. */
  async getClientDossier(
    tenantId: string,
    clientId: string,
    billId: string,
    opts: DossierOptions = {},
  ): Promise<BillDossierResponse> {
    const id = (billId ?? '').trim();
    if (!id) throw new BadRequestException('BILL_NOT_FOUND');
    // Validate the client belongs to this tenant (bound-param read; 404 otherwise)
    // BEFORE any cross-tenant leak is possible.
    if (!UUID_RE.test(clientId)) throw new NotFoundException('CLIENT_NOT_FOUND');
    const client = await this.sourceData.getClientProfile(tenantId, clientId);
    if (!client) throw new NotFoundException('CLIENT_NOT_FOUND');

    const core = isStateBillKey(id)
      ? await this.buildStateCore(id)
      : await this.buildFederalCore(id, opts);

    // Independent client-context reads run in parallel (§1.2).
    const [tracking, alertRows, matchedTopics, clientHearings] = await Promise.all([
      this.loadTracking(tenantId, clientId, id),
      this.loadClientAlerts(tenantId, clientId, id),
      this.loadMatchedTopics(tenantId, clientId, id),
      this.loadClientHearings(tenantId, clientId, id),
    ]);

    return {
      ...core,
      context: { contextType: 'client', externalRef: clientId, name: client.name ?? clientId },
      tracking,
      alerts: alertRows.map(toContextAlertView),
      matchedTopics,
      recommendedActions: buildRecommendedActions(alertRows),
      // Sessions that actually mentioned the bill (with quotes) lead; the public
      // upcoming-hearing rows from the core follow. Capped at MAX_HEARINGS total.
      hearings: [...clientHearings, ...core.hearings].slice(0, MAX_HEARINGS),
      overview: this.mergeAnalystOverview(core.overview, tracking, alertRows),
      // `core.funding` is the SAME block the global route derived its funding
      // cells from. Omitting it here (LW-QA-021) made client scope report "no
      // funding position" on bills the global scope showed a real amount for.
      kpis: this.buildKpis(
        core.bill.statusLabel,
        core.bill.statusAt,
        core.bill.stage,
        core.latest,
        core.votes,
        tracking,
        core.funding,
      ),
    };
  }

  // ── Federal rail ───────────────────────────────────────────────────────────

  private async buildFederalCore(
    billId: string,
    opts: DossierOptions = {},
  ): Promise<BillDossierResponse> {
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
    const funding = opts.funding ? await this.loadFunding(billId) : noFunding(FUNDING_UNAVAILABLE);

    // Batched member-vote tallies for every vote id in one query (no N+1).
    const voteIds = [
      ...billVoteRows.map((v) => v.id),
      ...ruleRows.map((r) => r.voteId).filter((x): x is string => Boolean(x)),
    ];
    const tallies = await this.sourceData.getBillMemberVoteSummary(voteIds);
    const partyByVote = buildPartyMap(tallies);

    const ruleVotes: BillVote[] = ruleRows
      .filter((r) => r.result || r.voteId)
      .map((r) => this.ruleVoteToBillVote(r, partyByVote));
    const billVotes: BillVote[] = billVoteRows.map((v) =>
      this.passageVoteToBillVote(v, partyByVote),
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

    const latest: LatestAction = {
      text: identity.latestActionText,
      date: toIso(identity.latestActionDate),
    };

    const milestones = this.buildFederalMilestones(actions, ruleRows);

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

    return {
      bill,
      latest,
      context: null,
      tracking: null,
      kpis: this.buildKpis(
        statusLabel,
        bill.statusAt,
        bill.stage,
        latest,
        votes,
        null,
        funding.block,
      ),
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

  private buildFederalMilestones(
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

  private ruleVoteToBillVote(
    r: SourceGoverningRule,
    party: Map<string, VotePartyBreakdown>,
  ): BillVote {
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

  private passageVoteToBillVote(
    v: SourceBillVote,
    party: Map<string, VotePartyBreakdown>,
  ): BillVote {
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

  // ── State rail (plan §1.5) ──────────────────────────────────────────────────

  private async buildStateCore(billId: string): Promise<BillDossierResponse> {
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
    const status = replacement && !['enacted', 'vetoed', 'veto_overridden'].includes(b.status ?? '')
      ? 'superseded' : b.status;
    const statusLabel = status ? stateBillStatusLabel(status) : 'Status unavailable';
    const latest: LatestAction = { text: b.latestActionText, date: toIso(b.latestActionDate) };
    const milestones = buildActionMilestones(actions, 10);

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

    const funding = emptyFunding(STATE_FUNDING_UNSUPPORTED);

    return {
      bill,
      latest,
      context: null,
      tracking: null,
      kpis: this.buildKpis(statusLabel, bill.statusAt, bill.stage, latest, votes, null, funding),
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
      provenance: {
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
      },
    };
  }

  // ── Funding (R3 §3.6) ───────────────────────────────────────────────────────

  /**
   * Load this bill's funding picture from the R3 budget-package substrate.
   *
   * Rules encoded here:
   *  - the PRIMARY position is reviewed/verified, on this bill vehicle's own track,
   *    and at the furthest stage; extracted figures remain evidence, not headlines;
   *  - a delta is only computed against a request row with the SAME fiscal year AND
   *    the SAME scope. Otherwise the delta is null and the guardrail explains why;
   *  - authorization and appropriation rows both appear, separately labelled, and
   *    are never merged into one "current" figure;
   *  - accepted add/cut/transfer provisions suppress the topline until their
   *    numerical effect has been reconciled with the table;
   *  - when nothing is linked, the block returns `available: false` with a grounded
   *    status string and EMPTY arrays — never a fabricated $0.
   */
  private async loadFunding(billId: string): Promise<LoadedFunding> {
    const [positions, peImpacts, related, provisions, parent] = await Promise.all([
      this.sourceData.getBillFundingPositions(billId, MAX_FUNDING_POSITIONS),
      this.sourceData.getBillProgramElementImpacts(billId, MAX_PE_IMPACTS),
      this.sourceData.getRelatedBudgetVehicles(billId, MAX_RELATED_VEHICLES),
      this.sourceData.getBillFundingProvisions(billId, MAX_PROVISIONS),
      this.sourceData.getParentBudgetPackage(billId),
    ]);

    const positionViews = positions.map(toFundingPositionView);
    const impactViews = peImpacts.map(toPeImpactView);
    const provisionViews = provisions.map(toFundingProvisionView);
    const relatedVehicles = related.map(toRelatedVehicleView);
    const vehicle = toFundingVehicleContext(parent, positions);

    if (!positionViews.length && !impactViews.length) {
      return {
        block: {
          ...emptyFunding(FUNDING_NO_DATA),
          provisions: provisionViews,
          parentPackageLabel: parent ? parent.name : null,
          vehicle,
        },
        relatedVehicles,
      };
    }

    const tablesAvailable =
      positionViews.some(
        (position) => !vehicle || (position.vehicleId === vehicle.id && position.fiscalYear === vehicle.fiscalYear),
      ) || impactViews.some((impact) => hasFundingTableValues(impact));
    const overrideReconciliationRequired = provisions.some(
      (provision) =>
        provision.reviewStatus === 'accepted' &&
        provision.billLinkStatus === 'accepted' &&
        ['adds', 'cuts', 'transfers'].includes(provision.actionType ?? ''),
    );
    const primaryCandidate = pickPrimaryPosition(positionViews, vehicle);
    const overrideReconciled =
      overrideReconciliationRequired &&
      primaryCandidate != null &&
      isOverrideReconciled(primaryCandidate);
    const primary = overrideReconciliationRequired && !overrideReconciled ? null : primaryCandidate;
    const withPrimary = positionViews.map((p) => ({ ...p, primary: primary?.id === p.id }));

    const reqCompare = primary ? buildRequestComparison(primary, positions) : null;
    const senateCompare = primary ? buildSenateComparison(primary, positions) : null;
    const comparisons = primary ? buildLikeForLikeComparisons(primary, positions) : [];
    const scopes = new Set(positionViews.map((p) => p.scope));

    return {
      block: {
        available: true,
        status: primary
          ? null
          : tablesAvailable
            ? FUNDING_TABLES_PENDING
            : FUNDING_NO_PRIMARY_POSITION,
        tablesAvailable,
        analysisStatus:
          primary?.verification === 'verified'
            ? 'verified'
            : primary
              ? 'reviewed'
              : 'analysis_pending',
        vehicle,
        overrideReconciliation: overrideReconciliationRequired
          ? overrideReconciled
            ? 'reconciled'
            : 'verification_required'
          : 'not_required',
        positions: withPrimary,
        reqCompare,
        senateCompare,
        comparisons,
        // Only warn when there is genuinely more than one basis in play — a
        // single-scope bill needs no caveat.
        guardrail: overrideReconciliationRequired && !overrideReconciled
          ? OVERRIDE_RECONCILIATION_GUARDRAIL
          : scopes.size > 1
            ? SCOPE_GUARDRAIL
            : null,
        programElementImpacts: impactViews,
        provisions: provisionViews,
        parentPackageLabel: parent ? parent.name : null,
      },
      relatedVehicles,
    };
  }

  // ── Client context ──────────────────────────────────────────────────────────

  private async loadTracking(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<BillContext> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.findFirst({ where: { tenantId, clientId, billId } }),
    );
    if (!row) {
      return {
        tracked: false,
        position: null,
        priority: null,
        analystNote: null,
        stage: null,
        trackedAt: null,
        expected: null,
      };
    }
    const hasExpected = Boolean(
      row.expectedMilestoneType ||
      row.expectedWindowStart ||
      row.expectedWindowEnd ||
      row.expectedRationale,
    );
    const expected: ExpectedMilestone | null = hasExpected
      ? {
          milestoneType: (row.expectedMilestoneType as ExpectedMilestoneType | null) ?? null,
          windowStart: toIso(row.expectedWindowStart),
          windowEnd: toIso(row.expectedWindowEnd),
          confidence: (row.expectedConfidence as ExpectedConfidenceLevel | null) ?? null,
          rationale: row.expectedRationale ?? null,
          updatedBy: row.expectedUpdatedBy ?? null,
          updatedAt: toIso(row.expectedUpdatedAt),
          stale: row.expectedWindowEnd ? row.expectedWindowEnd.getTime() < Date.now() : false,
        }
      : null;
    return {
      tracked: true,
      position: normalizePosition(row.position),
      priority: normalizePriority(row.priority),
      // Preserve legacy `note` when no explicit analyst note was set (plan §1.3).
      analystNote: row.analystNote ?? row.note ?? null,
      stage: row.stage ?? null,
      trackedAt: toIso(row.trackedAt),
      expected,
    };
  }

  /**
   * This client's alert rows for the bill (newest-first, bounded). Returns the raw
   * rows — the caller derives the alert list, the recommended actions, and the
   * derived "why it matters" fallback from ONE read rather than three.
   */
  private async loadClientAlerts(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<ClientAlertRow[]> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        // Index-backed: @@index([tenantId, sourceType, sourceRef]); clientId is a
        // cheap residual equality (still applied by Postgres, not in JS).
        where: { tenantId, clientId, sourceType: 'bill', sourceRef: billId },
        orderBy: { createdAt: 'desc' },
        take: MAX_ALERTS,
        select: {
          id: true,
          severity: true,
          createdAt: true,
          title: true,
          whyItMatters: true,
          recommendedAction: true,
        },
      }),
    );
  }

  /**
   * The watchlist tags that matched this bill for this client (§1.2 "matched
   * topics"), from the client's `intel_bill_match` row. Single indexed row read
   * (@@unique([clientId, billId]) + explicit tenant predicate — intel-api has no
   * RLS). Returns `[]` when the bill was tracked manually and never matched.
   */
  private async loadMatchedTopics(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<MatchedTopic[]> {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.billMatch.findFirst({
        where: { tenantId, clientId, billId },
        select: { matchedTags: true, fit: true, jurisdiction: true, lastFitAt: true },
      }),
    );
    if (!row) return [];
    return (row.matchedTags ?? [])
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => ({
        label: t,
        fit: typeof row.fit === 'number' ? row.fit : null,
        jurisdiction: row.jurisdiction ?? null,
        matchedAt: toIso(row.lastFitAt),
      }));
  }

  /**
   * Hearing sessions that discussed this bill FOR THIS CLIENT, with per-mention
   * timestamp/speaker/quote (§1.2 "hearing mentions for the client"). Reads the
   * linker's denormalized `combined` alert evidence — the same source and the same
   * tenant+client predicate as the existing GET /clients/:c/bills/:b/hearings
   * endpoint, reusing its pure mapper. Bounded to MAX_HEARINGS sessions and
   * MAX_MENTIONS_PER_HEARING mentions per session.
   *
   * Quotes are only present when the linker stored plaintext; encrypted segments
   * were already recorded as `quote: null` at link time, so no decryption happens
   * here and ciphertext can never leak into the dossier.
   */
  private async loadClientHearings(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<BillHearingView[]> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        where: {
          tenantId,
          clientId,
          sourceType: 'combined',
          sourceRef: billId,
          status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: MAX_HEARINGS,
        select: { sourceRef: true, evidence: true, createdAt: true },
      }),
    );
    return mapCombinedAlertsToHearings(rows)
      .hearings.slice(0, MAX_HEARINGS)
      .map((h) => ({
        id: h.sessionId,
        title: h.title,
        committee: h.committeeId,
        date: h.occurredAt,
        mentions: h.mentions.slice(0, MAX_MENTIONS_PER_HEARING).map((m) => ({
          ts: m.timestampMs === null ? null : msToClock(m.timestampMs),
          speaker: m.speakerName,
          quote: m.quote,
        })),
      }));
  }

  private mergeAnalystOverview(
    base: DossierOverview,
    tracking: BillContext | null,
    alertRows: ClientAlertRow[] = [],
  ): DossierOverview {
    const out: DossierOverview = { ...base };
    // Derived (Capiro analysis) fallback: the newest alert that recorded a
    // why-it-matters. An analyst note, when present, wins below.
    const derived = alertRows.find((r) => (r.whyItMatters ?? '').trim().length > 0);
    if (derived) {
      out.whyItMatters = {
        origin: 'derived',
        text: derived.whyItMatters as string,
        asOf: toIso(derived.createdAt),
        source: 'Capiro alert analysis',
      };
    }
    if (!tracking || !tracking.tracked) return out;
    if (tracking.analystNote) {
      out.whyItMatters = {
        origin: 'analyst',
        text: tracking.analystNote,
        asOf: tracking.trackedAt,
        source: 'Analyst note',
      };
    }
    if (tracking.expected?.rationale) {
      out.analystOutlook = {
        origin: 'analyst',
        text: tracking.expected.rationale,
        asOf: tracking.expected.updatedAt,
        expires: tracking.expected.windowEnd,
      };
    }
    return out;
  }

  /**
   * The six KPI cells, each carrying its own semantic `id` (LW-QA-021).
   *
   * Every cell is either a real figure or an explicit `value: null` plus a
   * grounded `unavailableReason` — the strip never claims `0`, and it never
   * leaves a tile blank for the reader to interpret. `funding` is the response
   * block (the same object the dossier returns), so the client route and the
   * global route derive identical funding cells.
   */
  private buildKpis(
    statusLabel: string,
    statusAt: string | null,
    stage: string | null,
    latest: LatestAction,
    votes: BillVote[],
    tracking: BillContext | null,
    funding: FundingBlock | null,
  ): BillKpi[] {
    // A later procedural roll call (for example a failed recommit motion) must
    // not displace the bill's actual passage vote in the headline KPI.
    const v0 = votes.find((v) => v.target === 'passage') ?? votes[0] ?? null;
    const expected = tracking?.expected ?? null;
    const inferredNextStep = expected?.milestoneType
      ? EXPECTED_MILESTONE_TYPE_LABELS[expected.milestoneType]
      : expectedNextStep(stage, statusLabel);
    // R3: the funding cells show the primary position and its same-scope delta once
    // funding data exists. Otherwise they say WHY there is no figure (§3.6).
    const primary = funding?.positions.find((p) => p.primary) ?? null;
    const delta = funding?.reqCompare?.deltaMillions ?? null;
    const noFundingReason = fundingUnavailableReason(funding);
    const fundingPending =
      !primary && funding?.tablesAvailable === true && funding.analysisStatus === 'analysis_pending';
    const fundingLabel =
      fundingPending && funding.vehicle
        ? fundingStageTrackLabel(funding.vehicle.stage, funding.vehicle.track)
        : 'Funding position';
    const requestLabel = funding?.vehicle?.fiscalYear
      ? `Change vs. FY${funding.vehicle.fiscalYear} request`
      : 'Δ from request';
    return [
      {
        id: 'current_status',
        label: 'Current status',
        value: statusLabel,
        valueType: 'status',
        asOf: statusAt,
        sub: null,
        unavailableReason: null,
      },
      {
        id: 'latest_vote',
        label: 'Latest recorded vote',
        value: v0 ? (v0.result ? `${v0.result} ${v0.tally}` : v0.tally) : null,
        valueType: 'text',
        asOf: v0?.date ?? null,
        sub: v0 ? v0.label : null,
        unavailableReason: v0 ? null : NO_TARGET_VOTE,
      },
      {
        id: 'funding_position',
        label: fundingLabel,
        value: primary ? fmtMillions(primary.amountMillions) : null,
        valueType: 'money',
        asOf: primary?.effectiveDate ?? null,
        sub: primary
          ? `${primary.scope} · ${fundingStageTrackLabel(primary.stage, primary.vehicleClass)}`
          : null,
        unavailableLabel: fundingPending ? 'Analysis pending' : null,
        unavailableReason: primary ? null : noFundingReason,
      },
      {
        id: 'delta_from_request',
        label: requestLabel,
        value: delta != null ? fmtSignedMillions(delta) : null,
        valueType: 'signed_money',
        asOf: null,
        sub: delta != null ? 'same scope only' : null,
        unavailableLabel: fundingPending ? 'Comparison pending' : null,
        unavailableReason:
          delta != null
            ? null
            : primary
              ? (funding?.guardrail ?? NO_REQUEST_COMPARISON)
              : noFundingReason,
      },
      {
        id: 'last_official_action',
        label: 'Latest action',
        value: latest.date,
        valueType: 'date',
        asOf: latest.date,
        sub: latest.text,
        unavailableReason: latest.date ? null : NO_OFFICIAL_ACTION,
      },
      {
        id: 'next_milestone',
        label: 'Expected next step',
        value: inferredNextStep,
        valueType: 'text',
        asOf: expected?.windowStart ?? null,
        sub: inferredNextStep
          ? expected?.windowStart
            ? 'Expected window opens'
            : 'Date not verified'
          : null,
        unavailableReason: inferredNextStep ? null : NO_EXPECTED_MILESTONE,
      },
    ];
  }
}

// ── Pure helpers (module-scoped; unit-tested through the service) ─────────────

/** The `intel_alert` projection the client dossier reads (one query, three uses). */
interface ClientAlertRow {
  id: string;
  severity: string | null;
  createdAt: Date;
  title: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
}

function toContextAlertView(r: ClientAlertRow): ContextAlertView {
  return { id: r.id, sev: sevForAlert(r.severity), date: toIso(r.createdAt), title: r.title };
}

/**
 * Recommended next actions for the bill, taken VERBATIM from
 * `intel_alert.recommended_action` on this client's alerts. Nothing is
 * synthesized: alerts with no recorded recommendation contribute nothing, so an
 * empty list is an honest "no recommendation on record". Deduped by text
 * (newest-first wins) and bounded.
 */
function buildRecommendedActions(rows: ClientAlertRow[]): RecommendedActionView[] {
  const out: RecommendedActionView[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const text = (r.recommendedAction ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      origin: 'derived',
      sev: sevForAlert(r.severity),
      date: toIso(r.createdAt),
      alertId: r.id,
    });
    if (out.length >= MAX_RECOMMENDED_ACTIONS) break;
  }
  return out;
}

/** Transcript offset (ms) → `h:mm:ss` / `m:ss` clock label for a hearing mention. */
function msToClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// ── Funding mappers + comparability rules (R3 §3.6) ───────────────────────────

/** Stage order used to pick the furthest-progressed figure. */
const STAGE_ORDER: Record<string, number> = {
  president: 0,
  house: 1,
  senate: 2,
  conference: 3,
  enacted: 4,
};

function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function versionedValueSource(
  label: string,
  value: number | null,
  sourceKey: string | null | undefined,
  sha256: string | null | undefined,
): string | null {
  if (value == null) return null;
  if (!sourceKey && !sha256) return `${label} source version not verified`;
  return `${label} source ${sourceKey ?? 'document'}${sha256 ? `@${sha256.slice(0, 12)}` : ''}`;
}

/** $X.XB at >= 1000M, else $XM. Mirrors the web formatter so KPI text agrees. */
function fmtMillions(m: number): string {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

/** Signed delta; 'flat' at exactly zero. U+2212 MINUS for negatives. */
function fmtSignedMillions(m: number): string {
  if (m === 0) return 'flat';
  return `${m > 0 ? '+' : '−'}${fmtMillions(Math.abs(m))}`;
}

function amountTreatmentFor(track: string | null | undefined): FundingAmountTreatment {
  switch (track) {
    case 'request':
      return 'request';
    case 'authorization':
      return 'proposed_authorization';
    case 'appropriation':
      return 'appropriated_funding';
    case 'interim_funding':
      return 'interim_funding';
    case 'supplemental':
      return 'supplemental';
    case 'reconciliation':
      return 'reconciliation';
    default:
      return 'unknown';
  }
}

function fundingStageTrackLabel(stage: string, track: string): string {
  const stageLabel =
    stage === 'president'
      ? 'President\'s'
      : stage === 'house'
        ? 'House'
        : stage === 'senate'
          ? 'Senate'
          : stage === 'conference'
            ? 'Conference'
            : stage === 'enacted'
              ? 'Enacted'
              : stage;
  const trackLabel =
    track === 'authorization'
      ? 'authorization'
      : track === 'appropriation'
        ? 'appropriation'
        : track === 'request'
          ? 'request'
          : track.replaceAll('_', ' ');
  return `${stageLabel} ${trackLabel}`;
}

function toFundingPositionView(p: SourceFundingPosition): FundingPositionView & { id: string } {
  return {
    id: p.id,
    vehicleId: p.vehicleId,
    fiscalYear: p.fiscalYear,
    scope: p.scope as FundingPositionView['scope'],
    stage: p.stage as FundingPositionView['stage'],
    vehicleClass: p.vehicleClass as FundingPositionView['vehicleClass'],
    vehicleTrack: (p.vehicleTrack as FundingPositionView['vehicleTrack']) ?? null,
    vehicleStatus: p.vehicleStatus,
    amountTreatment: amountTreatmentFor(p.vehicleTrack ?? p.vehicleClass),
    amountMillions: Number(p.amountMillions),
    effectiveDate: toIso(p.effectiveDate),
    source: p.vehicleLabel ?? p.packageName,
    sourceUrl: p.sourceUrl,
    sourcePage: p.sourcePage,
    sourceDocumentTitle: p.sourceDocumentTitle,
    sourceDocumentKey: p.sourceDocumentKey,
    sourceDocumentVersion: p.sourceDocumentSha256,
    sourceDocumentCurrent: p.sourceDocumentCurrent,
    verification: p.verificationStatus as FundingPositionView['verification'],
    primary: false,
    note: p.note,
  };
}

function toPeImpactView(p: SourceBillPeImpact): ProgramElementImpact {
  const vehicleTrack = (p.vehicleTrack as ProgramElementImpact['vehicleTrack']) ?? null;
  const stageRank = STAGE_ORDER[p.vehicleStage ?? ''] ?? -1;
  const request = num(p.requestMillions);
  const house = stageRank >= (STAGE_ORDER.house ?? 2) ? num(p.houseMillions) : null;
  const senate = stageRank >= (STAGE_ORDER.senate ?? 3) ? num(p.senateMillions) : null;
  const conference =
    stageRank >= (STAGE_ORDER.conference ?? 4) ? num(p.conferenceMillions) : null;
  // Enacted is the appropriations/public-law rung. Never let a malformed or
  // legacy row append it to an authorization ladder.
  const enacted =
    vehicleTrack === 'appropriation' && stageRank >= (STAGE_ORDER.enacted ?? 5)
      ? num(p.enactedMillions)
      : null;
  // Same fiscal year by construction (the query pins the PE year to the package FY).
  const latest = enacted ?? conference ?? senate ?? house;
  const delta = request != null && latest != null ? latest - request : null;
  const isAuthorization = vehicleTrack === 'authorization';
  return {
    pe: p.peCode,
    name: p.title,
    fiscalYear: p.fiscalYear,
    vehicleTrack,
    houseLabel: isAuthorization
      ? 'House authorization (HASC)'
      : vehicleTrack === 'appropriation'
        ? 'House appropriation (HAC-D)'
        : 'House amount (track not verified)',
    senateLabel: isAuthorization
      ? 'Senate authorization (SASC)'
      : vehicleTrack === 'appropriation'
        ? 'Senate appropriation (SAC-D)'
        : 'Senate amount (track not verified)',
    conferenceLabel: isAuthorization
      ? 'NDAA conference authorization'
      : vehicleTrack === 'appropriation'
        ? 'Appropriations conference'
        : 'Conference amount (track not verified)',
    requestMillions: request,
    houseMillions: house,
    senateMillions: senate,
    conferenceMillions: conference,
    enactedMillions: enacted,
    deltaVsRequestMillions: delta,
    pct:
      delta != null && request != null && request !== 0
        ? Number(((delta / request) * 100).toFixed(2))
        : null,
    // A verbatim PE-code link is explicit; everything fuzzier is inferred and the UI
    // must label it as such (§5 edge cases 23-24).
    basis: p.matchBasis === 'explicit_pe_code' ? 'explicit' : 'inferred',
    source: [
      p.fiscalYear ? `FY${p.fiscalYear}` : null,
      p.vehicleTrack ? `${p.vehicleTrack} track` : 'track not verified',
      p.matchBasis,
      p.reviewStatus,
      `confidence ${p.confidence}`,
      versionedValueSource(
        'request',
        request,
        p.requestSourceDocumentKey,
        p.requestSourceDocumentSha256,
      ),
      versionedValueSource(
        'house',
        house,
        p.houseSourceDocumentKey,
        p.houseSourceDocumentSha256,
      ),
      versionedValueSource(
        'senate',
        senate,
        p.senateSourceDocumentKey,
        p.senateSourceDocumentSha256,
      ),
      versionedValueSource(
        'conference',
        conference,
        p.conferenceSourceDocumentKey,
        p.conferenceSourceDocumentSha256,
      ),
      versionedValueSource(
        'enacted',
        enacted,
        p.enactedSourceDocumentKey,
        p.enactedSourceDocumentSha256,
      ),
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

function toFundingProvisionView(p: SourceBillProvision): FundingProvision {
  return {
    sec: p.peCode ? `PE ${p.peCode}` : null,
    title: p.heading,
    summary: p.text,
    // Report language is quoted verbatim from an official document.
    origin: 'official',
    source: [p.committee, `FY${p.fy}`, p.pageStart != null ? `p.${p.pageStart}` : null]
      .filter(Boolean)
      .join(' · '),
    actionType: p.actionType,
    reviewStatus: p.reviewStatus,
    billLinkStatus: p.billLinkStatus,
    reconciliationRequired:
      p.reviewStatus === 'accepted' &&
      p.billLinkStatus === 'accepted' &&
      ['adds', 'cuts', 'transfers'].includes(p.actionType ?? ''),
  };
}

function toFundingVehicleContext(
  parent: SourceParentPackage | null,
  positions: SourceFundingPosition[],
): FundingVehicleContext | null {
  if (parent) {
    return {
      id: parent.vehicleId,
      label: parent.vehicleLabel,
      track: parent.vehicleTrack as FundingVehicleContext['track'],
      stage: parent.vehicleStage as FundingVehicleContext['stage'],
      status: parent.vehicleStatus,
      chamber: parent.vehicleChamber,
      fiscalYear: parent.fiscalYear,
      amountTreatment: amountTreatmentFor(parent.vehicleTrack),
      sourceDocumentTitle: parent.sourceDocumentTitle,
      sourceDocumentKey: parent.sourceDocumentKey,
      sourceDocumentVersion: parent.sourceDocumentSha256,
      sourceDocumentUrl: parent.sourceDocumentUrl,
      sourceDocumentCurrent: parent.sourceDocumentCurrent,
    };
  }
  const position = positions[0];
  if (!position || !position.vehicleId || !position.vehicleTrack || !position.vehicleLabel) {
    return null;
  }
  return {
    id: position.vehicleId,
    label: position.vehicleLabel,
    track: position.vehicleTrack as FundingVehicleContext['track'],
    stage: position.stage as FundingVehicleContext['stage'],
    status: position.vehicleStatus ?? 'unknown',
    chamber: null,
    fiscalYear: position.fiscalYear,
    amountTreatment: amountTreatmentFor(position.vehicleTrack),
    sourceDocumentTitle: position.sourceDocumentTitle,
    sourceDocumentKey: position.sourceDocumentKey,
    sourceDocumentVersion: position.sourceDocumentSha256,
    sourceDocumentUrl: position.sourceUrl,
    sourceDocumentCurrent: position.sourceDocumentCurrent,
  };
}

function hasFundingTableValues(impact: ProgramElementImpact): boolean {
  return [
    impact.requestMillions,
    impact.houseMillions,
    impact.senateMillions,
    impact.conferenceMillions,
    impact.enactedMillions,
  ].some((value) => value != null);
}

function toRelatedVehicleView(v: SourceRelatedVehicle): RelatedVehicle {
  return {
    billId: v.billId ?? v.vehicleId,
    num: v.billId ? humanizeBillId(v.billId) : (v.publicLaw ?? v.reportNumber ?? v.label),
    title: v.label,
    role: `${v.track} · ${v.stage}`,
  };
}

/**
 * The position the KPI strip shows: reviewed/verified only, on the bill vehicle's
 * own track, at the furthest-progressed stage. Extracted rows remain visible as
 * evidence but can never become a headline amount.
 */
function pickPrimaryPosition(
  positions: Array<FundingPositionView & { id: string }>,
  vehicle: FundingVehicleContext | null,
): (FundingPositionView & { id: string }) | null {
  if (!vehicle) return null;
  const eligible = positions.filter(
    (position) =>
      isReviewedVerification(position.verification) &&
      position.vehicleId === vehicle.id &&
      position.fiscalYear === vehicle.fiscalYear &&
      position.stage === vehicle.stage &&
      position.vehicleClass === vehicle.track &&
      position.vehicleTrack === vehicle.track &&
      position.sourceDocumentCurrent !== false,
  );
  if (!eligible.length) return null;
  const rank = (p: FundingPositionView) =>
    (STAGE_ORDER[p.stage] ?? -1) * 100 +
    (p.vehicleClass === 'appropriation' ? 20 : p.vehicleClass === 'authorization' ? 10 : 0) +
    (p.verification === 'verified' ? 5 : p.verification === 'reviewed' ? 3 : 0);
  return [...eligible].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

function isOverrideReconciled(position: FundingPositionView): boolean {
  return (
    position.verification === 'verified' &&
    (position.note ?? '').toLowerCase().includes(OVERRIDE_RECONCILIATION_MARKER)
  );
}

function isReviewedVerification(verification: string): boolean {
  return verification === 'reviewed' || verification === 'verified';
}

/**
 * Delta of the primary position against the REQUEST, computed ONLY when both rows
 * share a fiscal year and a scope (§3.2 hard rule). `comparable: false` tells the UI
 * to render the request figure without a delta rather than omit it.
 */
function buildRequestComparison(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison | null {
  const request = raw.find(
    (r) =>
      r.stage === 'president' &&
      r.vehicleClass === 'request' &&
      isReviewedVerification(r.verificationStatus) &&
      r.sourceDocumentCurrent !== false &&
      r.scope === primary.scope &&
      r.fiscalYear === fiscalYearOf(raw, primary.id),
  );
  if (!request) return null;
  const requestAmount = Number(request.amountMillions);
  const delta = primary.amountMillions - requestAmount;
  return {
    scope: primary.scope,
    label: "President's request",
    amountMillions: requestAmount,
    deltaMillions: delta,
    pct: requestAmount === 0 ? null : Number(((delta / requestAmount) * 100).toFixed(2)),
    billId: null,
    comparable: true,
  };
}

/** The Senate figure on the SAME scope, for a like-for-like chamber comparison. */
function buildSenateComparison(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison | null {
  const fy = fiscalYearOf(raw, primary.id);
  const senate = raw.find(
    (r) =>
      r.stage === 'senate' &&
      r.vehicleClass === primary.vehicleClass &&
      isReviewedVerification(r.verificationStatus) &&
      r.sourceDocumentCurrent !== false &&
      r.scope === primary.scope &&
      r.fiscalYear === fy,
  );
  if (!senate || senate.id === primary.id) return null;
  return {
    scope: primary.scope,
    label: senate.vehicleLabel ?? 'Senate',
    amountMillions: Number(senate.amountMillions),
    deltaMillions: null,
    pct: null,
    billId: null,
    comparable: true,
  };
}

/**
 * The full like-for-like set (R4 §4.1): every OTHER figure that shares the primary's
 * fiscal year AND scope — House, Senate, conference, enacted.
 *
 * Membership is the comparability test: a row on a different scope or a different
 * fiscal year is simply absent, so the UI cannot render a comparison that was never
 * claimed. Each entry carries its delta against the primary, in stage order.
 */
function buildLikeForLikeComparisons(
  primary: FundingPositionView & { id: string },
  raw: SourceFundingPosition[],
): FundingComparison[] {
  const fy = fiscalYearOf(raw, primary.id);
  return raw
    .filter(
      (r) =>
        r.id !== primary.id &&
        (r.vehicleClass === 'request' || r.vehicleClass === primary.vehicleClass) &&
        isReviewedVerification(r.verificationStatus) &&
        r.sourceDocumentCurrent !== false &&
        r.scope === primary.scope &&
        r.fiscalYear === fy,
    )
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 99) - (STAGE_ORDER[b.stage] ?? 99))
    .map((r) => {
      const amount = Number(r.amountMillions);
      const delta = amount - primary.amountMillions;
      return {
        scope: primary.scope,
        label: r.vehicleLabel ?? `${r.stage} ${r.vehicleClass}`,
        amountMillions: amount,
        deltaMillions: delta,
        pct:
          primary.amountMillions === 0
            ? null
            : Number(((delta / primary.amountMillions) * 100).toFixed(2)),
        billId: null,
        comparable: true,
      };
    });
}

function fiscalYearOf(raw: SourceFundingPosition[], id: string): number {
  return raw.find((r) => r.id === id)?.fiscalYear ?? -1;
}

/**
 * Why the funding KPI cells carry no amount, in the bill's own terms. The block's
 * own `status` already explains the "nothing linked / flag off / state rail" cases;
 * a block that IS available but has no reviewed position row (impacts only) gets
 * its own reason rather than falling through to a bare em-dash.
 */
function fundingUnavailableReason(funding: FundingBlock | null): string {
  if (!funding) return FUNDING_UNAVAILABLE;
  return funding.status ?? FUNDING_NO_PRIMARY_POSITION;
}

function emptyFunding(status: string): FundingBlock {
  return {
    available: false,
    status,
    tablesAvailable: false,
    analysisStatus: 'unavailable',
    vehicle: null,
    overrideReconciliation: 'not_required',
    positions: [],
    reqCompare: null,
    senateCompare: null,
    comparisons: [],
    guardrail: null,
    programElementImpacts: [],
    provisions: [],
    parentPackageLabel: null,
  };
}

function buildPartyMap(rows: SourceMemberVoteTally[]): Map<string, VotePartyBreakdown> {
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

function toIso(d: Date | null | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface ActionMilestoneSource {
  id: string;
  date: Date;
  text: string;
  type: string | null;
  chamber: string | null;
}

/**
 * Congressional roll-call questions are not interchangeable. In particular,
 * recommit/reconsider motions are bill-linked votes but are not passage votes.
 */
function isPassageVoteQuestion(question: string | null | undefined): boolean {
  const q = (question ?? '').toLowerCase();
  return /on passage|passage of the bill|suspend the rules and pass|suspend the rules and agree|third reading|to concur|concur in the senate amendment|on agreeing to the resolution|on agreeing to the (conference|senate|house) amendment/.test(
    q,
  );
}

function isPassageActionText(text: string): boolean {
  const t = text.toLowerCase();
  if (/motion to (recommit|reconsider|table)|cloture|previous question/.test(t)) return false;
  return /\bon passage\b.*\b(pass|agree)|passed\/agreed to in (the )?(house|senate)|\bpassed (the )?(house|senate)\b|passage of the bill|third reading.*\b(pass|agree)/.test(
    t,
  );
}

function readableChamber(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/house|lower/i.test(value)) return /lower/i.test(value) ? 'Lower chamber' : 'House';
  if (/senate|upper/i.test(value)) return /upper/i.test(value) ? 'Upper chamber' : 'Senate';
  return capitalize(value);
}

function chamberFromAction(text: string, fallback: string | null): string | null {
  if (/\bhouse\b/i.test(text)) return 'House';
  if (/\bsenate\b/i.test(text)) return 'Senate';
  return readableChamber(fallback);
}

function actionOutcome(text: string): { label: string; sev: DossierSeverity } | null {
  const result = classifyVoteResult(text);
  if (result === 'fail') {
    return { label: /\breject(?:ed|ion)\b/i.test(text) ? 'Rejected' : 'Failed', sev: 'critical' };
  }
  if (result === 'pass') {
    if (/\bpassed\b/i.test(text)) return { label: 'Passed', sev: 'success' };
    if (/\badopted\b/i.test(text)) return { label: 'Adopted', sev: 'success' };
    return { label: 'Agreed', sev: 'success' };
  }
  return null;
}

function readableActionType(type: string | null, text: string): string | null {
  if (/received in (the )?senate/i.test(text)) return 'Senate receipt';
  if (/received in (the )?house/i.test(text)) return 'House receipt';
  switch ((type ?? '').toLowerCase()) {
    case 'introreferral':
      return 'Chamber referral';
    case 'floor':
      return 'Floor action';
    case 'committee':
      return 'Committee action';
    case 'president':
      return 'Presidential action';
    default: {
      const clean = (type ?? '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();
      return clean ? capitalize(clean) : null;
    }
  }
}

function passageDetail(text: string): string {
  const parts = ['On passage'];
  const tally = text.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b/);
  if (tally) parts.push(`${tally[1]}–${tally[2]}`);
  const roll = text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i);
  if (roll) parts.push(`Roll no. ${roll[1]}`);
  return parts.join(' · ');
}

function actionSemanticKey(action: ActionMilestoneSource): string {
  const day = action.date.toISOString().slice(0, 10);
  if (isPassageActionText(action.text)) {
    const chamber = chamberFromAction(action.text, action.chamber) ?? '';
    const tally = action.text.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b/);
    if (tally) {
      // Tally is shared by Congress.gov's detailed and summary rows even when
      // only one of them carries the roll number.
      return `${day}|passage:${chamber.toLowerCase()}:tally:${tally[1]}-${tally[2]}`;
    }
    const roll = action.text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i)?.[1];
    return `${day}|passage:${chamber.toLowerCase()}:roll:${roll ?? 'unknown'}`;
  }
  const roll = action.text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i)?.[1];
  if (roll) {
    // Roll numbers are chamber-scoped; House and Senate can use the same one.
    const chamber = chamberFromAction(action.text, action.chamber) ?? '';
    return `${day}|roll:${chamber.toLowerCase()}:${roll}`;
  }
  if (/received in (the )?(house|senate)/i.test(action.text)) {
    return `${day}|receipt:${chamberFromAction(action.text, action.chamber)?.toLowerCase() ?? ''}`;
  }
  const normalized = action.text
    .replace(/^passed\/agreed to in (the )?(house|senate):\s*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${day}|${normalized}`;
}

/**
 * Builds a display projection only. Duplicate official rows are aggregated by
 * legislative event while every underlying row id remains available for drill-
 * through/audit in `sourceIds`.
 */
function buildActionMilestones(
  actions: ActionMilestoneSource[],
  limit: number,
): LegislativeMilestone[] {
  const grouped = new Map<string, LegislativeMilestone>();
  for (const action of actions) {
    const key = actionSemanticKey(action);
    const existing = grouped.get(key);
    if (existing) {
      existing.sourceIds = [...(existing.sourceIds ?? []), action.id];
      existing.sourceCount = existing.sourceIds.length;
      continue;
    }

    const passage = isPassageActionText(action.text);
    const chamber = chamberFromAction(action.text, action.chamber);
    const receipt = /received in (the )?(house|senate)/i.test(action.text);
    // Receipt/referral rows describe routing, not a vote outcome. Some official
    // copy recites that the originating chamber passed the bill; do not attach
    // that historical result to the receipt event itself.
    const outcome = receipt ? null : actionOutcome(action.text);
    const readableType = readableActionType(action.type, action.text);
    const label = passage
      ? `Passed${chamber ? ` ${chamber}` : ''}`
      : receipt
        ? `Received in${chamber ? ` ${chamber}` : ''}`
        : truncate(action.text, 90);
    const detail = passage
      ? passageDetail(action.text)
      : [chamber, readableType].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ') ||
        null;
    grouped.set(key, {
      date: toIso(action.date),
      label,
      detail,
      state: outcome?.sev === 'critical' ? 'failed' : 'done',
      sev: outcome?.sev,
      outcome: outcome?.label ?? null,
      outcomeSev: outcome?.sev ?? 'neutral',
      sourceIds: [action.id],
      sourceCount: 1,
    });
  }

  const result = [...grouped.values()].slice(0, limit);
  if (result[0]?.state === 'done') result[0].state = 'current';
  return result;
}

function federalStatusPresentation(input: {
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

function expectedNextStep(stage: string | null, statusLabel: string): string | null {
  if (stage === 'passed_chamber') {
    if (/house/i.test(statusLabel)) return 'Senate action';
    if (/senate/i.test(statusLabel)) return 'House action';
    return 'Action in the other chamber';
  }
  switch (stage) {
    case 'introduced':
    case 'committee':
      return 'Committee action';
    case 'reported':
    case 'rule_pending':
    case 'floor':
      return 'Floor action';
    case 'resolving':
      return 'Resolution of chamber differences';
    case 'to_president':
      return 'Presidential action';
    default:
      return null;
  }
}

function capitalize(s: string | null): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettifyStatus(status: string): string {
  return status
    .split('_')
    .map((w) => capitalize(w))
    .join(' ');
}

function isFailedResult(result: string | null): boolean {
  return classifyVoteResult(result) === 'fail';
}

function sevForResult(result: string | null): DossierSeverity {
  const classified = classifyVoteResult(result);
  if (classified === 'pass') return 'success';
  if (classified === 'fail') return 'critical';
  return 'neutral';
}

function sevForStatus(status: string | null): DossierSeverity {
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

function sevForAlert(severity: string | null): DossierSeverity {
  if (severity === 'critical') return 'critical';
  if (severity === 'notable') return 'notable';
  return 'info';
}

/**
 * Official "next step" text derived from the canonical status. Deliberately never
 * says "pending floor vote" — a rule-failed / stalled bill has no scheduled floor
 * vote and the truth layer must not imply one (plan §5 edge case 2/3, §0.4).
 */
function officialNextStepText(status: string | null, ruleFailed: boolean): string {
  if (status === 'rule_failed' || (ruleFailed && !['passed_chamber', 'resolving', 'to_president', 'enacted', 'vetoed', 'failed'].includes(status ?? ''))) {
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

/** A source is "fresh" once our sync has caught up to the source's own change stamp. */
function isFresh(sourceChangeTs: Date | null, lastSyncedAt: Date | null | undefined): boolean {
  if (!lastSyncedAt) return false;
  if (sourceChangeTs) return lastSyncedAt.getTime() >= sourceChangeTs.getTime();
  return Date.now() - lastSyncedAt.getTime() < 7 * DAY_MS;
}

function normalizePosition(v: string | null): 'support' | 'oppose' | 'monitor' | null {
  return v === 'support' || v === 'oppose' || v === 'monitor' ? v : null;
}

function normalizePriority(v: string | null): 'low' | 'med' | 'high' | null {
  return v === 'low' || v === 'med' || v === 'high' ? v : null;
}

function byDateDesc(a: { date: string | null }, b: { date: string | null }): number {
  return (b.date ?? '').localeCompare(a.date ?? '');
}
