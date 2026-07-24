import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from './versioning.service.js';
import { parseDbDate } from './dates.js';
import { loadStrategyDetail } from './detail.js';
import type { CreateNodeDto, UpdateNodeDto } from './dto/node.dto.js';
import type { CreateArtifactDto } from './dto/artifact.dto.js';

/**
 * Node CRUD (G3). Each mutation runs in ONE withTenantUser tx so the node
 * write, the strategy lastEdited bump, the version, and the audit row commit
 * atomically. Adds/deletes cut a fresh version; field updates coalesce per the
 * versioning policy. All node identity is verified node∈strategy∈tenant before
 * mutating (the query hook adds tenantId; the strategyId check adds ownership).
 */
@Injectable()
export class NodeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  async add(tenantId: string, clerkUserId: string, strategyId: string, dto: CreateNodeDto) {
    const startsOn = parseDbDate(dto.startsOn, 'startsOn');
    const endsOn = dto.endsOn ? parseDbDate(dto.endsOn, 'endsOn') : null;
    if (endsOn && endsOn < startsOn) {
      throw new BadRequestException('endsOn must be on or after startsOn');
    }

    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const strat = await tx.spStrategy.findFirst({
        where: { id: strategyId },
        select: { id: true },
      });
      if (!strat) throw new NotFoundException('Strategy not found');

      const dependsOnIds = await this.resolveDependsOn(tx, strategyId, null, dto.dependsOnIds);

      const node = await tx.spNode.create({
        data: {
          tenantId,
          strategyId,
          kind: dto.kind,
          subject: dto.subject,
          title: dto.title,
          note: dto.note ?? null,
          ownerUserId: dto.ownerUserId ?? null,
          status: dto.status ?? 'draft',
          startsOn,
          endsOn,
          // "Ongoing" is a risk-only concept — never set it for other kinds.
          openEnded: dto.kind === 'risk' ? (dto.openEnded ?? false) : false,
          dependsOnIds: dependsOnIds ?? [],
          targetRef: dto.targetRef ? { ...dto.targetRef } : undefined,
          meriAuthored: false,
          createdByUserId: clerkUserId,
        },
      });
      await this.bump(tx, strategyId, clerkUserId);
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: `Added ${node.title}`,
        coalesce: false,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'node.created',
        entityType: 'node',
        entityId: node.id,
        after: { title: node.title, kind: node.kind, subject: node.subject },
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }

  async update(
    tenantId: string,
    clerkUserId: string,
    strategyId: string,
    nodeId: string,
    dto: UpdateNodeDto,
  ) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const node = await tx.spNode.findFirst({ where: { id: nodeId, strategyId } });
      if (!node) throw new NotFoundException('Node not found');

      // Cross-validate the (possibly partial) date change against current state.
      const newStarts = dto.startsOn !== undefined ? parseDbDate(dto.startsOn, 'startsOn') : node.startsOn;
      let newEnds: Date | null = node.endsOn;
      if (dto.endsOn !== undefined) {
        newEnds = dto.endsOn === null ? null : parseDbDate(dto.endsOn, 'endsOn');
      }
      if (newEnds && newEnds < newStarts) {
        throw new BadRequestException('endsOn must be on or after startsOn');
      }

      const dependsOnIds = await this.resolveDependsOn(tx, strategyId, nodeId, dto.dependsOnIds);

      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const set = <T>(key: keyof UpdateNodeDto, value: T, prev: T) => {
        data[key as string] = value;
        before[key as string] = prev;
      };
      if (dto.kind !== undefined) set('kind', dto.kind, node.kind);
      if (dto.subject !== undefined) set('subject', dto.subject, node.subject);
      if (dto.title !== undefined) set('title', dto.title, node.title);
      if (dto.note !== undefined) set('note', dto.note, node.note);
      if (dto.ownerUserId !== undefined) set('ownerUserId', dto.ownerUserId, node.ownerUserId);
      if (dto.status !== undefined) set('status', dto.status, node.status);
      if (dto.startsOn !== undefined) set('startsOn', newStarts, node.startsOn);
      if (dto.endsOn !== undefined) set('endsOn', newEnds, node.endsOn);
      if (dto.openEnded !== undefined) set('openEnded', dto.openEnded, node.openEnded);
      if (dto.dependsOnIds !== undefined) set('dependsOnIds', dependsOnIds ?? [], node.dependsOnIds);
      if (dto.targetRef !== undefined) {
        set(
          'targetRef',
          dto.targetRef ? ({ ...dto.targetRef } as Prisma.InputJsonValue) : Prisma.DbNull,
          node.targetRef,
        );
      }

      // "Ongoing" is risk-only: converting a node away from risk clears the flag
      // so it isn't stuck "Ongoing" with a permanently-disabled end date.
      const resultingKind = dto.kind ?? node.kind;
      if (resultingKind !== 'risk' && node.openEnded && data.openEnded === undefined) {
        set('openEnded', false, node.openEnded);
      }

      if (Object.keys(data).length === 0) {
        // No field changes (e.g. only changeNote sent) — no version churn.
        return loadStrategyDetail(tx, strategyId);
      }

      await tx.spNode.update({ where: { id: nodeId }, data: data as Prisma.SpNodeUpdateInput });
      await this.bump(tx, strategyId, clerkUserId);
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note: dto.changeNote?.trim() || `Updated ${dto.title ?? node.title}`,
        coalesce: true,
      });
      // Prisma.DbNull is only meaningful as the DIRECT value of a Json-typed
      // Prisma field (the spNode.update call above) — nested inside the
      // activity log's `after` snapshot (itself a Json blob) it would not
      // serialize as a clean null. Swap it for a plain null in the audit copy
      // (mirrors meri.service.ts's own provenance-clearing convention).
      const auditAfter =
        data.targetRef === Prisma.DbNull ? { ...data, targetRef: null } : data;
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'node.updated',
        entityType: 'node',
        entityId: nodeId,
        before,
        after: auditAfter,
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }

  async remove(tenantId: string, clerkUserId: string, strategyId: string, nodeId: string) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const node = await tx.spNode.findFirst({ where: { id: nodeId, strategyId } });
      if (!node) throw new NotFoundException('Node not found');

      await tx.spNode.delete({ where: { id: nodeId } });
      // A2: strip the deleted id from every sibling's dependency edges, in the
      // same tx and BEFORE the snapshot. Raw UPDATE (Prisma has no atomic
      // scalar-list remove); capiro_app bypasses RLS, so the tenant filter is
      // explicit and load-bearing.
      const unlinked = await tx.$executeRaw`
        UPDATE sp_node
           SET depends_on_ids = array_remove(depends_on_ids, ${nodeId}::uuid)
         WHERE strategy_id = ${strategyId}::uuid
           AND tenant_id = ${tenantId}::uuid
           AND ${nodeId}::uuid = ANY (depends_on_ids)`;
      await this.bump(tx, strategyId, clerkUserId);
      await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId,
        authorKind: 'person',
        authorUserId: clerkUserId,
        note:
          unlinked > 0
            ? `Deleted ${node.title} (unlinked from ${unlinked} step${unlinked === 1 ? '' : 's'})`
            : `Deleted ${node.title}`,
        coalesce: false,
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'node.deleted',
        entityType: 'node',
        entityId: nodeId,
        // The sp_node row was deleted above IN THIS TX, so the F2 outbox
        // consumer's node -> strategy resolution finds nothing at drain time;
        // carry the strategy explicitly so node.deleted actually wakes the
        // strategy's watcher missions within one poll.
        strategyId,
        before: { title: node.title, kind: node.kind },
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }

  /**
   * RTE-3: record a node -> Capiro artifact back-link (Workspace draft / Outreach
   * record). Idempotent on the unique [nodeId, artifactType, artifactRef] triple
   * so re-routing to the same artifact never duplicates. Artifacts are NOT part of
   * the version snapshot (restore deliberately drops them), so this cuts NO version
   * and does NOT bump lastEdited — a routing side effect must not churn the library
   * ordering or the audit-restore surface.
   */
  async linkArtifact(
    tenantId: string,
    clerkUserId: string,
    strategyId: string,
    nodeId: string,
    dto: CreateArtifactDto,
  ) {
    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const node = await tx.spNode.findFirst({
        where: { id: nodeId, strategyId },
        select: { id: true },
      });
      if (!node) throw new NotFoundException('Node not found');

      await tx.spNodeArtifact.upsert({
        where: {
          nodeId_artifactType_artifactRef: {
            nodeId,
            artifactType: dto.artifactType,
            artifactRef: dto.artifactRef,
          },
        },
        // The query hook scopes upsert.where but NOT the create branch, so every
        // scalar (esp. tenantId) MUST be set explicitly here (prisma.service RLS note).
        create: {
          tenantId,
          strategyId,
          nodeId,
          artifactType: dto.artifactType,
          artifactRef: dto.artifactRef,
          createdByUserId: clerkUserId,
        },
        update: {},
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: clerkUserId,
        authorKind: 'person',
        action: 'artifact.linked',
        entityType: 'node',
        entityId: nodeId,
        after: { artifactType: dto.artifactType, artifactRef: dto.artifactRef },
      });
      return loadStrategyDetail(tx, strategyId);
    });
  }

  /**
   * A2: validate + normalize an incoming dependency-edge set. Dedupes, rejects a
   * self-reference, and rejects any id that isn't a node in THIS strategy
   * (referential integrity — a dangling edge is invalid data). Cycles are NOT
   * blocked here: manual edits are advisory-only, so a cycle surfaces as a
   * verifier warning (A6), never a hard block. Returns undefined when the field
   * was absent (leave the column untouched).
   */
  private async resolveDependsOn(
    tx: Prisma.TransactionClient,
    strategyId: string,
    selfId: string | null,
    dependsOnIds: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (dependsOnIds === undefined) return undefined;
    const unique = [...new Set(dependsOnIds)];
    if (selfId && unique.includes(selfId)) {
      throw new BadRequestException('A step cannot depend on itself');
    }
    if (unique.length === 0) return [];
    const rows = await tx.spNode.findMany({
      where: { strategyId, id: { in: unique } },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(`Unknown dependency step(s): ${missing.join(', ')}`);
    }
    return unique;
  }

  private async bump(
    tx: Parameters<typeof loadStrategyDetail>[0],
    strategyId: string,
    clerkUserId: string,
  ) {
    await tx.spStrategy.update({
      where: { id: strategyId },
      data: { lastEditedByUserId: clerkUserId, lastEditedAt: new Date() },
    });
  }
}
