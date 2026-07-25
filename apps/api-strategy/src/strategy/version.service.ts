import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SpNodeKind,
  SpNodeStatus,
  SpNodeSubject,
  SpStrategyType,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from './versioning.service.js';
import { parseDbDate } from './dates.js';
import { loadStrategyDetail } from './detail.js';
import { ARCHIVED_NODE_WHERE, LIVE_NODE_WHERE } from './live-node.js';
import {
  diffSnapshotAgainstCurrent,
  isNoOpRestore,
  provenanceDiffers,
  type ImpactCurrentNode,
  type ImpactSnapshotNode,
} from './restore-impact.js';
import type { StrategySnapshot } from './versioning.js';

type Tx = Prisma.TransactionClient;

/**
 * Version history (HIS) + P0-1 NON-DESTRUCTIVE restore.
 *
 * ---- P0-1 (deep-audit critical finding) --------------------------------------
 * Restore used to be `DELETE FROM sp_node WHERE strategy_id = $1` followed by a
 * createMany from the chosen snapshot. A strategy node is no longer just a shape
 * on a canvas — it is referenced by execution runs, send approvals, watcher
 * findings, Workspace drafts, Outreach records, provenance and fact refs — and
 * because sp_node_artifact.node_id is ON DELETE CASCADE, that destroyed the
 * Workspace/Outreach back-links of every node the snapshot omitted and left runs
 * (which hold node_id in findings JSON, no FK) pointing at dead ids.
 *
 * Restore is now "restore AS A NEW VERSION", and it never deletes:
 *  - nodes the snapshot omits are ARCHIVED (sp_node.archived_at), not deleted;
 *  - their artifact relationships are marked DETACHED (sp_node_artifact
 *    .detached_at) and stay discoverable via listDetached();
 *  - the upstream artifacts themselves (ws_draft / outreach_records, owned by
 *    other engines) are never touched;
 *  - a node the snapshot DOES contain but which is currently archived is REVIVED
 *    and its artifacts RE-ATTACH (snapshot node ids are stable);
 *  - provenance is restored from the snapshot when the snapshot carries the key,
 *    and otherwise LEFT ALONE (a pre-P0-1 snapshot has no provenance to restore,
 *    so overwriting would erase grounding added after the snapshot);
 *  - the restore itself is recorded BOTH as a fresh version (history is never
 *    rewritten) and as an applied sp_change_set, which is what makes it show up
 *    in the review queue with a working one-click Undo.
 *
 * restoreImpact() computes the preview from the SAME diff module restore uses,
 * so the preview can never disagree with what the write actually does.
 */
@Injectable()
export class VersionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  async list(tenantId: string, strategyId: string, opts?: { take?: number; cursor?: string }) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const strat = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { id: true },
      });
      if (!strat) throw new NotFoundException('Strategy not found');

      const take = Math.min(Math.max(opts?.take ?? 50, 1), 100);
      const rows = await tx.spVersion.findMany({
        where: { strategyId },
        // id tiebreaker makes the order total so cursor pagination is
        // deterministic even when two versions share a createdAt.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          authorKind: true,
          authorUserId: true,
          note: true,
          restoredFromVersionId: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > take;
      const items = hasMore ? rows.slice(0, take) : rows;
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    });
  }

  // ---- P0-1 impact preview ---------------------------------------------------

  /**
   * What restoring `versionId` WOULD do — the audit's required pre-restore impact
   * preview. Read-only (opens one withTenant tx, writes nothing).
   *
   * Reports, per the audit: nodes added/revived/changed/removed; the Workspace
   * drafts and Outreach records that would be detached (and re-attached);
   * the active and historical execution runs that reference an affected node; and
   * the provenance/fact references at stake.
   */
  async restoreImpact(tenantId: string, strategyId: string, versionId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const version = await tx.spVersion.findFirst({
        where: { id: versionId, strategyId },
        select: {
          id: true,
          note: true,
          createdAt: true,
          authorKind: true,
          authorUserId: true,
          snapshot: true,
        },
      });
      if (!version) throw new NotFoundException('Version not found');
      const snap = version.snapshot as unknown as StrategySnapshot;

      // ALL rows, archived included — that is what separates `revived` from `added`.
      const current = await tx.spNode.findMany({
        where: { strategyId },
        orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
      });
      const diff = diffSnapshotAgainstCurrent(
        (snap.nodes ?? []) as unknown as ImpactSnapshotNode[],
        current as unknown as ImpactCurrentNode[],
      );

      const removedIds = diff.removed.map((n) => n.id);
      const revivedIds = diff.revived.map((n) => n.id);

      // Artifact relationships that would go historical / come back.
      const artifactRows = await tx.spNodeArtifact.findMany({
        where: { strategyId, nodeId: { in: [...removedIds, ...revivedIds] } },
        select: {
          id: true,
          nodeId: true,
          artifactType: true,
          artifactRef: true,
          detachedAt: true,
        },
      });
      const affected = artifactRows.filter((a) => removedIds.includes(a.nodeId));
      const reattaching = artifactRows.filter((a) => revivedIds.includes(a.nodeId));

      // Runs that reference an affected node. sp_agent_run has no node FK — the
      // Execution Agent's idempotencyKey is `exec:<nodeId>:<kind>`, which is the
      // only queryable node linkage, so match on that prefix.
      const runRows = removedIds.length
        ? await tx.spAgentRun.findMany({
            where: {
              strategyId,
              OR: removedIds.map((id) => ({ idempotencyKey: { startsWith: `exec:${id}:` } })),
            },
            select: { id: true, state: true, idempotencyKey: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 100,
          })
        : [];
      const activeRuns = runRows.filter((r) => !TERMINAL_RUN_STATES.has(r.state));

      // Provenance / fact refs on the nodes that would be archived.
      const removedWithProvenance = current.filter(
        (n) => removedIds.includes(n.id) && n.provenance != null,
      );

      return {
        versionId: version.id,
        versionNote: version.note,
        versionCreatedAt: version.createdAt,
        versionAuthorKind: version.authorKind,
        versionAuthorUserId: version.authorUserId,
        noOp: isNoOpRestore(diff),
        nodes: {
          added: diff.added,
          revived: diff.revived,
          changed: diff.changed,
          removed: diff.removed,
          unchangedCount: diff.unchanged.length,
        },
        artifacts: {
          // The audit asks for these two counts by name.
          workspaceDraftsAffected: affected.filter((a) => a.artifactType === 'workspace_draft')
            .length,
          outreachRecordsAffected: affected.filter((a) => a.artifactType === 'outreach_record')
            .length,
          detaching: affected
            .filter((a) => a.detachedAt == null)
            .map((a) => ({
              nodeId: a.nodeId,
              artifactType: a.artifactType,
              artifactRef: a.artifactRef,
            })),
          reattaching: reattaching.map((a) => ({
            nodeId: a.nodeId,
            artifactType: a.artifactType,
            artifactRef: a.artifactRef,
          })),
          // Stated explicitly so the UI can promise it: a restore deletes no artifact.
          deleted: 0,
        },
        runs: {
          active: activeRuns.map((r) => ({
            id: r.id,
            state: r.state,
            nodeId: nodeIdFromExecKey(r.idempotencyKey),
          })),
          activeCount: activeRuns.length,
          historicalCount: runRows.length - activeRuns.length,
        },
        provenance: {
          // Provenance that becomes historical because its node is archived.
          nodesArchivedWithProvenance: removedWithProvenance.length,
          // A snapshot cut before P0-1 carries no provenance key, so restore
          // cannot put grounding back on the nodes it re-creates — surface that
          // rather than silently erasing it.
          snapshotCarriesProvenance: (snap.nodes ?? []).some(
            (n) => (n as unknown as ImpactSnapshotNode).provenance !== undefined,
          ),
          nodesReCreatedWithoutProvenance: diff.added.length,
        },
      };
    });
  }

  /**
   * The detached surface (audit: "Detached artifacts remain discoverable").
   * Archived nodes for a strategy plus their now-historical artifact links.
   */
  async listDetached(tenantId: string, strategyId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const strat = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { id: true },
      });
      if (!strat) throw new NotFoundException('Strategy not found');

      const nodes = await tx.spNode.findMany({
        where: { strategyId, ...ARCHIVED_NODE_WHERE },
        orderBy: [{ archivedAt: 'desc' }, { startsOn: 'asc' }],
        take: 200,
      });
      const artifacts = nodes.length
        ? await tx.spNodeArtifact.findMany({
            where: { strategyId, nodeId: { in: nodes.map((n) => n.id) } },
            orderBy: { createdAt: 'asc' },
          })
        : [];
      return { nodes, artifacts };
    });
  }

  // ---- P0-1 restore ----------------------------------------------------------

  /**
   * Restore a snapshot AS A NEW VERSION. Nothing is deleted: omitted nodes are
   * archived, their artifact links go historical, snapshot nodes are
   * created/revived/updated in place (stable ids), and the operation is recorded
   * as both a version and an applied change-set (giving it a working Undo).
   *
   * One withTenantUser tx: the node writes, the artifact detach/re-attach, the
   * version cut, the change-set row and the audit row all commit together.
   */
  async restore(tenantId: string, clerkUserId: string, strategyId: string, versionId: string) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const version = await tx.spVersion.findFirst({ where: { id: versionId, strategyId } });
      if (!version) throw new NotFoundException('Version not found');
      const snap = version.snapshot as unknown as StrategySnapshot;
      const snapNodes = (snap.nodes ?? []) as unknown as ImpactSnapshotNode[];

      // The head BEFORE this restore — pinned on the change-set below so Undo
      // restores exactly the pre-restore plan.
      const preHead = await tx.spVersion.findFirst({
        where: { strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

      // ALL rows, archived included (separates revive from create).
      const current = await tx.spNode.findMany({ where: { strategyId } });
      const diff = diffSnapshotAgainstCurrent(snapNodes, current as unknown as ImpactCurrentNode[]);
      const currentById = new Map(current.map((n) => [n.id, n]));

      await tx.spStrategy.update({
        where: { id: strategyId },
        data: {
          title: snap.meta.title,
          type: snap.meta.type as SpStrategyType,
          goal: snap.meta.goal,
          meriContext: snap.meta.meriContext,
          meriSummary: snap.meta.meriSummary ?? null,
          targetDate: snap.meta.targetDate ? parseDbDate(snap.meta.targetDate) : null,
          ownerUserId: snap.meta.ownerUserId,
          lastEditedByUserId: clerkUserId,
          lastEditedAt: new Date(),
        },
      });

      const now = new Date();
      const when = new Date(version.createdAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      const archiveReason = `Archived by restore of the ${when} version`;

      // 1. ARCHIVE (never delete) the live nodes the snapshot omits.
      const archivedIds = diff.removed.map((n) => n.id);
      if (archivedIds.length) {
        await tx.spNode.updateMany({
          where: { strategyId, id: { in: archivedIds }, ...LIVE_NODE_WHERE },
          data: {
            archivedAt: now,
            archivedByUserId: clerkUserId,
            archivedReason: archiveReason,
          },
        });
        // Their artifact relationships become HISTORICAL. The upstream drafts /
        // outreach records are NOT touched — only the link is marked detached, and
        // only if it isn't already (so an earlier detach keeps its original stamp).
        await tx.spNodeArtifact.updateMany({
          where: { strategyId, nodeId: { in: archivedIds }, detachedAt: null },
          data: { detachedAt: now, detachedReason: archiveReason },
        });
      }

      // 2. CREATE the snapshot nodes that have no row at all (hard-deleted since).
      const toCreate = diff.added
        .map((ref) => snapNodes.find((n) => n.id === ref.id))
        .filter((n): n is ImpactSnapshotNode => !!n);
      if (toCreate.length) {
        const data: Prisma.SpNodeCreateManyInput[] = toCreate.map((n) => ({
          id: n.id,
          tenantId,
          strategyId,
          kind: n.kind as SpNodeKind,
          subject: n.subject as SpNodeSubject,
          title: n.title,
          note: n.note,
          ownerUserId: n.ownerUserId,
          status: n.status as SpNodeStatus,
          startsOn: parseDbDate(n.startsOn),
          endsOn: n.endsOn ? parseDbDate(n.endsOn) : null,
          openEnded: snapshotOpenEnded(n),
          // `?? []` guards snapshots cut before A2 added the column.
          dependsOnIds: n.dependsOnIds ?? [],
          // Guards snapshots cut before targetRef was added (undefined -> DbNull).
          targetRef: jsonOrDbNull(n.targetRef),
          // A pre-P0-1 snapshot has no provenance key; a re-created node then has
          // no grounding to restore (reported by restoreImpact).
          provenance: jsonOrDbNull(n.provenance),
          meriAuthored: snapshotMeriAuthored(n),
          createdByUserId: snapshotCreatedBy(n) ?? clerkUserId,
          createdAt: snapshotCreatedAt(n) ?? now,
        }));
        await tx.spNode.createMany({ data });
      }

      // 3. REVIVE + 4. UPDATE the snapshot nodes that already have a row. Both are
      // per-row updates (createMany cannot upsert, and updateMany cannot set
      // per-row values), which is fine: a strategy holds tens of nodes.
      const revivedIds = new Set(diff.revived.map((n) => n.id));
      // An `unchanged` node whose PROVENANCE drifted still needs the in-place write
      // (its user-visible fields match, so the diff can't see it) — otherwise
      // "restore puts provenance back" would silently only hold for changed nodes.
      const provenanceOnlyIds = diff.unchanged
        .filter((ref) => {
          const n = snapNodes.find((s) => s.id === ref.id);
          const cur = currentById.get(ref.id);
          return !!n && !!cur && provenanceDiffers(n, cur as unknown as ImpactCurrentNode);
        })
        .map((ref) => ref.id);
      const inPlaceIds = [
        ...diff.revived.map((n) => n.id),
        ...diff.changed.map((n) => n.id),
        ...provenanceOnlyIds,
      ];
      for (const id of inPlaceIds) {
        const n = snapNodes.find((s) => s.id === id);
        const cur = currentById.get(id);
        if (!n || !cur) continue;
        const reviving = revivedIds.has(id);
        await tx.spNode.update({
          where: { id },
          data: {
            kind: n.kind as SpNodeKind,
            subject: n.subject as SpNodeSubject,
            title: n.title,
            note: n.note,
            ownerUserId: n.ownerUserId,
            status: n.status as SpNodeStatus,
            startsOn: parseDbDate(n.startsOn),
            endsOn: n.endsOn ? parseDbDate(n.endsOn) : null,
            openEnded: snapshotOpenEnded(n),
            dependsOnIds: n.dependsOnIds ?? [],
            targetRef: jsonOrDbNull(n.targetRef),
            // KEY-PRESENCE rule: only overwrite provenance when this snapshot
            // actually carries the key. A pre-P0-1 snapshot has no opinion, and
            // blanking it here is exactly the "erase provenance added after the
            // snapshot" defect P0-1 calls out.
            ...(n.provenance !== undefined ? { provenance: jsonOrDbNull(n.provenance) } : {}),
            ...(reviving ? { archivedAt: null, archivedByUserId: null, archivedReason: null } : {}),
          },
        });
      }

      // Revived nodes rejoin the live plan, so their artifact links re-attach.
      if (revivedIds.size) {
        await tx.spNodeArtifact.updateMany({
          where: { strategyId, nodeId: { in: [...revivedIds] } },
          data: { detachedAt: null, detachedReason: null },
        });
      }

      const counts = {
        archived: archivedIds.length,
        created: toCreate.length,
        revived: revivedIds.size,
        updated: diff.changed.length,
        provenanceRestored: provenanceOnlyIds.length,
        unchanged: diff.unchanged.length,
      };

      // 5. The restore is itself a fresh version (history is never rewritten).
      const restoredVersionId = await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: `Restored version from ${when}`,
        coalesce: false,
        restoredFromVersionId: version.id,
      });

      // 6. Record the restore as an APPLIED change-set (audit: "Record the restore
      // as a change set"). Written directly rather than via ChangeSetsService: that
      // service already injects VersionService, so calling back would be a circular
      // dependency. strategyVersionId pins the PRE-restore head, which is what makes
      // ChangeSetsService.undo restore the pre-restore plan; appliedVersionId is the
      // version this restore cut, which satisfies undo's head guard.
      //
      // `ops` is descriptive, NOT a replayable Meri PlanEdit list. That is safe
      // because the row is born 'applied': apply() requires 'approved', reject()
      // requires proposed/approved and refreshProposedOps() requires 'proposed' —
      // so undo() is the only lifecycle action this row can ever take.
      if (preHead) {
        await tx.spChangeSet.create({
          data: {
            tenantId,
            strategyId,
            summary: `Restored version from ${when}`,
            ops: [
              {
                op: 'restore_version',
                restoredFromVersionId: version.id,
                ...counts,
              },
            ] as unknown as Prisma.InputJsonValue,
            // A restore rewrites the whole plan shape — never classify it low.
            risk: 'high',
            status: 'applied',
            strategyVersionId: preHead.id,
            appliedVersionId: restoredVersionId,
            appliedByUserId: clerkUserId,
            appliedAt: now,
            createdByUserId: clerkUserId,
          },
        });
      }

      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'version.restored',
        entityType: 'strategy',
        entityId: strategyId,
        before: { restoredFromVersionId: version.id, restoredFromCreatedAt: when },
        // Who restored what, when, and precisely what it moved — the audit's
        // "activity history records who restored which version and when", plus the
        // non-destructive proof (nothing deleted, artifacts detached not dropped).
        after: {
          restoredVersionId,
          preRestoreVersionId: preHead?.id ?? null,
          ...counts,
          nodesDeleted: 0,
          artifactsDeleted: 0,
        },
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }
}

/** Run states with no outgoing transition (mirrors agents/run-state.ts). */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled']);

/** `exec:<nodeId>:<kind>` -> nodeId, or null for a non-execution run key. */
function nodeIdFromExecKey(key: string): string | null {
  const m = /^exec:([^:]+):/.exec(key);
  return m?.[1] ?? null;
}

/** Prisma needs DbNull (not null) to clear a Json column. */
function jsonOrDbNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return (value ?? null) == null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/*
 * The three helpers below read fields that live on SnapshotNode but not on the
 * narrower ImpactSnapshotNode the diff module works with. Reading them through a
 * cast keeps restore-impact.ts free of fields it does not compare.
 */
function snapshotOpenEnded(n: ImpactSnapshotNode): boolean {
  return !!(n as unknown as { openEnded?: boolean }).openEnded;
}
function snapshotMeriAuthored(n: ImpactSnapshotNode): boolean {
  return !!(n as unknown as { meriAuthored?: boolean }).meriAuthored;
}
function snapshotCreatedBy(n: ImpactSnapshotNode): string | null {
  return (n as unknown as { createdByUserId?: string }).createdByUserId ?? null;
}
function snapshotCreatedAt(n: ImpactSnapshotNode): Date | null {
  const raw = (n as unknown as { createdAt?: string }).createdAt;
  return raw ? new Date(raw) : null;
}
