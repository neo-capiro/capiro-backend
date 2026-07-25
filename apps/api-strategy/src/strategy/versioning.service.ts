import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { buildSnapshot, isCoalescible, type StrategySnapshot } from './versioning.js';
import { LIVE_NODE_WHERE } from './live-node.js';

type Tx = Prisma.TransactionClient;
type AuthorKind = 'person' | 'meri';

/**
 * Centralizes the version + activity-log writes so every mutation path
 * (node CRUD, strategy patch, restore, and later the Meri assistant) records
 * history identically. Every method takes the caller's `withTenant(User)` tx so
 * the mutation, its version, and its audit row commit atomically.
 */
@Injectable()
export class VersioningService {
  /**
   * Read the current strategy+nodes and build the snapshot JSON.
   *
   * P0-1: LIVE nodes only. A node archived by a non-destructive restore must never
   * re-enter a version snapshot — if it did, the next restore of that version would
   * resurrect it into the live plan, and the archive would silently undo itself.
   */
  async snapshot(tx: Tx, strategyId: string): Promise<StrategySnapshot> {
    const s = await tx.spStrategy.findFirstOrThrow({
      where: { id: strategyId },
      include: {
        nodes: {
          where: { ...LIVE_NODE_WHERE },
          orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    return buildSnapshot(s, s.nodes);
  }

  /**
   * Cut (or coalesce) a version capturing the CURRENT post-mutation state.
   * Returns the version id. Person field-edits with `coalesce:true` fold into
   * the latest eligible version (autosave); everything else cuts fresh.
   */
  async cutVersion(
    tx: Tx,
    opts: {
      tenantId: string;
      strategyId: string;
      authorKind: AuthorKind;
      authorUserId: string | null;
      note: string;
      coalesce: boolean;
      restoredFromVersionId?: string | null;
    },
  ): Promise<string> {
    const snapshot = (await this.snapshot(tx, opts.strategyId)) as unknown as Prisma.InputJsonValue;
    const now = new Date();

    if (opts.coalesce && opts.authorKind === 'person') {
      const latest = await tx.spVersion.findFirst({
        where: { strategyId: opts.strategyId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          authorKind: true,
          authorUserId: true,
          restoredFromVersionId: true,
          coalescible: true,
          createdAt: true,
        },
      });
      if (isCoalescible(latest, { authorUserId: opts.authorUserId, nowMs: now.getTime() })) {
        // Fold the newest state + note into the existing row and slide its
        // timestamp forward so the window tracks the latest keystroke burst.
        // coalescible:true is re-checked AT WRITE TIME (not just in the read
        // above): ChangeSetsService.create SEALS the pinned head by flipping
        // coalescible off, and under READ COMMITTED this predicate is
        // re-evaluated after any lock wait — so a fold racing the seal matches
        // 0 rows and falls through to cut a fresh version (head id moves and
        // apply's staleness check fires) instead of silently rewriting the
        // pinned snapshot in place.
        const folded = await tx.spVersion.updateMany({
          where: { id: latest!.id, coalescible: true },
          data: { snapshot, note: opts.note, createdAt: now },
        });
        if (folded.count === 1) return latest!.id;
      }
    }

    const created = await tx.spVersion.create({
      data: {
        tenantId: opts.tenantId,
        strategyId: opts.strategyId,
        snapshot,
        authorKind: opts.authorKind,
        authorUserId: opts.authorUserId,
        note: opts.note,
        restoredFromVersionId: opts.restoredFromVersionId ?? null,
        // Only field-edit batches (coalesce:true) are valid future fold targets;
        // adds/deletes/creates/restores/Meri versions stand alone in history.
        coalescible: opts.coalesce && opts.authorKind === 'person',
        // Stamp from the app clock (same source as the coalesce-window check),
        // so the fold decision never depends on app-vs-DB clock skew.
        createdAt: now,
      },
    });
    return created.id;
  }

  /**
   * Append an audit row (sp_activity_log is INSERT-only via DB trigger).
   *
   * Stage C transactional-outbox choke point: every mutation path already
   * flows through logActivity inside its own withTenant(User) tx, so emitting
   * the sp_event_outbox row HERE means every bump site emits by construction —
   * atomically with the mutation it describes. The write is unconditional (do
   * not soften it with optional chaining); the F2 Watcher consumer filters by
   * `type` and marks consumed_at.
   */
  async logActivity(
    tx: Tx,
    opts: {
      tenantId: string;
      actorUserId: string | null;
      authorKind: AuthorKind;
      action: string;
      entityType: string;
      entityId: string;
      /**
       * Optional explicit strategy for the OUTBOX payload only (not the
       * activity row). Required for events whose entity can't be resolved to a
       * strategy at drain time — e.g. node.deleted, where the sp_node row is
       * deleted in this same tx, so the F2 consumer's node -> strategy lookup
       * finds nothing.
       */
      strategyId?: string;
      before?: unknown;
      after?: unknown;
      requestId?: string | null;
    },
  ): Promise<void> {
    await tx.spActivityLog.create({
      data: {
        tenantId: opts.tenantId,
        actorUserId: opts.actorUserId,
        authorKind: opts.authorKind,
        action: opts.action,
        entityType: opts.entityType,
        entityId: opts.entityId,
        before:
          opts.before === undefined ? undefined : (opts.before as Prisma.InputJsonValue),
        after: opts.after === undefined ? undefined : (opts.after as Prisma.InputJsonValue),
        requestId: opts.requestId ?? null,
      },
    });
    await tx.spEventOutbox.create({
      data: {
        tenantId: opts.tenantId,
        type: opts.action,
        payload: {
          entityType: opts.entityType,
          entityId: opts.entityId,
          // Only present when the caller supplied it — keeps every other
          // event's payload shape unchanged.
          ...(opts.strategyId ? { strategyId: opts.strategyId } : {}),
          actorUserId: opts.actorUserId,
          authorKind: opts.authorKind,
          requestId: opts.requestId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }
}
