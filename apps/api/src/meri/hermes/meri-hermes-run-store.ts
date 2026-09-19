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
   * terminal) row back instead of throwing or silently overwriting it.
   */
  update(runId: string, patch: RunPatch, tx?: Prisma.TransactionClient): Promise<MeriHermesRunRecord>;
  append(
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility?: 'public' | 'internal',
    tx?: Prisma.TransactionClient,
  ): Promise<MeriHermesRunEvent>;
  eventsAfter(runId: string, afterSeq: number, visibility?: 'public' | 'all'): Promise<MeriHermesRunEvent[]>;
  subscribe(runId: string, listener: MeriHermesRunListener): () => void;
  addInteraction(runId: string, interaction: MeriHermesPendingInteraction): Promise<void>;
  resolveInteraction(
    runId: string,
    requestId: string,
    resolution: NonNullable<MeriHermesPendingInteraction['resolution']>,
  ): Promise<MeriHermesPendingInteraction | null>;
  listActiveForScope(executionScopeId: string): Promise<MeriHermesRunRecord[]>;
  listForConversation(tenantId: string, actorId: string, conversationId: string): Promise<MeriHermesRunRecord[]>;
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
  async update(runId: string, patch: RunPatch, _tx?: Prisma.TransactionClient): Promise<MeriHermesRunRecord> {
    const run = this.require(runId);
    const wasTerminal = MERI_HERMES_TERMINAL_STATUSES.has(run.status);
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

  /** `tx` is accepted for interface parity with `MeriHermesPrismaRunRepository` and ignored — this store has no transactions. */
  async append(
    runId: string,
    kind: MeriHermesRunEventKind,
    payload: Record<string, unknown>,
    visibility: 'public' | 'internal' = 'public',
    _tx?: Prisma.TransactionClient,
  ): Promise<MeriHermesRunEvent> {
    const run = this.require(runId);
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
    if (log.length > MAX_EVENTS_PER_RUN) {
      // Keep the head (acceptance) and the tail; mark the gap so a reconnect knows.
      log.splice(1, log.length - MAX_EVENTS_PER_RUN);
      log[1] = { ...log[1]!, payload: { ...log[1]!.payload, truncatedBefore: true } };
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

  private idemKey(executionScopeId: string, idempotencyKey: string): string {
    return `${executionScopeId}::${idempotencyKey}`;
  }
}
