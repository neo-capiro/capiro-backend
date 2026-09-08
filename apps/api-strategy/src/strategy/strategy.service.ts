import {
  BadRequestException,
  ConflictException,
  Injectable,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from './versioning.service.js';
import { parseDbDate } from './dates.js';
import { loadStrategyDetail } from './detail.js';
import { ATTACHED_ARTIFACT_WHERE, LIVE_NODE_WHERE } from './live-node.js';
import { lockStrategyForMutation } from './mutation-lock.js';
import type { CreateStrategyDto, StrategyTypeValue } from './dto/create-strategy.dto.js';
import type { PatchStrategyDto } from './dto/patch-strategy.dto.js';

/**
 * Strategy read + manual-create + meta-patch. All access goes through
 * withTenant / withTenantUser (the query hook injects where.tenantId). Node
 * CRUD lives in NodeService; history/restore in VersionService; the Meri
 * assistant arrives in G5.
 */
@Injectable()
export class StrategyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  /** Library list projection: active (non-archived) strategies, newest-edited first. */
  async list(tenantId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findMany({
        where: { archivedAt: null },
        orderBy: [{ lastEditedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          clientId: true,
          title: true,
          type: true,
          ownerUserId: true,
          createdByUserId: true,
          lastEditedByUserId: true,
          lastEditedAt: true,
          createdAt: true,
          updatedAt: true,
          // P0-1: count the LIVE plan only — a node archived by a non-destructive
          // restore must not inflate the library's step count.
          _count: { select: { nodes: { where: { ...LIVE_NODE_WHERE } } } },
          nodes: { where: { ...LIVE_NODE_WHERE }, select: { ownerUserId: true, status: true } },
        },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      title: r.title,
      type: r.type,
      ownerUserId: r.ownerUserId,
      createdByUserId: r.createdByUserId,
      lastEditedByUserId: r.lastEditedByUserId,
      lastEditedAt: r.lastEditedAt,
      createdAt: r.createdAt,
      nodeCount: r._count.nodes,
      summary: {
        assignedCount: r.nodes.filter((node) => Boolean(node.ownerUserId)).length,
        unassignedCount: r.nodes.filter((node) => !node.ownerUserId && node.status !== 'completed').length,
        completedCount: r.nodes.filter((node) => node.status === 'completed').length,
        reviewCount: r.nodes.filter((node) => ['draft', 'internal_review', 'suggested'].includes(node.status)).length,
      },
    }));
  }

  /** Editor payload: strategy meta + its nodes + artifact back-links. */
  async byId(tenantId: string, id: string) {
    const strategy = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id },
        include: {
          // P0-1: live plan only (archived nodes live on the detached surface).
          nodes: { where: { ...LIVE_NODE_WHERE }, orderBy: { startsOn: 'asc' } },
          artifacts: { where: { ...ATTACHED_ARTIFACT_WHERE } },
        },
      }),
    );
    if (!strategy) {
      throw new NotFoundException('Strategy not found');
    }
    if (strategy.archivedAt) throw new GoneException({ statusCode: 410, message: 'This strategy is archived and is retained as history. Choose an active strategy or review its saved versions.', strategyId: strategy.id, title: strategy.title });
    return strategy;
  }

  /** Manual create: empty strategy + version 1 + an attributed activity-log row, in one tx. */
  async create(tenantId: string, clerkUserId: string, dto: CreateStrategyDto) {
    const owner = dto.ownerUserId?.trim() || clerkUserId;
    const title = deriveTitle(dto);
    const targetDate = dto.targetDate ? parseDbDate(dto.targetDate, 'targetDate') : null;

    // clientId is a cross-schema reference (no FK); validate it belongs to the
    // caller's tenant so a strategy can't be created against a foreign client id.
    // capiro_app is NOT RLS-bypass on `clients`, so this must run inside
    // withTenant (sets app.current_tenant) or the clients RLS filters every row
    // and the check false-negatives ("Unknown client") for a valid client. The
    // explicit tenant_id predicate is defense-in-depth alongside the RLS scope.
    const clientRows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`,
    );
    if (clientRows.length === 0) {
      throw new BadRequestException('Unknown client for this tenant');
    }

    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const strategy = await tx.spStrategy.create({
        data: {
          tenantId,
          clientId: dto.clientId,
          title,
          type: dto.type,
          goal: dto.goal?.trim() || null,
          meriContext: dto.meriContext?.trim() || null,
          targetDate,
          ownerUserId: owner,
          createdByUserId: clerkUserId,
          lastEditedByUserId: clerkUserId,
          lastEditedAt: new Date(),
        },
        include: { nodes: true, artifacts: true },
      });
      await tx.spActivityLog.create({
        data: {
          tenantId,
          actorUserId: clerkUserId,
          authorKind: 'person',
          action: 'strategy.created',
          entityType: 'strategy',
          entityId: strategy.id,
          after: { title: strategy.title, type: strategy.type, clientId: strategy.clientId },
        },
      });
      // Version 1 — the empty (or, in G5, Meri-drafted) baseline the history
      // and restore paths anchor on.
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId: strategy.id,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: 'Created strategy',
        coalesce: false,
      });
      return strategy;
    });
  }

  /** Strategy meta edit (title/type/owner/targetDate/goal/meriContext). */
  async patchMeta(
    tenantId: string,
    clerkUserId: string,
    strategyId: string,
    dto: PatchStrategyDto,
  ) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      await lockStrategyForMutation(tx, tenantId, strategyId);
      const strat = await tx.spStrategy.findFirst({ where: { id: strategyId } });
      if (!strat) throw new NotFoundException('Strategy not found');

      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const set = (key: string, value: unknown, prev: unknown) => {
        data[key] = value;
        before[key] = prev;
      };
      if (dto.title !== undefined) set('title', dto.title, strat.title);
      if (dto.type !== undefined) set('type', dto.type, strat.type);
      if (dto.goal !== undefined) set('goal', dto.goal, strat.goal);
      if (dto.meriContext !== undefined) set('meriContext', dto.meriContext, strat.meriContext);
      if (dto.targetDate !== undefined) {
        set(
          'targetDate',
          dto.targetDate === null ? null : parseDbDate(dto.targetDate, 'targetDate'),
          strat.targetDate,
        );
      }
      if (dto.ownerUserId !== undefined) set('ownerUserId', dto.ownerUserId, strat.ownerUserId);

      if (Object.keys(data).length === 0) {
        return loadStrategyDetail(tx, strategyId);
      }
      data.lastEditedByUserId = clerkUserId;
      data.lastEditedAt = new Date();
      await tx.spStrategy.update({
        where: { id: strategyId },
        data: data as Prisma.SpStrategyUpdateInput,
      });
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: dto.changeNote?.trim() || 'Updated strategy details',
        coalesce: true,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'strategy.updated',
        entityType: 'strategy',
        entityId: strategyId,
        before,
        after: data,
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }

  /**
   * Delete a strategy from the library.
   *
   * NON-DESTRUCTIVE by the same rule that governs node removal and version
   * restore (P0-1): the row is stamped `archivedAt` rather than dropped, so
   * version history, applied change-sets, agent runs, conversations and the
   * Workspace/Outreach artifact back-links that reference it all stay
   * resolvable. `list()` already filters `archivedAt: null`, so the strategy
   * leaves the library immediately.
   *
   * Idempotent-safe: a second delete of the same strategy 409s rather than
   * silently re-stamping, so a double-click cannot rewrite the audit timestamp.
   */
  async archive(tenantId: string, clerkUserId: string, strategyId: string) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      await lockStrategyForMutation(tx, tenantId, strategyId);
      const strat = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { id: true, title: true, archivedAt: true },
      });
      if (!strat) throw new NotFoundException('Strategy not found');
      if (strat.archivedAt) {
        throw new ConflictException('Strategy is already deleted');
      }

      const archivedAt = new Date();
      await tx.spStrategy.update({
        where: { id: strategyId },
        data: { archivedAt, lastEditedByUserId: clerkUserId, lastEditedAt: archivedAt },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'strategy.archived',
        entityType: 'strategy',
        entityId: strategyId,
        // The entity is still resolvable, but pass it explicitly for parity with
        // node.deleted so the outbox payload never depends on a live lookup.
        strategyId,
        before: { archivedAt: null },
        after: { archivedAt: archivedAt.toISOString() },
      });
      return { id: strategyId, archivedAt: archivedAt.toISOString() };
    });
  }
}

/** Manual create has no title field; derive one from the goal, else a default. */
function deriveTitle(dto: CreateStrategyDto): string {
  const explicit = dto.title?.trim();
  if (explicit) return explicit;
  const goal = dto.goal?.trim();
  if (goal) return goal.length > 120 ? `${goal.slice(0, 117)}…` : goal;
  return `${labelForType(dto.type)} strategy`;
}

function labelForType(type: StrategyTypeValue): string {
  const map: Record<StrategyTypeValue, string> = {
    appropriations: 'Appropriations',
    authorization: 'Authorization',
    regulatory: 'Regulatory / policy',
    coalition: 'Coalition / positioning',
    procurement: 'Contract / procurement',
    earmark: 'Grant / earmark',
  };
  return map[type];
}
