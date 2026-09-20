/**
 * In-memory durable-run test double for the Hermes runtime — Phase 0 PROTOTYPE,
 * kept in Phase 1 as the fast in-memory `MeriHermesRunRepository` implementation.
 *
 * Meri, not the worker, is the canonical owner of run status, the sequenced
 * event log and pending interactions. This class keeps that state in process
 * memory behind the `MeriHermesRunRepository` interface. Phase 1 backlog #1
 * added `MeriHermesPrismaRunRepository` (meri-hermes-prisma-run-repository.ts),
 * a Prisma-backed sibling behind the SAME interface, wired as the real runtime
 * implementation via the `MERI_HERMES_RUN_REPOSITORY` token in meri.module.ts.
 * This class remains provided/exported for specs and any consumer that wants
 * the fast in-memory double on purpose.
 *
 * What survives here: browser detach/reconnect within one API process.
 * What does NOT (documented limitation): API process restart, multi-replica —
 * see `MeriHermesPrismaRunRepository` for the durable implementation.
 *
 * Public event payloads carry a `frames` array: the exact Meri SSE frames the
 * browser should receive for that event. Replay after reconnect is therefore
 * a straight filter on `seq > cursor`.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  MERI_HERMES_TERMINAL_STATUSES,
  type MeriHermesAuthorizationEnvelope,
  type MeriHermesPendingInteraction,
  type MeriHermesRunEvent,
  type MeriHermesRunEventKind,
  type MeriHermesRunStatus,
  type MeriHermesUsage,
} from './hermes-runtime.contracts.js';

/** Durable-dispatch outbox lite (P1-02): see the `dispatchStatus` column comment on `MeriAgentRun` in schema.prisma. */
export type MeriHermesDispatchStatus = 'pending' | 'dispatched' | 'failed';

/**
 * Thrown by `MeriHermesRunRepository.create()` when a NEW, distinct submission
 * (a different idempotency key) targets a conversation that already has a
 * live (non-terminal) run — the single-writer-per-conversation lease P1-02
 * requires. An identical resubmit (same idempotency key) never throws this;
 * `create()` reattaches to the existing run instead. Carries the occupying
 * run's id so the caller can build an actionable conflict response. Only
 * `MeriHermesPrismaRunRepository` throws this today (the in-memory store has
 * no conversation-level occupancy concept — see its class doc).
 */
export class MeriHermesConversationOccupiedError extends Error {
  constructor(public readonly occupyingRunId: string) {
    super(`Conversation already has an active run (${occupyingRunId})`);
    this.name = 'MeriHermesConversationOccupiedError';
  }
}

/**
 * Thrown by a FENCED `append()` / `update()` (one carrying
 * `{ consumerId }`) when that consumer no longer holds the run's lease —
 * because another replica took the run over, or because the run went
 * terminal. P1-09 gave the lease an atomic claim and a heartbeat, but the
 * WRITE path never checked it: a consumer whose heartbeat had already failed
 * kept appending events and overwriting `output`, so a taken-over run's
 * durable log interleaved two writers. The fence closes that: after a
 * takeover the old consumer's writes are rejected at the database, not merely
 * discouraged by a flag it might not have read yet.
 *
 * It is a normal, expected outcome — the losing consumer catches it, stops
 * consuming and terminates cleanly. It is never a reason to fail a run.
 */
export class MeriHermesConsumerFencedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly consumerId: string,
  ) {
    super(`Consumer ${consumerId} no longer owns run ${runId}`);
    this.name = 'MeriHermesConsumerFencedError';
  }
}

/**
 * Write-side fence for the consumer lease. When `consumerId` is present the
 * write only applies while that consumer still owns a non-terminal run;
 * otherwise it is rejected with `MeriHermesConsumerFencedError` and nothing is
 * written. Omitting it leaves the write unfenced, which is correct for the
 * paths that are NOT the stream consumer (admission, browser detach, explicit
 * Stop, broker tool calls, takeover recovery).
 */
export interface RunWriteFence {
  consumerId?: string | null;
}

export interface MeriHermesRunRecord {
  runId: string;
  hermesRunId: string | null;
  hermesSessionId: string | null;
  envelope: MeriHermesAuthorizationEnvelope;
  /**
   * Server-side snapshot of the authenticated actor (never sent to a worker).
   * Used to re-enter Meri services (Context Plane, memory) on the actor's behalf.
   */
  actorContext: TenantContext;
  idempotencyKey: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  status: MeriHermesRunStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastSeq: number;
  output: string;
  /**
   * Pruning-safe recovery snapshot cursor (P1-08): the `seq` of the last event
   * whose content is already represented in `output`. Written in the SAME
   * transaction as that event, so the two can never diverge. A recovering
   * client takes `output` as authoritative up to here and then asks only for
   * `seq > outputSeq`; the event cap correspondingly never prunes an event
   * above this line.
   */
  outputSeq: number;
  usage: MeriHermesUsage | null;
  error: string | null;
  finishReason: string | null;
  partial: boolean;
  pendingInteractions: MeriHermesPendingInteraction[];
  /** True once the originating browser connection went away while the run was live. */
  detached: boolean;
  stopRequestedAt: string | null;
  brokerCalls: number;
  /** Durable-dispatch outbox lite (P1-02) — see `MeriHermesDispatchStatus`. */
  dispatchStatus: MeriHermesDispatchStatus;
  dispatchAttempts: number;
  /** Consumer lease owner (P1-09): the replica consuming Hermes's stream, or null. */
  consumerId: string | null;
  /** Consumer lease liveness; stale (or null) means the run may be taken over. */
  consumerHeartbeatAt: string | null;
}

/**
 * Everything the conversation-scoped discovery endpoint
 * (`GET /api/clio/hermes/conversations/:conversationId/active`) needs, in ONE
 * repository round trip. `run` is the most recent NON-terminal run for
 * (tenant, actor, conversation) — the answer to "is something still running
 * here?" without any client-side pointer. `pendingInteractions` deliberately
 * spans TERMINAL runs too: a clarification is a `durable_continuation`, so it
 * must stay answerable after the run that asked it has ended.
 */
export interface MeriHermesConversationActivity {
  run: MeriHermesRunRecord | null;
  pendingInteractions: Array<MeriHermesPendingInteraction & { runId: string }>;
}

export type MeriHermesRunListener = (event: MeriHermesRunEvent) => void;

export type RunPatch = Partial<
  Omit<MeriHermesRunRecord, 'runId' | 'envelope' | 'actorContext' | 'lastSeq' | 'createdAt'>
>;

export interface MeriHermesRunCreateInput {
  envelope: MeriHermesAuthorizationEnvelope;
  actorContext: TenantContext;
  idempotencyKey: string;
  userMessageId: string | null;
}

/**
 * All I/O methods are async (Postgres-backed in production via
 * `MeriHermesPrismaRunRepository`). `subscribe` is the one exception: it is
 * in-process pub/sub for live SSE forwarding within one API replica, not a
 * database read, and every call site relies on it being callable without an
 * `await`. See `MeriHermesPrismaRunRepository`'s class doc for what this means
 * for cross-replica live push vs. replay.
 */
export interface MeriHermesRunRepository {
  create(input: MeriHermesRunCreateInput): Promise<MeriHermesRunRecord>;
  get(runId: string): Promise<MeriHermesRunRecord | null>;
  findByHermesRunId(hermesRunId: string): Promise<MeriHermesRunRecord | null>;
  findByIdempotencyKey(executionScopeId: string, idempotencyKey: string): Promise<MeriHermesRunRecord | null>;
  requireOwned(runId: string, tenantId: string, actorId: string): Promise<MeriHermesRunRecord | null>;
  /**
   * `tx`: an optional externally-supplied transaction client (Prisma-backed
   * implementation only; the in-memory store accepts and ignores it — it has
   * no transactions). Passing one lets a caller (e.g. the adapter's
   * `finalize()`) commit this write atomically together with other writes
   * (an assistant `ClioMessage` create, another `append()`) in ONE
   * transaction. When omitted, the call runs in its own transaction as before.
   * A patch that sets `status` to a terminal value is a FENCED transition:
   * only a run that is still non-terminal actually moves, so two racing
   * terminal updates (e.g. an explicit Stop crossing a late Hermes success
   * callback) can never both "win" — the loser gets the current (already
   * terminal) row back instead of throwing or silently overwriting it. Use
   * `transitionTerminal()` when the caller needs to KNOW which side it was on.
   *
   * `fence`: see `RunWriteFence`. A consumer that has lost the lease is
   * rejected with `MeriHermesConsumerFencedError` and writes nothing.
   */
  update(
    runId: string,
    patch: RunPatch,
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunRecord>;
  /**
   * The fenced terminal transition of `update()`, with the winner made
   * explicit: `won` is true for exactly ONE caller per run — the one whose
   * guarded write actually moved the run from non-terminal to terminal. Every
   * later/racing caller gets `won: false` and the current terminal row.
   *
   * That distinction is what makes finalization atomic (P1-12): the assistant
   * `ClioMessage` and the final event may only be published by the winner, so
   * competing completion / Stop / revocation paths can no longer each persist
   * their own assistant message for one turn before discovering they lost.
   * Pass the same `tx` used for those writes so the decision and the
   * publication commit together.
   */
  transitionTerminal(
    runId: string,
    patch: RunPatch,
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<{ won: boolean; run: MeriHermesRunRecord }>;
  /**
   * ATOMIC tool-budget reservation (closeout defect A4). Consumes one unit of
   * the run's `budget.maxToolCalls` and reports whether it was admitted, in a
   * SINGLE conditional statement — never read-then-write.
   *
   * The broker used to do `const calls = auth.run.brokerCalls + 1` against a
   * snapshot taken at `authorize()` and write it back with a plain `SET`.
   * Parallel tool calls are normal for an agent runtime, so N concurrent
   * calls all read the same snapshot and all wrote `snapshot + 1`: the
   * declared budget was a suggestion, not a cap.
   *
   * Contract for every implementation:
   *   - Over the whole life of a run, AT MOST `maxToolCalls` calls may return
   *     `admitted: true`, no matter how many run concurrently.
   *   - `brokerCalls` is the counter value AFTER a successful reservation, or
   *     the current (unchanged) value when refused.
   *   - Refusal must not consume budget.
   *   - An unknown run id throws, exactly as `update()` does; it is never
   *     reported as a quiet refusal.
   *
   * `maxToolCalls <= 0` means no tool call is ever admitted.
   */
  reserveBrokerCall(runId: string, maxToolCalls: number): Promise<{ admitted: boolean; brokerCalls: number }>;
  append(
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility?: 'public' | 'internal',
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunEvent>;
  eventsAfter(runId: string, afterSeq: number, visibility?: 'public' | 'all'): Promise<MeriHermesRunEvent[]>;
  /**
   * Durable, REPLICA-AGNOSTIC subscription (P1-09). Polls `eventsAfter` on an
   * interval, delivers every matching event in `seq` order exactly once,
   * advances its own cursor, and resolves when the run reaches a terminal
   * status with nothing left to deliver, or when `signal` aborts.
   *
   * Why polling and not the in-process emitter: `subscribe()` is a
   * process-local listener map, so a browser attached to replica B never sees
   * events produced by replica A. `watch()` reads the durable log, so any
   * replica sees every event. Because the cursor is always
   * `seq > lastDelivered`, there is NO replay/live handoff seam by
   * construction — the "read history, then attach a live subscription" pattern
   * this replaces had a gap window between the two steps. The in-process
   * emitter survives only as a latency optimisation that wakes the poll early;
   * correctness never depends on it (proved by
   * meri-hermes-cross-replica.spec.ts, which uses two independently
   * constructed repositories that share no emitter).
   *
   * Delivery is strictly serialized: an async `onEvent` is awaited before the
   * next event is handed over, so a consumer can do ordered I/O per event.
   * Poll interval: `opts.intervalMs`, else `MERI_HERMES_WATCH_INTERVAL_MS`,
   * else 300 ms.
   */
  watch(
    runId: string,
    fromSeq: number,
    onEvent: (event: MeriHermesRunEvent) => void | Promise<void>,
    signal: AbortSignal,
    opts?: { visibility?: 'public' | 'all'; intervalMs?: number },
  ): Promise<void>;
  subscribe(runId: string, listener: MeriHermesRunListener): () => void;
  addInteraction(runId: string, interaction: MeriHermesPendingInteraction): Promise<void>;
  resolveInteraction(
    runId: string,
    requestId: string,
    resolution: NonNullable<MeriHermesPendingInteraction['resolution']>,
  ): Promise<MeriHermesPendingInteraction | null>;
  listActiveForScope(executionScopeId: string): Promise<MeriHermesRunRecord[]>;
  listForConversation(tenantId: string, actorId: string, conversationId: string): Promise<MeriHermesRunRecord[]>;
  /**
   * Conversation-scoped discovery (P1-10): the active run and every UNRESOLVED
   * interaction for one owned conversation, including interactions whose run
   * already went terminal. Owner-scoped by (tenantId, actorId) in the query
   * itself, so a conversation the caller does not own is indistinguishable
   * from an unknown one.
   */
  findConversationActivity(
    tenantId: string,
    actorId: string,
    conversationId: string,
  ): Promise<MeriHermesConversationActivity>;
  /**
   * Claim (or renew) the consumer lease for `runId` (P1-09). Succeeds when the
   * run is non-terminal AND the lease is free, already ours, or stale beyond
   * `staleAfterMs`. Atomic: two concurrent claims by different replicas can
   * never both return true.
   */
  claimConsumer(runId: string, consumerId: string, staleAfterMs: number, now?: Date): Promise<boolean>;
  /** Renew our lease. `false` means we lost it (or the run is terminal) — stop consuming. */
  heartbeatConsumer(runId: string, consumerId: string, now?: Date): Promise<boolean>;
  /**
   * Non-terminal, already-dispatched runs whose consumer heartbeat is stale
   * (takeover candidates). `opts.tenantId` narrows the scan to one tenant,
   * which is what the request-driven recovery sweep uses: a replica serving a
   * request for tenant T recovers T's orphans and never reaches across
   * tenants it was not asked about. Omitted = the global scan a scheduler
   * would use.
   */
  listTakeoverCandidates(
    staleAfterMs: number,
    now?: Date,
    opts?: { tenantId?: string },
  ): Promise<MeriHermesRunRecord[]>;
  /**
   * P1-07 ambiguous-startup reconciliation: admitted (`dispatchStatus:
   * 'pending'`) but never confirmed dispatched within `olderThanMs` → marked
   * `interrupted`, never retried. On the interface (not just the Prisma class)
   * because the admission path and the discovery endpoint both call it.
   */
  reconcileStuckDispatches(olderThanMs: number, now?: Date): Promise<number>;
  sweep(now?: Date): Promise<number>;
}

/**
 * DI token for `MeriHermesRunRepository` (an interface, not a class — same
 * pattern as `MERI_HERMES_SECURITY_ENVELOPE` in meri-hermes-security.port.ts).
 * `meri.module.ts` binds this to `MeriHermesPrismaRunRepository` for real
 * runtime wiring; specs may construct `MeriHermesRunStore` directly instead.
 */
export const MERI_HERMES_RUN_REPOSITORY = Symbol('MERI_HERMES_RUN_REPOSITORY');

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EVENTS_PER_RUN = 5000;
/** Default `watch()` poll interval; override per call or via `MERI_HERMES_WATCH_INTERVAL_MS`. */
export const DEFAULT_WATCH_INTERVAL_MS = 300;

/** Resolve the effective `watch()` poll interval (explicit > env > default). */
export function meriHermesWatchIntervalMs(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromEnv = Number(env.MERI_HERMES_WATCH_INTERVAL_MS ?? '');
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_WATCH_INTERVAL_MS;
}

@Injectable()
export class MeriHermesRunStore implements MeriHermesRunRepository {
  private readonly runs = new Map<string, MeriHermesRunRecord>();
  private readonly events = new Map<string, MeriHermesRunEvent[]>();
  private readonly listeners = new Map<string, Set<MeriHermesRunListener>>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly byHermesRunId = new Map<string, string>();

  // Not constructor parameters: Nest would try to inject Number/Function by type.
  private ttlMs: number = DEFAULT_TTL_MS;
  private now: () => Date = () => new Date();

  /**
   * Test seam, mirroring `MeriHermesPrismaRunRepository.maxEventsPerRun`:
   * exercising the pruning rules for real is cheaper at a cap of ~20 events
   * than at 5 000. Production never assigns this.
   */
  maxEventsPerRun: number = MAX_EVENTS_PER_RUN;

  /** Test seam: a store with an explicit TTL and clock. */
  static withClock(ttlMs: number, now: () => Date): MeriHermesRunStore {
    const store = new MeriHermesRunStore();
    store.ttlMs = ttlMs;
    store.now = now;
    return store;
  }

  async create(input: MeriHermesRunCreateInput): Promise<MeriHermesRunRecord> {
    const existing = await this.findByIdempotencyKey(input.envelope.executionScopeId, input.idempotencyKey);
    if (existing) return existing;
    const at = this.now().toISOString();
    const record: MeriHermesRunRecord = {
      runId: input.envelope.runId || randomUUID(),
      hermesRunId: null,
      hermesSessionId: null,
      envelope: input.envelope,
      actorContext: input.actorContext,
      idempotencyKey: input.idempotencyKey,
      userMessageId: input.userMessageId,
      assistantMessageId: null,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      lastSeq: 0,
      output: '',
      outputSeq: 0,
      usage: null,
      error: null,
      finishReason: null,
      partial: false,
      pendingInteractions: [],
      detached: false,
      stopRequestedAt: null,
      brokerCalls: 0,
      dispatchStatus: 'pending',
      dispatchAttempts: 0,
      consumerId: null,
      consumerHeartbeatAt: null,
    };
    this.runs.set(record.runId, record);
    this.events.set(record.runId, []);
    this.byIdempotency.set(
      this.idemKey(input.envelope.executionScopeId, input.idempotencyKey),
      record.runId,
    );
    await this.append(record.runId, 'run.accepted', {
      idempotencyKey: input.idempotencyKey,
      executionScopeId: input.envelope.executionScopeId,
      frames: [],
    });
    return record;
  }

  async get(runId: string): Promise<MeriHermesRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async findByHermesRunId(hermesRunId: string): Promise<MeriHermesRunRecord | null> {
    const runId = this.byHermesRunId.get(hermesRunId);
    return runId ? this.get(runId) : null;
  }

  async findByIdempotencyKey(executionScopeId: string, idempotencyKey: string): Promise<MeriHermesRunRecord | null> {
    const runId = this.byIdempotency.get(this.idemKey(executionScopeId, idempotencyKey));
    return runId ? this.get(runId) : null;
  }

  /** Ownership check: same tenant AND same actor. A guessed run id from another user is "not found". */
  async requireOwned(runId: string, tenantId: string, actorId: string): Promise<MeriHermesRunRecord | null> {
    const run = await this.get(runId);
    if (!run) return null;
    if (run.envelope.tenantId !== tenantId || run.envelope.actorId !== actorId) return null;
    return run;
  }

  /** `tx` is accepted for interface parity with `MeriHermesPrismaRunRepository` and ignored — this store has no transactions. */
  async update(
    runId: string,
    patch: RunPatch,
    _tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunRecord> {
    const run = this.require(runId);
    this.assertOwns(run, fence);
    const wasTerminal = MERI_HERMES_TERMINAL_STATUSES.has(run.status);
    // A terminal run's status is immutable — mirrors the Prisma repository's
    // guarded status write, so a Stop that lost the race cannot move a
    // finished run back to `cancelling`.
    if (wasTerminal && patch.status !== undefined) return run;
    if (patch.hermesRunId && patch.hermesRunId !== run.hermesRunId) {
      if (run.hermesRunId) this.byHermesRunId.delete(run.hermesRunId);
      this.byHermesRunId.set(patch.hermesRunId, runId);
    }
    Object.assign(run, patch, { updatedAt: this.now().toISOString() });
    if (!wasTerminal && patch.status && MERI_HERMES_TERMINAL_STATUSES.has(patch.status)) {
      run.finishedAt = run.finishedAt ?? this.now().toISOString();
    }
    return run;
  }

  /**
   * In-memory equivalent of the Prisma repository's guarded terminal
   * `updateMany`: this single-threaded store has no concurrent writers, so
   * "did I win" is simply "was the run still non-terminal when I got here",
   * and a loser applies NOTHING.
   */
  async transitionTerminal(
    runId: string,
    patch: RunPatch,
    tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<{ won: boolean; run: MeriHermesRunRecord }> {
    const existing = this.require(runId);
    this.assertOwns(existing, fence);
    if (MERI_HERMES_TERMINAL_STATUSES.has(existing.status)) return { won: false, run: existing };
    return { won: true, run: await this.update(runId, patch, tx, fence) };
  }

  /**
   * In-memory equivalent of the Prisma repository's conditional
   * `UPDATE … SET broker_calls = broker_calls + 1 WHERE broker_calls < $limit
   * RETURNING broker_calls`. The check and the increment are one synchronous
   * block with NO `await` between them, so the JavaScript event loop cannot
   * interleave two reservations here any more than Postgres's row lock can
   * interleave two of them there. That is what makes `maxToolCalls` an actual
   * cap rather than a snapshot-plus-one race (closeout defect A4).
   */
  async reserveBrokerCall(
    runId: string,
    maxToolCalls: number,
  ): Promise<{ admitted: boolean; brokerCalls: number }> {
    const run = this.require(runId);
    if (!(run.brokerCalls < maxToolCalls)) return { admitted: false, brokerCalls: run.brokerCalls };
    run.brokerCalls += 1;
    run.updatedAt = this.now().toISOString();
    return { admitted: true, brokerCalls: run.brokerCalls };
  }

  /** `tx` is accepted for interface parity with `MeriHermesPrismaRunRepository` and ignored — this store has no transactions. */
  async append(
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility: 'public' | 'internal' = 'public',
    _tx?: Prisma.TransactionClient,
    fence?: RunWriteFence,
  ): Promise<MeriHermesRunEvent> {
    const run = this.require(runId);
    this.assertOwns(run, fence);
    const log = this.events.get(runId)!;
    run.lastSeq += 1;
    run.updatedAt = this.now().toISOString();
    const event: MeriHermesRunEvent = {
      seq: run.lastSeq,
      runId,
      at: run.updatedAt,
      kind,
      visibility,
      payload,
    };
    log.push(event);
    if (log.length > this.maxEventsPerRun) {
      // Keep the head (acceptance) and the tail; mark the gap so a reconnect knows.
      // PRUNING-SAFE (P1-08): an event at or above the `outputSeq` snapshot is
      // NOT yet represented in `output`, so dropping it would lose assistant
      // text a recovering client can no longer reconstruct. Only the prefix at
      // or below the snapshot is droppable, which can leave the log
      // temporarily over the cap — over-retaining is the safe failure.
      const wanted = log.length - this.maxEventsPerRun;
      let droppable = 0;
      while (droppable < wanted && log[1 + droppable] && log[1 + droppable]!.seq <= run.outputSeq) droppable += 1;
      if (droppable > 0) {
        log.splice(1, droppable);
        log[1] = { ...log[1]!, payload: { ...log[1]!.payload, truncatedBefore: true } };
      }
    }
    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must never break the run.
      }
    }
    return event;
  }

  async eventsAfter(
    runId: string,
    afterSeq: number,
    visibility: 'public' | 'all' = 'public',
  ): Promise<MeriHermesRunEvent[]> {
    const log = this.events.get(runId) ?? [];
    return log.filter(
      (e) => e.seq > afterSeq && (visibility === 'all' || e.visibility === 'public'),
    );
  }

  /**
   * Same contract as the Prisma implementation, polling this store's own
   * arrays instead of Postgres. It exists so the interface stays honest (a
   * consumer written against `watch()` works against either implementation)
   * and so adapter-level specs can exercise the watch-driven code paths
   * without a database.
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
    for (;;) {
      if (signal.aborted) return;
      const batch = await this.eventsAfter(runId, cursor, visibility);
      for (const event of batch) {
        if (signal.aborted) return;
        cursor = event.seq;
        await onEvent(event);
      }
      if (batch.length) continue;
      const run = await this.get(runId);
      if (!run) return;
      if (MERI_HERMES_TERMINAL_STATUSES.has(run.status)) {
        // Drain anything that landed between the poll above and this status
        // read, then stop: terminal + nothing left to deliver.
        for (const event of await this.eventsAfter(runId, cursor, visibility)) {
          cursor = event.seq;
          await onEvent(event);
        }
        return;
      }
      await this.sleep(intervalMs, signal);
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async findConversationActivity(
    tenantId: string,
    actorId: string,
    conversationId: string,
  ): Promise<MeriHermesConversationActivity> {
    const runs = await this.listForConversation(tenantId, actorId, conversationId);
    const active = [...runs].reverse().find((r) => !MERI_HERMES_TERMINAL_STATUSES.has(r.status)) ?? null;
    const pendingInteractions = runs.flatMap((r) =>
      r.pendingInteractions.filter((i) => !i.resolution).map((i) => ({ ...i, runId: r.runId })),
    );
    return { run: active, pendingInteractions };
  }

  async claimConsumer(runId: string, consumerId: string, staleAfterMs: number, now: Date = this.now()): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || MERI_HERMES_TERMINAL_STATUSES.has(run.status)) return false;
    const heartbeat = run.consumerHeartbeatAt ? Date.parse(run.consumerHeartbeatAt) : null;
    const free = !run.consumerId || run.consumerId === consumerId || heartbeat === null;
    const stale = heartbeat !== null && now.getTime() - heartbeat > staleAfterMs;
    if (!free && !stale) return false;
    run.consumerId = consumerId;
    run.consumerHeartbeatAt = now.toISOString();
    run.updatedAt = run.consumerHeartbeatAt;
    return true;
  }

  async heartbeatConsumer(runId: string, consumerId: string, now: Date = this.now()): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.consumerId !== consumerId || MERI_HERMES_TERMINAL_STATUSES.has(run.status)) return false;
    run.consumerHeartbeatAt = now.toISOString();
    return true;
  }

  async listTakeoverCandidates(
    staleAfterMs: number,
    now: Date = this.now(),
    opts?: { tenantId?: string },
  ): Promise<MeriHermesRunRecord[]> {
    return [...this.runs.values()].filter((r) => {
      if (MERI_HERMES_TERMINAL_STATUSES.has(r.status) || r.dispatchStatus !== 'dispatched') return false;
      if (opts?.tenantId && r.envelope.tenantId !== opts.tenantId) return false;
      // A never-heartbeated run counts as orphaned only once it has ALSO been
      // untouched for the stale window — see the Prisma sibling for why (the
      // dispatched-but-not-yet-claimed window is a healthy run with no
      // heartbeat, and the request-driven sweep must not interrupt it).
      if (!r.consumerHeartbeatAt) return now.getTime() - Date.parse(r.updatedAt) > staleAfterMs;
      return now.getTime() - Date.parse(r.consumerHeartbeatAt) > staleAfterMs;
    });
  }

  async reconcileStuckDispatches(olderThanMs: number, now: Date = this.now()): Promise<number> {
    let reconciled = 0;
    for (const run of this.runs.values()) {
      if (run.dispatchStatus !== 'pending' || MERI_HERMES_TERMINAL_STATUSES.has(run.status)) continue;
      if (now.getTime() - Date.parse(run.createdAt) <= olderThanMs) continue;
      run.status = 'interrupted';
      run.finishReason = 'interrupted';
      run.dispatchStatus = 'failed';
      run.error =
        'Admission succeeded but dispatch to Hermes was never confirmed (process crash or timeout); treated as ambiguous startup, not retried.';
      run.finishedAt = now.toISOString();
      run.updatedAt = run.finishedAt;
      reconciled += 1;
    }
    return reconciled;
  }

  subscribe(runId: string, listener: MeriHermesRunListener): () => void {
    this.require(runId);
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(runId);
    };
  }

  async addInteraction(runId: string, interaction: MeriHermesPendingInteraction): Promise<void> {
    const run = this.require(runId);
    if (run.pendingInteractions.some((i) => i.requestId === interaction.requestId)) return;
    run.pendingInteractions.push(interaction);
    run.updatedAt = this.now().toISOString();
  }

  async resolveInteraction(
    runId: string,
    requestId: string,
    resolution: NonNullable<MeriHermesPendingInteraction['resolution']>,
  ): Promise<MeriHermesPendingInteraction | null> {
    const run = this.require(runId);
    const interaction = run.pendingInteractions.find((i) => i.requestId === requestId);
    if (!interaction || interaction.resolution) return null;
    interaction.resolution = resolution;
    run.updatedAt = this.now().toISOString();
    return interaction;
  }

  async listActiveForScope(executionScopeId: string): Promise<MeriHermesRunRecord[]> {
    return [...this.runs.values()].filter(
      (r) =>
        r.envelope.executionScopeId === executionScopeId &&
        !MERI_HERMES_TERMINAL_STATUSES.has(r.status),
    );
  }

  async listForConversation(tenantId: string, actorId: string, conversationId: string): Promise<MeriHermesRunRecord[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.envelope.tenantId === tenantId &&
          r.envelope.actorId === actorId &&
          r.envelope.conversationId === conversationId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Drop terminal runs older than the TTL. Returns the number removed. */
  async sweep(now: Date = this.now()): Promise<number> {
    let removed = 0;
    for (const [runId, run] of this.runs) {
      if (!MERI_HERMES_TERMINAL_STATUSES.has(run.status)) continue;
      const finished = run.finishedAt ? Date.parse(run.finishedAt) : Date.parse(run.updatedAt);
      if (now.getTime() - finished > this.ttlMs) {
        this.runs.delete(runId);
        this.events.delete(runId);
        this.listeners.delete(runId);
        this.byIdempotency.delete(this.idemKey(run.envelope.executionScopeId, run.idempotencyKey));
        if (run.hermesRunId) this.byHermesRunId.delete(run.hermesRunId);
        removed += 1;
      }
    }
    return removed;
  }

  private require(runId: string): MeriHermesRunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown Hermes run ${runId}`);
    return run;
  }

  /** Write-side consumer fence — see `RunWriteFence` / `MeriHermesConsumerFencedError`. */
  private assertOwns(run: MeriHermesRunRecord, fence?: RunWriteFence): void {
    const consumerId = fence?.consumerId;
    if (!consumerId) return;
    if (run.consumerId !== consumerId || MERI_HERMES_TERMINAL_STATUSES.has(run.status)) {
      throw new MeriHermesConsumerFencedError(run.runId, consumerId);
    }
  }

  private idemKey(executionScopeId: string, idempotencyKey: string): string {
    return `${executionScopeId}::${idempotencyKey}`;
  }
}
