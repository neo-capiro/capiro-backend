import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { RUN_TERMINAL_STATES, assertTransition } from './run-state.js';
import type { CreateRunDto, TransitionRunDto } from './dto/agents.dto.js';

type Tx = Prisma.TransactionClient;

/**
 * Agent runs (Stage C — lifecycle only, no LLM). A run belongs to an ACTIVE
 * mission; (tenantId, idempotencyKey) dedupes re-triggers: a duplicate create
 * returns the EXISTING run unchanged (no second row, no second activity/outbox
 * event). userId is null for scheduler/system-triggered work (F2), in which
 * case writes run under withTenant and activity is attributed authorKind=meri.
 */
@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  /** One withTenantUser/withTenant tx depending on whether a person acted. */
  private inTx<T>(tenantId: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return userId
      ? this.prisma.withTenantUser(tenantId, userId, fn)
      : this.prisma.withTenant(tenantId, fn);
  }

  async createRun(tenantId: string, userId: string | null, missionId: string, dto: CreateRunDto) {
    try {
      return await this.inTx(tenantId, userId, async (tx) => {
        // SELECT ... FOR UPDATE: an unlocked read here races a concurrent
        // mission pause/cancel (READ COMMITTED) — the PATCH could commit
        // between this gate and the run INSERT, minting a queued run on a
        // canceled mission. The row lock blocks on an in-flight mission UPDATE
        // and re-evaluates the row post-commit, so a just-canceled mission is
        // rejected; a PATCH arriving after we hold the lock waits until this
        // tx commits. Raw SQL bypasses the tenant-scope model hook, hence the
        // explicit tenant_id predicate (and we are inside withTenant/User).
        const [mission] = await tx.$queryRaw<
          Array<{ id: string; state: string; strategyId: string | null }>
        >`
          SELECT id, state, strategy_id AS "strategyId" FROM sp_agent_mission
          WHERE id = ${missionId}::uuid AND tenant_id = ${tenantId}::uuid
          FOR UPDATE`;
        if (!mission) throw new NotFoundException('Mission not found');
        if (mission.state !== 'active') {
          throw new BadRequestException('mission is not active');
        }
        // Tenant-scoped existence check (the query hook injects tenantId) — a
        // run may not point at another tenant's / a nonexistent strategy;
        // SpAgentRun.strategyId has no FK to catch it (mirrors
        // MissionsService.create / ChangeSetsService.create).
        if (dto.strategyId) {
          const strat = await tx.spStrategy.findFirst({
            where: { id: dto.strategyId },
            select: { id: true },
          });
          if (!strat) throw new BadRequestException('Unknown strategy for this tenant');
        }
        const run = await tx.spAgentRun.create({
          data: {
            tenantId,
            missionId,
            strategyId: dto.strategyId ?? mission.strategyId,
            trigger: dto.trigger,
            idempotencyKey: dto.idempotencyKey,
            createdByUserId: userId,
          },
        });
        await this.versioning.logActivity(tx, {
          tenantId,
          actorUserId: userId,
          authorKind: userId ? 'person' : 'meri',
          action: 'run.created',
          entityType: 'run',
          entityId: run.id,
          after: { missionId, trigger: dto.trigger, idempotencyKey: dto.idempotencyKey },
        });
        return run;
      });
    } catch (err) {
      // (tenantId, idempotencyKey) unique violation => idempotent replay. The
      // failed INSERT poisoned the tx (rolled back — so no stray activity row);
      // fetch the surviving original in a fresh read and return it unchanged.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.withTenant(tenantId, (tx) =>
          tx.spAgentRun.findFirst({ where: { idempotencyKey: dto.idempotencyKey } }),
        );
        if (existing) {
          // The unique constraint is (tenantId, idempotencyKey) — tenant-wide,
          // not per-mission. Only treat this as an idempotent replay when the
          // surviving run belongs to the mission in the request; otherwise the
          // key was reused across missions and returning the other mission's
          // run would silently mis-associate state (e.g. the F2 scheduler).
          if (existing.missionId !== missionId) {
            throw new ConflictException(
              'idempotencyKey already used by a run on a different mission',
            );
          }
          return existing;
        }
      }
      throw err;
    }
  }

  async transition(tenantId: string, userId: string | null, runId: string, dto: TransitionRunDto) {
    return this.inTx(tenantId, userId, async (tx) => {
      const run = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!run) throw new NotFoundException('Run not found');

      try {
        assertTransition(run.state, dto.to);
      } catch (err) {
        throw new BadRequestException((err as Error).message);
      }

      const now = new Date();
      const data: Record<string, unknown> = { state: dto.to };
      if (dto.to === 'planning' && !run.startedAt) data.startedAt = now;
      if (RUN_TERMINAL_STATES.has(dto.to)) data.finishedAt = now;
      if (dto.to === 'waiting_for_input') {
        data.waitingReason = dto.waitingReason ?? null;
      } else if (run.state === 'waiting_for_input') {
        // Leaving waiting_for_input: clear the blocked-on reason so a resumed
        // (or finished) run no longer reads as waiting on input.
        data.waitingReason = null;
      }
      if (dto.to === 'failed') data.error = dto.error ?? null;
      if (dto.findings !== undefined) {
        if (typeof dto.findings !== 'object' || dto.findings === null || Array.isArray(dto.findings)) {
          throw new BadRequestException('findings must be a JSON object');
        }
        // Shallow-merge onto existing findings (later runs accumulate keys).
        const prev =
          run.findings && typeof run.findings === 'object' && !Array.isArray(run.findings)
            ? (run.findings as Record<string, unknown>)
            : {};
        data.findings = { ...prev, ...dto.findings } as Prisma.InputJsonValue;
      }

      // Compare-and-swap: include the state we validated against in the WHERE
      // so a concurrent transition that commits between our read and this
      // write makes the predicate miss (count 0) instead of clobbering the
      // winner (e.g. resurrecting a just-canceled terminal run). Under READ
      // COMMITTED, Postgres re-evaluates the full predicate against the
      // committed row after any blocking writer, so the stale-state update
      // simply matches nothing.
      const cas = await tx.spAgentRun.updateMany({
        where: { id: runId, state: run.state },
        data: data as Prisma.SpAgentRunUpdateManyMutationInput,
      });
      if (cas.count === 0) {
        throw new ConflictException(
          `Run state changed concurrently (expected '${run.state}') — retry the transition`,
        );
      }
      const updated = await tx.spAgentRun.findFirst({ where: { id: runId } });
      if (!updated) throw new NotFoundException('Run not found');
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: userId ? 'person' : 'meri',
        action: 'run.transitioned',
        entityType: 'run',
        entityId: runId,
        before: { state: run.state },
        after: { state: dto.to },
      });
      return updated;
    });
  }

  async get(tenantId: string, id: string) {
    const run = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentRun.findFirst({ where: { id } }),
    );
    if (!run) throw new NotFoundException('Run not found');
    return run;
  }

  /**
   * Firm-level review surface (Stage F): ready_for_review runs with NO
   * strategy (strategyId null) — the F2 scheduler's firm-calendar placeholder
   * mints these with findings but no change-set, so the change-set review
   * queue alone would never show them (and WatchRail is strategy-scoped).
   * This feeds the review queue's firm-level section; a reviewer acknowledges
   * a run through the normal transition endpoint (ready_for_review ->
   * completed), which is what drains it from this list.
   *
   * ZERO-FINDING rows are excluded: the placeholder's no-change path parks
   * `{ findings: [], calendarFingerprint }` runs in ready_for_review as ledger
   * rows ("the run row is the record") — they carry no review obligation and
   * surfacing them would bury the real critical rows in daily no-op noise.
   * The filter is on the JSON payload, so it runs in TS over a bounded recent
   * window rather than as an awkward Prisma JSON-path predicate.
   */
  async listFirmReview(tenantId: string, opts: { take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 100);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentRun.findMany({
        where: { strategyId: null, state: 'ready_for_review' },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    );
    return rows
      .filter((run) => {
        const f = run.findings;
        if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
        const list = (f as Record<string, unknown>).findings;
        return Array.isArray(list) && list.length > 0;
      })
      .slice(0, take);
  }

  async listForMission(tenantId: string, missionId: string, opts: { take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 100);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const mission = await tx.spAgentMission.findFirst({
        where: { id: missionId },
        select: { id: true },
      });
      if (!mission) throw new NotFoundException('Mission not found');
      return tx.spAgentRun.findMany({
        where: { missionId },
        orderBy: { createdAt: 'desc' },
        take,
      });
    });
  }
}
