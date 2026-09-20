/**
 * Prisma-backed durable run repository — Phase 1 backlog #1.
 *
 * Real runtime implementation of `MeriHermesRunRepository` (wired via the
 * `MERI_HERMES_RUN_REPOSITORY` token in meri.module.ts), replacing the
 * in-memory `MeriHermesRunStore` prototype so a run, its sequenced event log
 * and its pending interactions survive an API process restart and are
 * readable from any replica. `MeriHermesRunStore` itself is kept as the fast
 * in-memory test double (see its class doc). Tables: `meri_execution_scopes`,
 * `meri_agent_runs`, `meri_agent_run_events`, `meri_agent_interactions`
 * (migration 20280920010000_meri_hermes_durable_runs; design in
 * docs/meri/hermes/phase-0/contracts.md §7).
 *
 * TENANT ISOLATION: all four tables carry Postgres Row-Level Security
 * policies keyed off `current_tenant_id()`, ENABLED **and FORCED** — unlike
 * most tables in this codebase, capiro_app cannot fall back on table
 * ownership to bypass RLS here (see PrismaService's own doc on the
 * 2026-07-16/07-20 hardening). Every query therefore runs through
 * `PrismaService.withTenant` (sets `app.current_tenant` for the transaction,
 * which the RLS policies read) or, for the minority of operations below,
 * `PrismaService.withSystem`. `withSystem` is used in exactly two situations:
 *
 *   1. `sweep()` — a global TTL sweep is inherently cross-tenant.
 *   2. A handful of interface methods take an opaque `runId` / `hermesRunId` /
 *      `executionScopeId` with NO `tenantId` parameter to scope by (the
 *      interface is intentionally unchanged from the in-memory prototype —
 *      see meri-hermes-run-store.ts). For those, `resolveRunTenant` /
 *      `resolveHermesRunTenant` / `resolveScopeTenant` do a `withSystem`
 *      lookup that reads ONLY the `tenantId` column for that one row (by
 *      primary key or unique key), then the real read/write reruns through
 *      `withTenant` with the resolved tenant. That lookup cannot leak row
 *      CONTENT across tenants — it returns a tenant id, not data — and the
 *      caller already holds the id being resolved (it came from a
 *      `MeriHermesRunRecord` already loaded via `create`/`requireOwned`, or
 *      from a `hermesRunId` the broker independently verifies against the
 *      worker token's own claimed tenant in `authorize()`). `requireOwned`
 *      and `listForConversation`, which DO carry an explicit `tenantId` (and
 *      `actorId`), apply it directly in the `WHERE` clause with no lookup
 *      step, so a cross-tenant/cross-actor guess resolves to "not found"
 *      rather than leaking existence.
 *
 * CONCURRENCY: `append()` allocates `seq` with an atomic
 * `UPDATE ... SET last_seq = last_seq + 1 ... RETURNING last_seq` inside the
 * same tenant-scoped transaction as the event insert, so two concurrent
 * appends on the same run never collide on `seq` (Postgres row-level locking
 * on the `UPDATE` serializes them). `create()` relies on the
 * `(scope_id, idempotency_key)` unique constraint: on a conflict (P2002) it
 * re-fetches and returns the existing row instead of throwing, mirroring the
 * in-memory store's `findByIdempotencyKey` short-circuit.
 *
 * CROSS-REPLICA DELIVERY (P1-09, supersedes ticket #1's KNOWN LIMITATION):
 * `watch()` is the replica-agnostic subscription. It polls `eventsAfter()` —
 * a plain durable read — from a cursor that is always `seq > lastDelivered`,
 * so a subscriber on ANY replica receives every event produced by ANY other
 * replica, in order, exactly once, and there is NO replay/live handoff seam:
 * the "read history, then attach a live listener" pattern it replaces had a
 * gap window between those two steps. `subscribe()` remains, but ONLY as a
 * latency optimisation that wakes a sleeping poll early on the replica that
 * happens to be producing; nothing depends on it for correctness, which
 * `meri-hermes-cross-replica.spec.ts` proves with two independently
 * constructed repositories that share no emitter.
 *
 * ORDERING GUARANTEE that makes polling gap-free: `appendInTx` allocates `seq`
 * with `UPDATE meri_agent_runs SET last_seq = last_seq + 1 ... RETURNING`,
 * which takes a row lock on the run that is held until that transaction
 * commits. A concurrent append therefore cannot obtain the NEXT seq until the
 * previous one has committed, so commit order is seq order and a poller can
 * never observe seq N+1 before seq N is visible. (Without that lock, polling
 * `seq > cursor` would be free to skip a still-uncommitted lower seq forever.)
 *
 * EVENT CAP: mirrors the in-memory store's intent (cap 5000 events per run,
 * head event always kept, gap marked) rather than its exact mechanics — see
 * `enforceEventCap` for what differs (count-based, not a JS array splice) and
 * for the P1-08 pruning-safety rule (never prune above the `output_seq`
 * snapshot).
 *
 * ADMISSION FENCING (P1-02): `create()` takes a Postgres advisory
 * transaction lock keyed by `conversationId` so concurrent admission attempts
 * on the SAME conversation serialize deterministically, then admits at most
 * one non-terminal run per conversation — a genuinely competing distinct
 * submission throws `MeriHermesConversationOccupiedError`, never silently
 * races the partial unique index. `update()` separately fences every
 * transition INTO a terminal status with a conditional `WHERE status NOT IN
 * (terminal)` write, so a stale/late write (e.g. an explicit Stop racing a
 * late Hermes success callback) can never resurrect or overwrite an already
 * terminal run. `reconcileStuckDispatches()` applies the same
 * don't-clobber-a-row-that-moved-on discipline to admitted-but-never-dispatched
 * runs (P1-07); it is implemented and unit-tested here but NOT wired to a
 * scheduler in this pass.
 *
 * TRANSACTIONAL WRITES: `update()` and `append()` both take an optional
 * trailing `tx` so a caller can commit this write atomically together with
 * other writes in ONE transaction — e.g. the adapter's `finalize()` creates
 * the terminal assistant `ClioMessage` and calls both `update()` and
 * `append()` against that same transaction, so the browser-visible message
 * and the durable terminal run state can never diverge on a crash mid-finalize.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  MeriAgentRun as MeriAgentRunRow,
  MeriAgentInteraction as MeriAgentInteractionRow,
  MeriAgentRunEvent as MeriAgentRunEventRow,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MERI_HERMES_TERMINAL_STATUSES,
  type MeriHermesAuthorizationEnvelope,
  type MeriHermesInteractionKind,
  type MeriHermesPendingInteraction,
  type MeriHermesRunEvent,
  type MeriHermesRunEventKind,
  type MeriHermesRunStatus,
  type MeriHermesUsage,
} from './hermes-runtime.contracts.js';
import {
  DEFAULT_TTL_MS,
  MAX_EVENTS_PER_RUN,
  MeriHermesConsumerFencedError,
  MeriHermesConversationOccupiedError,
  meriHermesWatchIntervalMs,
  type MeriHermesConversationActivity,
  type MeriHermesRunCreateInput,
  type MeriHermesRunListener,
  type MeriHermesRunRecord,
  type MeriHermesRunRepository,
  type RunPatch,
  type RunWriteFence,
} from './meri-hermes-run-store.js';

/** Detect a Prisma unique-constraint violation, optionally targeting a specific constraint/column hint. */
function isUniqueConstraintViolation(error: unknown, hint: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes(hint);
  if (Array.isArray(target)) return target.some((t) => hint.toLowerCase().includes(String(t).toLowerCase()));
  // Unknown target shape: the only unique constraints `create()` can hit besides
  // the (never-colliding) random UUID primary key are the ones we pass a `hint`
  // for, so treat any P2002 here as that conflict.
  return true;
}

@Injectable()
export class MeriHermesPrismaRunRepository implements MeriHermesRunRepository {
  /**
   * In-process pub/sub. NOT the delivery mechanism any more (see the class
   * doc): `watch()` uses it only to wake its own sleep early when the producing
   * append happens to run on this replica.
   */
  private readonly listeners = new Map<string, Set<MeriHermesRunListener>>();

  /**
   * Test seam (not a constructor parameter — Nest would try to inject Number).
   * Exercising the cap and the P1-08 pruning-safety rule for real is far
   * cheaper at a cap of ~20 rows than at 5 000. Production never assigns this.
   */
  maxEventsPerRun: number = MAX_EVENTS_PER_RUN;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomic admission with single-writer-per-conversation fencing (P1-02).
   * Order: take a transaction-scoped Postgres advisory lock keyed by
   * `conversationId` (serializes every concurrent admission attempt on the
   * SAME conversation deterministically; auto-released at commit/rollback,
   * never held across the model call which happens long after this method
   * returns) → look for an existing NON-TERMINAL run on that conversation →
   * same idempotency key = reattach to it, different key = a genuinely
   * competing distinct submission, throw `MeriHermesConversationOccupiedError`
   * → otherwise admit: upsert the scope, insert the run, insert its
   * `run.accepted` seq-1 event, all in the one transaction.
   *
   * The `(scopeId, idempotencyKey)` unique constraint and the
   * `meri_agent_runs_conversation_single_writer_idx` partial unique index are
   * BOTH still live as backstops (see the catch below), but are not the
   * primary mechanism — the lock + explicit check above is. The constraint
   * backstop matters for one case the lock does not cover: a retry of an
   * idempotency key whose run already went TERMINAL (so it no longer occupies
   * the conversation and the in-lock lookup won't find it), which correctly
   * falls through to the insert, hits the (scopeId, idempotencyKey) unique
   * constraint, and is resolved by returning the existing (terminal) row —
   * mirroring the in-memory store's unconditional `findByIdempotencyKey` short
   * circuit.
   */
  async create(input: MeriHermesRunCreateInput): Promise<MeriHermesRunRecord> {
    const { envelope, actorContext, idempotencyKey, userMessageId } = input;
    const scopeId = envelope.executionScopeId;
    const runId = envelope.runId || randomUUID();
    const scopeKind = envelope.audience === 'private' ? 'private' : envelope.audience;
    try {
      return await this.prisma.withTenant(envelope.tenantId, async (tx): Promise<MeriHermesRunRecord> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${envelope.conversationId}))`;
        const occupying = await tx.meriAgentRun.findFirst({
          where: { conversationId: envelope.conversationId, status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] } },
        });
        if (occupying) {
          if (occupying.idempotencyKey === idempotencyKey) {
            // Retry of the turn that already admitted: reattach, never duplicate.
            return this.loadRunFromRow(tx, occupying);
          }
          // A genuinely competing distinct submission to an occupied conversation.
          throw new MeriHermesConversationOccupiedError(occupying.id);
        }
        await tx.meriExecutionScope.upsert({
          where: { id: scopeId },
          create: {
            id: scopeId,
            tenantId: envelope.tenantId,
            principalType: envelope.actorType,
            principalId: envelope.actorId,
            kind: scopeKind,
            authorizationVersion: envelope.authorizationVersion,
          },
          // Keep the scope's stored authorization version current on every new
          // run — it is the version the broker's per-call recheck compares
          // against (contracts.md §2).
          update: { authorizationVersion: envelope.authorizationVersion },
        });
        const created = await tx.meriAgentRun.create({
          data: {
            id: runId,
            tenantId: envelope.tenantId,
            scopeId,
            actorId: envelope.actorId,
            conversationId: envelope.conversationId,
            userMessageId,
            status: 'queued',
            idempotencyKey,
            envelope: envelope as unknown as Prisma.InputJsonValue,
            actorContext: actorContext as unknown as Prisma.InputJsonValue,
            // The initial run.accepted event below is seq 1; start last_seq there
            // (matches MeriHermesRunStore: lastSeq goes 0 -> 1 on that append).
            lastSeq: 1,
          },
        });
        await tx.meriAgentRunEvent.create({
          data: {
            runId: created.id,
            seq: 1,
            kind: 'run.accepted',
            visibility: 'public',
            payload: { idempotencyKey, executionScopeId: scopeId, frames: [] } as Prisma.InputJsonValue,
          },
        });
        return this.toRecord(created, []);
      });
    } catch (error) {
      if (error instanceof MeriHermesConversationOccupiedError) throw error;
      if (isUniqueConstraintViolation(error, 'meri_agent_runs_scope_idempotency_key')) {
        // Idempotent resubmit racing (or following) an earlier create() for the
        // same (scope, idempotencyKey) whose run has since gone terminal (so it
        // no longer occupies the conversation): return the row that won, never
        // throw and never insert a duplicate.
        const existing = await this.findByIdempotencyKey(scopeId, idempotencyKey);
        if (existing) return existing;
      }
      if (isUniqueConstraintViolation(error, 'meri_agent_runs_conversation_single_writer_idx')) {
        // Backstop only: the advisory lock above should make this unreachable
        // in practice. Re-resolve the occupying run and surface the same
        // conflict a lock-serialized attempt would have seen.
        const occupying = await this.prisma.withTenant(envelope.tenantId, (tx) =>
          tx.meriAgentRun.findFirst({
            where: { conversationId: envelope.conversationId, status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] } },
          }),
        );
        if (occupying) throw new MeriHermesConversationOccupiedError(occupying.id);
      }
      throw error;
    }
  }

  async get(runId: string): Promise<MeriHermesRunRecord | null> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) return null;
    return this.prisma.withTenant(tenantId, (tx) => this.loadRun(tx, runId));
  }

  async findByHermesRunId(hermesRunId: string): Promise<MeriHermesRunRecord | null> {
    const tenantId = await this.resolveHermesRunTenant(hermesRunId);
    if (!tenantId) return null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.meriAgentRun.findUnique({ where: { hermesRunId } });
      return row ? this.loadRunFromRow(tx, row) : null;
    });
  }

  async findByIdempotencyKey(executionScopeId: string, idempotencyKey: string): Promise<MeriHermesRunRecord | null> {
    const tenantId = await this.resolveScopeTenant(executionScopeId);
    if (!tenantId) return null;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.meriAgentRun.findUnique({
        where: { scopeId_idempotencyKey: { scopeId: executionScopeId, idempotencyKey } },
      });
      return row ? this.loadRunFromRow(tx, row) : null;
    });
  }

  /** Ownership check via the WHERE clause (not a post-fetch check): wrong tenant/actor/id all resolve to null identically. */
  async requireOwned(runId: string, tenantId: string, actorId: string): Promise<MeriHermesRunRecord | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.meriAgentRun.findFirst({ where: { id: runId, tenantId, actorId } });
      return row ? this.loadRunFromRow(tx, row) : null;
    });
  }

  /**
   * `tx` supplied: run against it directly (no new transaction opened — the
   * caller, e.g. the adapter's transactional `finalize()`, already holds a
   * tenant-scoped transaction and wants this write to commit atomically
   * alongside others in it). `tx` omitted: resolve the run's tenant and open
   * our own transaction, as before.
   *
   * FENCED TERMINAL TRANSITION: when `patch.status` is one of the terminal
   * statuses, the write is `UPDATE ... WHERE id = $1 AND status NOT IN
   * (<terminal list>)` (via `updateMany`, since Prisma's typed `update()` only
   * takes a unique-key `where`) so a run that is ALREADY terminal cannot be
   * clobbered by a stale/late write — e.g. an explicit Stop racing a late
   * Hermes success callback. If the write matches zero rows (lost the race),
   * this returns the CURRENT (already terminal) row instead of throwing.
   * `finishedAt` is set exactly on the transition that wins, because the
   * guard ensures at most one terminal `updateMany` for a given run ever
   * matches. A non-terminal patch (most `update()` calls) is a plain
   * `WHERE id = $1` update.
   */
  async update(
    runId: string,
    patch: RunPatch,
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunRecord> {
    if (tx) return (await this.applyUpdate(tx, runId, patch, fence)).run;
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
    return this.prisma.withTenant(tenantId, async (innerTx) => (await this.applyUpdate(innerTx, runId, patch, fence)).run);
  }

  /**
   * The fenced terminal transition with the winner reported. See the interface
   * doc in meri-hermes-run-store.ts; the mechanism is the same guarded
   * `updateMany` `update()` already used, and `won` is simply whether that
   * write matched its row.
   */
  async transitionTerminal(
    runId: string,
    patch: RunPatch,
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<{ won: boolean; run: MeriHermesRunRecord }> {
    if (!(patch.status !== undefined && MERI_HERMES_TERMINAL_STATUSES.has(patch.status))) {
      throw new Error('transitionTerminal() requires a terminal status in the patch');
    }
    if (tx) return this.applyUpdate(tx, runId, patch, fence);
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
    return this.prisma.withTenant(tenantId, (innerTx) => this.applyUpdate(innerTx, runId, patch, fence));
  }

  /**
   * ATOMIC tool-budget reservation (closeout defect A4) — see the interface
   * doc in meri-hermes-run-store.ts for the contract.
   *
   * The whole decision is ONE statement:
   *
   *   UPDATE meri_agent_runs
   *      SET broker_calls = broker_calls + 1
   *    WHERE id = $1 AND broker_calls < $2
   *   RETURNING broker_calls
   *
   * Postgres takes a row lock for the UPDATE, so concurrent reservations on
   * one run serialize and each sees the previous one's committed value —
   * exactly the mechanism `appendInTx()` already relies on for `last_seq`.
   * A row comes back only when the guard held, so the caller enforces the cap
   * on the ATOMIC RESULT, never on a snapshot it read earlier. With N callers
   * racing a budget of M, precisely M statements match and N − M return no
   * row.
   *
   * No explicit `tenant_id` filter: `meri_agent_runs` FORCEs row-level
   * security (see the class doc), so a wrong-tenant id matches zero rows.
   * That makes "no row" ambiguous between "budget exhausted" and "not my
   * run", so the refusal path re-reads the row and distinguishes the two —
   * an unknown run throws, as `update()` does, rather than being reported as
   * a quiet budget refusal.
   */
  async reserveBrokerCall(
    runId: string,
    maxToolCalls: number,
  ): Promise<{ admitted: boolean; brokerCalls: number }> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
    const limit = Number.isFinite(maxToolCalls) ? Math.floor(maxToolCalls) : 0;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ broker_calls: number }>>(Prisma.sql`
        UPDATE meri_agent_runs
        SET broker_calls = broker_calls + 1, updated_at = now()
        WHERE id = ${runId}::uuid AND broker_calls < ${limit}
        RETURNING broker_calls
      `);
      const reserved = rows[0]?.broker_calls;
      if (reserved !== undefined) return { admitted: true, brokerCalls: Number(reserved) };
      const current = await tx.meriAgentRun.findUnique({
        where: { id: runId },
        select: { brokerCalls: true },
      });
      if (!current) throw new Error(`Unknown Hermes run ${runId}`);
      return { admitted: false, brokerCalls: current.brokerCalls };
    });
  }

  /**
   * `won` is meaningful only for a terminal patch (it is the result of the
   * guarded `updateMany`); a non-terminal patch always reports `won: true`
   * because there is no race to lose.
   */
  private async applyUpdate(
    tx: Prisma.TransactionClient,
    runId: string,
    patch: RunPatch,
    fence?: RunWriteFence,
  ): Promise<{ won: boolean; run: MeriHermesRunRecord }> {
    const isTerminalPatch = patch.status !== undefined && MERI_HERMES_TERMINAL_STATUSES.has(patch.status);
    const data: Prisma.MeriAgentRunUpdateInput = {
      ...(patch.hermesRunId !== undefined ? { hermesRunId: patch.hermesRunId } : {}),
      ...(patch.hermesSessionId !== undefined ? { hermesSessionId: patch.hermesSessionId } : {}),
      ...(patch.idempotencyKey !== undefined ? { idempotencyKey: patch.idempotencyKey } : {}),
      ...(patch.userMessageId !== undefined ? { userMessageId: patch.userMessageId } : {}),
      ...(patch.assistantMessageId !== undefined ? { assistantMessageId: patch.assistantMessageId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      // P1-08: `outputSeq` is only ever meaningful when written in the SAME
      // transaction as the append() that allocated that seq — see the adapter's
      // consume(). Writing it here is the mechanism; the atomicity is the
      // caller's `tx`.
      ...(patch.outputSeq !== undefined ? { outputSeq: patch.outputSeq } : {}),
      ...(patch.usage !== undefined
        ? { usage: patch.usage === null ? Prisma.JsonNull : (patch.usage as unknown as Prisma.InputJsonValue) }
        : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.finishReason !== undefined ? { finishReason: patch.finishReason } : {}),
      ...(patch.partial !== undefined ? { partial: patch.partial } : {}),
      ...(patch.detached !== undefined ? { detached: patch.detached } : {}),
      ...(patch.stopRequestedAt !== undefined
        ? { stopRequestedAt: patch.stopRequestedAt ? new Date(patch.stopRequestedAt) : null }
        : {}),
      ...(patch.brokerCalls !== undefined ? { brokerCalls: patch.brokerCalls } : {}),
      ...(patch.dispatchStatus !== undefined ? { dispatchStatus: patch.dispatchStatus } : {}),
      ...(patch.dispatchAttempts !== undefined ? { dispatchAttempts: patch.dispatchAttempts } : {}),
      // Consumer lease fields are normally written by claimConsumer /
      // heartbeatConsumer (which are atomic and conditional); they are mapped
      // here too so a test or an administrative path can clear a lease.
      ...(patch.consumerId !== undefined ? { consumerId: patch.consumerId } : {}),
      ...(patch.consumerHeartbeatAt !== undefined
        ? { consumerHeartbeatAt: patch.consumerHeartbeatAt ? new Date(patch.consumerHeartbeatAt) : null }
        : {}),
      // pendingInteractions is intentionally NOT mapped here: interactions are
      // owned exclusively by addInteraction()/resolveInteraction() below.
      ...(isTerminalPatch
        ? {
            // Only reachable via the successful fenced updateMany below, which
            // can match at most once per run — so this is the single stamp.
            finishedAt: patch.finishedAt !== undefined ? (patch.finishedAt ? new Date(patch.finishedAt) : null) : new Date(),
          }
        : patch.finishedAt !== undefined
          ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null }
          : {}),
    };
    // Write-side consumer fence (P1-09 completion): when the caller declares a
    // consumerId, the WHERE clause carries it, so a consumer that has been
    // taken over matches zero rows and writes nothing — the check and the
    // write are one statement, with no read-then-write window in between.
    const consumerId = fence?.consumerId ?? null;
    /**
     * ANY status write is guarded, not just a terminal one: a terminal run's
     * status is immutable. Without that, an explicit Stop that lost the race
     * to a completion could still write `cancelling` over `completed` a
     * moment later and resurrect a finished run — the fenced terminal
     * transition alone did not cover it, because `cancelling` is not terminal
     * and so took the unguarded path.
     */
    const isStatusPatch = patch.status !== undefined;
    if (isStatusPatch || consumerId) {
      const result = await tx.meriAgentRun.updateMany({
        where: {
          id: runId,
          ...(isStatusPatch || consumerId ? { status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] } } : {}),
          ...(consumerId ? { consumerId } : {}),
        },
        data,
      });
      // Whether the guarded write matched (this call won) or not (the run was
      // already terminal, or is owned by someone else), return the CURRENT row.
      const row = await tx.meriAgentRun.findUnique({ where: { id: runId } });
      if (!row) throw new Error(`Unknown Hermes run ${runId}`);
      if (result.count === 0 && consumerId && row.consumerId !== consumerId) {
        throw new MeriHermesConsumerFencedError(runId, consumerId);
      }
      if (result.count === 0 && consumerId && MERI_HERMES_TERMINAL_STATUSES.has(row.status as MeriHermesRunStatus)) {
        throw new MeriHermesConsumerFencedError(runId, consumerId);
      }
      return { won: result.count === 1, run: await this.loadRunFromRow(tx, row) };
    }
    const updated = await tx.meriAgentRun.update({ where: { id: runId }, data });
    return { won: true, run: await this.loadRunFromRow(tx, updated) };
  }

  /**
   * `tx` supplied: allocate the seq and insert the event against it directly
   * (no new transaction — see `update()`'s doc for why: atomic commit
   * alongside other writes in the caller's transaction, e.g. the adapter's
   * `finalize()`). `tx` omitted: resolve tenant and open our own transaction.
   *
   * ORDERED EVENT REPLAY: seq allocation is `UPDATE meri_agent_runs SET
   * last_seq = last_seq + 1 ... RETURNING last_seq` in the SAME transaction as
   * the event insert. Postgres row-level locking on that UPDATE serializes
   * concurrent `append()` calls on the same run, so two never RETURNING (and
   * therefore never inserting) the same `seq` — the correctness property
   * `eventsAfter()` (a plain ordered `seq ASC` read) depends on.
   */
  async append(
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility: 'public' | 'internal' = 'public',
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunEvent> {
    const created = tx
      ? await this.appendInTx(tx, runId, kind, payload, visibility, fence)
      : await (async () => {
          const tenantId = await this.resolveRunTenant(runId);
          if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
          return this.prisma.withTenant(tenantId, (innerTx) =>
            this.appendInTx(innerTx, runId, kind, payload, visibility, fence),
          );
        })();
    const mapped = this.toEvent(created);
    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener(mapped);
      } catch {
        // A failing subscriber must never break the run (mirrors MeriHermesRunStore).
      }
    }
    return mapped;
  }

  private async appendInTx(
    tx: Prisma.TransactionClient,
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility: 'public' | 'internal',
    fence?: RunWriteFence,
  ): Promise<MeriAgentRunEventRow> {
    // Atomic seq allocation: the UPDATE's row lock serializes concurrent
    // appends on the same run, so no two ever RETURNING the same last_seq.
    // No explicit tenant_id filter needed: these tables FORCE row-level
    // security (see the class doc), so a wrong-tenant runId simply matches
    // zero rows regardless of raw SQL vs. the ORM query hook.
    //
    // The consumer fence rides on that SAME statement: a taken-over consumer's
    // `AND consumer_id = <its id>` matches nothing, so it never even allocates
    // a seq — the event is rejected before it can enter the durable log,
    // rather than being written and then regretted.
    const consumerId = fence?.consumerId ?? null;
    const rows = consumerId
      ? await tx.$queryRaw<Array<{ last_seq: number }>>(Prisma.sql`
          UPDATE meri_agent_runs
          SET last_seq = last_seq + 1, updated_at = now()
          WHERE id = ${runId}::uuid AND consumer_id = ${consumerId}
          RETURNING last_seq
        `)
      : await tx.$queryRaw<Array<{ last_seq: number }>>(Prisma.sql`
          UPDATE meri_agent_runs
          SET last_seq = last_seq + 1, updated_at = now()
          WHERE id = ${runId}::uuid
          RETURNING last_seq
        `);
    const seq = rows[0]?.last_seq;
    if (seq === undefined && consumerId) throw new MeriHermesConsumerFencedError(runId, consumerId);
    if (seq === undefined) throw new Error(`Unknown Hermes run ${runId}`);
    const event = await tx.meriAgentRunEvent.create({
      data: {
        runId,
        seq,
        kind,
        visibility,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });
    await this.enforceEventCap(tx, runId);
    return event;
  }

  /**
   * Keep at most `maxEventsPerRun` rows: always keep seq=1 (run.accepted),
   * drop the oldest overflow among the rest, and mark the new oldest survivor
   * (after seq=1) with `truncatedBefore: true` so a reconnecting client can
   * render the gap. Count-based rather than a JS array splice (the in-memory
   * mechanics), but the same intent: a bounded log with a visible gap marker.
   *
   * PRUNING SAFETY (P1-08) — the invariant this whole ticket turns on: NEVER
   * prune an event with `seq > output_seq`. Everything at or below the snapshot
   * is already represented verbatim in `output`, so a client that recovers from
   * (`outputSnapshot`, `outputSeq`) and then asks only for `seq > outputSeq`
   * loses nothing but ephemeral tool-progress frames. An event ABOVE the
   * snapshot has no other representation anywhere, so dropping it would
   * silently truncate the assistant's answer — which is exactly the bug the
   * old unconditional `take: overflow` produced once a long run crossed the
   * 5 000-event cap. When the droppable prefix is shorter than the overflow the
   * log simply stays over the cap until the snapshot advances; over-retaining
   * is the safe direction to fail.
   */
  private async enforceEventCap(tx: Prisma.TransactionClient, runId: string): Promise<void> {
    const count = await tx.meriAgentRunEvent.count({ where: { runId } });
    if (count <= this.maxEventsPerRun) return;
    const overflow = count - this.maxEventsPerRun;
    const run = await tx.meriAgentRun.findUnique({ where: { id: runId }, select: { outputSeq: true } });
    const outputSeq = run?.outputSeq ?? 0;
    if (outputSeq <= 1) return;
    const toDrop = await tx.meriAgentRunEvent.findMany({
      where: { runId, seq: { gt: 1, lte: outputSeq } },
      orderBy: { seq: 'asc' },
      take: overflow,
      select: { id: true },
    });
    if (!toDrop.length) return;
    await tx.meriAgentRunEvent.deleteMany({ where: { id: { in: toDrop.map((r) => r.id) } } });
    const survivor = await tx.meriAgentRunEvent.findFirst({
      where: { runId, seq: { gt: 1 } },
      orderBy: { seq: 'asc' },
    });
    if (survivor) {
      const payload =
        survivor.payload && typeof survivor.payload === 'object' && !Array.isArray(survivor.payload)
          ? (survivor.payload as Record<string, unknown>)
          : {};
      await tx.meriAgentRunEvent.update({
        where: { id: survivor.id },
        data: { payload: { ...payload, truncatedBefore: true } as unknown as Prisma.InputJsonValue },
      });
    }
  }

  async eventsAfter(
    runId: string,
    afterSeq: number,
    visibility: 'public' | 'all' = 'public',
  ): Promise<MeriHermesRunEvent[]> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) return [];
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.meriAgentRunEvent.findMany({
        where: { runId, seq: { gt: afterSeq }, ...(visibility === 'all' ? {} : { visibility: 'public' }) },
        orderBy: { seq: 'asc' },
      }),
    );
    return rows.map((r) => this.toEvent(r));
  }

  /**
   * Ordered durable polling — the cross-replica delivery mechanism (P1-09).
   * See the interface doc in meri-hermes-run-store.ts for the contract and the
   * class doc above for why polling (rather than the in-process emitter) is
   * what makes it replica-agnostic AND gap-free by construction.
   *
   * Shape of the loop:
   *   poll eventsAfter(cursor) → deliver each in seq order, cursor = seq
   *   → if the batch was non-empty, poll again immediately (drain fast)
   *   → else read the run: gone → return; terminal → one final drain (to catch
   *     anything committed between the poll and the status read) → return
   *   → else sleep (woken early by a same-replica append, or by `signal`).
   *
   * The terminal check deliberately uses "nothing left at this visibility"
   * rather than `cursor >= lastSeq`: with `visibility: 'public'` a trailing
   * INTERNAL event legitimately leaves the cursor below `lastSeq` forever, and
   * waiting for it would hang the stream on every run that ends with one.
   */
  async watch(
    runId: string,
    fromSeq: number,
    onEvent: (event: MeriHermesRunEvent) => void | Promise<void>,
    signal: AbortSignal,
    opts?: { visibility?: 'public' | 'all'; intervalMs?: number },
  ): Promise<void> {
    const visibility = opts?.visibility ?? 'public';
    const intervalMs = meriHermesWatchIntervalMs(opts?.intervalMs);
    let cursor = fromSeq;
    const deliver = async (events: MeriHermesRunEvent[]): Promise<boolean> => {
      for (const event of events) {
        if (signal.aborted) return false;
        cursor = event.seq;
        await onEvent(event);
      }
      return true;
    };
    for (;;) {
      if (signal.aborted) return;
      const batch = await this.eventsAfter(runId, cursor, visibility);
      if (!(await deliver(batch))) return;
      if (batch.length) continue;
      const run = await this.get(runId);
      // A swept/unknown run has nothing more to deliver, ever.
      if (!run) return;
      if (MERI_HERMES_TERMINAL_STATUSES.has(run.status)) {
        await deliver(await this.eventsAfter(runId, cursor, visibility));
        return;
      }
      await this.sleepUntilWakeOrTimeout(runId, intervalMs, signal);
    }
  }

  /**
   * Sleep `ms`, returning early on abort or on a same-replica `append()` for
   * this run. The early wake is a LATENCY optimisation only — if the producing
   * append happens on another replica nothing fires here and the poll simply
   * runs at its normal interval, which is why `watch()` is correct
   * cross-replica without any shared pub/sub.
   */
  private sleepUntilWakeOrTimeout(runId: string, ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const unsubscribe = this.subscribe(runId, () => done());
      const timer = setTimeout(() => done(), ms);
      function done(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * In-process pub/sub — a wake signal for `watch()` on this replica, not a
   * delivery path (see class doc). It cannot verify the run exists in the
   * database without breaking the "no await" contract every call site relies
   * on; a subscription on an unknown/wrong-replica runId is harmless because
   * nothing publishes to it until a same-replica append() (which does verify
   * the run) fires.
   */
  subscribe(runId: string, listener: MeriHermesRunListener): () => void {
    const set = this.listeners.get(runId) ?? new Set<MeriHermesRunListener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  async addInteraction(runId: string, interaction: MeriHermesPendingInteraction): Promise<void> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
    await this.prisma.withTenant(tenantId, async (tx) => {
      try {
        await tx.meriAgentInteraction.create({
          data: {
            runId,
            requestId: interaction.requestId,
            kind: interaction.kind,
            continuation: interaction.continuation,
            prompt: interaction.prompt,
            choices: interaction.choices as unknown as Prisma.InputJsonValue,
            multiSelect: interaction.multiSelect,
            createdAt: new Date(interaction.createdAt),
            expiresAt: interaction.expiresAt ? new Date(interaction.expiresAt) : null,
            // resolution is left unset (SQL NULL) here; resolveInteraction() below
            // is the only writer, matching the in-memory store's `resolution: null`.
          },
        });
      } catch (error) {
        // (runId, requestId) already exists: dedupe as a no-op, same as
        // MeriHermesRunStore.addInteraction's `.some(...) return`.
        if (!isUniqueConstraintViolation(error, 'meri_agent_interactions_run_request_key')) throw error;
      }
    });
  }

  async resolveInteraction(
    runId: string,
    requestId: string,
    resolution: NonNullable<MeriHermesPendingInteraction['resolution']>,
  ): Promise<MeriHermesPendingInteraction | null> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) throw new Error(`Unknown Hermes run ${runId}`);
    return this.prisma.withTenant(tenantId, async (tx) => {
      // Atomic check-and-set: only resolves a row that is still unresolved, so
      // two concurrent resolutions of the same interaction can't both "win".
      const result = await tx.meriAgentInteraction.updateMany({
        where: { runId, requestId, resolution: { equals: Prisma.DbNull } },
        data: { resolution: resolution as unknown as Prisma.InputJsonValue },
      });
      if (result.count === 0) return null;
      const row = await tx.meriAgentInteraction.findUnique({ where: { runId_requestId: { runId, requestId } } });
      return row ? this.toInteraction(row) : null;
    });
  }

  async listActiveForScope(executionScopeId: string): Promise<MeriHermesRunRecord[]> {
    const tenantId = await this.resolveScopeTenant(executionScopeId);
    if (!tenantId) return [];
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.meriAgentRun.findMany({
        where: { scopeId: executionScopeId, status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] } },
        orderBy: { createdAt: 'asc' },
      });
      return Promise.all(rows.map((r) => this.loadRunFromRow(tx, r)));
    });
  }

  async listForConversation(tenantId: string, actorId: string, conversationId: string): Promise<MeriHermesRunRecord[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.meriAgentRun.findMany({
        where: { tenantId, actorId, conversationId },
        orderBy: { createdAt: 'asc' },
      });
      return Promise.all(rows.map((r) => this.loadRunFromRow(tx, r)));
    });
  }

  /**
   * Conversation-scoped discovery (P1-10) — what makes a client-side
   * `sessionStorage` run pointer unnecessary. Ownership is applied in the
   * WHERE clause (tenant + actor), exactly like `requireOwned`, so a
   * conversation belonging to someone else yields the same empty answer as an
   * unknown one and the caller can 404 both identically.
   *
   * The two halves are deliberately asymmetric:
   *   - `run` is the most recent NON-TERMINAL run only. A finished run is not
   *     something to reattach a live stream to.
   *   - `pendingInteractions` spans EVERY run of the conversation, terminal
   *     ones included, and is filtered on `resolution IS NULL`. That is the
   *     whole point: a clarification is a `durable_continuation` — the run
   *     that asked it ends its turn immediately (contracts.md §3), so if
   *     discovery hid interactions on terminal runs, every clarification
   *     would become unanswerable the moment it was asked.
   */
  async findConversationActivity(
    tenantId: string,
    actorId: string,
    conversationId: string,
  ): Promise<MeriHermesConversationActivity> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const active = await tx.meriAgentRun.findFirst({
        where: {
          tenantId,
          actorId,
          conversationId,
          status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const interactions = await tx.meriAgentInteraction.findMany({
        where: {
          resolution: { equals: Prisma.DbNull },
          run: { tenantId, actorId, conversationId },
        },
        orderBy: { createdAt: 'asc' },
      });
      return {
        run: active ? await this.loadRunFromRow(tx, active) : null,
        pendingInteractions: interactions.map((i) => ({ ...this.toInteraction(i), runId: i.runId })),
      };
    });
  }

  /**
   * Atomic consumer-lease claim (P1-09). ONE conditional `updateMany`: the row
   * moves only if the run is still non-terminal AND the lease is free, already
   * ours, or stale beyond `staleAfterMs`. Two replicas racing to take over the
   * same run cannot both win — Postgres serializes the two UPDATEs on the row
   * and re-evaluates the loser's WHERE against the winner's committed version,
   * where `consumer_id` is now the winner's and the heartbeat is fresh, so the
   * loser matches zero rows. (An application-level read-then-write would let
   * both pass the read.)
   */
  async claimConsumer(
    runId: string,
    consumerId: string,
    staleAfterMs: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) return false;
    const cutoff = new Date(now.getTime() - staleAfterMs);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const result = await tx.meriAgentRun.updateMany({
        where: {
          id: runId,
          status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] },
          OR: [
            { consumerId: null },
            { consumerId },
            { consumerHeartbeatAt: null },
            { consumerHeartbeatAt: { lt: cutoff } },
          ],
        },
        data: { consumerId, consumerHeartbeatAt: now },
      });
      return result.count === 1;
    });
  }

  /** Renew our own lease; `false` means we lost it (or the run went terminal) and must stop consuming. */
  async heartbeatConsumer(runId: string, consumerId: string, now: Date = new Date()): Promise<boolean> {
    const tenantId = await this.resolveRunTenant(runId);
    if (!tenantId) return false;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const result = await tx.meriAgentRun.updateMany({
        where: { id: runId, consumerId, status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] } },
        data: { consumerHeartbeatAt: now },
      });
      return result.count === 1;
    });
  }

  /**
   * Runs whose consuming replica appears to be gone: non-terminal, already
   * dispatched to Hermes (so there IS something to resume or to close out
   * honestly), and with a heartbeat that is stale or was never written.
   * Cross-tenant by nature (a replica scans for orphans regardless of tenant),
   * hence `withSystem`, mirroring `sweep()`/`reconcileStuckDispatches()`.
   */
  async listTakeoverCandidates(
    staleAfterMs: number,
    now: Date = new Date(),
    opts?: { tenantId?: string },
  ): Promise<MeriHermesRunRecord[]> {
    const cutoff = new Date(now.getTime() - staleAfterMs);
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.meriAgentRun.findMany({
        where: {
          status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] },
          dispatchStatus: 'dispatched',
          ...(opts?.tenantId ? { tenantId: opts.tenantId } : {}),
          /**
           * A NULL heartbeat alone is NOT evidence of an orphan. There is a
           * real window in `streamMessage` between marking a run `dispatched`
           * and `consume()` claiming the lease, during which a perfectly
           * healthy run has no heartbeat yet — and since the recovery sweep
           * now runs on a request path, treating that as stale would let it
           * take over and interrupt a run that had just started. So a run
           * that has never been heartbeated qualifies only once it has ALSO
           * been untouched for the stale window: `updatedAt` advances on
           * every append, so a live consumer keeps it fresh and a dead one
           * does not.
           */
          OR: [
            { consumerHeartbeatAt: { lt: cutoff } },
            { consumerHeartbeatAt: null, updatedAt: { lt: cutoff } },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });
      return Promise.all(rows.map((r) => this.loadRunFromRow(tx, r)));
    });
  }

  /**
   * P1-07 ambiguous-startup reconciliation (not wired to a scheduler in this
   * pass — Phase 1 scheduler territory; see the caller-side note in
   * meri-hermes-runtime.adapter.ts). Finds runs whose admission committed
   * (`dispatchStatus: 'pending'`) but whose dispatch to Hermes was never
   * durably confirmed within `olderThanMs`, and marks them `interrupted` —
   * NEVER retried, since Hermes may or may not have actually started the run
   * (a crash between "admitted" and "recorded dispatched" is genuinely
   * ambiguous). The `updateMany` WHERE re-checks BOTH `dispatchStatus:
   * 'pending'` AND a non-terminal `status` at write time (not just at
   * selection time), so a row that raced to `dispatched` (dispatch actually
   * succeeded) or to some other terminal status via the normal path in the
   * meantime is left alone — the same "don't clobber a row that already moved
   * on" guarantee `update()`'s fenced terminal transition gives, applied here
   * to the dispatch-status axis too. Cross-tenant by nature (a global sweep),
   * hence `withSystem`, mirroring `sweep()`. Returns the count reconciled.
   */
  async reconcileStuckDispatches(olderThanMs: number, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanMs);
    return this.prisma.withSystem(async (tx) => {
      const result = await tx.meriAgentRun.updateMany({
        where: {
          dispatchStatus: 'pending',
          createdAt: { lt: cutoff },
          status: { notIn: [...MERI_HERMES_TERMINAL_STATUSES] },
        },
        data: {
          status: 'interrupted',
          finishReason: 'interrupted',
          error:
            'Admission succeeded but dispatch to Hermes was never confirmed (process crash or timeout); treated as ambiguous startup, not retried.',
          dispatchStatus: 'failed',
          finishedAt: now,
        },
      });
      return result.count;
    });
  }

  /** Global TTL sweep: inherently cross-tenant, hence withSystem. FK cascade removes events/interactions. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - DEFAULT_TTL_MS);
    return this.prisma.withSystem(async (tx) => {
      const result = await tx.meriAgentRun.deleteMany({
        where: {
          status: { in: [...MERI_HERMES_TERMINAL_STATUSES] },
          OR: [{ finishedAt: { lt: cutoff } }, { finishedAt: null, updatedAt: { lt: cutoff } }],
        },
      });
      return result.count;
    });
  }

  // ---------------------------------------------------------------------------
  // Tenant resolution for id-only interface methods (see class doc)
  // ---------------------------------------------------------------------------

  /**
   * Memo for `resolveRunTenant`. A run's tenant is immutable for the run's
   * whole life, and nearly every id-only interface method needs it, so the
   * lookup was costing an extra transaction per call — including once per
   * consumer heartbeat, several times a second per live run. Under load that
   * was enough on its own to exhaust the connection pool and start timing out
   * transactions ("Unable to start a transaction in the given time"), which
   * matters here because the pilot envelope caps Hermes-attributable
   * connections at 20% of the API pool.
   *
   * Bounded and self-correcting: a wrong or stale entry cannot leak data,
   * because the query it scopes still filters on the run id and RLS still
   * applies — a deleted run simply returns null from the real query.
   */
  private readonly runTenantMemo = new Map<string, string>();
  private static readonly RUN_TENANT_MEMO_MAX = 2000;

  private async resolveRunTenant(runId: string): Promise<string | null> {
    const memoized = this.runTenantMemo.get(runId);
    if (memoized) return memoized;
    const row = await this.prisma.withSystem((tx) =>
      tx.meriAgentRun.findUnique({ where: { id: runId }, select: { tenantId: true } }),
    );
    if (!row?.tenantId) return null;
    if (this.runTenantMemo.size >= MeriHermesPrismaRunRepository.RUN_TENANT_MEMO_MAX) {
      // Cheap bound: drop the oldest insertion. Nothing depends on retention.
      const oldest = this.runTenantMemo.keys().next();
      if (!oldest.done) this.runTenantMemo.delete(oldest.value);
    }
    this.runTenantMemo.set(runId, row.tenantId);
    return row.tenantId;
  }

  private async resolveHermesRunTenant(hermesRunId: string): Promise<string | null> {
    const row = await this.prisma.withSystem((tx) =>
      tx.meriAgentRun.findUnique({ where: { hermesRunId }, select: { tenantId: true } }),
    );
    return row?.tenantId ?? null;
  }

  private async resolveScopeTenant(executionScopeId: string): Promise<string | null> {
    const row = await this.prisma.withSystem((tx) =>
      tx.meriExecutionScope.findUnique({ where: { id: executionScopeId }, select: { tenantId: true } }),
    );
    return row?.tenantId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Row -> domain mapping
  // ---------------------------------------------------------------------------

  private async loadRun(tx: Prisma.TransactionClient, runId: string): Promise<MeriHermesRunRecord | null> {
    const row = await tx.meriAgentRun.findUnique({ where: { id: runId } });
    return row ? this.loadRunFromRow(tx, row) : null;
  }

  private async loadRunFromRow(tx: Prisma.TransactionClient, row: MeriAgentRunRow): Promise<MeriHermesRunRecord> {
    const interactions = await tx.meriAgentInteraction.findMany({
      where: { runId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    return this.toRecord(row, interactions);
  }

  private toRecord(row: MeriAgentRunRow, interactions: MeriAgentInteractionRow[]): MeriHermesRunRecord {
    return {
      runId: row.id,
      hermesRunId: row.hermesRunId,
      hermesSessionId: row.hermesSessionId,
      envelope: row.envelope as unknown as MeriHermesAuthorizationEnvelope,
      actorContext: row.actorContext as unknown as MeriHermesRunRecord['actorContext'],
      idempotencyKey: row.idempotencyKey,
      userMessageId: row.userMessageId,
      assistantMessageId: row.assistantMessageId,
      status: row.status as MeriHermesRunStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      lastSeq: row.lastSeq,
      output: row.output,
      outputSeq: row.outputSeq,
      usage: (row.usage as unknown as MeriHermesUsage | null) ?? null,
      error: row.error,
      finishReason: row.finishReason,
      partial: row.partial,
      pendingInteractions: interactions.map((i) => this.toInteraction(i)),
      detached: row.detached,
      stopRequestedAt: row.stopRequestedAt ? row.stopRequestedAt.toISOString() : null,
      brokerCalls: row.brokerCalls,
      dispatchStatus: row.dispatchStatus as MeriHermesRunRecord['dispatchStatus'],
      dispatchAttempts: row.dispatchAttempts,
      consumerId: row.consumerId,
      consumerHeartbeatAt: row.consumerHeartbeatAt ? row.consumerHeartbeatAt.toISOString() : null,
    };
  }

  private toInteraction(row: MeriAgentInteractionRow): MeriHermesPendingInteraction {
    return {
      requestId: row.requestId,
      kind: row.kind as MeriHermesInteractionKind,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      prompt: row.prompt,
      choices: Array.isArray(row.choices) ? (row.choices as unknown as string[]) : [],
      multiSelect: row.multiSelect,
      continuation: row.continuation as MeriHermesPendingInteraction['continuation'],
      resolution: (row.resolution as unknown as MeriHermesPendingInteraction['resolution']) ?? null,
    };
  }

  private toEvent(row: MeriAgentRunEventRow): MeriHermesRunEvent {
    return {
      seq: row.seq,
      runId: row.runId,
      at: row.at.toISOString(),
      kind: row.kind as MeriHermesRunEventKind,
      visibility: row.visibility as 'public' | 'internal',
      payload: (row.payload as Record<string, unknown>) ?? {},
    };
  }
}
