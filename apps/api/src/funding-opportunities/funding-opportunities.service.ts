import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  computeEligibility,
  scoreOpportunityRelevance,
  type ClientRelevanceProfile,
} from '../district-nexus/grant-opportunity-relevance.js';
import {
  computeSamEligibility,
  scoreSamOpportunityRelevance,
  type SamClientProfile,
  type SamOpportunityProfile,
} from './sam-opportunity-relevance.js';
import {
  buildClientOpportunityProfile,
  emptyAwardHistory,
} from './client-opportunity-profile.builder.js';
import {
  buildAwardHistoryIdentity,
  contractorIdsToResolve,
} from './award-history-identity.js';
import {
  asProfileReadClient,
  readAwardHistoryByBasis,
  readClientProfileFacts,
  resolveContractorUeis,
} from './client-opportunity-profile.repository.js';
import type { ClientOpportunityProfileV1 } from './client-opportunity-profile.types.js';
import { grantsGovKind, samNoticeKind } from './opportunity-kind.js';
import {
  GRANT_ACTIVE_SQL,
  SAM_PURSUABLE_SQL,
  grantActiveWhere,
  grantClosedWhere,
  isGrantActive as isGrantActiveShared,
  isSamActive as isSamActiveShared,
  samClosedWhere,
  samInformationalWhere,
  samPursuableWhere,
} from './source-lifecycle.js';
import {
  missingProfileFields,
  profileIsTooThin,
  type ProfileCompleteness,
} from './missing-profile-fields.js';
import { recommendOpportunity } from './opportunity-recommendation.js';
import {
  HUMAN_DECISION_STATUSES,
  NON_PURSUABLE_KINDS,
  WORKFLOW_SORT_PRIORITY,
  type ClientFundingOpportunitySummary,
  type EmptyReason,
  type GrantEnrichmentHealth,
  type FundingOpportunity,
  type FundingOpportunityCounts,
  type FundingOpportunityListResponse,
  type OpportunityKind,
  type OpportunitySource,
  type OpportunitySourceFreshness,
  type OpportunityWorkflow,
  type OpportunityWorkflowStatus,
} from './funding-opportunities.types.js';

/**
 * Funding Opportunities — discovery, scoring and durable workflow.
 *
 * ── Why this reads the catalogs directly instead of a candidate table ────────
 *
 * The pre-existing grant pipeline could only show a client an opportunity if the
 * nightly producer had already written a `ClientGrantNexus`
 * 'opportunity_candidate' row for it. That made the surface honest but
 * permanently empty for any tenant the producer had not run for, and it made a
 * newly-onboarded client's page look like "there is no federal money for you"
 * when the truth was "nothing has run yet". So relevance is computed AT READ
 * TIME over a bounded active-opportunity set, and the producer's rows become an
 * optimisation and an alerting substrate rather than a prerequisite for
 * visibility.
 *
 * ── The transaction shape is load-bearing ───────────────────────────────────
 *
 * Every read follows the same four steps, in this order:
 *
 *   1. read tenant-scoped CLIENT FACTS in a short `withTenant` transaction;
 *   2. query the GLOBAL source catalogs OUTSIDE that transaction;
 *   3. combine and score IN MEMORY;
 *   4. write tenant workflow state in a separate short `withTenant` transaction.
 *
 * Holding a tenant transaction open across a scan of `federal_grant` /
 * `sam_opportunity` is what starved the Prisma pool and took the Knowledge Graph
 * down on 2026-07-2x (the graph-sync advisory-lock incident). The catalogs are
 * global and carry no RLS, so there is no correctness reason to hold the tenant
 * scope while reading them — only a cost.
 *
 * There is also no per-pair query anywhere in this file. Scoring is a pure
 * function over rows already in memory; N clients × M opportunities costs a
 * fixed number of queries, not N×M.
 */
@Injectable()
export class FundingOpportunitiesService {
  private readonly logger = new Logger(FundingOpportunitiesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public: unscoped catalog list (optionally scored for one client) ───────

  async listOpportunities(
    tenantId: string,
    query: OpportunityQuery,
  ): Promise<FundingOpportunityListResponse> {
    if (query.clientId) {
      return this.listClientOpportunities(tenantId, query.clientId, query);
    }

    // No client selected: return the catalog with no scoring at all rather than
    // an arbitrary score. A relevance number with no client behind it is
    // meaningless, and showing one would invite a user to trust it.
    const freshness = await this.readFreshness();
    const fetched = await this.fetchSourceRows(null, query);
    const rows = fetched.rows;
    const shaped = rows.map((r) => this.shapeUnscored(r));
    const filtered = this.applyPostFilters(shaped, query);
    const sorted = this.sortOpportunities(filtered);
    const page = this.paginate(sorted, query);

    return {
      opportunities: page.items,
      total: sorted.length,
      totalIsCapped: fetched.capped,
      page: page.page,
      pageSize: page.pageSize,
      counts: this.countFor(sorted, []),
      freshness,
      emptyReason: page.items.length === 0 ? this.emptyReasonFor(rows, sorted, freshness, null) : null,
      emptyExplanation:
        page.items.length === 0
          ? EMPTY_EXPLANATIONS[this.emptyReasonFor(rows, sorted, freshness, null)]
          : null,
      missingProfileFields: [],
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Public: one client's opportunities ────────────────────────────────────

  async listClientOpportunities(
    tenantId: string,
    clientId: string,
    query: OpportunityQuery,
  ): Promise<FundingOpportunityListResponse> {
    // STEP 1 — tenant-scoped client facts, short transaction.
    const facts = await this.readClientFacts(tenantId, clientId);

    // STEP 2 — global catalogs, outside the tenant transaction.
    const freshness = await this.readFreshness();
    const fetched = await this.fetchSourceRows(facts, query);
    const rows = fetched.rows;

    // Workflow rows are tenant-scoped, so this is its own short transaction.
    const workflows = await this.readWorkflowRows(tenantId, clientId);

    // STEP 3 — combine and score in memory.
    const scored = rows.map((r) => this.shapeScored(r, facts, workflows));
    const gaps = missingProfileFields(facts.completeness, query.source);

    // A row the producer never created and that clears no floor is not a
    // suggestion. Rows with a workflow row survive regardless of score: a human
    // saved or dismissed it, and their decision does not stop being real because
    // the score moved.
    const surfaced = scored.filter(
      (o) => o.workflow != null || this.clearsSuggestionFloor(o, query.minRelevance),
    );

    const filtered = this.applyPostFilters(surfaced, query);
    const sorted = this.sortOpportunities(filtered);
    const paged = this.paginate(sorted, query);

    const emptyReason =
      paged.items.length === 0 ? this.emptyReasonFor(rows, sorted, freshness, facts) : null;

    return {
      opportunities: paged.items,
      total: sorted.length,
      totalIsCapped: fetched.capped,
      page: paged.page,
      pageSize: paged.pageSize,
      counts: this.countFor(scored, workflows),
      freshness,
      emptyReason,
      emptyExplanation: emptyReason ? EMPTY_EXPLANATIONS[emptyReason] : null,
      missingProfileFields: gaps,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Public: one opportunity ───────────────────────────────────────────────

  async getOpportunity(
    tenantId: string,
    source: OpportunitySource,
    sourceRecordId: string,
    clientId: string | null,
  ): Promise<FundingOpportunity> {
    const facts = clientId ? await this.readClientFacts(tenantId, clientId) : null;
    const row = await this.fetchOneSourceRow(source, sourceRecordId);
    if (!row) throw new NotFoundException('Opportunity not found');
    if (!facts) return this.shapeUnscored(row);
    const workflows = await this.readWorkflowRows(tenantId, clientId!);
    return this.shapeScored(row, facts, workflows);
  }

  // ── Public: the persistent client-profile card ────────────────────────────

  /**
   * Always returns a payload, even at zero matches. The card must render with an
   * explanation rather than disappear — a hidden card is indistinguishable from
   * a feature the tenant does not have, and that is the specific confusion the
   * empty-state copy exists to remove.
   */
  async getClientSummary(
    tenantId: string,
    clientId: string,
  ): Promise<ClientFundingOpportunitySummary> {
    const facts = await this.readClientFacts(tenantId, clientId);
    const freshness = await this.readFreshness();
    const fetched = await this.fetchSourceRows(facts, { ...DEFAULT_QUERY });
    const rows = fetched.rows;
    const workflows = await this.readWorkflowRows(tenantId, clientId);

    const scored = rows.map((r) => this.shapeScored(r, facts, workflows));
    const surfaced = scored.filter(
      (o) => o.workflow != null || this.clearsSuggestionFloor(o, undefined),
    );
    const sorted = this.sortOpportunities(surfaced);

    const active = sorted.filter((o) => o.isActive && o.isPursuable);
    const withDeadline = active
      .filter((o) => o.responseDeadline != null && !isDismissed(o))
      .sort((a, b) => (a.responseDeadline! < b.responseDeadline! ? -1 : 1));
    const next = withDeadline[0] ?? null;

    const emptyReason =
      sorted.length === 0 ? this.emptyReasonFor(rows, sorted, freshness, facts) : null;

    return {
      clientId,
      counts: this.countFor(scored, workflows),
      nextDeadline: next
        ? {
            opportunityId: next.id,
            title: next.title,
            source: next.source,
            responseDeadline: next.responseDeadline!,
          }
        : null,
      topGrants: sorted.filter((o) => o.source === 'grants_gov').slice(0, CARD_TOP_N),
      topContracts: sorted.filter((o) => o.source === 'sam_gov').slice(0, CARD_TOP_N),
      missingProfileFields: missingProfileFields(facts.completeness),
      freshness,
      emptyReason,
      emptyExplanation: emptyReason ? EMPTY_EXPLANATIONS[emptyReason] : null,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Public: workflow writes ───────────────────────────────────────────────

  /**
   * Save (or re-save) an opportunity for a client at an explicit status.
   *
   * The source record is verified to EXIST before a workflow row is written. A
   * row pointing at a notice id that is not in the catalog would render as a
   * blank card forever, and the FK-less pointer means the database will not catch
   * it for us.
   */
  async setWorkflowStatus(
    tenantId: string,
    clientId: string,
    source: OpportunitySource,
    sourceRecordId: string,
    input: {
      status: OpportunityWorkflowStatus;
      actorUserId: string;
      ownerUserId?: string | null;
      facilityId?: string | null;
      notes?: string | null;
      dismissedReason?: string | null;
      outcomeNote?: string | null;
    },
  ): Promise<OpportunityWorkflow> {
    await this.assertClientInTenant(tenantId, clientId);
    const row = await this.fetchOneSourceRow(source, sourceRecordId);
    if (!row) throw new NotFoundException('Opportunity not found');

    if (input.ownerUserId != null) await this.assertUserInTenant(tenantId, input.ownerUserId);
    if (input.facilityId != null) {
      await this.assertFacilityBelongsToClient(tenantId, clientId, input.facilityId);
    }
    this.assertPursuable(row, input.status);

    const facts = await this.readClientFacts(tenantId, clientId);
    const score = this.scoreRow(row, facts);
    const sourceSnapshot = this.sourceSnapshot(row);
    const data = {
      workflowStatus: input.status,
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.facilityId !== undefined ? { facilityId: input.facilityId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.dismissedReason !== undefined ? { dismissedReason: input.dismissedReason } : {}),
      ...(input.outcomeNote !== undefined ? { outcomeNote: input.outcomeNote } : {}),
      relevanceScore: score.relevanceScore,
      matchSignals: score.matchedSignals as unknown as Prisma.InputJsonValue,
      eligibilityState: score.eligibility.state,
      eligibilityReason: score.eligibility.reason,
      sourceStatusSnapshot: sourceSnapshot.status,
      responseDeadlineSnapshot: sourceSnapshot.deadline,
      sourceUpdatedAtSnapshot: sourceSnapshot.updatedAt,
      userCreated: true,
      staleAt: null,
      updatedBy: input.actorUserId,
    };

    const write = async () =>
      this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        const saved = existing
          ? await tx.clientFundingOpportunity.update({ where: { id: existing.id }, data })
          : await tx.clientFundingOpportunity.create({
              data: {
                tenantId,
                clientId,
                source,
                grantOpportunityId: source === 'grants_gov' ? sourceRecordId : null,
                samOpportunityId: source === 'sam_gov' ? sourceRecordId : null,
                evidenceSourceType: 'user_action',
                createdBy: input.actorUserId,
                ...data,
              },
            });
        await this.writeWorkflowAudit(tx, {
          tenantId,
          actorUserId: input.actorUserId,
          action: `funding_opportunity.workflow.${input.status}`,
          entityId: saved.id,
          before: existing
            ? {
                workflowStatus: existing.workflowStatus,
                ownerUserId: existing.ownerUserId ?? null,
                facilityId: existing.facilityId ?? null,
              }
            : null,
          after: {
            workflowStatus: input.status,
            ownerUserId: saved.ownerUserId ?? null,
            facilityId: saved.facilityId ?? null,
          },
        });
        return this.shapeWorkflow(saved, null, null);
      });

    try {
      return await write();
    } catch (error) {
      // The partial unique indexes are the concurrency backstop. Two simultaneous
      // first saves can both observe no row; the loser retries as an update rather
      // than leaking a P2002 to the user.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        if (!existing) throw error;
        const saved = await tx.clientFundingOpportunity.update({ where: { id: existing.id }, data });
        return this.shapeWorkflow(saved, null, null);
      });
    }
  }

  /**
   * Patch a workflow row's mutable fields — CREATING the row if the edit itself
   * is the first human action.
   *
   * This used to throw `NotFoundException('No saved opportunity to update — save
   * or pursue it first.')` whenever no row existed, which made "assign an owner",
   * "add a note" and "link a project site" impossible on a machine-suggested
   * recommendation. Every suggestion starts with no workflow row, so the three
   * most natural first actions a user takes on a suggestion all failed, and the
   * error told them to perform a DIFFERENT action first. Assigning an owner IS
   * saving it: a human has taken responsibility for the row.
   *
   * The created row is `saved`, never `pursuing` — pursuit is an explicit
   * decision, and inferring it from "somebody attached a note" would overstate
   * what happened.
   */
  async patchWorkflow(
    tenantId: string,
    clientId: string,
    source: OpportunitySource,
    sourceRecordId: string,
    input: {
      actorUserId: string;
      status?: OpportunityWorkflowStatus;
      ownerUserId?: string | null;
      facilityId?: string | null;
      notes?: string | null;
      outcomeNote?: string | null;
    },
  ): Promise<OpportunityWorkflow> {
    await this.assertClientInTenant(tenantId, clientId);
    // The source record must exist before a workflow row can reference it. The
    // old patch path skipped this — only setWorkflowStatus checked — so a bogus
    // id in the URL produced a row pointing at nothing.
    const row = await this.fetchOneSourceRow(source, sourceRecordId);
    if (!row) throw new NotFoundException('Opportunity not found');

    if (input.ownerUserId != null) await this.assertUserInTenant(tenantId, input.ownerUserId);
    if (input.facilityId != null) {
      await this.assertFacilityBelongsToClient(tenantId, clientId, input.facilityId);
    }
    if (input.status !== undefined) this.assertPursuable(row, input.status);

    const mutable = {
      ...(input.status !== undefined ? { workflowStatus: input.status } : {}),
      ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.facilityId !== undefined ? { facilityId: input.facilityId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.outcomeNote !== undefined ? { outcomeNote: input.outcomeNote } : {}),
      // A human touched this row, so the producer may no longer overwrite it and
      // any stale-suggestion mark it carried no longer describes it.
      userCreated: true,
      staleAt: null,
      updatedBy: input.actorUserId,
    };

    const write = async (): Promise<OpportunityWorkflow> =>
      this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        if (existing) {
          const saved = await tx.clientFundingOpportunity.update({
            where: { id: existing.id },
            data: mutable,
          });
          await this.writeWorkflowAudit(tx, {
            tenantId,
            actorUserId: input.actorUserId,
            action: 'funding_opportunity.workflow.patched',
            entityId: existing.id,
            before: {
              workflowStatus: existing.workflowStatus,
              ownerUserId: existing.ownerUserId ?? null,
              facilityId: existing.facilityId ?? null,
            },
            after: mutable,
          });
          return this.shapeWorkflow(saved, null, null);
        }

        // First human action. Score it so the created row carries the same
        // producer bookkeeping a save would have, and snapshot the source so the
        // lifecycle pass has a baseline rather than treating it as brand new.
        const facts = await this.readClientFacts(tenantId, clientId);
        const score = this.scoreRow(row, facts);
        const snap = this.sourceSnapshot(row);
        const created = await tx.clientFundingOpportunity.create({
          data: {
            tenantId,
            clientId,
            source,
            grantOpportunityId: source === 'grants_gov' ? sourceRecordId : null,
            samOpportunityId: source === 'sam_gov' ? sourceRecordId : null,
            evidenceSourceType: 'user_action',
            createdBy: input.actorUserId,
            relevanceScore: score.relevanceScore,
            matchSignals: score.matchedSignals as unknown as Prisma.InputJsonValue,
            eligibilityState: score.eligibility.state,
            eligibilityReason: score.eligibility.reason,
            sourceStatusSnapshot: snap.status,
            responseDeadlineSnapshot: snap.deadline,
            sourceUpdatedAtSnapshot: snap.updatedAt,
            ...mutable,
            // An edit is a save, not a pursuit — unless the caller asked for a
            // status explicitly.
            workflowStatus: input.status ?? 'saved',
          },
        });
        await this.writeWorkflowAudit(tx, {
          tenantId,
          actorUserId: input.actorUserId,
          action: 'funding_opportunity.workflow.created_by_edit',
          entityId: created.id,
          before: null,
          after: { workflowStatus: created.workflowStatus, ...mutable },
        });
        return this.shapeWorkflow(created, null, null);
      });

    try {
      return await write();
    } catch (error) {
      // Same concurrency backstop as setWorkflowStatus: two simultaneous first
      // edits can both observe no row, and the loser must retry as an update
      // rather than leaking a P2002 to the user.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
        if (!existing) throw error;
        const saved = await tx.clientFundingOpportunity.update({
          where: { id: existing.id },
          data: mutable,
        });
        return this.shapeWorkflow(saved, null, null);
      });
    }
  }

  /**
   * A closed or informational notice may not be marked `pursuing`.
   *
   * Nothing enforced this before: `pursuing` was accepted for any notice the URL
   * named, so an award notice announcing a competition somebody else won could be
   * marked as an active pursuit — and it would then sort to the TOP of the
   * workflow rail, above real bids.
   *
   * Every other status stays available, `saved` included. Saving an award notice
   * for reference is legitimate and is exactly how a team tracks a competitor's
   * win; claiming to be bidding it is not.
   */
  private assertPursuable(row: SourceRow, status: OpportunityWorkflowStatus): void {
    if (status !== 'pursuing') return;
    const now = new Date();
    if (row.kind === 'grant') {
      if (!isGrantActiveShared({ status: row.row.status, closeDate: row.row.closeDate }, now)) {
        throw new BadRequestException(
          'This grant opportunity is closed, so it cannot be marked as being pursued. Save it for reference instead.',
        );
      }
      return;
    }
    const kind = samNoticeKind(row.row.noticeType);
    if (NON_PURSUABLE_KINDS.has(kind)) {
      throw new BadRequestException(
        `A ${kind.replace(/_/g, ' ')} is informational, not a solicitation, so it cannot be marked as being pursued. Save it for reference instead.`,
      );
    }
    if (
      !isSamActiveShared(
        {
          active: row.row.active,
          responseDeadline: row.row.responseDeadline,
          archiveDate: row.row.archiveDate,
        },
        now,
      )
    ) {
      throw new BadRequestException(
        'This contract opportunity is closed, so it cannot be marked as being pursued. Save it for reference instead.',
      );
    }
  }

  /**
   * One audit row, in the CALLER'S transaction.
   *
   * Passed the `tx` rather than using `this.prisma` so the audit cannot survive a
   * rolled-back write, and a committed write cannot lack its audit. A workflow
   * change with no record of who made it is unauditable, which is the whole
   * reason the table exists.
   */
  private async writeWorkflowAudit(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      actorUserId: string;
      action: string;
      entityId: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: 'client_funding_opportunity',
        entityId: input.entityId,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: input.after as Prisma.InputJsonValue,
      },
    });
  }

  async dismiss(
    tenantId: string,
    clientId: string,
    source: OpportunitySource,
    sourceRecordId: string,
    input: { actorUserId: string; reason?: string | null },
  ): Promise<OpportunityWorkflow> {
    return this.setWorkflowStatus(tenantId, clientId, source, sourceRecordId, {
      status: 'dismissed',
      actorUserId: input.actorUserId,
      dismissedReason: input.reason ?? null,
    });
  }

  /**
   * Restore a dismissed opportunity to 'saved'.
   *
   * Deliberately NOT back to 'suggested': 'suggested' means "a machine proposed
   * this and nobody has looked", and a human has now looked twice. The dismissal
   * reason is cleared because it no longer describes the row's state.
   */
  async restore(
    tenantId: string,
    clientId: string,
    source: OpportunitySource,
    sourceRecordId: string,
    input: { actorUserId: string },
  ): Promise<OpportunityWorkflow> {
    await this.assertClientInTenant(tenantId, clientId);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await this.findWorkflowRow(tx, clientId, source, sourceRecordId);
      if (!existing) throw new NotFoundException('No dismissed opportunity to restore.');
      if (existing.workflowStatus !== 'dismissed') {
        throw new BadRequestException(
          `Only a dismissed opportunity can be restored; this one is '${existing.workflowStatus}'.`,
        );
      }
      const saved = await tx.clientFundingOpportunity.update({
        where: { id: existing.id },
        data: {
          workflowStatus: 'saved',
          dismissedReason: null,
          staleAt: null,
          userCreated: true,
          updatedBy: input.actorUserId,
        },
      });
      await this.writeWorkflowAudit(tx, {
        tenantId,
        actorUserId: input.actorUserId,
        action: 'funding_opportunity.workflow.restored',
        entityId: existing.id,
        before: { workflowStatus: 'dismissed', dismissedReason: existing.dismissedReason ?? null },
        after: { workflowStatus: 'saved', dismissedReason: null },
      });
      return this.shapeWorkflow(saved, null, null);
    });
  }

  // ── Step 1: tenant-scoped client facts ───────────────────────────────────

  /**
   * Everything about the client that any signal reads, in ONE short tenant
   * transaction, plus the award history that hangs off the client's CONFIRMED
   * federal identities (read from the global award tables afterwards, outside
   * the transaction).
   */
  private async readClientFacts(tenantId: string, clientId: string): Promise<ClientFacts> {
    // Tenant facts in a SHORT tenant-scoped transaction. The award-history read
    // that follows hits global tables and is the slow one, so it stays outside:
    // holding a tenant transaction open across it turns one slow client into a
    // connection-pool problem for every other request.
    const facts = await this.prisma.withTenant(tenantId, (tx) =>
      readClientProfileFacts(asProfileReadClient(tx), { clientId }),
    );
    if (!facts) throw new NotFoundException('Client not found');

    // The read path degrades to empty history rather than failing the request.
    // The producers deliberately do NOT — see the repository docblock. That is
    // why `readAwardHistory` throws and this try/catch lives here.
    let history;
    try {
      // The contracting rail's externalId is a federal_contractor UUID, so the
      // verified UEI has to be resolved before identity can be decided. Global
      // reference table, so it reads outside the tenant transaction.
      const contractorUeis = await resolveContractorUeis(
        this.prisma,
        contractorIdsToResolve([facts]),
      );
      history = await readAwardHistoryByBasis(
        this.prisma,
        buildAwardHistoryIdentity(facts, contractorUeis),
      );
    } catch (error) {
      this.logger.warn(
        `award-history read failed; source-specific history signals will not fire: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      history = emptyAwardHistory();
    }

    const profile = buildClientOpportunityProfile(facts, history);

    return {
      clientId,
      profile,
      grantProfile: profile.grant,
      samProfile: profile.sam,
      completeness: profile.completeness,
      facilitiesById: new Map(facts.facilities.map((f) => [f.id, f])),
    };
  }

  // ── Step 2: global catalog reads ─────────────────────────────────────────

  /**
   * The bounded candidate set: a TARGETED query keyed on the client's own codes
   * and history, UNIONed with a recency/deadline window.
   *
   * The window alone would be wrong in a way that is easy to miss. Ordered by
   * soonest deadline and capped, it silently drops a perfect Assistance-Listing
   * match that closes in four months in favour of a hundred irrelevant notices
   * closing next week. The targeted query is what makes the cap safe: anything
   * the client's structured facts can reach is fetched regardless of when it
   * closes, and the window then fills in discovery for facts we do not hold.
   */
  private async fetchSourceRows(
    facts: ClientFacts | null,
    query: OpportunityQuery,
  ): Promise<SourceFetchResult> {
    const wantGrants = query.source === undefined || query.source === 'grants_gov';
    const wantSam = query.source === undefined || query.source === 'sam_gov';
    const includeClosed = query.activeState === 'closed' || query.activeState === 'all';
    const includeActive = query.activeState !== 'closed';
    // Informational notices (award, special notice and family) are excluded from
    // default discovery and reachable ONLY by asking for them by kind. That is
    // what "available only through explicit informational filtering" means: no
    // date range and no activeState opens the door, because an award notice is not
    // a solicitation at any date.
    const includeInformational = (query.kind ?? []).some((kind) => NON_PURSUABLE_KINDS.has(kind));

    const [grants, sam] = await Promise.all([
      wantGrants
        ? this.fetchGrantRows(facts, { includeActive, includeClosed })
        : Promise.resolve({ rows: [] as SourceRow[], capped: false }),
      wantSam
        ? this.fetchSamRows(facts, { includeActive, includeClosed, includeInformational })
        : Promise.resolve({ rows: [] as SourceRow[], capped: false }),
    ]);
    return { rows: [...grants.rows, ...sam.rows], capped: grants.capped || sam.capped };
  }

  private async fetchGrantRows(
    facts: ClientFacts | null,
    opts: { includeActive: boolean; includeClosed: boolean },
  ): Promise<SourceFetchResult> {
    // ── The lifecycle predicate goes IN the query, before the row cap.
    //
    // This used to read `status: { in: [...] }` and leave the close date to a
    // TypeScript filter applied AFTER `take: SCAN_CAP_PER_SOURCE`. That is not a
    // filter, it is a post-hoc trim of whatever the cap admitted — and because
    // the ordering is soonest-deadline-first, the cap was consumed by the
    // LONGEST-EXPIRED notices while genuinely open grants fell off the end.
    // Grants.gov leaves `oppStatus` at 'posted' on notices whose close date
    // passed months ago, so that tail is large.
    //
    // The status list was also wrong on the closed side: `['closed','archived']`
    // misses the much bigger population of still-'posted' grants whose close date
    // has passed, so the closed tab could not show them at all.
    const now = new Date();
    const lifecycleOr: Prisma.FederalGrantWhereInput[] = [
      ...(opts.includeActive ? [grantActiveWhere(now) as Prisma.FederalGrantWhereInput] : []),
      ...(opts.includeClosed ? [grantClosedWhere(now) as Prisma.FederalGrantWhereInput] : []),
    ];
    if (lifecycleOr.length === 0) return { rows: [], capped: false };
    // One clause → use it directly, so the planner sees a flat predicate rather
    // than a single-branch OR.
    const where: Prisma.FederalGrantWhereInput =
      lifecycleOr.length === 1 ? lifecycleOr[0]! : { OR: lifecycleOr };
    const select = GRANT_SELECT;
    const windowRows = await this.prisma.federalGrant.findMany({
      where,
      select,
      orderBy: [{ closeDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: SCAN_CAP_PER_SOURCE,
    });

    const structuredOr: Prisma.FederalGrantWhereInput[] = [];
    const textOr: Prisma.FederalGrantWhereInput[] = [];
    if (facts) {
      const listings = dedupe(facts.grantProfile.priorAssistanceListings);
      const agencies = dedupe(facts.grantProfile.priorAgencies);
      const applicantTypes = dedupe(facts.grantProfile.applicantTypes);
      if (listings.length) structuredOr.push({ cfdaNumbers: { hasSome: listings } });
      if (applicantTypes.length) structuredOr.push({ eligibility: { hasSome: applicantTypes } });
      structuredOr.push(
        ...agencies.slice(0, TARGET_TERM_CAP).map((agency) => ({
          agency: { equals: agency, mode: 'insensitive' as const },
        })),
      );
      const terms = distinctiveSearchTerms([
        ...facts.grantProfile.capabilityKeywords,
        facts.grantProfile.sector,
      ]);
      for (const term of terms) {
        textOr.push({ title: { contains: term, mode: 'insensitive' } });
        textOr.push({ description: { contains: term, mode: 'insensitive' } });
        textOr.push({ category: { contains: term, mode: 'insensitive' } });
      }
    }

    // `AND: [lifecycle, { OR: targeted }]`, NOT `{ ...lifecycle, OR: targeted }`.
    // The lifecycle predicate now carries its own top-level `OR` (close date is
    // null OR in the future), so spreading it and then assigning `OR` silently
    // DELETES the lifecycle half and returns expired grants again.
    const [structured, text] = await Promise.all([
      structuredOr.length
        ? this.prisma.federalGrant.findMany({
            where: { AND: [where, { OR: structuredOr }] },
            select,
            orderBy: [{ closeDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            take: SCAN_CAP_PER_SOURCE,
          })
        : Promise.resolve([]),
      textOr.length
        ? this.prisma.federalGrant.findMany({
            where: { AND: [where, { OR: textOr }] },
            select,
            orderBy: [{ closeDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            take: SCAN_CAP_PER_SOURCE,
          })
        : Promise.resolve([]),
    ]);

    const byId = new Map<string, (typeof windowRows)[number]>();
    for (const row of [...structured, ...text, ...windowRows]) byId.set(row.id, row);
    return {
      rows: [...byId.values()].map((row) => ({ kind: 'grant' as const, row })),
      capped:
        windowRows.length >= SCAN_CAP_PER_SOURCE ||
        structured.length >= SCAN_CAP_PER_SOURCE ||
        text.length >= SCAN_CAP_PER_SOURCE,
    };
  }

  private async fetchSamRows(
    facts: ClientFacts | null,
    opts: { includeActive: boolean; includeClosed: boolean; includeInformational: boolean },
  ): Promise<SourceFetchResult> {
    // ── Same defect, same fix, plus the notice-type half.
    //
    // The old predicate was `{}` / `{ active: true }` / `{ active: false }`:
    //
    //   * `{}` for activeState 'all' meant NO predicate before the cap at all;
    //   * `active: true` ignores the response deadline, and `active` is derived
    //     from the ARCHIVE date — which commonly trails the deadline by weeks — so
    //     it admitted notices whose window to respond had already shut;
    //   * nothing excluded award and special notices, so finished awards competed
    //     for the cap with live solicitations and were offered as pursuable.
    //
    // Award/informational notices are now reachable ONLY when the caller asks for
    // them by kind. They remain saveable for reference; they are never pursuable.
    const now = new Date();
    const lifecycleOr: Prisma.SamOpportunityWhereInput[] = [
      ...(opts.includeActive ? [samPursuableWhere(now) as Prisma.SamOpportunityWhereInput] : []),
      ...(opts.includeClosed ? [samClosedWhere(now) as Prisma.SamOpportunityWhereInput] : []),
      ...(opts.includeInformational
        ? [samInformationalWhere() as Prisma.SamOpportunityWhereInput]
        : []),
    ];
    if (lifecycleOr.length === 0) return { rows: [], capped: false };
    const activeWhere: Prisma.SamOpportunityWhereInput =
      lifecycleOr.length === 1 ? lifecycleOr[0]! : { OR: lifecycleOr };
    const select = SAM_SELECT;
    const windowRows = await this.prisma.samOpportunity.findMany({
      where: activeWhere,
      select,
      orderBy: [{ responseDeadline: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: SCAN_CAP_PER_SOURCE,
    });

    const structuredOr: Prisma.SamOpportunityWhereInput[] = [];
    const textOr: Prisma.SamOpportunityWhereInput[] = [];
    if (facts) {
      const profile = facts.samProfile;
      if (profile.naicsCodes.length) structuredOr.push({ naicsCode: { in: profile.naicsCodes } });
      if (profile.pscCodes.length) structuredOr.push({ pscCode: { in: profile.pscCodes } });
      structuredOr.push(
        ...profile.priorAgencies.slice(0, TARGET_TERM_CAP).map((agency) => ({
          agency: { equals: agency, mode: 'insensitive' as const },
        })),
        ...profile.priorOffices.slice(0, TARGET_TERM_CAP).map((office) => ({
          office: { equals: office, mode: 'insensitive' as const },
        })),
      );
      if (profile.programElementCodes.length) {
        structuredOr.push({
          matches: {
            some: {
              reviewStatus: 'accepted',
              peCode: { in: profile.programElementCodes },
            },
          },
        });
      }
      if (profile.setAsideCertifications.length) {
        structuredOr.push({ setAsideCode: { in: profile.setAsideCertifications } });
      }
      const terms = distinctiveSearchTerms([...profile.capabilityKeywords, profile.sector]);
      for (const term of terms) {
        textOr.push({ title: { contains: term, mode: 'insensitive' } });
        textOr.push({ description: { contains: term, mode: 'insensitive' } });
      }
    }

    // Already `AND`-composed here, which is why the SAM side did not have the
    // spread-clobber hazard the grant side did.
    const [structured, text] = await Promise.all([
      structuredOr.length
        ? this.prisma.samOpportunity.findMany({
            where: { AND: [activeWhere, { OR: structuredOr }] },
            select,
            orderBy: [{ responseDeadline: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            take: SCAN_CAP_PER_SOURCE,
          })
        : Promise.resolve([]),
      textOr.length
        ? this.prisma.samOpportunity.findMany({
            where: { AND: [activeWhere, { OR: textOr }] },
            select,
            orderBy: [{ responseDeadline: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
            take: SCAN_CAP_PER_SOURCE,
          })
        : Promise.resolve([]),
    ]);

    const byId = new Map<string, (typeof windowRows)[number]>();
    for (const row of [...structured, ...text, ...windowRows]) byId.set(row.id, row);
    return {
      rows: [...byId.values()].map((row) => ({ kind: 'sam' as const, row })),
      capped:
        windowRows.length >= SCAN_CAP_PER_SOURCE ||
        structured.length >= SCAN_CAP_PER_SOURCE ||
        text.length >= SCAN_CAP_PER_SOURCE,
    };
  }

  private async fetchOneSourceRow(
    source: OpportunitySource,
    sourceRecordId: string,
  ): Promise<SourceRow | null> {
    if (source === 'grants_gov') {
      // tenant-scope-exempt: global catalog.
      const row = await this.prisma.federalGrant.findUnique({
        where: { id: sourceRecordId },
      });
      return row ? { kind: 'grant', row } : null;
    }
    if (!UUID_RE.test(sourceRecordId)) {
      // sam_opportunity.id is a uuid column; a non-uuid string would make Prisma
      // throw a raw driver error (a 500) for what is really a client mistake.
      throw new BadRequestException('SAM opportunity id must be a UUID');
    }
    // tenant-scope-exempt: global catalog.
    const row = await this.prisma.samOpportunity.findUnique({
      where: { id: sourceRecordId },
      include: { matches: { where: { reviewStatus: 'accepted' }, select: { peCode: true } } },
    });
    return row ? { kind: 'sam', row } : null;
  }

  // ── Tenant-scoped workflow reads ─────────────────────────────────────────

  private async readWorkflowRows(
    tenantId: string,
    clientId: string,
  ): Promise<WorkflowRowWithRefs[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.clientFundingOpportunity.findMany({
        where: { clientId },
        take: WORKFLOW_ROW_CAP,
        orderBy: { updatedAt: 'desc' },
      });
      const ownerIds = dedupe(rows.map((r) => r.ownerUserId));
      const facilityIds = dedupe(rows.map((r) => r.facilityId));
      // Two batched lookups, never one per row.
      const owners = ownerIds.length
        ? await tx.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : [];
      const facilities = facilityIds.length
        ? await tx.clientFacility.findMany({
            where: { id: { in: facilityIds }, clientId },
            select: { id: true, name: true, state: true, congressionalDistrict: true },
          })
        : [];
      const ownerById = new Map(owners.map((o) => [o.id, o]));
      const facilityById = new Map(facilities.map((f) => [f.id, f]));
      return rows.map((r) => ({
        row: r,
        owner: r.ownerUserId ? (ownerById.get(r.ownerUserId) ?? null) : null,
        facility: r.facilityId ? (facilityById.get(r.facilityId) ?? null) : null,
      }));
    });
  }

  private async findWorkflowRow(
    tx: Prisma.TransactionClient,
    clientId: string,
    source: OpportunitySource,
    sourceRecordId: string,
  ) {
    if (source === 'sam_gov' && !UUID_RE.test(sourceRecordId)) {
      throw new BadRequestException('SAM opportunity id must be a UUID');
    }
    return tx.clientFundingOpportunity.findFirst({
      where: {
        clientId,
        source,
        ...(source === 'grants_gov'
          ? { grantOpportunityId: sourceRecordId }
          : { samOpportunityId: sourceRecordId }),
      },
    });
  }

  // ── Tenant-safety assertions ─────────────────────────────────────────────

  private async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!found) throw new NotFoundException('Client not found');
  }

  /**
   * An owner uuid arrives in a request body, which proves nothing about whose
   * tenant that user is in. Without this check a caller could assign another
   * tenant's user as the owner of their pursuit, and that user's name would then
   * be rendered to them — a cross-tenant identity leak through a field nobody
   * would think of as a read.
   */
  private async assertUserInTenant(tenantId: string, userId: string): Promise<void> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { id: userId }, select: { id: true } }),
    );
    if (!found) throw new BadRequestException('Owner must be a user in this tenant');
  }

  /**
   * A facility must belong to THIS client, not merely to this tenant. Linking
   * client A's opportunity to client B's plant would attribute a pursuit to the
   * wrong congressional district — the exact fabricated-geography failure the
   * project-site rule exists to prevent.
   */
  private async assertFacilityBelongsToClient(
    tenantId: string,
    clientId: string,
    facilityId: string,
  ): Promise<void> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findFirst({ where: { id: facilityId, clientId }, select: { id: true } }),
    );
    if (!found) {
      throw new BadRequestException('Project site must be a facility belonging to this client');
    }
  }

  // ── Step 3: shaping and scoring (pure, in memory) ────────────────────────

  private sourceSnapshot(src: SourceRow): { status: string | null; deadline: Date | null; updatedAt: Date | null } {
    if (src.kind === 'grant') {
      return {
        status: src.row.status ?? null,
        deadline: src.row.closeDate ?? null,
        updatedAt: src.row.lastUpdatedAt ?? src.row.detailSyncedAt ?? src.row.syncedAt,
      };
    }
    return {
      status: src.row.active ? 'active' : 'archived',
      deadline: src.row.responseDeadline ?? null,
      updatedAt: src.row.updatedAt ?? src.row.lastSyncedAt,
    };
  }

  private scoreRow(
    src: SourceRow,
    facts: ClientFacts,
  ): {
    relevanceScore: number;
    matchedSignals: FundingOpportunity['matchedSignals'];
    eligibility: { state: FundingOpportunity['eligibility']['state']; reason: string };
    meetsSuggestionFloor: boolean;
  } {
    if (src.kind === 'grant') {
      const g = src.row;
      const profile = {
        assistanceListingNumber: g.cfdaNumbers[0] ?? null,
        agency: g.agency,
        fundingCategory: g.category,
        title: g.title,
        description: g.description,
        eligibleApplicantTypes: g.eligibility,
        // Grants.gov's search and detail payloads carry NO geographic-restriction
        // field, verified against the ingestion (sync-grants.ts documents the
        // exact ten fields search2 returns; enrich-grant-details.ts writes no
        // geography either). Honestly empty rather than inferred — inferring a
        // restriction would fabricate an ineligibility.
        geographicRestrictions: [] as string[],
      };
      const scored = scoreOpportunityRelevance(facts.grantProfile, profile);
      const eligibility = computeEligibility(facts.grantProfile, profile);
      return {
        relevanceScore: scored.relevanceScore,
        matchedSignals: scored.matchedSignals.map((s) => ({
          signal: s.signal,
          strength: s.strength,
          weight: s.weight,
          matchedOn: s.matchedOn,
        })),
        eligibility: { state: eligibility.state, reason: eligibility.reason },
        // The grant scorer has no floor concept of its own; a strong or moderate
        // signal is the same bar the SAM engine applies, kept identical so the
        // two rails cannot disagree about what counts as a suggestion.
        meetsSuggestionFloor:
          scored.matchedSignals.some((s) => s.strength === 'strong') ||
          scored.matchedSignals.filter((s) => s.strength === 'moderate').length >= 2,
      };
    }

    const s = src.row;
    const pop = parsePlaceOfPerformance(s.placeOfPerformance);
    const profile: SamOpportunityProfile = {
      title: s.title,
      description: s.description,
      agency: s.agency,
      subAgency: s.subAgency,
      office: s.office,
      naicsCode: s.naicsCode,
      pscCode: s.pscCode,
      setAside: s.setAside,
      setAsideCode: s.setAsideCode,
      placeOfPerformance: pop ? { city: pop.city, state: pop.state, zip: pop.zip } : null,
      acceptedProgramElementCodes: dedupe((s.matches ?? []).map((m) => m.peCode)),
    };
    const scored = scoreSamOpportunityRelevance(facts.samProfile, profile);
    const eligibility = computeSamEligibility(facts.samProfile, profile);
    return {
      relevanceScore: scored.relevanceScore,
      matchedSignals: scored.matchedSignals.map((sig) => ({
        signal: sig.signal,
        strength: sig.strength,
        weight: sig.weight,
        matchedOn: sig.matchedOn,
      })),
      eligibility: { state: eligibility.state, reason: eligibility.reason },
      meetsSuggestionFloor: scored.meetsSuggestionFloor,
    };
  }

  /**
   * `asOf` is a parameter, not `new Date()`, so a recommendation is reproducible:
   * the same request replayed against the same data gives the same answer, and a
   * test can pin deadline proximity without freezing the clock.
   */
  private shapeScored(
    src: SourceRow,
    facts: ClientFacts,
    workflows: WorkflowRowWithRefs[],
    asOf: Date = new Date(),
  ): FundingOpportunity {
    const base = this.shapeUnscored(src);
    const scored = this.scoreRow(src, facts);
    const wf = workflows.find((w) =>
      base.source === 'grants_gov'
        ? w.row.grantOpportunityId === base.sourceRecordId
        : w.row.samOpportunityId === base.sourceRecordId,
    );

    const linkedFacility = wf?.facility ?? null;
    return {
      ...base,
      clientId: facts.clientId,
      relevanceScore: scored.relevanceScore,
      matchedSignals: scored.matchedSignals,
      eligibility: scored.eligibility,
      // Computed, never persisted. Recomputing on read is what keeps it honest
      // against a client profile that has changed since the producer last ran.
      recommendation: recommendOpportunity({
        source: base.source,
        kind: base.kind,
        isActive: base.isActive,
        isPursuable: base.isPursuable,
        responseDeadline: base.responseDeadline,
        relevanceScore: scored.relevanceScore,
        signalStrengths: scored.matchedSignals.map((sig) => sig.strength),
        signalKeys: scored.matchedSignals.map((sig) => sig.signal),
        eligibility: scored.eligibility.state,
        profileTooThin: profileIsTooThin(facts.completeness),
        asOf,
      }),
      missingProfileFields: missingProfileFields(facts.completeness, base.source),
      // An explicit project site OVERRIDES nothing — it is the only district
      // source for a grant (Grants.gov publishes no geography) and it is a
      // reviewed statement, so it takes precedence over a SAM place of
      // performance, which describes where the work happens rather than which of
      // this client's sites is involved.
      districtKey: linkedFacility
        ? districtKeyFor(linkedFacility.state, linkedFacility.congressionalDistrict)
        : base.districtKey,
      districtBasis: linkedFacility ? 'linked_project_site' : base.districtBasis,
      workflow: wf ? this.shapeWorkflow(wf.row, wf.owner, wf.facility) : null,
      _meetsFloor: scored.meetsSuggestionFloor,
    } as FundingOpportunity & { _meetsFloor: boolean };
  }

  /** Source facts only. No score, no eligibility, no client. */
  private shapeUnscored(src: SourceRow): FundingOpportunity {
    if (src.kind === 'grant') {
      const g = src.row;
      const today = startOfUtcDay(new Date());
      const kind = grantsGovKind(g.fundingInstrument);
      return {
        id: `grants_gov:${g.id}`,
        source: 'grants_gov',
        sourceRecordId: g.id,
        sourceReference: g.opportunityNumber ?? g.id,
        sourceUrl: g.url ?? null,
        kind,
        kindRaw: g.fundingInstrument ?? null,
        baseKind: null,
        title: g.title,
        agency: g.agency,
        subAgency: g.subAgency ?? null,
        office: null,
        status: g.status ?? null,
        postedDate: g.openDate ? g.openDate.toISOString() : null,
        responseDeadline: g.closeDate ? g.closeDate.toISOString() : null,
        responseDeadlineNote: g.responseDateDesc ?? null,
        closeOrArchiveDate: g.closeDate ? g.closeDate.toISOString() : null,
        isActive: isGrantActive(g.status, g.closeDate, today),
        isPursuable: !NON_PURSUABLE_KINDS.has(kind),
        summary: g.description ?? null,
        summaryIsLink: false,
        naicsCodes: [],
        pscCodes: [],
        setAside: null,
        setAsideCode: null,
        eligibleApplicantTypes: g.eligibility,
        assistanceListings: g.cfdaNumbers,
        fundingInstrument: g.fundingInstrument ?? null,
        category: g.category ?? null,
        grantFunding: {
          estimatedProgramFunding: g.estimatedFunding ?? null,
          awardFloor: g.awardFloor ?? null,
          awardCeiling: g.awardCeiling ?? null,
          expectedAwardCount: g.expectedAwards ?? null,
          costSharingRequired: g.costSharing ?? null,
        },
        contractValue: null,
        placeOfPerformance: null,
        // Grants.gov publishes applicant eligibility, not a place of
        // performance. There is no honest district for a grant opportunity
        // absent an explicit project site.
        districtKey: null,
        districtBasis: null,
        relevanceScore: 0,
        eligibility: { state: 'unknown', reason: NO_CLIENT_REASON },
        matchedSignals: [],
        // Null, not a placeholder: a recommendation is always relative to a
        // specific client, and the unscoped catalog read has none.
        recommendation: null,
        missingProfileFields: [],
        sourceUpdatedAt: (g.lastUpdatedAt ?? g.detailSyncedAt ?? g.syncedAt)?.toISOString() ?? null,
        workflow: null,
        clientId: null,
      };
    }

    const s = src.row;
    const kind = samNoticeKind(s.noticeType);
    const pop = parsePlaceOfPerformance(s.placeOfPerformance);
    const summary = s.description ?? null;
    return {
      id: `sam_gov:${s.id}`,
      source: 'sam_gov',
      sourceRecordId: s.id,
      sourceReference: s.solicitationNumber ?? s.noticeId,
      sourceUrl: s.sourceUrl ?? null,
      kind,
      kindRaw: s.noticeType,
      baseKind: s.baseType ? samNoticeKind(s.baseType) : null,
      title: s.title,
      agency: s.agency ?? null,
      subAgency: s.subAgency ?? null,
      office: s.office ?? null,
      status: s.active ? 'active' : 'archived',
      postedDate: s.postedDate ? s.postedDate.toISOString() : null,
      responseDeadline: s.responseDeadline ? s.responseDeadline.toISOString() : null,
      responseDeadlineNote: null,
      closeOrArchiveDate: s.archiveDate ? s.archiveDate.toISOString() : null,
      isActive: isSamActive(s.active, s.responseDeadline, s.archiveDate, new Date()),
      isPursuable: !NON_PURSUABLE_KINDS.has(kind),
      summary,
      // SAM's search payload puts EITHER inline prose OR a link to its
      // description endpoint in this field. Flagged rather than hidden, so the UI
      // can render a link as a link instead of as a synopsis that looks corrupt.
      summaryIsLink: isHttpUrl(summary),
      naicsCodes: s.naicsCode ? [s.naicsCode] : [],
      pscCodes: s.pscCode ? [s.pscCode] : [],
      setAside: s.setAside ?? null,
      setAsideCode: s.setAsideCode ?? null,
      eligibleApplicantTypes: [],
      assistanceListings: [],
      fundingInstrument: null,
      category: null,
      grantFunding: null,
      contractValue: {
        // See ContractValue's docblock: SAM publishes no estimated value for a
        // pursuable notice. `null` + 'not_stated_by_source' is the honest answer
        // and the UI renders "Not stated", never "$0".
        estimatedValue: null,
        basis: 'not_stated_by_source',
      },
      placeOfPerformance: pop,
      // Source-stated geography only, and only to STATE granularity — the
      // notice's place of performance is where the work happens, which may be a
      // government installation nowhere near the client. Left null here; the
      // scored path fills it from an explicitly linked project site.
      districtKey: null,
      districtBasis: null,
      relevanceScore: 0,
      eligibility: { state: 'unknown', reason: NO_CLIENT_REASON },
      matchedSignals: [],
      // Null, not a 'needs_review' placeholder: a recommendation is always
      // relative to a specific client, and inventing one for the unscoped catalog
      // would be a claim about a client nobody named.
      recommendation: null,
      missingProfileFields: [],
      sourceUpdatedAt: (s.updatedAt ?? s.lastSyncedAt)?.toISOString() ?? null,
      workflow: null,
      clientId: null,
    };
  }

  private shapeWorkflow(
    row: {
      id: string;
      workflowStatus: string;
      ownerUserId: string | null;
      notes: string | null;
      dismissedReason: string | null;
      outcomeNote: string | null;
      userCreated: boolean;
      staleAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    owner: { id: string; firstName: string | null; lastName: string | null; email: string } | null,
    facility: {
      id: string;
      name: string;
      state: string | null;
      congressionalDistrict: string | null;
    } | null,
  ): OpportunityWorkflow {
    return {
      id: row.id,
      status: row.workflowStatus as OpportunityWorkflowStatus,
      owner: row.ownerUserId
        ? {
            userId: row.ownerUserId,
            name: owner
              ? [owner.firstName, owner.lastName].filter(Boolean).join(' ') || null
              : null,
            email: owner?.email ?? null,
          }
        : null,
      facility: facility
        ? {
            id: facility.id,
            name: facility.name,
            state: facility.state,
            districtKey: districtKeyFor(facility.state, facility.congressionalDistrict),
          }
        : null,
      notes: row.notes,
      dismissedReason: row.dismissedReason,
      outcomeNote: row.outcomeNote,
      userCreated: row.userCreated,
      staleAt: row.staleAt ? row.staleAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ── Filtering, sorting, counting ─────────────────────────────────────────

  private clearsSuggestionFloor(o: FundingOpportunity, minRelevance: number | undefined): boolean {
    const meets = (o as FundingOpportunity & { _meetsFloor?: boolean })._meetsFloor === true;
    if (!meets) return false;
    if (minRelevance != null) return o.relevanceScore >= minRelevance;
    return true;
  }

  private applyPostFilters(
    items: FundingOpportunity[],
    q: OpportunityQuery,
  ): FundingOpportunity[] {
    let out = items;

    // Dismissed rows are hidden UNLESS explicitly asked for. A dismissal is a
    // decision to stop seeing something, and honouring it by default is the
    // whole point of recording it.
    if (q.workflowStatus && q.workflowStatus.length > 0) {
      const wanted = new Set(q.workflowStatus);
      out = out.filter((o) => o.workflow != null && wanted.has(o.workflow.status));
    } else {
      out = out.filter((o) => o.workflow?.status !== 'dismissed');
    }

    if (q.kind && q.kind.length > 0) {
      const wanted = new Set(q.kind);
      out = out.filter((o) => wanted.has(o.kind));
    }
    if (q.activeState === 'active') out = out.filter((o) => o.isActive);
    if (q.activeState === 'closed') out = out.filter((o) => !o.isActive);
    if (q.agency) {
      const needle = q.agency.toLowerCase();
      out = out.filter(
        (o) =>
          (o.agency ?? '').toLowerCase().includes(needle) ||
          (o.subAgency ?? '').toLowerCase().includes(needle) ||
          (o.office ?? '').toLowerCase().includes(needle),
      );
    }
    if (q.naics) {
      const needle = normCode(q.naics);
      out = out.filter((o) => o.naicsCodes.some((c) => normCode(c) === needle));
    }
    if (q.psc) {
      const needle = normCode(q.psc);
      out = out.filter((o) => o.pscCodes.some((c) => normCode(c) === needle));
    }
    if (q.setAside) {
      const needle = q.setAside.toLowerCase();
      out = out.filter(
        (o) =>
          (o.setAside ?? '').toLowerCase().includes(needle) ||
          (o.setAsideCode ?? '').toLowerCase() === needle,
      );
    }
    if (q.eligibility && q.eligibility.length > 0) {
      const wanted = new Set(q.eligibility);
      out = out.filter((o) => wanted.has(o.eligibility.state));
    }
    if (q.minRelevance != null) {
      // Rows a human acted on are never filtered out by a score threshold: the
      // team's own decision outranks the machine's opinion of it.
      out = out.filter((o) => o.workflow != null || o.relevanceScore >= q.minRelevance!);
    }
    if (q.deadlineFrom) {
      out = out.filter((o) => o.responseDeadline != null && o.responseDeadline >= q.deadlineFrom!);
    }
    if (q.deadlineTo) {
      out = out.filter((o) => o.responseDeadline != null && o.responseDeadline <= q.deadlineTo!);
    }
    if (q.q) {
      const needle = q.q.toLowerCase();
      out = out.filter(
        (o) =>
          o.title.toLowerCase().includes(needle) ||
          (o.sourceReference ?? '').toLowerCase().includes(needle) ||
          (o.agency ?? '').toLowerCase().includes(needle) ||
          // Only search the summary when it is prose. A URL "matching" a search
          // term is a false hit the user cannot see the reason for.
          (!o.summaryIsLink && (o.summary ?? '').toLowerCase().includes(needle)),
      );
    }
    return out;
  }

  /** workflow priority → relevance → deadline → source update. §6's exact order. */
  private sortOpportunities(items: FundingOpportunity[]): FundingOpportunity[] {
    return [...items].sort((a, b) => {
      const aw = a.workflow ? WORKFLOW_SORT_PRIORITY[a.workflow.status] : SUGGESTION_PRIORITY;
      const bw = b.workflow ? WORKFLOW_SORT_PRIORITY[b.workflow.status] : SUGGESTION_PRIORITY;
      if (aw !== bw) return aw - bw;
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      // Soonest real deadline first; a null deadline sorts last rather than
      // first, so "continuous" notices do not monopolise the top of the list.
      const ad = a.responseDeadline ?? '￿';
      const bd = b.responseDeadline ?? '￿';
      if (ad !== bd) return ad < bd ? -1 : 1;
      const au = a.sourceUpdatedAt ?? '';
      const bu = b.sourceUpdatedAt ?? '';
      if (au !== bu) return au > bu ? -1 : 1;
      // Total order, so pagination cannot repeat or skip a row between requests.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  private paginate(
    items: FundingOpportunity[],
    q: OpportunityQuery,
  ): { items: FundingOpportunity[]; page: number; pageSize: number } {
    const pageSize = Math.min(Math.max(q.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(q.page ?? 1, 1);
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), page, pageSize };
  }

  /**
   * Counts, kept deliberately separate per rail.
   *
   * There is no blended dollar total and no blended "opportunity value" here, by
   * design — see funding-opportunities.types.ts. Grants and contracts are
   * counted separately because a single number would invite exactly the
   * apples-to-oranges claim the feature exists to avoid.
   */
  private countFor(
    scored: FundingOpportunity[],
    workflows: WorkflowRowWithRefs[],
  ): FundingOpportunityCounts {
    const now = Date.now();
    const in30 = now + 30 * 86_400_000;
    const eligibleForActiveCount = scored.filter(
      (o) =>
        o.isActive &&
        o.isPursuable &&
        o.workflow?.status !== 'dismissed' &&
        (o.workflow != null || this.clearsSuggestionFloor(o, undefined)),
    );
    return {
      activeGrants: eligibleForActiveCount.filter((o) => o.source === 'grants_gov').length,
      activeContracts: eligibleForActiveCount.filter((o) => o.source === 'sam_gov').length,
      // Workflow counts come from the WORKFLOW ROWS, not from the scored page: a
      // saved opportunity whose notice has scrolled out of the bounded scan is
      // still saved, and a card that said "0 saved" because of a scan cap would
      // be wrong in a way the user cannot diagnose.
      saved: workflows.filter((w) => w.row.workflowStatus === 'saved').length,
      pursuing: workflows.filter((w) => w.row.workflowStatus === 'pursuing').length,
      dismissed: workflows.filter((w) => w.row.workflowStatus === 'dismissed').length,
      deadlinesIn30Days: eligibleForActiveCount.filter((o) => {
        if (!o.responseDeadline) return false;
        const t = Date.parse(o.responseDeadline);
        return Number.isFinite(t) && t >= now && t <= in30;
      }).length,
    };
  }

  /**
   * WHY the list is empty — never "there is nothing out there" when the truth is
   * "we have not looked" or "we hold nothing to look with".
   *
   * Ordered most-fundamental-first: a rail that never synced explains an empty
   * catalog, and an empty catalog explains an empty result, so reporting the
   * downstream symptom would send someone to fix the wrong thing.
   */
  private emptyReasonFor(
    rows: SourceRow[],
    afterFilters: FundingOpportunity[],
    freshness: OpportunitySourceFreshness[],
    facts: ClientFacts | null,
  ): EmptyReason {
    if (freshness.some((f) => f.neverSynced) && rows.length === 0) return 'source_never_synced';
    if (rows.length === 0) return 'no_source_records';
    if (facts && profileIsTooThin(facts.completeness)) return 'client_profile_too_thin';
    if (afterFilters.length === 0 && rows.length > 0) {
      // Distinguish "nothing scored high enough" from "your filters excluded
      // everything" — different problems with different fixes.
      return facts ? 'no_match_above_threshold' : 'no_results_for_filters';
    }
    return 'no_results_for_filters';
  }

  // ── Freshness ────────────────────────────────────────────────────────────

  /**
   * Latest successful run per rail, plus the catalog's own size.
   *
   * A rail that has never completed is reported as `neverSynced`, not omitted:
   * silence reads as "fresh", and "SAM.gov has never synced" is the single most
   * useful thing to say to somebody looking at an empty contract list.
   */
  private async readFreshness(): Promise<OpportunitySourceFreshness[]> {
    const rails: Array<{ source: OpportunitySource; verb: string; label: string }> = [
      { source: 'grants_gov', verb: 'sync-grants', label: 'Grants.gov opportunities' },
      {
        source: 'sam_gov',
        verb: 'sync-sam-opportunities-all-federal',
        label: 'SAM.gov all-federal contract opportunities',
      },
    ];
    // The enrichment rail is a DEPENDENCY of the Grants.gov rail, not a rail of
    // its own: it is what populates award ceilings, eligibility text and the
    // amendment counters. Reported inside grants_gov rather than as a third row,
    // because "Grants.gov is current but has no terms on anything" is one fact
    // about one rail.
    const ENRICHMENT_VERB = 'enrich-grant-details';
    try {
      const [runs, grantCounts, samCounts] = await Promise.all([
        // ── Latest ATTEMPT, latest SUCCESS and latest FAILURE, per source, in one
        // pass. The previous query filtered to successful statuses only, so a rail
        // failing every night for a week reported the last time it worked and
        // nothing else — which reads as healthy and is the most dangerous possible
        // presentation of a dead rail.
        this.prisma.$queryRaw<
          Array<{
            source: string;
            last_attempt_at: Date | null;
            last_status: string | null;
            last_error_count: number | null;
            last_success_at: Date | null;
            last_failure_at: Date | null;
          }>
        >`
          WITH scoped AS (
            SELECT source, started_at, finished_at, status, error_count
            FROM sync_run
            WHERE source = ANY(${[...rails.map((r) => r.verb), ENRICHMENT_VERB]}::text[])
          ),
          latest AS (
            SELECT DISTINCT ON (source) source, started_at, finished_at, status, error_count
            FROM scoped
            ORDER BY source, started_at DESC
          )
          SELECT
            l.source,
            COALESCE(l.finished_at, l.started_at) AS last_attempt_at,
            l.status                              AS last_status,
            l.error_count                         AS last_error_count,
            (
              SELECT max(s.finished_at) FROM scoped s
              WHERE s.source = l.source
                AND s.status = ANY(${['success', 'success_with_errors']}::text[])
            ) AS last_success_at,
            (
              SELECT max(COALESCE(s.finished_at, s.started_at)) FROM scoped s
              WHERE s.source = l.source AND s.status = 'error'
            ) AS last_failure_at
          FROM latest l
        `,
        this.prisma.$queryRaw<
          Array<{ total: bigint; active: bigint; detailed: bigint; awaiting: bigint }>
        >`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (
              WHERE ${Prisma.raw(GRANT_ACTIVE_SQL)}
            )::bigint AS active,
            COUNT(*) FILTER (WHERE detail_synced_at IS NOT NULL)::bigint AS detailed,
            COUNT(*) FILTER (
              WHERE detail_synced_at IS NULL AND ${Prisma.raw(GRANT_ACTIVE_SQL)}
            )::bigint AS awaiting
          FROM federal_grant
        `,
        this.prisma.$queryRaw<Array<{ total: bigint; active: bigint }>>`
          SELECT
            COUNT(*)::bigint AS total,
            COUNT(*) FILTER (
              WHERE ${Prisma.raw(SAM_PURSUABLE_SQL)}
            )::bigint AS active
          FROM sam_opportunity
        `,
      ]);
      const byVerb = new Map(runs.map((r) => [r.source, r]));
      const grantRow = grantCounts[0];
      const counts = {
        grants_gov: { total: Number(grantRow?.total ?? 0n), active: Number(grantRow?.active ?? 0n) },
        sam_gov: {
          total: Number(samCounts[0]?.total ?? 0n),
          active: Number(samCounts[0]?.active ?? 0n),
        },
      } as const;

      const enrichRun = byVerb.get(ENRICHMENT_VERB);
      const enrichment: GrantEnrichmentHealth = {
        lastAttemptAt: enrichRun?.last_attempt_at?.toISOString() ?? null,
        lastSuccessAt: enrichRun?.last_success_at?.toISOString() ?? null,
        degraded:
          enrichRun == null ? null : isDegraded(enrichRun.last_status, enrichRun.last_error_count),
        detailedRecordCount: Number(grantRow?.detailed ?? 0n),
        activeAwaitingEnrichment: Number(grantRow?.awaiting ?? 0n),
      };

      return rails.map((rail) => {
        const run = byVerb.get(rail.verb);
        const c = counts[rail.source];
        const lastSuccess = run?.last_success_at ?? null;
        return {
          source: rail.source,
          verb: rail.verb,
          label: rail.label,
          lastSyncedAt: lastSuccess ? lastSuccess.toISOString() : null,
          lastAttemptAt: run?.last_attempt_at?.toISOString() ?? null,
          lastRunStatus: run?.last_status ?? null,
          lastRunErrorCount: run?.last_error_count ?? null,
          lastFailureAt: run?.last_failure_at?.toISOString() ?? null,
          hoursSinceLastSuccess: lastSuccess
            ? Math.floor((Date.now() - lastSuccess.getTime()) / 3_600_000)
            : null,
          neverSynced: lastSuccess == null,
          // Keyed on the LATEST ATTEMPT, not on the latest success. A failed run
          // last night degrades the rail even if the night before succeeded.
          lastRunDegraded: run == null ? null : isDegraded(run.last_status, run.last_error_count),
          countsUnavailable: false,
          recordCount: c.total,
          activeRecordCount: c.active,
          enrichment: rail.source === 'grants_gov' ? enrichment : null,
        };
      });
    } catch (error) {
      this.logger.warn(
        `funding-opportunity freshness read failed; reporting counts as unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return rails.map((rail) => ({
        source: rail.source,
        verb: rail.verb,
        label: rail.label,
        lastSyncedAt: null,
        lastAttemptAt: null,
        lastRunStatus: null,
        lastRunErrorCount: null,
        lastFailureAt: null,
        hoursSinceLastSuccess: null,
        // NOT `false`: we do not know whether it has ever synced, and claiming it
        // has is the wrong direction to guess in.
        neverSynced: false,
        lastRunDegraded: null,
        countsUnavailable: true,
        recordCount: null,
        activeRecordCount: null,
        enrichment: null,
      }));
    }
  }
}

// ── Query shape ─────────────────────────────────────────────────────────────

export interface OpportunityQuery {
  clientId?: string;
  source?: OpportunitySource;
  kind?: OpportunityKind[];
  workflowStatus?: OpportunityWorkflowStatus[];
  activeState?: 'active' | 'closed' | 'all';
  agency?: string;
  naics?: string;
  psc?: string;
  setAside?: string;
  deadlineFrom?: string;
  deadlineTo?: string;
  minRelevance?: number;
  eligibility?: Array<FundingOpportunity['eligibility']['state']>;
  q?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_QUERY: OpportunityQuery = { activeState: 'active' };

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Per-source scan cap. Two queries per source (targeted + window), so at most
 * 2×this rows per source reach memory.
 *
 * Sized against the measured corpora: 82,998 Grants.gov records across all
 * statuses (sync-grants.ts's own note, 2026-07-28) of which the active subset is
 * a small fraction, and an all-federal SAM.gov catalog that can be much larger than the display
 * window. Structured and text-targeted queries are UNIONed with that window, and
 * `totalIsCapped` is driven by explicit per-query cap metadata so truncation is
 * visible rather than inferred from the deduplicated row count.
 */
const SCAN_CAP_PER_SOURCE = 1200;
const TARGET_TERM_CAP = 20;

/** Cap on workflow rows read per client. Far above any realistic pursuit list. */
const WORKFLOW_ROW_CAP = 2000;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CARD_TOP_N = 3;

/**
 * Where a scored-but-unsaved suggestion sorts. Equal to 'suggested' — a
 * suggestion with no workflow row and one with a producer-written 'suggested'
 * row are the same thing to a user, and ranking them differently would make the
 * list reorder for no visible reason the first time a producer ran.
 */
const SUGGESTION_PRIORITY = WORKFLOW_SORT_PRIORITY.suggested;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_CLIENT_REASON =
  'No client selected, so eligibility has not been evaluated. Eligibility is always relative to a specific client.';

export const EMPTY_EXPLANATIONS: Record<EmptyReason, string> = {
  no_source_records:
    'The opportunity catalogs hold no records matching this view. This is a statement about what has been ingested, not about what exists at Grants.gov or SAM.gov.',
  source_never_synced:
    'This source has never completed a successful sync, so Capiro holds no opportunities from it yet. Nothing can be said about matches until it runs.',
  client_profile_too_thin:
    'This client has no NAICS codes, PSC codes, applicant types, capabilities or federal award history — nothing any matching signal reads. “No matches” here says nothing about the opportunity universe.',
  no_match_above_threshold:
    'Opportunities were evaluated and none cleared the relevance floor for this client. Completing the profile fields listed below is what changes this.',
  no_saved_opportunities:
    'Nothing has been saved or marked as being pursued for this client yet.',
  no_results_for_filters:
    'No opportunities match the current filters. Clearing filters will widen the view.',
};

// ── Row types ───────────────────────────────────────────────────────────────

const GRANT_SELECT = {
  id: true,
  title: true,
  agency: true,
  subAgency: true,
  opportunityNumber: true,
  category: true,
  fundingInstrument: true,
  eligibility: true,
  cfdaNumbers: true,
  awardCeiling: true,
  awardFloor: true,
  estimatedFunding: true,
  expectedAwards: true,
  openDate: true,
  closeDate: true,
  status: true,
  description: true,
  url: true,
  costSharing: true,
  responseDateDesc: true,
  lastUpdatedAt: true,
  detailSyncedAt: true,
  syncedAt: true,
} as const;

const SAM_SELECT = {
  id: true,
  noticeId: true,
  solicitationNumber: true,
  title: true,
  noticeType: true,
  baseType: true,
  agency: true,
  subAgency: true,
  office: true,
  pscCode: true,
  naicsCode: true,
  setAside: true,
  setAsideCode: true,
  postedDate: true,
  responseDeadline: true,
  archiveDate: true,
  description: true,
  placeOfPerformance: true,
  sourceUrl: true,
  active: true,
  lastSyncedAt: true,
  updatedAt: true,
  matches: { where: { reviewStatus: 'accepted' }, select: { peCode: true } },
} as const;

type GrantRow = {
  id: string;
  title: string;
  agency: string;
  subAgency: string | null;
  opportunityNumber: string | null;
  category: string | null;
  fundingInstrument: string | null;
  eligibility: string[];
  cfdaNumbers: string[];
  awardCeiling: number | null;
  awardFloor: number | null;
  estimatedFunding: number | null;
  expectedAwards: number | null;
  openDate: Date | null;
  closeDate: Date | null;
  status: string | null;
  description: string | null;
  url: string | null;
  costSharing: boolean | null;
  responseDateDesc: string | null;
  lastUpdatedAt: Date | null;
  detailSyncedAt: Date | null;
  syncedAt: Date;
};

type SamRow = {
  id: string;
  noticeId: string;
  solicitationNumber: string | null;
  title: string;
  noticeType: string;
  baseType: string | null;
  agency: string | null;
  subAgency: string | null;
  office: string | null;
  pscCode: string | null;
  naicsCode: string | null;
  setAside: string | null;
  setAsideCode: string | null;
  postedDate: Date | null;
  responseDeadline: Date | null;
  archiveDate: Date | null;
  description: string | null;
  placeOfPerformance: unknown;
  sourceUrl: string | null;
  active: boolean;
  lastSyncedAt: Date;
  updatedAt: Date;
  matches?: Array<{ peCode: string | null }>;
};

type SourceFetchResult = { rows: SourceRow[]; capped: boolean };

type SourceRow =
  | { kind: 'grant'; row: GrantRow }
  | { kind: 'sam'; row: SamRow };

interface WorkflowRowWithRefs {
  row: {
    id: string;
    source: string;
    grantOpportunityId: string | null;
    samOpportunityId: string | null;
    workflowStatus: string;
    ownerUserId: string | null;
    facilityId: string | null;
    notes: string | null;
    dismissedReason: string | null;
    outcomeNote: string | null;
    userCreated: boolean;
    staleAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  owner: { id: string; firstName: string | null; lastName: string | null; email: string } | null;
  facility: {
    id: string;
    name: string;
    state: string | null;
    congressionalDistrict: string | null;
  } | null;
}

interface ClientFacts {
  clientId: string;
  /**
   * The versioned profile, exactly as both producers build it. `grantProfile`,
   * `samProfile` and `completeness` below are views onto it, kept as named fields
   * because ~20 call sites read them and renaming those is churn this phase does
   * not need. They are the SAME objects — not copies — so they cannot drift.
   */
  profile: ClientOpportunityProfileV1;
  grantProfile: ClientRelevanceProfile;
  samProfile: SamClientProfile;
  completeness: ProfileCompleteness;
  facilitiesById: Map<
    string,
    { id: string; name: string; state: string | null; congressionalDistrict: string | null }
  >;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v && v.length > 0)),
  );
}

function distinctiveSearchTerms(values: Array<string | null | undefined>): string[] {
  const generic = new Set([
    'systems', 'system', 'technology', 'technologies', 'services', 'service',
    'solutions', 'solution', 'group', 'company', 'federal', 'government',
    'defense', 'support', 'management', 'program', 'contract', 'other',
  ]);
  return dedupe(values)
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/))
    .filter((term) => term.length >= 4 && !generic.has(term))
    .slice(0, TARGET_TERM_CAP);
}

function normCode(v: string | null | undefined): string {
  return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A run is degraded when it errored outright, completed with errors, or reported a
 * non-zero error count. `running` is NOT degraded — it has not finished.
 */
function isDegraded(status: string | null, errorCount: number | null): boolean {
  if (status === 'error') return true;
  if (status === 'success_with_errors') return true;
  return (errorCount ?? 0) > 0;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isDismissed(o: FundingOpportunity): boolean {
  return o.workflow?.status === 'dismissed';
}

function isHttpUrl(value: string | null): boolean {
  return value != null && /^https?:\/\//i.test(value.trim());
}

/**
 * Local wrappers over the shared predicates in `source-lifecycle.ts`.
 *
 * The definitions themselves used to live here, duplicated from the producers and
 * from the lifecycle pass, and the three copies had drifted: this file tested the
 * close date, the read QUERY did not, and the lifecycle pass ignored the response
 * deadline. Having exactly one definition is the point of the shared module — the
 * wrappers exist only to keep these call sites' positional argument shape.
 */
function isGrantActive(status: string | null, closeDate: Date | null, today: Date): boolean {
  return isGrantActiveShared({ status, closeDate }, today);
}

function isSamActive(
  active: boolean,
  responseDeadline: Date | null,
  archiveDate: Date | null,
  now: Date,
): boolean {
  return isSamActiveShared({ active, responseDeadline, archiveDate }, now);
}

/** `<STATE>-<2-char district>`, or null when either half is missing. */
function districtKeyFor(state: string | null, district: string | null): string | null {
  const s = (state ?? '').trim().toUpperCase();
  const d = (district ?? '').trim();
  if (!s || !d) return null;
  return `${s}-${d.padStart(2, '0')}`;
}

/**
 * SAM's `placeOfPerformance` is a JSON column whose shape is the vendor's, not
 * ours — never assume it. Returns null rather than an object of nulls when the
 * notice stated nothing, so "no place of performance" is distinguishable from
 * "a place of performance with no fields".
 */
export function parsePlaceOfPerformance(
  value: unknown,
): { city: string | null; state: string | null; zip: string | null; country: string | null } | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const nested = (key: string, inner: string): string | null => {
    const obj = v[key];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const got = (obj as Record<string, unknown>)[inner];
      return typeof got === 'string' && got.trim() ? got.trim() : null;
    }
    return null;
  };
  const flat = (key: string): string | null => {
    const got = v[key];
    return typeof got === 'string' && got.trim() ? got.trim() : null;
  };
  const city = nested('city', 'name') ?? flat('city');
  const state = nested('state', 'code') ?? nested('state', 'name') ?? flat('state');
  const zip = flat('zip');
  const country = nested('country', 'code') ?? nested('country', 'name') ?? flat('country');
  if (!city && !state && !zip && !country) return null;
  return { city, state, zip, country };
}
