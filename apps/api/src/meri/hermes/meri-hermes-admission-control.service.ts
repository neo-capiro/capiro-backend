/**
 * S-2 — fairness: global / per-tenant / per-scope concurrency caps with bounded
 * per-tenant queues.
 *
 * Declared envelope (decisions.md §4, configurable in meri-hermes-scaling.config.ts):
 *
 *   concurrent runs, global ............ 8   → queue, bounded, oldest-waiting first
 *   concurrent runs per tenant ......... 4   → queue with a VISIBLE queued state
 *   concurrent runs per execution scope  2   → queue
 *   queue depth per tenant ............. 8   → beyond this, refuse admission with an
 *                                              actionable conflict, never drop silently
 *
 * COMPOSITION, NOT DUPLICATION. "One active run per conversation" is already a
 * DB-enforced invariant somewhere else — the partial unique index
 * `meri_agent_runs_conversation_single_writer_idx` plus the conversation
 * advisory lock in `MeriHermesPrismaRunRepository.create()`. This service does
 * not re-check it and holds no opinion about it. Two rules, one owner each.
 *
 * ORDER, and why: the adapter calls `runs.create()` FIRST and takes a capacity
 * slot second. The conversation invariant therefore answers before any capacity
 * is consumed, and — the reason that ordering was chosen — a run that has to
 * QUEUE already has a durable run record to be visibly queued IN (status
 * `queued`, with an event log a reconnecting browser replays). A capacity
 * refusal consequently has a run to finalize, and the adapter finalizes it
 * honestly rather than leaving it occupying the conversation.
 *
 * WHY A TABLE AND AN ADVISORY LOCK, not an in-process semaphore: the API runs
 * as N replicas, so an in-process counter would enforce "8 per replica" while
 * the envelope declares "8 globally". The decision — count, then insert — is
 * taken inside ONE transaction that holds `pg_advisory_xact_lock` on a single
 * gate key, so concurrent admissions on any replica serialize and each sees the
 * previous one's committed state. The lock is held for the duration of three
 * counting queries and one insert (sub-millisecond on the pilot's row counts)
 * and is released automatically at commit or rollback.
 *
 * HONEST LIMITATION: that gate is a global critical section. At the declared
 * ceiling of 8 concurrent runs it is irrelevant — admissions are rare and the
 * held section is tiny — but it is not the design for a thousand admissions a
 * second, and this phase does not claim it is. `decisions.md` §4 explicitly
 * scopes the pilot to 1 tenant / 2 users.
 *
 * WHY `withSystem`: the GLOBAL concurrency count is inherently cross-tenant, and
 * promotion after a release must be able to promote a waiter belonging to a
 * different tenant than the one that just finished. Both are the same
 * documented exception the run repository already makes for `sweep()`. Every
 * identifier used here is server-resolved (from the authorization envelope),
 * never client input, and no row content other than capacity bookkeeping is
 * read.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
// Value import, not `import type`: Nest reads `design:paramtypes` for
// constructor injection, and a type-only import erases to `Object`.
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import { meriHermesScalingLimits, type MeriHermesScalingLimits } from './meri-hermes-scaling.config.js';

export type MeriHermesSlotState = 'active' | 'queued';

export interface MeriHermesCapacityCounts {
  globalActive: number;
  tenantActive: number;
  scopeActive: number;
  tenantQueued: number;
}

export interface MeriHermesAdmissionOutcome {
  runId: string;
  state: MeriHermesSlotState;
  /** 1-based position among this tenant's waiters; null when admitted straight to `active`. */
  queuePosition: number | null;
  /**
   * Capacity counts AFTER this decision, so a caller can log or surface the
   * state it just produced. (For a `reused` outcome nothing changed, so these
   * are simply the current counts.)
   */
  counts: MeriHermesCapacityCounts;
  /** True when the run already held a slot (an idempotent resubmit), so nothing was counted twice. */
  reused: boolean;
}

/** Every concurrency cap AND the tenant's queue are full: refuse, with something the user can act on. */
export class MeriHermesCapacityExhaustedError extends Error {
  readonly code = 'hermes_capacity_exhausted';
  constructor(
    readonly counts: MeriHermesCapacityCounts,
    readonly limits: Pick<
      MeriHermesScalingLimits,
      'maxConcurrentRunsGlobal' | 'maxConcurrentRunsTenant' | 'maxConcurrentRunsScope' | 'tenantQueueDepth'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'MeriHermesCapacityExhaustedError';
  }
}

/** A queued run waited out `queueWaitMs` without reaching the front. Its slot is released before this is thrown. */
export class MeriHermesQueueTimeoutError extends Error {
  readonly code = 'hermes_queue_timeout';
  constructor(
    readonly runId: string,
    readonly waitedMs: number,
    readonly lastPosition: number | null,
  ) {
    super(
      `This request waited ${Math.round(waitedMs / 1000)}s for Hermes capacity` +
        (lastPosition ? ` (still position ${lastPosition} in the queue)` : '') +
        ' and was not started. Nothing was run and nothing was charged; please try again shortly.',
    );
    this.name = 'MeriHermesQueueTimeoutError';
  }
}

interface SlotRow {
  run_id: string;
  tenant_id: string;
  scope_id: string;
  conversation_id: string;
  state: string;
  queued_at: Date;
  activated_at: Date | null;
}

interface CountRow {
  global_active: bigint | number;
  tenant_active: bigint | number;
  scope_active: bigint | number;
  tenant_queued: bigint | number;
}

function n(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

@Injectable()
export class MeriHermesAdmissionControlService {
  private readonly logger = new Logger(MeriHermesAdmissionControlService.name);

  /** Test seam; same convention as the adapter's `env`. */
  env: NodeJS.ProcessEnv = process.env;

  /** Assignable so a spec can share one governor (and its counters) across services. */
  governor: MeriHermesDbGovernor;

  constructor(
    private readonly prisma: PrismaService,
    governor?: MeriHermesDbGovernor,
  ) {
    this.governor = governor ?? meriHermesSharedDbGovernor();
  }

  limits(): MeriHermesScalingLimits {
    return meriHermesScalingLimits(this.env);
  }

  /**
   * Take a capacity slot for `runId`, or queue it, or refuse.
   *
   * Idempotent by run id: a resubmit that already holds a slot gets that slot
   * back and counts nothing twice.
   */
  async admit(input: {
    runId: string;
    tenantId: string;
    scopeId: string;
    conversationId: string;
  }): Promise<MeriHermesAdmissionOutcome> {
    const limits = this.limits();
    const outcome = await this.governor.withSystemTx<MeriHermesAdmissionOutcome | { refusal: MeriHermesCapacityExhaustedError }>(
      this.prisma,
      'admission.admit',
      async (tx) => {
        await this.lockGate(tx);
        const existing = await tx.$queryRaw<SlotRow[]>(Prisma.sql`
          SELECT * FROM meri_agent_admission_slots WHERE run_id = ${input.runId}::uuid
        `);
        const counts = await this.countsIn(tx, input.tenantId, input.scopeId);
        if (existing[0]) {
          const state: MeriHermesSlotState = existing[0].state === 'active' ? 'active' : 'queued';
          return {
            runId: input.runId,
            state,
            queuePosition: state === 'queued' ? await this.positionIn(tx, input.runId, input.tenantId) : null,
            counts,
            reused: true,
          };
        }

        const fits =
          counts.globalActive < limits.maxConcurrentRunsGlobal &&
          counts.tenantActive < limits.maxConcurrentRunsTenant &&
          counts.scopeActive < limits.maxConcurrentRunsScope;

        if (fits) {
          await tx.$executeRaw`
            INSERT INTO meri_agent_admission_slots
              (run_id, tenant_id, scope_id, conversation_id, state, queued_at, activated_at, heartbeat_at)
            VALUES
              (${input.runId}::uuid, ${input.tenantId}::uuid, ${input.scopeId}, ${input.conversationId}::uuid,
               'active', now(), now(), now())
          `;
          return {
            runId: input.runId,
            state: 'active' as const,
            queuePosition: null,
            counts: { ...counts, globalActive: counts.globalActive + 1, tenantActive: counts.tenantActive + 1, scopeActive: counts.scopeActive + 1 },
            reused: false,
          };
        }

        if (counts.tenantQueued < limits.tenantQueueDepth) {
          await tx.$executeRaw`
            INSERT INTO meri_agent_admission_slots
              (run_id, tenant_id, scope_id, conversation_id, state, queued_at, heartbeat_at)
            VALUES
              (${input.runId}::uuid, ${input.tenantId}::uuid, ${input.scopeId}, ${input.conversationId}::uuid,
               'queued', now(), now())
          `;
          return {
            runId: input.runId,
            state: 'queued' as const,
            queuePosition: counts.tenantQueued + 1,
            counts: { ...counts, tenantQueued: counts.tenantQueued + 1 },
            reused: false,
          };
        }

        // Nothing is dropped and nothing is left hanging: the caller gets a
        // conflict that names the wall it hit and what will clear it.
        const wall =
          counts.scopeActive >= limits.maxConcurrentRunsScope
            ? `this workspace area already has ${counts.scopeActive} of ${limits.maxConcurrentRunsScope} Hermes runs in progress`
            : counts.tenantActive >= limits.maxConcurrentRunsTenant
              ? `this workspace already has ${counts.tenantActive} of ${limits.maxConcurrentRunsTenant} Hermes runs in progress`
              : `the Hermes pilot is at its global limit of ${limits.maxConcurrentRunsGlobal} concurrent runs`;
        return {
          refusal: new MeriHermesCapacityExhaustedError(
            counts,
            limits,
            `Hermes cannot start this run right now: ${wall}, and the waiting queue for this workspace is full ` +
              `(${counts.tenantQueued} of ${limits.tenantQueueDepth}). Nothing was started and nothing was charged. ` +
              'Stop a run you no longer need, or try again once one of the runs in progress finishes.',
          ),
        };
      },
    );
    if ('refusal' in outcome) throw outcome.refusal;
    return outcome;
  }

  /**
   * Release `runId`'s slot and promote as many waiters as now fit, oldest-waiting
   * first (decisions.md §4). Safe to call for a run that holds no slot.
   * Returns the run ids that just became `active` so the caller can wake them.
   */
  async release(runId: string): Promise<{ released: boolean; promoted: string[] }> {
    const limits = this.limits();
    return this.governor.withSystemTx(this.prisma, 'admission.release', async (tx) => {
      await this.lockGate(tx);
      const deleted = await tx.$executeRaw`
        DELETE FROM meri_agent_admission_slots WHERE run_id = ${runId}::uuid
      `;
      const promoted = await this.promoteIn(tx, limits);
      return { released: deleted > 0, promoted };
    });
  }

  /** Renew the slot's liveness so `reapStaleSlots` does not reclaim capacity from a healthy run. */
  async heartbeat(runId: string): Promise<boolean> {
    const updated = await this.governor.withSystemTx(this.prisma, 'admission.heartbeat', (tx) =>
      tx.$executeRaw`
        UPDATE meri_agent_admission_slots SET heartbeat_at = now() WHERE run_id = ${runId}::uuid
      `,
    );
    return updated > 0;
  }

  /**
   * Reclaim capacity from slots whose holder stopped heart-beating (a replica
   * died mid-run). Without this a dead replica permanently consumes part of the
   * declared global 8, exactly as a dead consumer lease would permanently own a
   * run.
   *
   * THE TWO STATES ARE REAPED BY DIFFERENT CLOCKS, and they have to be. Only an
   * ACTIVE slot is heart-beaten — the consume loop does it alongside the
   * consumer-lease heartbeat. A QUEUED slot's owner is sitting in
   * `awaitActivation`, sending nothing, so reaping queued slots on the same
   * heartbeat rule would evict runs that are waiting exactly as designed. A
   * queued slot is instead bounded by its owner's own `queueWaitMs` (which
   * releases the slot on timeout); the sweep here is only the backstop for an
   * owner that died while waiting, so its threshold is deliberately generous —
   * `queueWaitMs + slotStaleMs` after it was queued.
   */
  async reapStaleSlots(now: Date = new Date()): Promise<{ reaped: number; promoted: string[] }> {
    const limits = this.limits();
    const activeCutoff = new Date(now.getTime() - limits.slotStaleMs);
    const queuedCutoff = new Date(now.getTime() - (limits.queueWaitMs + limits.slotStaleMs));
    return this.governor.withSystemTx(this.prisma, 'admission.reapStaleSlots', async (tx) => {
      await this.lockGate(tx);
      const reaped = await tx.$executeRaw`
        DELETE FROM meri_agent_admission_slots
         WHERE (state = 'active' AND heartbeat_at < ${activeCutoff})
            OR (state = 'queued' AND queued_at < ${queuedCutoff})
      `;
      const promoted = reaped > 0 ? await this.promoteIn(tx, limits) : [];
      return { reaped, promoted };
    });
  }

  /** Current state of one slot (`null` when it has been released). */
  async slotState(runId: string): Promise<{ state: MeriHermesSlotState; queuePosition: number | null } | null> {
    return this.governor.withSystemTx(this.prisma, 'admission.slotState', async (tx) => {
      const rows = await tx.$queryRaw<SlotRow[]>(Prisma.sql`
        SELECT * FROM meri_agent_admission_slots WHERE run_id = ${runId}::uuid
      `);
      const row = rows[0];
      if (!row) return null;
      const state: MeriHermesSlotState = row.state === 'active' ? 'active' : 'queued';
      return {
        state,
        queuePosition: state === 'queued' ? await this.positionIn(tx, runId, row.tenant_id) : null,
      };
    });
  }

  /**
   * Wait for a queued run to be promoted. Bounded by `queueWaitMs`; on timeout
   * the slot is released (so a caller that gave up does not keep a queue place)
   * and `MeriHermesQueueTimeoutError` is thrown.
   *
   * `onWait` is called on each poll with the current position, which is how the
   * queued state is made VISIBLE rather than being a silent block.
   */
  async awaitActivation(
    runId: string,
    opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onWait?: (position: number | null) => void },
  ): Promise<{ activated: boolean; waitedMs: number }> {
    const limits = this.limits();
    const timeoutMs = opts?.timeoutMs ?? limits.queueWaitMs;
    const pollMs = opts?.pollMs ?? limits.queuePollMs;
    const started = Date.now();
    let lastPosition: number | null = null;
    for (;;) {
      const slot = await this.slotState(runId);
      // No slot at all: it was released (e.g. the run was stopped). Not an
      // activation, but not an error this method should invent either.
      if (!slot) return { activated: false, waitedMs: Date.now() - started };
      if (slot.state === 'active') return { activated: true, waitedMs: Date.now() - started };
      lastPosition = slot.queuePosition;
      opts?.onWait?.(lastPosition);
      const waited = Date.now() - started;
      if (waited >= timeoutMs || opts?.signal?.aborted) {
        await this.release(runId).catch(() => undefined);
        throw new MeriHermesQueueTimeoutError(runId, waited, lastPosition);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, timeoutMs - waited))));
    }
  }

  /** Capacity counts, for reporting and for tests. */
  async counts(tenantId: string, scopeId: string): Promise<MeriHermesCapacityCounts> {
    return this.governor.withSystemTx(this.prisma, 'admission.counts', (tx) =>
      this.countsIn(tx, tenantId, scopeId),
    );
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * The single gate key every admission/release/reap serializes on. The
   * two-argument form is used deliberately: it lives in a DIFFERENT advisory
   * lock space from the one-argument `pg_advisory_xact_lock(hashtext(conversationId))`
   * the run repository takes, so the two can never collide by hash accident.
   */
  private async lockGate(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meri_hermes_admission_gate'), 0)`;
  }

  private async countsIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scopeId: string,
  ): Promise<MeriHermesCapacityCounts> {
    const rows = await tx.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE state = 'active')                                        AS global_active,
        count(*) FILTER (WHERE state = 'active' AND tenant_id = ${tenantId}::uuid)      AS tenant_active,
        count(*) FILTER (WHERE state = 'active' AND scope_id = ${scopeId})              AS scope_active,
        count(*) FILTER (WHERE state = 'queued' AND tenant_id = ${tenantId}::uuid)      AS tenant_queued
      FROM meri_agent_admission_slots
    `);
    const row = rows[0];
    return {
      globalActive: n(row?.global_active),
      tenantActive: n(row?.tenant_active),
      scopeActive: n(row?.scope_active),
      tenantQueued: n(row?.tenant_queued),
    };
  }

  private async positionIn(tx: Prisma.TransactionClient, runId: string, tenantId: string): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ position: bigint | number }>>(Prisma.sql`
      SELECT count(*) + 1 AS position
        FROM meri_agent_admission_slots q
       WHERE q.state = 'queued'
         AND q.tenant_id = ${tenantId}::uuid
         AND q.queued_at < (SELECT s.queued_at FROM meri_agent_admission_slots s WHERE s.run_id = ${runId}::uuid)
    `);
    return rows[0] ? n(rows[0].position) : null;
  }

  /**
   * Promote waiters one at a time, oldest eligible first, until nothing else
   * fits. One statement per promotion so each decision sees the previous
   * promotion's effect (same transaction, so it is visible); bounded by the
   * global cap, so the loop cannot run away.
   */
  private async promoteIn(tx: Prisma.TransactionClient, limits: MeriHermesScalingLimits): Promise<string[]> {
    const promoted: string[] = [];
    for (let i = 0; i < limits.maxConcurrentRunsGlobal; i += 1) {
      const rows = await tx.$queryRaw<Array<{ run_id: string }>>(Prisma.sql`
        WITH cand AS (
          SELECT s.run_id
            FROM meri_agent_admission_slots s
           WHERE s.state = 'queued'
             AND (SELECT count(*) FROM meri_agent_admission_slots a WHERE a.state = 'active')
                   < ${limits.maxConcurrentRunsGlobal}
             AND (SELECT count(*) FROM meri_agent_admission_slots a
                   WHERE a.state = 'active' AND a.tenant_id = s.tenant_id)
                   < ${limits.maxConcurrentRunsTenant}
             AND (SELECT count(*) FROM meri_agent_admission_slots a
                   WHERE a.state = 'active' AND a.scope_id = s.scope_id)
                   < ${limits.maxConcurrentRunsScope}
           ORDER BY s.queued_at ASC, s.run_id ASC
           LIMIT 1
        )
        UPDATE meri_agent_admission_slots t
           SET state = 'active', activated_at = now(), heartbeat_at = now()
          FROM cand
         WHERE t.run_id = cand.run_id
        RETURNING t.run_id
      `);
      if (!rows[0]) break;
      promoted.push(rows[0].run_id);
    }
    return promoted;
  }
}
