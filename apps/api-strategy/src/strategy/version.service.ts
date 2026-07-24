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
import type { StrategySnapshot } from './versioning.js';

/**
 * Version history (HIS). List returns metadata only (no heavy snapshots);
 * restore replaces the strategy's meta+nodes from a snapshot and itself cuts a
 * fresh version (history is never rewritten). Node ids from the snapshot are
 * preserved so deep-links / artifact identity survive a restore.
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

  async restore(tenantId: string, clerkUserId: string, strategyId: string, versionId: string) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const version = await tx.spVersion.findFirst({ where: { id: versionId, strategyId } });
      if (!version) throw new NotFoundException('Version not found');
      const snap = version.snapshot as unknown as StrategySnapshot;

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

      // Replace the node set from the snapshot (cascade drops any node artifacts;
      // artifact re-link is a routing-phase concern, G6).
      await tx.spNode.deleteMany({ where: { strategyId } });
      if (snap.nodes.length) {
        const data: Prisma.SpNodeCreateManyInput[] = snap.nodes.map((n) => ({
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
          openEnded: n.openEnded,
          // `?? []` guards snapshots cut before A2 added the column.
          dependsOnIds: n.dependsOnIds ?? [],
          meriAuthored: n.meriAuthored,
          createdByUserId: n.createdByUserId ?? clerkUserId,
          createdAt: n.createdAt ? new Date(n.createdAt) : new Date(),
        }));
        await tx.spNode.createMany({ data });
      }

      const when = new Date(version.createdAt).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: `Restored version from ${when}`,
        coalesce: false,
        restoredFromVersionId: version.id,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'version.restored',
        entityType: 'strategy',
        entityId: strategyId,
        before: { restoredFromVersionId: version.id, restoredFromCreatedAt: when },
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }
}
