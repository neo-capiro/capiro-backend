import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SpChangeSetStatus } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { VersionService } from '../strategy/version.service.js';
import { MeriService } from '../meri/meri.service.js';
import type { PlanEdit } from '../meri/meri.types.js';
import type { ApproveChangeSetDto, CreateChangeSetDto } from './dto/agents.dto.js';

/**
 * ChangeSet lifecycle (Stage C): proposed -> approved -> applied -> undone,
 * with reject (from proposed/approved) and stale (head moved before apply).
 * Ops reuse the Meri assistant PlanEdit shape and are re-validated op-by-op on
 * APPLY through MeriService.applyEditSet — the SAME pipeline the assistant
 * uses, so a malformed op rolls the whole apply back. strategyVersionId pins
 * the version head the proposal was computed against; undo restores exactly
 * that pinned pre-apply snapshot via the existing VersionService.restore path.
 */
@Injectable()
export class ChangeSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
    private readonly versions: VersionService,
    private readonly meri: MeriService,
  ) {}

  /** Latest version head for a strategy (total order: createdAt desc, id desc). */
  private headOf(tx: Prisma.TransactionClient, strategyId: string) {
    return tx.spVersion.findFirst({
      where: { strategyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
  }

  async create(tenantId: string, userId: string | null, dto: CreateChangeSetDto) {
    const run = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      userId
        ? this.prisma.withTenantUser(tenantId, userId, fn)
        : this.prisma.withTenant(tenantId, fn);
    return run(async (tx) => {
      const strat = await tx.spStrategy.findFirst({
        where: { id: dto.strategyId },
        select: { id: true },
      });
      if (!strat) throw new BadRequestException('Unknown strategy for this tenant');

      // SpChangeSet.runId has no FK — tenant-scoped existence check (the query
      // hook injects tenantId) so a proposal can't claim provenance from
      // another tenant's / a nonexistent run (mirrors the strategyId check).
      if (dto.runId) {
        const runRow = await tx.spAgentRun.findFirst({
          where: { id: dto.runId },
          select: { id: true },
        });
        if (!runRow) throw new BadRequestException('Unknown run for this tenant');
      }

      // Pin the head this proposal was computed against (every strategy gets a
      // v1 at create/draft time, so an empty history is a data problem).
      const head = await this.headOf(tx, dto.strategyId);
      if (!head) throw new BadRequestException('strategy has no version history');

      // Apply's staleness check watches head.id — but a COALESCIBLE head is
      // rewritten IN PLACE by the same author's next autosave inside the
      // coalesce window (cutVersion folds into latest.id: same id, snapshot
      // overwritten, createdAt slid forward), so the plan could materially
      // change under this pin without the head id ever moving and apply would
      // replay ops computed against stale content with no 409. SEAL the pinned
      // head: flip coalescible off so every subsequent edit cuts a FRESH
      // version and the head-id check fires. (cutVersion's fold re-checks
      // coalescible at write time, so a concurrent fold can't slip past the
      // seal.)
      const sealed = await tx.spVersion.updateMany({
        where: { id: head.id, coalescible: true },
        data: { coalescible: false },
      });

      const cs = await tx.spChangeSet.create({
        data: {
          tenantId,
          strategyId: dto.strategyId,
          runId: dto.runId ?? null,
          summary: dto.summary,
          ops: dto.ops as Prisma.InputJsonValue,
          risk: dto.risk,
          status: 'proposed',
          strategyVersionId: head.id,
          createdByUserId: userId,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action: 'changeset.proposed',
        entityType: 'change_set',
        entityId: cs.id,
        after: {
          strategyId: dto.strategyId,
          summary: dto.summary,
          risk: dto.risk,
          opCount: dto.ops.length,
          // Audit the seal (the sp_version write above) in the same tx/row.
          pinnedHeadSealed: sealed.count > 0,
        },
      });
      return cs;
    });
  }

  async list(tenantId: string, opts: { strategyId?: string; status?: string } = {}) {
    // ?status= is raw client input — validate against the enum here so a bogus
    // value 400s instead of surfacing as a PrismaClientValidationError 500.
    if (opts.status && !(Object.values(SpChangeSetStatus) as string[]).includes(opts.status)) {
      throw new BadRequestException(
        `Invalid status '${opts.status}' — expected one of: ${Object.values(SpChangeSetStatus).join(', ')}`,
      );
    }
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spChangeSet.findMany({
        where: {
          ...(opts.strategyId ? { strategyId: opts.strategyId } : {}),
          ...(opts.status ? { status: opts.status as SpChangeSetStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async get(tenantId: string, id: string) {
    const cs = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spChangeSet.findFirst({ where: { id } }),
    );
    if (!cs) throw new NotFoundException('Change-set not found');
    return cs;
  }

  async approve(tenantId: string, userId: string, id: string, dto: ApproveChangeSetDto) {
    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const cs = await tx.spChangeSet.findFirst({ where: { id } });
      if (!cs) throw new NotFoundException('Change-set not found');
      if (cs.status !== 'proposed') {
        throw new ConflictException(`Change-set is ${cs.status} — only a proposed change-set can be approved`);
      }

      // Selective approval: opIndexes are indexes into ops; the stored
      // approvedOps SUBSET (deduped, in original ops order) is what apply replays.
      // An EMPTY subset is rejected up front: approving zero ops would make
      // apply a no-op that still bumps lastEdited, cuts a redundant version and
      // stamps 'applied' — reject the change-set instead of approving nothing.
      let approvedOps: Prisma.InputJsonValue | undefined;
      if (dto.opIndexes !== undefined) {
        if (dto.opIndexes.length === 0) {
          throw new BadRequestException(
            'opIndexes must select at least one op — reject the change-set instead of approving an empty subset',
          );
        }
        const ops = Array.isArray(cs.ops) ? (cs.ops as unknown[]) : [];
        for (const idx of dto.opIndexes) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= ops.length) {
            throw new BadRequestException(`opIndexes contains an out-of-range index: ${idx}`);
          }
        }
        const unique = [...new Set(dto.opIndexes)].sort((a, b) => a - b);
        approvedOps = unique.map((i) => ops[i]) as Prisma.InputJsonValue;
      }

      const updated = await tx.spChangeSet.update({
        where: { id },
        data: {
          status: 'approved',
          approvedByUserId: userId,
          approvedAt: new Date(),
          ...(approvedOps !== undefined ? { approvedOps } : {}),
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'changeset.approved',
        entityType: 'change_set',
        entityId: id,
        after: { opIndexes: dto.opIndexes ?? null },
      });
      return updated;
    });
  }

  async reject(tenantId: string, userId: string, id: string) {
    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const cs = await tx.spChangeSet.findFirst({ where: { id } });
      if (!cs) throw new NotFoundException('Change-set not found');
      if (cs.status !== 'proposed' && cs.status !== 'approved') {
        throw new ConflictException(`Change-set is ${cs.status} — only proposed/approved can be rejected`);
      }
      const updated = await tx.spChangeSet.update({
        where: { id },
        data: { status: 'rejected', rejectedByUserId: userId, rejectedAt: new Date() },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'changeset.rejected',
        entityType: 'change_set',
        entityId: id,
        before: { status: cs.status },
      });
      return updated;
    });
  }

  /**
   * Apply an approved change-set: ONE withTenantUser tx replays the ops
   * (approvedOps subset if selective, else all) through the Meri assistant
   * pipeline, bumps lastEdited, cuts ONE meri version, stamps applied and runs
   * the assistant's A6 plan verifier (STRATEGY_VERIFY_BLOCK errors 422 and roll
   * the whole tx back; the outcome is logged as plan.verified either way).
   * If the version head moved since the proposal was pinned, the change-set is
   * marked stale (that status write COMMITS — it happens inside the tx and the
   * 409 is thrown after) and a ConflictException tells the caller to regenerate.
   */
  async apply(tenantId: string, userId: string, id: string) {
    // A6 grounding (fiscal window + firm phases + reference calendars) for the
    // post-apply verifier — fetched BEFORE the tx opens (same as the assistant
    // path): grounding reads run their own withTenant txs, and nesting them
    // inside the apply tx would hold two pool connections.
    const ground = await this.meri.grounding(tenantId);
    const result = await this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      // Row-lock the change-set BEFORE the status read. Plain READ COMMITTED
      // reads don't serialize: two concurrent applies of the SAME change-set
      // would both see 'approved' and replay the ops twice. The loser blocks
      // here until the winner commits, then its status read (fresh statement
      // snapshot) sees 'applied' -> 409. Raw SQL bypasses both the tenant-scope
      // injection and RLS (capiro_app), hence the explicit tenant_id predicate.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sp_change_set
        WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('Change-set not found');

      const cs = await tx.spChangeSet.findFirst({ where: { id } });
      if (!cs) throw new NotFoundException('Change-set not found');
      if (cs.status !== 'approved') {
        throw new ConflictException(`Change-set is ${cs.status} — approve it before applying`);
      }

      // Strategy-level ordering lock BEFORE headOf. Two DIFFERENT approved
      // change-sets pinned to the same head can't see each other's uncommitted
      // spVersion, so both would pass the stale check and the second would
      // apply onto a plan the first already mutated. The loser acquires this
      // lock only after the winner commits, so its headOf sees the new version
      // and takes the stale/409 path instead. Lock order is always
      // change-set -> strategy, so concurrent applies cannot deadlock.
      await tx.$queryRaw`
        SELECT id FROM sp_strategy
        WHERE id = ${cs.strategyId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;

      const head = await this.headOf(tx, cs.strategyId);
      if (!head || head.id !== cs.strategyVersionId) {
        // Head moved since the proposal was computed. Mark stale and log — a
        // throw here would roll that back, so signal and throw post-commit.
        await tx.spChangeSet.update({ where: { id }, data: { status: 'stale' } });
        await this.versioning.logActivity(tx, {
          tenantId,
          actorUserId: userId,
          authorKind: 'person',
          action: 'changeset.stale',
          entityType: 'change_set',
          entityId: id,
          before: { strategyVersionId: cs.strategyVersionId, headVersionId: head?.id ?? null },
        });
        return { stale: true as const };
      }

      const edits = (cs.approvedOps ?? cs.ops) as unknown as PlanEdit[];
      // Re-validate + apply through the SAME assistant pipeline — a malformed
      // op throws and rolls the whole apply back (no partial write).
      await this.meri.applyEditSet(tx, tenantId, cs.strategyId, userId, edits);

      await tx.spStrategy.update({
        where: { id: cs.strategyId },
        data: { lastEditedByUserId: userId, lastEditedAt: new Date() },
      });
      const appliedVersionId = await this.versioning.cutVersion(tx, {
        tenantId,
        strategyId: cs.strategyId,
        authorKind: 'meri',
        authorUserId: userId,
        note: `Applied change-set: ${cs.summary.slice(0, 120)}`,
        coalesce: false,
      });
      await tx.spChangeSet.update({
        where: { id },
        data: {
          status: 'applied',
          appliedByUserId: userId,
          appliedAt: new Date(),
          appliedVersionId,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'meri',
        action: 'changeset.applied',
        entityType: 'change_set',
        entityId: id,
        after: { opCount: edits.length, appliedVersionId },
      });
      // A6 parity with the assistant path (MeriService.assistant): verify the
      // resulting persisted plan, hard-block under STRATEGY_VERIFY_BLOCK (the
      // 422 rolls this WHOLE tx back — ops, version cut and status flip) and
      // log plan.verified in the same tx.
      const { detail } = await this.meri.verifyAppliedPlan(tx, tenantId, userId, cs.strategyId, ground);
      return { stale: false as const, detail };
    });

    if (result.stale) {
      throw new ConflictException('plan changed since this was proposed — regenerate');
    }
    return result.detail;
  }

  /**
   * Undo an applied change-set: restore the pinned PRE-apply version (the head
   * the proposal was computed against). The precondition check runs in ONE tx
   * and mirrors apply's stale protection: the row must still be 'applied' AND
   * the version head must still be this change-set's appliedVersionId —
   * otherwise restoring the pre-apply snapshot would wholesale revert every
   * edit (and any later-applied change-set) made since the apply, so we 409
   * and point at version history instead. VersionService.restore then runs
   * its OWN withTenantUser tx (and itself cuts a person version + audit row);
   * the change-set status flip is a documented follow-up write in a second tx
   * — if the process dies between them, the plan is correctly restored and
   * the change-set stays 'applied' (re-running undo 409s on the head guard,
   * since restore's cut moved the head; recover via version history).
   */
  async undo(tenantId: string, userId: string, id: string) {
    const cs = await this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.spChangeSet.findFirst({ where: { id } });
      if (!row) throw new NotFoundException('Change-set not found');
      if (row.status !== 'applied') {
        throw new ConflictException(`Change-set is ${row.status} — only an applied change-set can be undone`);
      }
      // Head guard: only the MOST RECENT apply may be undone this way. If the
      // head moved (later edits or a later apply), reverting to the pre-apply
      // snapshot would silently destroy that work.
      const head = await this.headOf(tx, row.strategyId);
      if (!head || head.id !== row.appliedVersionId) {
        throw new ConflictException(
          'plan changed since this change-set was applied — restore from version history instead',
        );
      }
      return row;
    });

    const detail = await this.versions.restore(tenantId, userId, cs.strategyId, cs.strategyVersionId);

    await this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      await tx.spChangeSet.update({
        where: { id },
        data: { status: 'undone', undoneByUserId: userId, undoneAt: new Date() },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'changeset.undone',
        entityType: 'change_set',
        entityId: id,
        after: { restoredVersionId: cs.strategyVersionId },
      });
    });
    return detail;
  }
}
