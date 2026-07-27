import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EXPECTED_MILESTONE_TYPE_LABELS,
  billStatusLabel,
  humanizeBillId,
  humanizeStateBillKey,
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
  FundingBlock,
  FundingComparison,
  FundingPositionView,
  FundingProvision,
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
      kpis: this.buildKpis(core.bill.statusLabel, core.bill.statusAt, core.latest, core.votes, tracking),
    };
  }

  // ── Federal rail ───────────────────────────────────────────────────────────

  private async buildFederalCore(
    billId: string,
    opts: DossierOptions = {},
  ): Promise<BillDossierResponse> {
    const identity = await this.sourceData.getBillDossierIdentity(billId);
    if (!identity) throw new NotFoundException('BILL_NOT_FOUND');

    const [actions, passageVoteRows, ruleRows, committees, fiscalNotes, freshness, upcoming] =
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
      ? await this.loadFunding(billId)
      : noFunding(FUNDING_UNAVAILABLE);

    // Batched member-vote tallies for every vote id in one query (no N+1).
    const voteIds = [
      ...passageVoteRows.map((v) => v.id),
      ...ruleRows.map((r) => r.voteId).filter((x): x is string => Boolean(x)),
    ];
    const tallies = await this.sourceData.getBillMemberVoteSummary(voteIds);
    const partyByVote = buildPartyMap(tallies);

    const ruleVotes: BillVote[] = ruleRows
      .filter((r) => r.result || r.voteId)
      .map((r) => this.ruleVoteToBillVote(r, partyByVote));
    const passageVotes: BillVote[] = passageVoteRows.map((v) =>
      this.passageVoteToBillVote(v, partyByVote),
    );
    const votes = [...ruleVotes, ...passageVotes].sort(byDateDesc);
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

    const statusLabel = billStatusLabel(identity.status);
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
        origin: 'official',
        text: officialNextStepText(identity.status, ruleFailed),
        asOf: toIso(identity.statusAt),
        source: 'Congress.gov',
        sourceUrl: identity.url,
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
      statusAt: toIso(identity.statusAt),
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
      kpis: this.buildKpis(statusLabel, bill.statusAt, latest, votes, null, funding),
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
    actions: Array<{ date: Date; text: string; type: string | null; chamber: string | null }>,
    ruleRows: SourceGoverningRule[],
  ): LegislativeMilestone[] {
    const fromActions: LegislativeMilestone[] = actions.slice(0, 10).map((a, i) => ({
      date: toIso(a.date),
      label: truncate(a.text, 90),
      detail: a.chamber ? `${a.chamber}${a.type ? ` · ${a.type}` : ''}` : a.type,
      state: i === 0 ? 'current' : 'done',
    }));
    const failedRules: LegislativeMilestone[] = ruleRows
      .filter((r) => isFailedResult(r.result))
      .map((r) => ({
        date: toIso(r.voteDate),
        label: `Governing rule ${humanizeBillId(r.ruleBillId)} failed`,
        detail: r.question,
        state: 'failed' as const,
        sev: 'critical' as DossierSeverity,
      }));
    return [...failedRules, ...fromActions].sort(byDateDesc);
  }

  private ruleVoteToBillVote(r: SourceGoverningRule, party: Map<string, VotePartyBreakdown>): BillVote {
    return {
      id: r.voteId ?? `rule:${r.ruleBillId}`,
      label: `Governing rule ${humanizeBillId(r.ruleBillId)}`,
      target: 'rule',
      chamber: r.chamber,
      date: toIso(r.voteDate),
      result: r.result,
      resultSev: sevForResult(r.result),
      tally: `${r.yeas ?? 0}-${r.nays ?? 0}`,
      party: r.voteId ? party.get(r.voteId) ?? null : null,
      note: null,
    };
  }

  private passageVoteToBillVote(v: SourceBillVote, party: Map<string, VotePartyBreakdown>): BillVote {
    return {
      id: v.id,
      label: v.question ?? `${capitalize(v.chamber)} passage vote`,
      target: 'passage',
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
      this.stateSource.getStateVotesForBills([billId]),
      this.stateSource.getMovedCompanions([billId]),
    ]);
    // getStateBillActionsByIds returns ORDER BY date ASC → reverse for newest-first.
    const actions = [...actionsAsc].reverse();

    const votes: BillVote[] = votesRows.map((v) => ({
      id: `${billId}:${toIso(v.date) ?? 'na'}`,
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

    const statusLabel = b.status ? prettifyStatus(b.status) : 'Status unavailable';
    const latest: LatestAction = { text: b.latestActionText, date: toIso(b.latestActionDate) };
    const milestones: LegislativeMilestone[] = actions.slice(0, 10).map((a, i) => ({
      date: toIso(a.date),
      label: truncate(a.text, 90),
      detail: a.chamber,
      state: i === 0 ? 'current' : 'done',
    }));

    const bill = {
      id: b.id,
      num: humanizeStateBillKey(b.id),
      title: b.title ?? b.identifier,
      chamber: null,
      type: null,
      congress: null,
      sponsor: b.sponsorName,
      introduced: null,
      statusLabel,
      statusSev: 'neutral' as DossierSeverity,
      statusAt: toIso(b.statusAt),
      stage: b.status,
      jurisdiction: b.state?.toUpperCase() ?? b.id.split('-')[0]?.toUpperCase() ?? null,
      isState: true,
      url: b.stateUrl ?? b.url,
    };

    return {
      bill,
      latest,
      context: null,
      tracking: null,
      kpis: this.buildKpis(statusLabel, bill.statusAt, latest, votes, null),
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
      funding: emptyFunding(STATE_FUNDING_UNSUPPORTED),
      relatedVehicles: companions
        .filter((c) => c.relatedBillKey)
        .map((c) => ({
          billId: c.relatedBillKey as string,
          num: isStateBillKey(c.relatedBillKey as string)
            ? humanizeStateBillKey(c.relatedBillKey as string)
            : (c.relatedDisplay ?? (c.relatedBillKey as string)),
          title: c.relatedDisplay,
          role: c.linkType,
        })),
      hearings: [],
      alerts: [],
      matchedTopics: [],
      recommendedActions: [],
      provenance: {
        lastSyncedAt: toIso(b.textDate ?? b.statusAt),
        sources: [
          {
            label: 'LegiScan',
            as: toIso(b.statusAt),
            origin: 'official',
            fresh: true,
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
   *  - the PRIMARY position is the one on this bill's own vehicle at the furthest
   *    stage; it is what the KPI strip shows;
   *  - a delta is only computed against a request row with the SAME fiscal year AND
   *    the SAME scope. Otherwise the delta is null and the guardrail explains why;
   *  - authorization and appropriation rows both appear, separately labelled, and
   *    are never merged into one "current" figure;
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

    if (!positionViews.length && !impactViews.length) {
      return {
        block: {
          ...emptyFunding(FUNDING_NO_DATA),
          provisions: provisionViews,
          parentPackageLabel: parent ? parent.name : null,
        },
        relatedVehicles,
      };
    }

    const primary = pickPrimaryPosition(positionViews);
    const withPrimary = positionViews.map((p) => ({ ...p, primary: primary?.id === p.id }));

    const reqCompare = primary ? buildRequestComparison(primary, positions) : null;
    const senateCompare = primary ? buildSenateComparison(primary, positions) : null;
    const comparisons = primary ? buildLikeForLikeComparisons(primary, positions) : [];
    const scopes = new Set(positionViews.map((p) => p.scope));

    return {
      block: {
        available: true,
        status: null,
        positions: withPrimary,
        reqCompare,
        senateCompare,
        comparisons,
        // Only warn when there is genuinely more than one basis in play — a
        // single-scope bill needs no caveat.
        guardrail: scopes.size > 1 ? SCOPE_GUARDRAIL : null,
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
    return mapCombinedAlertsToHearings(rows).hearings.slice(0, MAX_HEARINGS).map((h) => ({
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

  private buildKpis(
    statusLabel: string,
    statusAt: string | null,
    latest: LatestAction,
    votes: BillVote[],
    tracking: BillContext | null,
    funding?: LoadedFunding,
  ): BillKpi[] {
    const v0 = votes[0] ?? null;
    const expected = tracking?.expected ?? null;
    // R3: the funding cells show the primary position and its same-scope delta once
    // funding data exists. They stay '—' otherwise — never $0 (§3.6).
    const primary = funding?.block.positions.find((p) => p.primary) ?? null;
    const req = funding?.block.reqCompare ?? null;
    return [
      { label: 'Current status', value: statusLabel, sub: statusAt },
      {
        label: 'Latest recorded vote',
        value: v0 ? `${v0.result ?? '—'} ${v0.tally}`.trim() : 'None recorded',
        sub: v0 ? v0.label : 'No roll call on this bill',
      },
      {
        label: 'Funding position',
        value: primary ? fmtMillions(primary.amountMillions) : '—',
        sub: primary ? `${primary.scope} · ${primary.stage}` : 'Not linked',
      },
      {
        label: 'Δ from request',
        value: req?.deltaMillions != null ? fmtSignedMillions(req.deltaMillions) : '—',
        sub: req?.deltaMillions != null ? 'same scope only' : 'n/a',
      },
      { label: 'Last official action', value: latest.date ?? '—', sub: latest.text },
      {
        label: 'Next milestone',
        value: expected?.milestoneType
          ? EXPECTED_MILESTONE_TYPE_LABELS[expected.milestoneType]
          : '—',
        sub: expected ? (expected.windowStart ?? 'Not scheduled') : 'None scheduled',
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

function toFundingPositionView(p: SourceFundingPosition): FundingPositionView & { id: string } {
  return {
    id: p.id,
    scope: p.scope as FundingPositionView['scope'],
    stage: p.stage as FundingPositionView['stage'],
    vehicleClass: p.vehicleClass as FundingPositionView['vehicleClass'],
    amountMillions: Number(p.amountMillions),
    effectiveDate: toIso(p.effectiveDate),
    source: p.vehicleLabel ?? p.packageName,
    sourceUrl: p.sourceUrl,
    sourcePage: p.sourcePage,
    verification: p.verificationStatus as FundingPositionView['verification'],
    primary: false,
    note: p.note,
  };
}

function toPeImpactView(p: SourceBillPeImpact): ProgramElementImpact {
  const request = num(p.requestMillions);
  const house = num(p.houseMillions);
  const senate = num(p.senateMillions);
  const enacted = num(p.enactedMillions);
  // Same fiscal year by construction (the query pins the PE year to the package FY).
  const latest = enacted ?? senate ?? house;
  const delta = request != null && latest != null ? latest - request : null;
  return {
    pe: p.peCode,
    name: p.title,
    requestMillions: request,
    houseMillions: house,
    senateMillions: senate,
    deltaVsRequestMillions: delta,
    pct:
      delta != null && request != null && request !== 0
        ? Number(((delta / request) * 100).toFixed(2))
        : null,
    // A verbatim PE-code link is explicit; everything fuzzier is inferred and the UI
    // must label it as such (§5 edge cases 23-24).
    basis: p.matchBasis === 'explicit_pe_code' ? 'explicit' : 'inferred',
    source: `${p.matchBasis} · ${p.reviewStatus} · confidence ${p.confidence}`,
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
  };
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
 * The position the KPI strip shows: the furthest-progressed stage, preferring an
 * appropriation over an authorization at the same stage (an appropriation is the
 * money), and a verified figure over an unreviewed one.
 */
function pickPrimaryPosition(
  positions: Array<FundingPositionView & { id: string }>,
): (FundingPositionView & { id: string }) | null {
  if (!positions.length) return null;
  const rank = (p: FundingPositionView) =>
    (STAGE_ORDER[p.stage] ?? -1) * 100 +
    (p.vehicleClass === 'appropriation' ? 20 : p.vehicleClass === 'authorization' ? 10 : 0) +
    (p.verification === 'verified' ? 5 : p.verification === 'reviewed' ? 3 : 0);
  return [...positions].sort((a, b) => rank(b) - rank(a))[0] ?? null;
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
    (r) => r.stage === 'senate' && r.scope === primary.scope && r.fiscalYear === fy,
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
      (r) => r.id !== primary.id && r.scope === primary.scope && r.fiscalYear === fy,
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

function emptyFunding(status: string): FundingBlock {
  return {
    available: false,
    status,
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
  return /fail|reject|defeat/i.test(result ?? '');
}

function sevForResult(result: string | null): DossierSeverity {
  if (!result) return 'neutral';
  if (/pass|agree|adopt/i.test(result)) return 'success';
  if (isFailedResult(result)) return 'critical';
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
  if (ruleFailed || status === 'rule_failed') {
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
