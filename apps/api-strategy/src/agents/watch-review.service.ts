import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { MeriService } from '../meri/meri.service.js';
import { LIVE_NODE_WHERE } from '../strategy/live-node.js';
import { WatcherService } from './watcher.service.js';
import { findingKey, type Finding, type FindingCategory } from './watcher-checks.js';
import { orderBatchOps } from './watch-batch-order.js';
import type { PlanEdit } from '../meri/meri.types.js';

type Tx = Prisma.TransactionClient;

/**
 * Stage F (Phase 3): the Watch review orchestration service. Owns everything
 * the in-editor Watch panel needs beyond the raw change-set CRUD
 * (ChangeSetsService) and the deterministic check pass (WatcherService):
 * version-aware read state, on-demand revalidation with unchanged/updated/
 * dropped reconciliation, permanent dismissal, and the two accept paths that
 * collapse propose→approve→apply into one user action with exactly one
 * visible History event.
 *
 * Deliberately does NOT extend/replace ChangeSetsService.approve()/apply(): a
 * Watch accept has a different observable contract (one `watch.change_applied`
 * /`watch.batch_applied` event, not the generic path's separate approved+
 * applied audit rows) and a different entry precondition (Watch proposals go
 * straight from 'proposed' to accepted — there is no separate approve step in
 * the prototype). Preserves the generic change-set endpoints unchanged.
 */
@Injectable()
export class WatchReviewService {
  private readonly logger = new Logger(WatchReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly meri: MeriService,
    private readonly watcher: WatcherService,
  ) {}

  // ---- Step 1: read current review state -------------------------------------

  async getState(tenantId: string, strategyId: string): Promise<WatchReviewState> {
    return this.prisma.withTenant(tenantId, (tx) => this.loadState(tx, strategyId, null));
  }

  // ---- Step 2: revalidate on demand -------------------------------------------

  /**
   * Panel-open (and post-accept) revalidation. Runs the fast no-op path when
   * nothing has moved since the last check; otherwise re-runs the SAME
   * deterministic check + dedup/refresh machinery a manual "Run check now"
   * uses (WatcherService.runCheckNow), then reconciles the pre-recheck
   * proposal snapshot against the post-recheck state into unchanged/updated/
   * dropped.
   *
   * Three separate critical sections on purpose, never one held across the
   * runCheckNow call: WatcherService.proposeChangeSets takes its OWN
   * strategy-row FOR UPDATE lock in its OWN transaction, so holding this
   * method's lock across that call would self-deadlock (the same house rule
   * that keeps grounding/orchestrator reads from nesting inside a held tx —
   * see ChangeSetsService.apply's comment on grounding). Phase (a) reads the
   * decision snapshot; phase (b) is the recheck itself, unlocked; phase (c)
   * re-locks the strategy row, now uncontended, for the supersede bookkeeping.
   */
  async revalidate(
    tenantId: string,
    userId: string,
    strategyId: string,
    reason: string,
  ): Promise<WatchReviewState> {
    const t0 = Date.now();

    const snapshot = await this.prisma.withTenant(tenantId, async (tx) => {
      const strategy = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { id: true, lastEditedAt: true },
      });
      if (!strategy) throw new NotFoundException('Strategy not found');
      const head = await tx.spVersion.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!head) throw new NotFoundException('strategy has no version history');
      const mission = await tx.spAgentMission.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }],
      });
      const openProposals = await tx.spChangeSet.findMany({
        where: { strategyId, status: 'proposed', watchKey: { not: null } },
        select: { id: true, watchKey: true, strategyVersionId: true, ops: true },
      });
      const latestRun = mission
        ? await tx.spAgentRun.findFirst({
            where: { missionId: mission.id },
            orderBy: [{ createdAt: 'desc' }],
            select: { id: true, createdAt: true },
          })
        : null;
      return { lastEditedAt: strategy.lastEditedAt, headId: head.id, mission, openProposals, latestRun };
    });

    const { headId, mission, openProposals, latestRun, lastEditedAt } = snapshot;
    const allCurrentHead = openProposals.every((p) => p.strategyVersionId === headId);
    const runIsFresh = !!latestRun && (!lastEditedAt || latestRun.createdAt > lastEditedAt);

    if (!mission || (allCurrentHead && runIsFresh)) {
      this.logger.log(
        `[strategy:${strategyId}] Watch revalidate no-op (reason:${reason}) — ${
          mission ? 'already fresh' : 'no Watch mission'
        }`,
      );
      const state = await this.prisma.withTenant(tenantId, (tx) => this.loadState(tx, strategyId, null));
      return {
        ...state,
        lastRecheck: { state: 'complete', elapsedMs: Date.now() - t0, unchanged: [], updated: [], dropped: [] },
      };
    }

    let recheckFailed = false;
    try {
      await this.watcher.runCheckNow(tenantId, userId, mission.id, {
        idempotencyKey: `recheck:${mission.id}:${headId}`,
        trigger: 'manual',
      });
    } catch (err) {
      this.logger.warn(
        `[strategy:${strategyId}] Watch revalidate check FAILED (reason:${reason}): ${(err as Error).message}`,
      );
      recheckFailed = true;
    }

    if (recheckFailed) {
      const state = await this.prisma.withTenant(tenantId, (tx) => this.loadState(tx, strategyId, null));
      return {
        ...state,
        lastRecheck: { state: 'failed', elapsedMs: Date.now() - t0, unchanged: [], updated: [], dropped: [] },
      };
    }

    const recheck = await this.prisma.withTenantUser(tenantId, userId, (tx) =>
      this.reconcile(tx, tenantId, userId, strategyId, headId, openProposals),
    );
    const droppedDeleted = recheck.dropped.filter((d) => d.targetDeleted).length;
    this.logger.log(
      `[strategy:${strategyId} head:${headId}] Watch revalidate complete (reason:${reason}): ` +
        `${recheck.unchanged.length} unchanged, ${recheck.updated.length} updated, ` +
        `${recheck.dropped.length} dropped (${droppedDeleted} deleted-target) in ${Date.now() - t0}ms`,
    );

    const finalState = await this.prisma.withTenant(tenantId, (tx) => this.loadState(tx, strategyId, null));
    return { ...finalState, lastRecheck: { ...recheck, elapsedMs: Date.now() - t0 } };
  }

  /**
   * Step 3: reissue and classify. Reconciles the PRE-recheck open-proposal
   * snapshot against the state runCheckNow just produced. A proposal already
   * pinned to the (unchanged) current head was handled entirely by
   * runCheckNow's own dedup/refresh — same row, no supersede chain; a
   * stale-head (zombie) proposal is reconciled against the fresh current-head
   * set by watchKey and either reissued (unchanged/updated, with the
   * replaces/superseded-by pointers set both ways) or dropped (superseded
   * with a plain-language reason, no reissue).
   */
  private async reconcile(
    tx: Tx,
    tenantId: string,
    userId: string,
    strategyId: string,
    preHeadId: string,
    preProposals: Array<{ id: string; watchKey: string | null; strategyVersionId: string; ops: unknown }>,
  ): Promise<Omit<WatchRecheckResult, 'elapsedMs'>> {
    await tx.$queryRaw`
      SELECT id FROM sp_strategy
      WHERE id = ${strategyId}::uuid AND tenant_id = ${tenantId}::uuid
      FOR UPDATE`;

    const newHead = await tx.spVersion.findFirst({
      where: { strategyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    const newHeadId = newHead?.id ?? preHeadId;

    const freshRows = await tx.spChangeSet.findMany({
      where: { strategyId, status: 'proposed', watchKey: { not: null }, strategyVersionId: newHeadId },
      select: { id: true, watchKey: true, ops: true },
    });
    const freshByKey = new Map(freshRows.filter((r) => r.watchKey).map((r) => [r.watchKey!, r]));

    const liveIds = new Set(
      (
        await tx.spNode.findMany({ where: { strategyId, ...LIVE_NODE_WHERE }, select: { id: true } })
      ).map((n) => n.id),
    );

    const unchanged: WatchRecheckResult['unchanged'] = [];
    const updated: WatchRecheckResult['updated'] = [];
    const dropped: WatchRecheckResult['dropped'] = [];

    for (const old of preProposals) {
      if (!old.watchKey) continue;

      if (old.strategyVersionId === newHeadId) {
        // Already current before AND after this recheck: runCheckNow's own
        // dedup either left the row untouched or refreshed it IN PLACE — same
        // id, nothing to supersede. Re-read (a concurrent accept/dismiss may
        // have moved it since the snapshot) and classify by comparing ops.
        const current = await tx.spChangeSet.findFirst({
          where: { id: old.id },
          select: { ops: true, status: true },
        });
        if (!current || current.status !== 'proposed') continue;
        const same = stableJson(current.ops) === stableJson(old.ops);
        (same ? unchanged : updated).push({ watchKey: old.watchKey, newProposalId: old.id });
        continue;
      }

      const fresh = freshByKey.get(old.watchKey);
      if (!fresh) {
        const targetIds = extractNodeIds(old.ops);
        const targetDeleted = targetIds.length > 0 && targetIds.some((id) => !liveIds.has(id));
        const reason = targetDeleted
          ? 'The step this was about is no longer in the plan.'
          : 'This is no longer an issue — the plan has already moved past it.';
        const cas = await tx.spChangeSet.updateMany({
          where: { id: old.id, status: 'proposed' },
          data: { status: 'superseded', supersededReason: reason },
        });
        if (cas.count > 0) {
          await this.versioning.logActivity(tx, {
            tenantId,
            actorUserId: userId,
            authorKind: 'person',
            action: 'watch.proposal_dropped',
            entityType: 'change_set',
            entityId: old.id,
            after: { watchKey: old.watchKey, reason, targetDeleted },
          });
          this.logger.log(`[strategy:${strategyId}] Watch proposal dropped (${old.watchKey}): ${reason}`);
        }
        dropped.push({ watchKey: old.watchKey, reason, targetDeleted });
        continue;
      }

      const same = stableJson(fresh.ops) === stableJson(old.ops);
      const recheckStatus: 'unchanged' | 'updated' = same ? 'unchanged' : 'updated';
      await tx.spChangeSet.updateMany({
        where: { id: fresh.id, status: 'proposed' },
        data: { replacesChangeSetId: old.id, recheckStatus },
      });
      const cas = await tx.spChangeSet.updateMany({
        where: { id: old.id, status: 'proposed' },
        data: { status: 'superseded', supersededByChangeSetId: fresh.id },
      });
      if (cas.count > 0) {
        await this.versioning.logActivity(tx, {
          tenantId,
          actorUserId: userId,
          authorKind: 'person',
          action: 'watch.proposal_reissued',
          entityType: 'change_set',
          entityId: fresh.id,
          before: { replacesChangeSetId: old.id },
          after: { watchKey: old.watchKey, recheckStatus },
        });
      }
      (same ? unchanged : updated).push({ watchKey: old.watchKey, newProposalId: fresh.id });
    }

    return { state: 'complete', unchanged, updated, dropped };
  }

  // ---- Step 4: permanently dismiss --------------------------------------------

  async dismiss(tenantId: string, userId: string, proposalId: string): Promise<WatchReviewState> {
    const strategyId = await this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_change_set
        WHERE id = ${proposalId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Proposal not found');

      const cs = await tx.spChangeSet.findFirst({ where: { id: proposalId } });
      if (!cs) throw new NotFoundException('Proposal not found');
      if (cs.status !== 'proposed') {
        throw new ConflictException(`Proposal is ${cs.status} — only a proposed Watch finding can be dismissed`);
      }
      if (!cs.watchKey) {
        throw new BadRequestException('Not a Watch proposal — use the change-set reject endpoint instead');
      }

      await tx.spWatchDismissal.upsert({
        where: { tenantId_strategyId_watchKey: { tenantId, strategyId: cs.strategyId, watchKey: cs.watchKey } },
        create: {
          tenantId,
          strategyId: cs.strategyId,
          watchKey: cs.watchKey,
          dismissedByUserId: userId,
          sourceChangeSetId: cs.id,
        },
        update: { dismissedByUserId: userId, dismissedAt: new Date(), sourceChangeSetId: cs.id },
      });
      await tx.spChangeSet.update({
        where: { id: proposalId },
        data: { status: 'rejected', rejectedByUserId: userId, rejectedAt: new Date() },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'watch.proposal_dismissed',
        entityType: 'change_set',
        entityId: proposalId,
        after: { watchKey: cs.watchKey },
      });
      return cs.strategyId;
    });

    this.logger.log(`[strategy:${strategyId}] Watch proposal permanently dismissed (change-set ${proposalId})`);
    return this.getState(tenantId, strategyId);
  }

  // ---- Step 5: accept one and recheck -----------------------------------------

  async acceptOne(
    tenantId: string,
    userId: string,
    proposalId: string,
  ): Promise<{ strategy: unknown; state: WatchReviewState; recheck: WatchRecheckResult }> {
    // A6 parity with the manual apply path (ChangeSetsService.apply) and the
    // Meri assistant path: grounding is fetched OUTSIDE the tx (its reads open
    // their own withTenant txs — nesting would stack pool connections).
    const ground = await this.meri.grounding(tenantId);

    const result = await this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const lockedCs = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_change_set
        WHERE id = ${proposalId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;
      if (lockedCs.length === 0) throw new NotFoundException('Proposal not found');
      const cs = await tx.spChangeSet.findFirst({ where: { id: proposalId } });
      if (!cs) throw new NotFoundException('Proposal not found');
      if (!cs.watchKey) {
        throw new BadRequestException('Not a Watch proposal — use the change-set approve/apply endpoints instead');
      }
      if (cs.status !== 'proposed') {
        throw new ConflictException(`Proposal is ${cs.status} — only a proposed Watch finding can be accepted`);
      }

      // Lock order change-set -> strategy, matching ChangeSetsService.apply
      // and WatcherService.proposeChangeSets everywhere else in this module.
      await tx.$queryRaw`
        SELECT id FROM sp_strategy
        WHERE id = ${cs.strategyId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;

      const head = await tx.spVersion.findFirst({
        where: { strategyId: cs.strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!head || head.id !== cs.strategyVersionId) {
        await tx.spChangeSet.updateMany({
          where: { id: proposalId, status: 'proposed' },
          data: { status: 'superseded', supersededReason: 'The plan changed since this was proposed.' },
        });
        return { stale: true as const };
      }

      const edits = cs.ops as unknown as PlanEdit[];
      // This endpoint call IS the explicit approval — Watch collapses
      // propose->approve->apply into one user action, so approval and applied
      // fields are stamped together rather than requiring a prior separate
      // /approve call.
      await this.meri.applyEditSet(tx, tenantId, cs.strategyId, userId, edits);
      await tx.spStrategy.update({
        where: { id: cs.strategyId },
        data: { lastEditedByUserId: userId, lastEditedAt: new Date() },
      });
      const appliedVersionId = await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId: cs.strategyId,
        authorKind: 'person',
        authorUserId: userId,
        note: `Accepted a Watch proposal: ${stripWatchMarker(cs.summary).slice(0, 120)}`,
        coalesce: false,
      });
      const now = new Date();
      await tx.spChangeSet.update({
        where: { id: proposalId },
        data: {
          status: 'applied',
          approvedByUserId: userId,
          approvedAt: now,
          appliedByUserId: userId,
          appliedAt: now,
          appliedVersionId,
        },
      });
      // Exactly ONE visible activity event for this user action (never the
      // generic path's separate changeset.approved + changeset.applied rows).
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'watch.change_applied',
        entityType: 'change_set',
        entityId: proposalId,
        after: {
          watchKey: cs.watchKey,
          opCount: edits.length,
          appliedVersionId,
          impact: stripWatchMarker(cs.summary),
        },
      });
      const { detail } = await this.meri.verifyAppliedPlan(tx, tenantId, userId, cs.strategyId, ground);
      return { stale: false as const, detail, strategyId: cs.strategyId };
    });

    if (result.stale) {
      throw new ConflictException('This plan changed since the proposal was made — refresh and try again.');
    }

    // Immediately revalidate against the new head — old-head proposals must
    // never be returned as actionable between this commit and the recheck.
    const state = await this.revalidate(tenantId, userId, result.strategyId, 'post-accept');
    this.logger.log(`[strategy:${result.strategyId}] Watch change applied (change-set ${proposalId})`);
    return { strategy: result.detail, state, recheck: state.lastRecheck! };
  }

  // ---- Step 6: accept all atomically ------------------------------------------

  async acceptAll(
    tenantId: string,
    userId: string,
    strategyId: string,
    expectedVersionId: string,
    proposalIds: string[],
  ): Promise<{ strategy: unknown; state: WatchReviewState; recheck: WatchRecheckResult }> {
    const uniqueIds = [...new Set(proposalIds)];
    if (uniqueIds.length === 0) {
      throw new BadRequestException('proposalIds must include at least one proposal');
    }

    const ground = await this.meri.grounding(tenantId);

    const applied = await this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      // Lock proposal rows in LEXICAL id order (a documented, deadlock-free
      // order shared by every accept-all call regardless of on-screen
      // selection order), THEN the strategy row — matching the
      // change-set -> strategy order used everywhere else in this module.
      for (const id of [...uniqueIds].sort()) {
        await tx.$queryRaw`
          SELECT id FROM sp_change_set
          WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
          FOR UPDATE`;
      }
      await tx.$queryRaw`
        SELECT id FROM sp_strategy
        WHERE id = ${strategyId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;

      const rows = await tx.spChangeSet.findMany({ where: { id: { in: uniqueIds } } });
      const rowsById = new Map(rows.map((r) => [r.id, r]));
      if (rowsById.size !== uniqueIds.length) {
        throw new NotFoundException('One or more proposals were not found for this tenant');
      }
      for (const r of rows) {
        if (r.strategyId !== strategyId) {
          throw new BadRequestException('All proposals must belong to the requested strategy');
        }
        if (!r.watchKey) {
          throw new BadRequestException('All proposals must be Watch-originated');
        }
        if (r.status !== 'proposed') {
          throw new ConflictException(
            `Proposal ${r.id} is ${r.status} — accept-all requires every row to be proposed`,
          );
        }
        if (r.strategyVersionId !== expectedVersionId) {
          throw new ConflictException('One or more proposals are pinned to a version other than expectedVersionId');
        }
      }

      const head = await tx.spVersion.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!head || head.id !== expectedVersionId) {
        throw new ConflictException('expectedVersionId is not the current head — refresh and try again');
      }

      const liveNodes = await tx.spNode.findMany({
        where: { strategyId, ...LIVE_NODE_WHERE },
        select: { id: true, dependsOnIds: true },
      });
      // Ordered by the CALLER's proposalIds sequence (its on-screen order,
      // itself sortRank-derived from getState) — Prisma's `in` filter makes
      // no ordering guarantee, and watch-batch-order.ts's "stable proposal
      // order" contract needs a real anchor, not DB return order.
      const orderedInputOps = uniqueIds.flatMap((id) => rowsById.get(id)!.ops as unknown as PlanEdit[]);
      const orderResult = orderBatchOps(
        liveNodes.map((n) => ({ id: n.id, dependsOnIds: n.dependsOnIds })),
        orderedInputOps,
      );
      if (!orderResult.ok) {
        throw new UnprocessableEntityException(`Cannot batch these proposals: ${orderResult.error.message}`);
      }

      await this.meri.applyEditSet(tx, tenantId, strategyId, userId, orderResult.ops);
      await tx.spStrategy.update({
        where: { id: strategyId },
        data: { lastEditedByUserId: userId, lastEditedAt: new Date() },
      });
      const appliedVersionId = await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: userId,
        note: `Accepted ${rows.length} Watch proposal${rows.length === 1 ? '' : 's'}`,
        coalesce: false,
      });
      const now = new Date();
      await tx.spChangeSet.updateMany({
        where: { id: { in: uniqueIds } },
        data: {
          status: 'applied',
          approvedByUserId: userId,
          approvedAt: now,
          appliedByUserId: userId,
          appliedAt: now,
          appliedVersionId,
        },
      });
      // Exactly ONE visible History event for the whole batch — never N
      // per-proposal entries.
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'watch.batch_applied',
        entityType: 'strategy',
        entityId: strategyId,
        after: {
          proposalIds: uniqueIds,
          watchKeys: rows.map((r) => r.watchKey),
          opCount: orderResult.ops.length,
          appliedVersionId,
        },
      });
      const { detail } = await this.meri.verifyAppliedPlan(tx, tenantId, userId, strategyId, ground);
      return detail;
    });

    const state = await this.revalidate(tenantId, userId, strategyId, 'post-accept-all');
    this.logger.log(`[strategy:${strategyId}] Watch batch applied (${uniqueIds.length} proposals)`);
    return { strategy: applied, state, recheck: state.lastRecheck! };
  }

  // ---- shared state builder ----------------------------------------------------

  private async loadState(
    tx: Tx,
    strategyId: string,
    lastRecheck: WatchRecheckResult | null,
  ): Promise<WatchReviewState> {
    const strategy = await tx.spStrategy.findFirst({ where: { id: strategyId }, select: { id: true } });
    if (!strategy) throw new NotFoundException('Strategy not found');

    const head = await tx.spVersion.findFirst({
      where: { strategyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (!head) throw new NotFoundException('strategy has no version history');

    const mission = await tx.spAgentMission.findFirst({
      where: { strategyId },
      orderBy: [{ createdAt: 'desc' }],
    });
    const latestRun = mission
      ? await tx.spAgentRun.findFirst({
          where: { missionId: mission.id },
          orderBy: [{ createdAt: 'desc' }],
          select: { createdAt: true, findings: true },
        })
      : null;
    const findingsByKey = extractFindingsByKey(latestRun?.findings);

    const dismissals = await tx.spWatchDismissal.findMany({
      where: { strategyId },
      select: { watchKey: true },
    });
    const dismissedKeys = new Set(dismissals.map((d) => d.watchKey));

    const liveNodes = await tx.spNode.findMany({
      where: { strategyId, ...LIVE_NODE_WHERE },
      select: { id: true, title: true },
    });
    const liveNodeIds = new Set(liveNodes.map((n) => n.id));
    const nodeTitleById = new Map(liveNodes.map((n) => [n.id, n.title]));

    // Only current-head, proposed, watch-originated rows: an old-head
    // proposal is never actionable, and getState must never return one.
    const openChangeSets = await tx.spChangeSet.findMany({
      where: { strategyId, status: 'proposed', watchKey: { not: null }, strategyVersionId: head.id },
      orderBy: [{ createdAt: 'asc' }],
    });

    const rows: Array<{
      cs: (typeof openChangeSets)[number];
      finding?: Finding;
      primaryNodeTitle?: string;
    }> = [];
    for (const cs of openChangeSets) {
      if (!cs.watchKey || dismissedKeys.has(cs.watchKey)) continue;
      const targetIds = extractNodeIds(cs.ops);
      // Deleted-target: the proposal can no longer apply (applyEdit would
      // throw "referenced an unknown node") — vanish silently, no error card.
      if (targetIds.some((id) => !liveNodeIds.has(id))) continue;
      const finding = findingsByKey.get(cs.watchKey);
      const primaryNodeTitle = targetIds.map((id) => nodeTitleById.get(id)).find((t): t is string => !!t);
      rows.push({ cs, finding, primaryNodeTitle });
    }

    // Sort by sortRank, then source date, then stable id — a finding that
    // fell out of the LATEST run's snapshot (rare: the run refreshed since
    // this proposal was reissued) sorts after every classified finding rather
    // than guessing its priority.
    const DEFAULT_SORT_RANK = 99;
    rows.sort((a, b) => {
      const rankA = a.finding?.sortRank ?? DEFAULT_SORT_RANK;
      const rankB = b.finding?.sortRank ?? DEFAULT_SORT_RANK;
      if (rankA !== rankB) return rankA - rankB;
      const dateA = a.finding?.sourceDate ?? '';
      const dateB = b.finding?.sourceDate ?? '';
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      return a.cs.id < b.cs.id ? -1 : a.cs.id > b.cs.id ? 1 : 0;
    });

    return {
      strategyId,
      headVersionId: head.id,
      mission: mission
        ? {
            id: mission.id,
            state: mission.state,
            cadence: mission.cadence,
            lastRunAt: latestRun ? latestRun.createdAt.toISOString() : null,
            nextRunAt: mission.nextRunAt ? mission.nextRunAt.toISOString() : null,
          }
        : null,
      pendingCount: rows.length,
      proposals: rows.map((r) => buildProposalCard(r.cs, r.finding, r.primaryNodeTitle)),
      lastRecheck: lastRecheck ?? null,
    };
  }
}

// ---- public response types (plan §5) ------------------------------------------

export interface WatchReviewState {
  strategyId: string;
  headVersionId: string;
  mission: {
    id: string;
    state: string;
    cadence: string | null;
    lastRunAt: string | null;
    nextRunAt: string | null;
  } | null;
  pendingCount: number;
  proposals: WatchProposalCard[];
  lastRecheck?: WatchRecheckResult | null;
}

export interface WatchProposalCard {
  id: string;
  watchKey: string;
  strategyVersionId: string;
  sourceLabel: string;
  sourceDate: string | null;
  badges: Array<'out_of_order' | 'updated' | 'critical' | 'high_risk'>;
  title: string;
  proposal: string;
  impact: string;
  why: string;
  risk: string;
  recheckStatus: 'unchanged' | 'updated' | null;
}

export interface WatchRecheckResult {
  state: 'complete' | 'failed';
  elapsedMs: number;
  unchanged: Array<{ watchKey: string; newProposalId: string }>;
  updated: Array<{ watchKey: string; newProposalId: string }>;
  dropped: Array<{ watchKey: string; reason: string; targetDeleted: boolean }>;
}

// ---- pure mapping helpers -------------------------------------------------------

function buildProposalCard(
  cs: {
    id: string;
    watchKey: string | null;
    strategyVersionId: string;
    ops: unknown;
    summary: string;
    risk: string;
    recheckStatus: string | null;
  },
  finding: Finding | undefined,
  primaryNodeTitle: string | undefined,
): WatchProposalCard {
  const badges: WatchProposalCard['badges'] = [];
  const category: FindingCategory | undefined = finding?.category;
  if (category === 'dependency') badges.push('out_of_order');
  if (cs.recheckStatus === 'updated') badges.push('updated');
  if (cs.risk === 'critical') badges.push('critical');
  if (cs.risk === 'high') badges.push('high_risk');

  const fallbackText = stripWatchMarker(cs.summary);
  return {
    id: cs.id,
    watchKey: cs.watchKey!,
    strategyVersionId: cs.strategyVersionId,
    sourceLabel: finding?.sourceLabel ?? primaryNodeTitle ?? 'This plan',
    sourceDate: finding?.sourceDate ?? null,
    badges,
    title: finding?.title ?? 'Plan check',
    proposal: describeOps(cs.ops),
    impact: finding?.impact ?? fallbackText,
    why: finding?.message ?? fallbackText,
    risk: cs.risk,
    recheckStatus: cs.recheckStatus === 'unchanged' || cs.recheckStatus === 'updated' ? cs.recheckStatus : null,
  };
}

/** Plain-language rendering of a proposal's ops for the card — not the fuller
 *  `why`/`impact` text, just what would actually change. */
function describeOps(ops: unknown): string {
  if (!Array.isArray(ops) || ops.length === 0) return 'No change';
  const first = ops[0] as Record<string, unknown>;
  if (first.op === 'retime' && typeof first.startsOn === 'string') {
    return typeof first.endsOn === 'string'
      ? `Retime to ${first.startsOn} – ${first.endsOn}`
      : `Retime to ${first.startsOn}`;
  }
  if (first.op === 'add') return 'Add a new step';
  if (first.op === 'remove') return 'Remove a step';
  return ops.length === 1 ? 'Update this step' : `${ops.length} changes to this plan`;
}

function stripWatchMarker(summary: string): string {
  return summary.replace(/^\[watch:[^\]]+\]\s*/, '');
}

function extractNodeIds(ops: unknown): string[] {
  if (!Array.isArray(ops)) return [];
  const ids: string[] = [];
  for (const op of ops as Array<Record<string, unknown>>) {
    if (typeof op.nodeId === 'string') ids.push(op.nodeId);
  }
  return ids;
}

function extractFindingsByKey(findings: unknown): Map<string, Finding> {
  const map = new Map<string, Finding>();
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return map;
  const list = (findings as Record<string, unknown>).findings;
  if (!Array.isArray(list)) return map;
  for (const f of list as Finding[]) {
    if (f && typeof f === 'object' && typeof f.code === 'string' && Array.isArray(f.nodeIds)) {
      map.set(findingKey(f), f);
    }
  }
  return map;
}

/** Key-order-independent JSON identity (mirrors watcher.service.ts's
 *  stableJson) — a stored op and a freshly recomputed twin must not read as
 *  "different" on jsonb key-order alone. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = (val as Record<string, unknown>)[key];
            return acc;
          }, {})
      : val,
  );
}
