/**
 * Typed contracts for the Meri ⇄ Hermes runtime integration (Phase 0).
 *
 * These are the PROPOSED integration contracts exercised by the Phase 0
 * compatibility harness. Meri owns identity, authorization, durable run records
 * and the product UI; Hermes owns its own agent loop, personality, skills and
 * native tools. Nothing here grants the model the ability to choose its tenant,
 * actor, audience or tools: every field of the envelope is server-created.
 *
 * Wire-level types for the pinned Hermes build (v2026.9.14 / 0.21.3) are kept
 * separate (`HermesWire*`) from Meri's own contracts (`MeriHermes*`) so a build
 * upgrade only touches the translator.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Authorization envelope (server-created, immutable for the life of a run)
// ---------------------------------------------------------------------------

export type MeriHermesActorType = 'user' | 'service';
export type MeriHermesAudience = 'private' | 'room' | 'tenant';

export interface MeriHermesToolPolicy {
  /**
   * Broker tool names the run may invoke. **Empty = none** — this is an
   * allow-list, not an optional filter, and `assertTool` enforces it that way
   * unconditionally (closeout defect A3: it used to short-circuit on
   * `allow.length`, so `allow: []` silently permitted every tool). A run that
   * is meant to use tools must name them.
   */
  allow: string[];
  /** Explicit denials that win over `allow` (defense in depth). */
  deny: string[];
  /**
   * When true the broker rejects every tool that is not explicitly classified
   * as safe for a read-only run in `MERI_HERMES_TOOL_EFFECTS`, regardless of
   * `allow`. Unclassified = rejected (closeout defect A5).
   */
  readOnly: boolean;
}

/**
 * The six broker tool names (Phase 0). Lives here — not in
 * `meri-hermes-broker.service.ts` or `meri-hermes-runtime.adapter.ts` — because
 * both of those modules need it (the adapter to build the default tool policy,
 * the broker to type-check tool calls) and putting it in either one would make
 * the two files import from each other (a real ESM circular import: the
 * adapter needs the broker's `MeriHermesRuntimeAdapter` for revocation
 * fencing, so the broker cannot also import a value from the adapter's file).
 */
export const MERI_HERMES_BROKER_TOOLS = [
  'meri_memory_search',
  'meri_memory_propose',
  'meri_fetch_attachment',
  'meri_publish_artifact',
  'meri_request_clarification',
  'meri_record_turn',
] as const;
export type MeriHermesBrokerTool = (typeof MERI_HERMES_BROKER_TOOLS)[number];

/**
 * What a broker tool DOES, which is what decides whether a `readOnly: true`
 * run may call it.
 *
 *   read              — returns governed application data, changes nothing.
 *   run_local         — writes only to Meri's own record of THIS run (its
 *                       durable event log / pending-interaction list). No
 *                       application or governed-memory state is touched, and
 *                       nothing outlives the run, so a read-only run may call
 *                       it: that is what lets a read-only run still ask the
 *                       user a question and record its own turn.
 *   application_write — creates or mutates application / governed-memory
 *                       state that outlives the run.
 *
 * Closeout defect A5: this replaced a hand-maintained two-element
 * `MUTATING_TOOLS` set in the broker. That set was consulted as
 * "is this tool mutating?", so any tool MISSING from it was treated as
 * read-only and permitted on a read-only run — every future write tool was
 * fail-OPEN by default. The classification is now:
 *
 *   1. Exhaustive by type. `Record<MeriHermesBrokerTool, …>` means adding a
 *      name to `MERI_HERMES_BROKER_TOOLS` without classifying it here is a
 *      COMPILE error, not a silent grant.
 *   2. Fail-closed at runtime. `isReadOnlySafeTool()` answers `false` for
 *      anything it does not recognise, so a tool that reaches the broker
 *      without a classification (a hand-built policy, a future dynamic
 *      registry) is refused on a read-only run rather than admitted.
 *
 * The effective behaviour for the six Phase 0 tools is unchanged: read-only
 * runs still refuse exactly `meri_memory_propose` and `meri_publish_artifact`.
 * What changed is the DEFAULT for anything new.
 */
export type MeriHermesToolEffect = 'read' | 'run_local' | 'application_write';

export const MERI_HERMES_TOOL_EFFECTS: Readonly<Record<MeriHermesBrokerTool, MeriHermesToolEffect>> = {
  /** Governed institutional-memory read through the Context Plane recall rail. */
  meri_memory_search: 'read',
  /** Owner-scoped chat attachment materialisation. */
  meri_fetch_attachment: 'read',
  /** Appends one internal `run.status` event to this run's own log. */
  meri_record_turn: 'run_local',
  /** Adds a pending interaction + event to this run; asks the user a question. */
  meri_request_clarification: 'run_local',
  /** Creates a governed memory candidate in the review queue. */
  meri_memory_propose: 'application_write',
  /** Creates a ClioArtifact row (and object-store bytes). */
  meri_publish_artifact: 'application_write',
};

/**
 * May a `readOnly: true` run call this tool? Fail-closed: an unrecognised
 * tool name is NOT read-only-safe. Takes `string` deliberately — the guard
 * must be able to reject a name that is not even a known broker tool.
 */
export function isReadOnlySafeTool(tool: string): boolean {
  const effect = (MERI_HERMES_TOOL_EFFECTS as Readonly<Record<string, MeriHermesToolEffect | undefined>>)[tool];
  return effect === 'read' || effect === 'run_local';
}

export interface MeriHermesRunBudget {
  maxToolCalls: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
}

export interface MeriHermesAuthorizationEnvelope {
  version: 1;
  tenantId: string;
  actorType: MeriHermesActorType;
  /** Capiro user id (never the Clerk id) for actorType 'user'; service id otherwise. */
  actorId: string;
  conversationId: string;
  workspaceId: string | null;
  /**
   * Execution scope = the isolated Hermes home / worker this run may use.
   * Phase 0: `tenant:<tenantId>:user:<userId>` (private scope). A shared room
   * gets its own scope id once room membership exists.
   */
  executionScopeId: string;
  audience: MeriHermesAudience;
  /** Server-derived client ids the actor may read (ethical wall applied). */
  authorizedClientIds: string[];
  /** Server-derived mailbox connection ids owned by the actor. */
  authorizedMailboxConnectionIds: string[];
  toolPolicy: MeriHermesToolPolicy;
  /** Monotonic per-scope version; a revocation bumps it and fences older runs. */
  authorizationVersion: string;
  runId: string;
  traceId: string;
  issuedAt: string;
  expiresAt: string;
  budget: MeriHermesRunBudget;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export const MERI_HERMES_RUN_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'waiting_for_approval',
  'waiting_for_clarification',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'expired',
] as const;
export type MeriHermesRunStatus = (typeof MERI_HERMES_RUN_STATUSES)[number];

export const MERI_HERMES_TERMINAL_STATUSES: ReadonlySet<MeriHermesRunStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'expired',
]);

export type MeriHermesFinishReason = 'stop' | 'aborted' | 'error' | 'interrupted' | 'expired';

export interface MeriHermesUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported cost when available; null when the runtime does not compute it. */
  costUsd: number | null;
}

export type MeriHermesRunMode = 'new' | 'regenerate' | 'resend';

export interface MeriHermesRunSubmission {
  envelope: MeriHermesAuthorizationEnvelope;
  /** Stable key for retries: `meri:<userMessageId>`. A replay reconnects, never duplicates. */
  idempotencyKey: string;
  mode: MeriHermesRunMode;
  input: {
    text: string;
    attachmentIds: string[];
  };
  /** Governed context prompt compiled by Meri's Context Plane for this turn (may be empty). */
  governedInstructions: string | null;
  /** Hermes session to continue (conversation ↔ session binding), null for a fresh session. */
  hermesSessionId: string | null;
  /** Long-term memory scope key handed to Hermes (`X-Hermes-Session-Key`) = executionScopeId. */
  sessionKey: string;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Sequenced events (Meri's durable event log; visibility decides UI exposure)
// ---------------------------------------------------------------------------

export const MERI_HERMES_EVENT_KINDS = [
  'run.accepted',
  'run.status',
  'message.delta',
  'tool.started',
  'tool.completed',
  'subagent.started',
  'subagent.completed',
  'approval.requested',
  'approval.resolved',
  'clarification.requested',
  'clarification.answered',
  'artifact.published',
  'memory.recalled',
  'memory.proposed',
  'steer.accepted',
  'usage',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'client.detached',
  'client.reconnected',
  'error',
] as const;
export type MeriHermesRunEventKind = (typeof MERI_HERMES_EVENT_KINDS)[number];

export interface MeriHermesRunEvent {
  /** Monotonic per run, starting at 1. Reconnect cursor = last seq acknowledged. */
  seq: number;
  runId: string;
  at: string;
  kind: MeriHermesRunEventKind;
  /** `public` may be streamed to the browser; `internal` stays in the run record. */
  visibility: 'public' | 'internal';
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pending interactions (approval / clarification) that must survive reconnect
// ---------------------------------------------------------------------------

export type MeriHermesInteractionKind = 'approval' | 'clarification';

export interface MeriHermesPendingInteraction {
  requestId: string;
  kind: MeriHermesInteractionKind;
  createdAt: string;
  expiresAt: string | null;
  /** Approval: the redacted command/description. Clarification: the question. */
  prompt: string;
  choices: string[];
  multiSelect: boolean;
  /**
   * `live_process` — the Hermes worker is blocked waiting (native approval over
   * /v1/runs). `durable_continuation` — the run ended its turn; the answer is
   * delivered as the next run in the same session (clarification adapter).
   */
  continuation: 'live_process' | 'durable_continuation';
  resolution: null | {
    at: string;
    actorId: string;
    decision: string;
    answer?: string | string[];
  };
}

export interface MeriHermesApprovalDecision {
  runId: string;
  requestId: string;
  /** Native Hermes choices are `once | session | always | deny`; Meri exposes only once/deny. */
  decision: 'approve_once' | 'deny';
}

export interface MeriHermesClarificationResponse {
  runId: string;
  requestId: string;
  answer: string | string[];
}

// ---------------------------------------------------------------------------
// Capability inspection
// ---------------------------------------------------------------------------

export interface MeriHermesCapabilityDescriptor {
  runtime: 'hermes';
  build: { tag: string; commit: string; version: string; imageDigest: string | null };
  /** Raw `/v1/capabilities` feature flags from the pinned build. */
  features: Record<string, boolean | string | number>;
  endpoints: Record<string, { method: string; path: string }>;
  toolsets: string[];
  skillCount: number;
  limits: { maxConcurrentRuns: number | null; eventBufferTtlSeconds: number | null };
  /** Meri-side adapters this build requires (from the compatibility ledger). */
  adaptersRequired: string[];
}

// ---------------------------------------------------------------------------
// Runtime port (what the adapter needs from any execution runtime)
// ---------------------------------------------------------------------------

export interface MeriHermesRuntimePort {
  capabilities(): Promise<MeriHermesCapabilityDescriptor>;
  submit(
    submission: MeriHermesRunSubmission,
  ): Promise<{ hermesRunId: string; hermesSessionId: string | null; replayed: boolean }>;
  subscribe(
    hermesRunId: string,
    onEvent: (event: HermesWireEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  status(hermesRunId: string): Promise<HermesWireRunStatus>;
  stop(hermesRunId: string): Promise<void>;
  resolveApproval(
    hermesRunId: string,
    requestId: string | null,
    choice: 'once' | 'deny',
  ): Promise<void>;
  steer(hermesRunId: string, text: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Hermes wire schemas (pinned build v2026.9.14). Parsed defensively with zod.
// ---------------------------------------------------------------------------

export const hermesWireEventSchema = z
  .object({
    event: z.string().min(1),
    run_id: z.string().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();
export type HermesWireEvent = z.infer<typeof hermesWireEventSchema> & Record<string, unknown>;

export const hermesWireRunStatusSchema = z
  .object({
    object: z.literal('hermes.run').optional(),
    run_id: z.string(),
    status: z.string(),
    session_id: z.string().optional(),
    created_at: z.number().optional(),
    updated_at: z.number().optional(),
    last_event: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    approval: z.record(z.string(), z.unknown()).optional(),
    pending_steer: z.unknown().optional(),
  })
  .passthrough();
export type HermesWireRunStatus = z.infer<typeof hermesWireRunStatusSchema>;

export const hermesWireRunAcceptedSchema = z
  .object({
    run_id: z.string(),
    status: z.string().optional(),
    session_id: z.string().nullable().optional(),
  })
  .passthrough();

export const hermesWireCapabilitiesSchema = z
  .object({
    // Feature values are booleans, strings or nested objects on the pinned build
    // (e.g. `runs_idempotency: {supported, durable, retention_seconds}`).
    features: z.record(z.string(), z.unknown()).optional(),
    endpoints: z.record(z.string(), z.unknown()).optional(),
    version: z.string().optional(),
  })
  .passthrough();

/** Hermes native run statuses (api_server_runs.py / api_server_run_idempotency.py). */
export const HERMES_WIRE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/** Meri SSE frame as consumed by apps/web `useMeriChatController` (`SseEvent` union). */
export type MeriSseFrame = Record<string, unknown> & { type: string };
