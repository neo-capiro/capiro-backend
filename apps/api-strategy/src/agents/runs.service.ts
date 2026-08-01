import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import {
  RUN_FAILURE_STATES,
  RUN_STATE_POLICY,
  RUN_SUPERSEDABLE_STATES,
  RUN_TERMINAL_STATES,
  assertTransition,
  isActionAllowed,
  reasonForState,
} from './run-state.js';
import type { CreateRunDto, TransitionRunDto } from './dto/agents.dto.js';

type Tx = Prisma.TransactionClient;

/**
 * Run states that count as CONCURRENT LOAD for the per-tenant cap: a run that is
 * actively occupying (or about to occupy) an agent worker. ready_for_review is
 * deliberately EXCLUDED — a review-ready run is parked awaiting a HUMAN and
 * burns no agent compute — as are the terminal states (completed/failed/
 * canceled). This is a policy constant, distinct from run-state's lifecycle
 * table on purpose.
 */
export const CONCURRENT_RUN_STATES = [
  'queued',
  'planning',
  'waiting_for_input',
  'executing',
] as const;

/** Default per-tenant concurrent-run cap when the env override is unset/invalid. */
const DEFAULT_MAX_CONCURRENT_RUNS = 20;

/**
 * Resolve the per-tenant concurrent-run cap from
 * STRATEGY_AGENTS_MAX_CONCURRENT_RUNS (default 20). Floored at 1 so the cap can
 * never be misconfigured to zero and lock a tenant out entirely; a non-positive
 * / non-numeric value falls back to the default.
 */
export function resolveConcurrentRunCap(): number {
  const raw = Number(process.env.STRATEGY_AGENTS_MAX_CONCURRENT_RUNS);
  return Math.max(
    Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT_RUNS,
    1,
  );
}

/**
 * Agent runs (Stage C — lifecycle only, no LLM). A run belongs to an ACTIVE
 * mission; (tenantId, idempotencyKey) dedupes re-triggers: a duplicate create
 * returns the EXISTING run unchanged (no second row, no second activity/outbox
 * event). userId is null for scheduler/system-triggered work (F2), in which
 * case writes run under withTenant and activity is attributed authorKind=meri.
 *
 * Stage H adds a per-tenant CONCURRENCY CAP
 * (STRATEGY_AGENTS_MAX_CONCURRENT_RUNS, default 20) checked before minting a
 * GENUINELY-NEW run: a tenant at its active-run budget gets a 503 'try again
 * shortly'. An idempotent replay (same idempotencyKey) is a RETRY, not new load
 * — it returns the existing run and never counts against or trips the cap.
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

        // IDEMPOTENT-REPLAY short-circuit, taken BEFORE the concurrency cap
        // (Stage H): a re-triggered create for a key we've already minted a run
        // for is NOT new load — it must return the existing run and never be
        // counted against (or rejected by) the cap. Placed AFTER the mission
        // gate so a replay keeps the existing mission-active semantics; the
        // INSERT + P2002 catch below still backstops the concurrent-create race
        // where two callers pass this read together (neither sees the other's
        // uncommitted row). Tenant-scoped via the query hook.
        const replay = await tx.spAgentRun.findFirst({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (replay) {
          if (replay.missionId !== missionId) {
            throw new ConflictException(
              'idempotencyKey already used by a run on a different mission',
            );
          }
          return replay;
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

        // PER-TENANT CONCURRENCY CAP (Stage H load-shed valve). Count this
        // tenant's actively-executing runs (queued/planning/waiting_for_input/
        // executing — CONCURRENT_RUN_STATES; a parked ready_for_review or a
        // terminal run does NOT count) and reject a genuinely-new run over the
        // cap with a 503. SOFT cap: the count and the insert are not atomic
        // across concurrent creators, so the ceiling may be exceeded by the
        // number of simultaneous inserters — acceptable for a load-shed valve,
        // not a hard invariant. The idempotent replay above already returned, so
        // a retry never reaches (or trips) this gate.
        const cap = resolveConcurrentRunCap();
        const active = await tx.spAgentRun.count({
          where: { state: { in: [...CONCURRENT_RUN_STATES] } },
        });
        if (active >= cap) {
          throw new ServiceUnavailableException(
            'too many active agent runs for this tenant — try again shortly',
          );
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
      // P0-2 HEARTBEAT. Every state change stamps it, so the reconciler can tell
      // "actively progressing" from "died mid-phase". Deliberately NOT updatedAt:
      // any unrelated column write bumps that, so it cannot prove liveness.
      data.heartbeatAt = now;
      if (dto.to === 'waiting_for_input') {
        data.waitingReason = dto.waitingReason ?? null;
      } else if (run.state === 'waiting_for_input') {
        // Leaving waiting_for_input: clear the blocked-on reason so a resumed
        // (or finished) run no longer reads as waiting on input.
        data.waitingReason = null;
      }
      // P0-2: all three failure states carry the reason (was: only legacy 'failed').
      if (RUN_FAILURE_STATES.has(dto.to)) data.error = dto.error ?? null;
      if (dto.findings !== undefined) {
        if (
          typeof dto.findings !== 'object' ||
          dto.findings === null ||
          Array.isArray(dto.findings)
        ) {
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

  // ---- P0-2 recovery operations ---------------------------------------------

  /**
   * Refresh the liveness clock WITHOUT changing state. Called at the end of every
   * execution phase (see ExecutionService.settlePhase) so a long but healthy phase
   * is never mistaken for a stranded run by the reconciler.
   *
   * Fire-and-forget by design: a failed heartbeat must never fail the phase that
   * was otherwise successful, so this swallows its own errors and only logs.
   */
  async heartbeat(tenantId: string, runId: string): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.spAgentRun.updateMany({ where: { id: runId }, data: { heartbeatAt: new Date() } }),
      );
    } catch {
      // Intentionally silent: liveness bookkeeping is not worth failing work for.
    }
  }

  /**
   * The audit's "Mark failed" control: a human declaring a stuck run dead.
   * Only from a state whose policy permits it (failed_recoverable), so this can
   * never be used to bypass a live run.
   */
  async markFailed(tenantId: string, userId: string, runId: string, reason?: string) {
    const run = await this.get(tenantId, runId);
    if (!isActionAllowed(run.state, 'mark_failed')) {
      throw new ConflictException(
        `run is ${run.state} — it cannot be marked failed (${reasonForState(run.state)})`,
      );
    }
    return this.transition(tenantId, userId, runId, {
      to: 'failed_terminal',
      error: reason?.trim() || 'marked failed by a reviewer',
    } as TransitionRunDto);
  }

  /**
   * The audit's "Retry" control — and the fix for "retries blocked by
   * deduplication".
   *
   * A retry does NOT reuse the run row. (tenantId, idempotencyKey) is UNIQUE and
   * the execution key is derived from (node, kind), so re-triggering the same key
   * returns the SAME stuck run forever — that is precisely the defect. Instead we
   * mint a NEW run with the next attempt's key (`<baseKey>#<attempt>`), record the
   * lineage both ways, and mark the prior attempt `superseded` when it was still
   * open. A genuinely terminal prior attempt (completed/failed_terminal/canceled)
   * is left untouched — you do not rewrite history to retry.
   *
   * The new run starts in `queued`, exactly like a fresh one, so the normal
   * plan/execute path drives it with no special-casing.
   */
  async retry(tenantId: string, userId: string, runId: string) {
    const prior = await this.get(tenantId, runId);
    if (!isActionAllowed(prior.state, 'retry')) {
      throw new ConflictException(
        `run is ${prior.state} — it cannot be retried (${reasonForState(prior.state)})`,
      );
    }
    const attempt = prior.attempt + 1;
    // Base key = the key with any prior `#n` suffix stripped, so attempt 4 keys
    // off the original node+kind rather than compounding suffixes.
    const baseKey = prior.idempotencyKey.replace(/#\d+$/, '');
    const idempotencyKey = `${baseKey}#${attempt}`;

    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      // Re-read the prior run under the tx and CAS its state below, so two
      // concurrent retries cannot both supersede it and mint two attempts.
      const locked = await tx.$queryRaw<Array<{ id: string; state: string }>>`
        SELECT id, state FROM sp_agent_run
        WHERE id = ${runId}::uuid AND tenant_id = ${tenantId}::uuid
        FOR UPDATE`;
      const lockedState = locked[0]?.state;
      if (!lockedState) throw new NotFoundException('Run not found');
      if (!isActionAllowed(lockedState, 'retry')) {
        throw new ConflictException(
          `run is ${lockedState} — it cannot be retried (${reasonForState(lockedState)})`,
        );
      }

      const existing = await tx.spAgentRun.findFirst({ where: { idempotencyKey } });
      if (existing) {
        // This attempt was already minted (double-click / replay) — return it
        // rather than erroring or creating a third row.
        return existing;
      }

      const next = await tx.spAgentRun.create({
        data: {
          tenantId,
          missionId: prior.missionId,
          strategyId: prior.strategyId,
          trigger: 'manual',
          idempotencyKey,
          createdByUserId: userId,
          attempt,
          retryOfRunId: prior.id,
          heartbeatAt: new Date(),
          // Carry the execution INTENT forward (kind/nodeId/strategyId/missionId +
          // pinnedVersionId) so plan() can drive the new run without the caller
          // re-supplying it. Results/tasks/approvals are deliberately NOT copied:
          // a retry must re-plan and re-approve from scratch.
          ...(carryExecutionIntent(prior.findings)
            ? { findings: carryExecutionIntent(prior.findings) as Prisma.InputJsonValue }
            : {}),
        },
      });

      // Mark the prior attempt superseded ONLY when it was still open. CAS on the
      // state we validated so a concurrent transition wins cleanly.
      if (RUN_SUPERSEDABLE_STATES.has(lockedState)) {
        await tx.spAgentRun.updateMany({
          where: { id: prior.id, state: lockedState as never },
          data: {
            state: 'superseded',
            supersededByRunId: next.id,
            finishedAt: new Date(),
            heartbeatAt: new Date(),
          },
        });
      } else {
        // Terminal prior attempt: record the forward pointer only.
        await tx.spAgentRun.updateMany({
          where: { id: prior.id },
          data: { supersededByRunId: next.id },
        });
      }

      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'run.retried',
        entityType: 'run',
        entityId: next.id,
        before: { priorRunId: prior.id, priorState: lockedState },
        after: {
          attempt,
          idempotencyKey,
          supersededPrior: RUN_SUPERSEDABLE_STATES.has(lockedState),
        },
      });
      return next;
    });
  }

  /**
   * Every attempt for one logical execution (the `exec:<nodeId>:<kind>` family),
   * oldest first — the audit's consolidated run history / "compare attempts".
   */
  async listAttempts(tenantId: string, runId: string) {
    const run = await this.get(tenantId, runId);
    const baseKey = run.idempotencyKey.replace(/#\d+$/, '');
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentRun.findMany({
        // baseKey and every `baseKey#n`. `startsWith` alone would also match a
        // DIFFERENT kind whose key is a prefix extension, so the family is
        // narrowed to exactly the base key or the base key + '#'.
        where: {
          OR: [{ idempotencyKey: baseKey }, { idempotencyKey: { startsWith: `${baseKey}#` } }],
        },
        orderBy: [{ attempt: 'asc' }, { createdAt: 'asc' }],
        take: 50,
      }),
    );
  }

  /** The allowed-next-actions list + plain-words reason for a run's state. */
  async policyFor(tenantId: string, runId: string) {
    const run = await this.get(tenantId, runId);
    const policy = RUN_STATE_POLICY[run.state];
    return {
      runId,
      state: run.state,
      reason: reasonForState(run.state),
      actions: policy?.actions ?? [],
      terminal: policy?.terminal ?? true,
      timeoutMinutes: policy?.timeoutMinutes ?? null,
      heartbeatAt: run.heartbeatAt,
      attempt: run.attempt,
      retryOfRunId: run.retryOfRunId,
      supersededByRunId: run.supersededByRunId,
    };
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

/**
 * P0-2: the findings a RETRY inherits — the execution INTENT only
 * ({kind, nodeId, strategyId, missionId, pinnedVersionId}).
 *
 * Results, reviewed tasks, prior reconciliation notes and (critically) any
 * sendApproval are deliberately DROPPED: a retry must re-plan and, under P0-3, be
 * re-approved from scratch. Inheriting findings.sendApproval would let an approval
 * granted against the previous attempt's payload authorise a brand-new one, which
 * is exactly the class of defect P0-3 exists to close.
 *
 * pinnedVersionId is intentionally NOT carried: it pinned the plan head the OLD
 * attempt was reviewed against, and plan() re-pins to the live head. Carrying it
 * would make the new attempt instantly version-drifted.
 */
function carryExecutionIntent(findings: unknown): { execution: Record<string, unknown> } | null {
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return null;
  const exec = (findings as Record<string, unknown>).execution;
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) return null;
  const e = exec as Record<string, unknown>;
  if (typeof e.kind !== 'string' || typeof e.nodeId !== 'string') return null;
  return {
    execution: {
      kind: e.kind,
      nodeId: e.nodeId,
      ...(typeof e.strategyId === 'string' ? { strategyId: e.strategyId } : {}),
      ...(typeof e.missionId === 'string' ? { missionId: e.missionId } : {}),
      pinnedVersionId: null,
    },
  };
}
