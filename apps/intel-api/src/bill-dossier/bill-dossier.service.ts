import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { isStateBillKey } from '@capiro/shared';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  SourceDataRepository,
  type SourceBillVote,
  type SourceGoverningRule,
} from '../sourcedata/source-data.repository.js';

import { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';

import type {
  BillContext,
  BillDossierResponse,
  BillHearingView,
  BillKpi,
  BillVote,
  DossierOverview,
  FundingBlock,
  LatestAction,
  LegislativeMilestone,
  MatchedTopic,
  VotePartyBreakdown,
} from './bill-dossier.types.js';
import { BillDossierFederal } from './bill-dossier-federal.js';
import { BillDossierState } from './bill-dossier-state.js';
import { BillDossierFunding, type LoadedFunding } from './bill-dossier-funding.js';
import {
  BillDossierClientContext,
  toContextAlertView,
  buildRecommendedActions,
  type ClientAlertRow,
} from './bill-dossier-client-context.js';
import { buildKpis as buildDossierKpis } from './bill-dossier-kpis.js';
import { MAX_HEARINGS } from './bill-dossier-presentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-request switches resolved by the controller from the tenant's feature flags. */
export interface DossierOptions {
  /** `defense_funding_intel` — when false, no funding query runs at all (§3.6). */
  funding?: boolean;
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
  private readonly federal: BillDossierFederal;
  private readonly state: BillDossierState;
  private readonly funding: BillDossierFunding;
  private readonly clientContext: BillDossierClientContext;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceData: SourceDataRepository,
    private readonly stateSource: StateSourceDataRepository,
  ) {
    this.funding = new BillDossierFunding(this.sourceData);
    this.clientContext = new BillDossierClientContext(this.prisma);
    this.federal = new BillDossierFederal(this.sourceData, {
      loadFunding: (...args) => this.loadFunding(...args),
      buildFederalMilestones: (...args) => this.buildFederalMilestones(...args),
      ruleVoteToBillVote: (...args) => this.ruleVoteToBillVote(...args),
      passageVoteToBillVote: (...args) => this.passageVoteToBillVote(...args),
      kpiOwner: () => this,
    });
    this.state = new BillDossierState(this.stateSource, { kpiOwner: () => this });
  }

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
      coverage:
        'Provider metadata and original source links; retained document text is available through Research',
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
    return this.federal.buildFederalCore(billId, opts);
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
    return this.federal.buildFederalMilestones(actions, ruleRows);
  }

  private ruleVoteToBillVote(
    r: SourceGoverningRule,
    party: Map<string, VotePartyBreakdown>,
  ): BillVote {
    return this.federal.ruleVoteToBillVote(r, party);
  }

  private passageVoteToBillVote(
    v: SourceBillVote,
    party: Map<string, VotePartyBreakdown>,
  ): BillVote {
    return this.federal.passageVoteToBillVote(v, party);
  }

  // ── State rail (plan §1.5) ──────────────────────────────────────────────────

  private async buildStateCore(billId: string): Promise<BillDossierResponse> {
    return this.state.buildStateCore(billId);
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
    return this.funding.loadFunding(billId);
  }

  // ── Client context ──────────────────────────────────────────────────────────

  private async loadTracking(
    tenantId: string,
    clientId: string,
    billId: string,
  ): Promise<BillContext> {
    return this.clientContext.loadTracking(tenantId, clientId, billId);
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
    return this.clientContext.loadClientAlerts(tenantId, clientId, billId);
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
    return this.clientContext.loadMatchedTopics(tenantId, clientId, billId);
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
    return this.clientContext.loadClientHearings(tenantId, clientId, billId);
  }

  private mergeAnalystOverview(
    base: DossierOverview,
    tracking: BillContext | null,
    alertRows: ClientAlertRow[] = [],
  ): DossierOverview {
    return this.clientContext.mergeAnalystOverview(base, tracking, alertRows);
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
    return buildDossierKpis(statusLabel, statusAt, stage, latest, votes, tracking, funding);
  }
}
