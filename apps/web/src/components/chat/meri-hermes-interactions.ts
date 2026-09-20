/**
 * Pure client-side state for the Hermes control surface (Phase 1 backlog
 * tickets 4 "Stop/detach/reconnect" and 5 "Clarification + native approval
 * UI" — see docs/meri/hermes/phase-0/contracts.md §3, §4.1, §5, §6).
 *
 * Kept dependency-free (no React, no chat-store import) so it is unit
 * testable the same way meri-pending-approvals.ts / meri-approval-intent.ts
 * are — those are the established pattern for "the rules with teeth" in this
 * directory, extracted so a DOM test isn't required to exercise them.
 *
 * Two frame families come from the server (contracts.md §4.1):
 *  - `{type:'pending_approval', runtime:'hermes', ..., interaction:{requestId,
 *    choices, continuation:'live_process'}}` — a native Hermes terminal-command
 *    approval. Choices are always constrained to once/deny (contracts.md §3);
 *    this is deliberately a DISTINCT shape from the business-action
 *    `MeriActionProposal` pending_approval card (no `runtime` field there),
 *    which offers richer lifecycle (executing/succeeded/failed_retryable/…)
 *    that does not exist for a native approval — Hermes never reports back
 *    approve/deny outcome as its own frame (approval.resolved is internal-only
 *    per contracts.md §4.1), so resolution here is always client-known, not
 *    server-confirmed lifecycle.
 *  - `{type:'clarify', runtime:'hermes', requestId, questions:[{id,question,
 *    choices,multiSelect}], continuation:'durable_continuation'}` — durable
 *    continuation; the pinned broker tool sends exactly one question per call.
 *
 * A third source is discovery: `GET .../conversations/:conversationId/active`
 * returns the conversation's most recent NON-TERMINAL run (or null) plus every
 * unresolved interaction — including ones whose producing run has already
 * finished. That endpoint, not any browser-local pointer, is what makes a run
 * or an unanswered question discoverable from a fresh tab, another browser or
 * another device (Phase 1 backlog ticket 4 acceptance criterion). The
 * per-run projection `GET .../runs/:runId` returns the same interaction shape
 * plus the output snapshot used to reseed the assistant message on reattach.
 */

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

function isKnownHermesStatus(value: unknown): value is MeriHermesRunStatus {
  return (
    typeof value === 'string' &&
    (MERI_HERMES_RUN_STATUSES as readonly string[]).includes(value)
  );
}

export function isHermesRunTerminal(status: string | null | undefined): boolean {
  return isKnownHermesStatus(status) && MERI_HERMES_TERMINAL_STATUSES.has(status);
}

/**
 * Is the run actively producing output (so the composer should hold its
 * streaming state)? `waiting_for_clarification` is non-terminal but has ENDED
 * its turn: the answer travels as the next chat message, so the composer must
 * stay usable or the question cannot be answered at all.
 */
export function hermesRunIsGenerating(status: string | null | undefined): boolean {
  return (
    isKnownHermesStatus(status) &&
    !MERI_HERMES_TERMINAL_STATUSES.has(status) &&
    status !== 'waiting_for_clarification'
  );
}

const STATUS_LABELS: Record<MeriHermesRunStatus, string> = {
  queued: 'Queued',
  provisioning: 'Starting…',
  running: 'Working',
  waiting_for_approval: 'Waiting for your approval',
  waiting_for_clarification: 'Waiting for your answer',
  cancelling: 'Stopping…',
  completed: 'Completed',
  cancelled: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
  expired: 'Expired',
};

/** Reuse this codebase's status/progress conventions (meriRuntimeStatusText,
 * meriTurnLifecycleLabel) rather than inventing new copy per status. */
export function hermesRunStatusLabel(status: MeriHermesRunStatus | string | null | undefined): string {
  if (isKnownHermesStatus(status)) return STATUS_LABELS[status];
  return STATUS_LABELS.running;
}

// ---------------------------------------------------------------------------
// Interaction cards
// ---------------------------------------------------------------------------

export interface MeriHermesApprovalCard {
  kind: 'approval';
  /** Meri's own run id (routes every control-surface POST). */
  runId: string;
  requestId: string;
  /** `hermes:<runId>:<requestId>` — stable across reconnect (contracts.md §4.1). */
  proposalId: string;
  label: string;
  /** Redacted command/description preview, when the server sent one. */
  command: string | null;
  /** Native Hermes choices as reported (informational only — the UI always
   * offers exactly Run once / Deny per contracts.md §3, never "always"/"session"). */
  choices: string[];
  createdAt: string;
  expiresAt: string | null;
  resolution: null | { decision: 'approve_once' | 'deny'; at: string };
  /**
   * The producing run is no longer live. A native approval is a `live_process`
   * continuation — the worker is blocked waiting on it — so once the run is
   * terminal the backend refuses the decision and there is nothing left to
   * approve. Optional so live frames (always produced by a running run) need
   * not set it.
   */
  runTerminal?: boolean;
}

export interface MeriHermesClarifyCard {
  kind: 'clarification';
  runId: string;
  requestId: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
  createdAt: string;
  resolution: null | { answer: string | string[]; at: string };
  /**
   * The producing run is terminal. Unlike an approval this is NOT fatal: a
   * clarification is a `durable_continuation`, so the answer travels as the
   * next chat message carrying the original requestId, and the card stays
   * answerable after its run has ended (contracts.md §6).
   */
  runTerminal?: boolean;
}

export type MeriHermesInteractionCard = MeriHermesApprovalCard | MeriHermesClarifyCard;

/** Approvals expire ~300s after creation (contracts.md §6 default). Clarifications
 * are durable continuations and never expire client-side. */
export function isHermesInteractionExpired(
  card: MeriHermesInteractionCard,
  nowMs: number = Date.now(),
): boolean {
  if (card.kind !== 'approval' || !card.expiresAt) return false;
  const expiry = Date.parse(card.expiresAt);
  return Number.isFinite(expiry) && expiry <= nowMs;
}

/**
 * Insert-or-replace by requestId — same contract as meri-pending-approvals'
 * upsertProposal: identity is the opaque request id, never re-derived.
 *
 * Resolution is monotonic: once this client has recorded an answer for a
 * request id, a later re-delivery of the same (still-pending) card — a
 * duplicate SSE frame, or a discovery read taken before the server saw the
 * answer — must not flip it back to actionable. Otherwise the user is offered
 * a second decision on a request that is already spent, and the second POST
 * is exactly the double-apply the backend then has to reject.
 * `runTerminal` is one-way for the same reason: a run that has ended cannot
 * un-end.
 */
export function upsertHermesInteraction(
  prev: MeriHermesInteractionCard[],
  next: MeriHermesInteractionCard,
): MeriHermesInteractionCard[] {
  const index = prev.findIndex((c) => c.requestId === next.requestId);
  if (index === -1) return [...prev, next];
  const existing = prev[index]!;
  const copy = [...prev];
  copy[index] = {
    ...next,
    resolution: next.resolution ?? existing.resolution,
    runTerminal: next.runTerminal || existing.runTerminal,
  } as MeriHermesInteractionCard;
  return copy;
}

export function resolveHermesInteraction(
  prev: MeriHermesInteractionCard[],
  requestId: string,
  resolution: MeriHermesInteractionCard['resolution'],
): MeriHermesInteractionCard[] {
  return prev.map((card) =>
    card.requestId === requestId ? ({ ...card, resolution } as MeriHermesInteractionCard) : card,
  );
}

/** Cards still waiting on the user — mirrors outstandingApprovals(). */
export function outstandingHermesInteractions(
  cards: MeriHermesInteractionCard[],
): MeriHermesInteractionCard[] {
  return cards.filter((c) => !c.resolution);
}

/**
 * Mark every card belonging to `runId` as produced by a run that has ended.
 * Resolved cards are left alone (their outcome is already final), and a
 * clarification stays answerable — only its "the run that asked is gone"
 * provenance changes.
 */
export function markHermesRunTerminal(
  prev: MeriHermesInteractionCard[],
  runId: string,
): MeriHermesInteractionCard[] {
  let changed = false;
  const next = prev.map((card) => {
    if (card.runId !== runId || card.runTerminal === true) return card;
    changed = true;
    return { ...card, runTerminal: true } as MeriHermesInteractionCard;
  });
  return changed ? next : prev;
}

/**
 * Why a native approval cannot be acted on — the single source of truth for
 * both the card's rendering and the controller's POST guard, so a stale or
 * duplicate decision is rejected in one place instead of relying on a hidden
 * button.
 *
 * `run_ended` exists because a native approval is a `live_process`
 * continuation (contracts.md §6): once the run is terminal the worker that
 * was blocked on it is gone and the backend refuses the decision outright, so
 * offering a button that would 409 is dishonest.
 */
export type MeriHermesApprovalBlock = 'resolved' | 'expired' | 'run_ended' | null;

export function hermesApprovalBlockedReason(
  card: MeriHermesApprovalCard,
  nowMs: number = Date.now(),
): MeriHermesApprovalBlock {
  if (card.resolution) return 'resolved';
  if (card.runTerminal) return 'run_ended';
  if (isHermesInteractionExpired(card, nowMs)) return 'expired';
  return null;
}

export const HERMES_APPROVAL_BLOCK_MESSAGES: Record<
  Exclude<MeriHermesApprovalBlock, null>,
  string
> = {
  resolved: 'That approval was already answered.',
  expired: 'That approval expired before it was answered.',
  run_ended: 'That run has ended, so Hermes can no longer act on this approval.',
};

// ---------------------------------------------------------------------------
// Live-frame parsing
// ---------------------------------------------------------------------------

interface RawHermesApprovalFrame {
  type?: unknown;
  runtime?: unknown;
  proposalId?: unknown;
  label?: unknown;
  reason?: unknown;
  expiresAt?: unknown;
  preview?: { fields?: Record<string, unknown> } | null;
  interaction?: { requestId?: unknown; choices?: unknown; continuation?: unknown } | null;
}

/**
 * Parse a live `{type:'pending_approval', ...}` SSE frame into a card. Returns
 * null for a business-action approval (no `runtime:'hermes'`) so callers may
 * pass every `pending_approval` frame through this without a pre-check, or a
 * malformed Hermes frame missing the one field (`interaction.requestId`) that
 * every valid frame carries.
 */
export function hermesApprovalCardFromFrame(
  frame: RawHermesApprovalFrame,
  runId: string,
  createdAt: string = new Date().toISOString(),
): MeriHermesApprovalCard | null {
  if (frame.runtime !== 'hermes') return null;
  const requestId = frame.interaction?.requestId;
  if (typeof requestId !== 'string' || !requestId) return null;
  const command = frame.preview?.fields?.command;
  const label =
    (typeof frame.label === 'string' && frame.label) ||
    (typeof frame.reason === 'string' && frame.reason) ||
    'Hermes requests approval for a guarded action.';
  const choices = Array.isArray(frame.interaction?.choices)
    ? (frame.interaction!.choices as unknown[]).map(String)
    : ['once', 'deny'];
  return {
    kind: 'approval',
    runId,
    requestId,
    proposalId:
      typeof frame.proposalId === 'string' && frame.proposalId
        ? frame.proposalId
        : `hermes:${runId}:${requestId}`,
    label,
    command: typeof command === 'string' && command ? command : null,
    choices,
    createdAt,
    expiresAt: typeof frame.expiresAt === 'string' ? frame.expiresAt : null,
    resolution: null,
  };
}

interface RawHermesClarifyFrame {
  type?: unknown;
  runtime?: unknown;
  requestId?: unknown;
  questions?: unknown;
}

/**
 * Parse a live `{type:'clarify', ...}` SSE frame. Only the first question is
 * read — `meri_request_clarification` (the only broker tool that emits this
 * frame) accepts a single `question` per call, so `questions` is always a
 * one-element array on this build (meri-hermes-broker.service.ts).
 */
export function hermesClarifyCardFromFrame(
  frame: RawHermesClarifyFrame,
  runId: string,
  createdAt: string = new Date().toISOString(),
): MeriHermesClarifyCard | null {
  if (frame.runtime !== 'hermes') return null;
  const questions = Array.isArray(frame.questions) ? frame.questions : [];
  const first = questions[0] as Record<string, unknown> | undefined;
  const requestId =
    typeof frame.requestId === 'string' && frame.requestId
      ? frame.requestId
      : typeof first?.id === 'string'
        ? first.id
        : null;
  const question = typeof first?.question === 'string' ? first.question : null;
  if (!requestId || !question) return null;
  return {
    kind: 'clarification',
    runId,
    requestId,
    question,
    choices: Array.isArray(first?.choices) ? (first!.choices as unknown[]).map(String) : [],
    multiSelect: Boolean(first?.multiSelect),
    createdAt,
    resolution: null,
  };
}

// ---------------------------------------------------------------------------
// Reconnect projection parsing (GET /api/clio/hermes/runs/:runId)
// ---------------------------------------------------------------------------

export interface RawHermesProjectedInteraction {
  requestId: string;
  kind: 'approval' | 'clarification';
  prompt: string;
  choices: string[];
  multiSelect: boolean;
  continuation: 'live_process' | 'durable_continuation';
  createdAt: string;
  expiresAt: string | null;
  resolved: boolean;
  decision: string | null;
}

export interface MeriHermesRunProjection {
  runId: string;
  status: MeriHermesRunStatus;
  finishReason: string | null;
  partial: boolean;
  error: string | null;
  lastSeq: number;
  /**
   * The assistant text the server has durably accumulated for this run, and
   * the seq it is current as of. Reattach seeds the message with the snapshot
   * and subscribes at `after=outputSeq` — replaying from seq 0 is NOT
   * equivalent, because the event log is capped at 5 000 events per run and
   * prunes the oldest, so a long run's replay silently loses its beginning
   * (contracts.md §4.2).
   */
  outputSnapshot: string;
  outputSeq: number;
  pendingInteractions: RawHermesProjectedInteraction[];
}

/** A non-negative integer seq cursor; anything else means "no cursor" (0). */
function readSeq(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function readProjectedInteraction(value: unknown): RawHermesProjectedInteraction | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== 'string' || !row.requestId) return null;
  if (row.kind !== 'approval' && row.kind !== 'clarification') return null;
  return {
    requestId: row.requestId,
    kind: row.kind,
    prompt: typeof row.prompt === 'string' ? row.prompt : '',
    choices: Array.isArray(row.choices) ? row.choices.map(String) : [],
    multiSelect: row.multiSelect === true,
    continuation: row.continuation === 'live_process' ? 'live_process' : 'durable_continuation',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : null,
    resolved: row.resolved === true,
    decision: typeof row.decision === 'string' ? row.decision : null,
  };
}

/** Parse the safe run projection `MeriHermesController.projectRun` returns. */
export function readHermesRunProjection(value: unknown): MeriHermesRunProjection | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.runId !== 'string' || !row.runId || !isKnownHermesStatus(row.status)) return null;
  const pending = Array.isArray(row.pendingInteractions) ? row.pendingInteractions : [];
  return {
    runId: row.runId,
    status: row.status,
    finishReason: typeof row.finishReason === 'string' ? row.finishReason : null,
    partial: row.partial === true,
    error: typeof row.error === 'string' ? row.error : null,
    lastSeq: typeof row.lastSeq === 'number' && Number.isFinite(row.lastSeq) ? row.lastSeq : 0,
    outputSnapshot: typeof row.outputSnapshot === 'string' ? row.outputSnapshot : '',
    outputSeq: readSeq(row.outputSeq),
    pendingInteractions: pending
      .map(readProjectedInteraction)
      .filter((x): x is RawHermesProjectedInteraction => x !== null),
  };
}

export function hermesInteractionCardFromProjection(
  interaction: RawHermesProjectedInteraction,
  runId: string,
  runTerminal = false,
): MeriHermesInteractionCard {
  if (interaction.kind === 'approval') {
    const resolution: MeriHermesApprovalCard['resolution'] =
      interaction.resolved && interaction.decision
        ? {
            decision: interaction.decision === 'deny' ? 'deny' : 'approve_once',
            at: interaction.createdAt,
          }
        : null;
    return {
      kind: 'approval',
      runId,
      requestId: interaction.requestId,
      proposalId: `hermes:${runId}:${interaction.requestId}`,
      label: interaction.prompt,
      command: null,
      choices: interaction.choices.length ? interaction.choices : ['once', 'deny'],
      createdAt: interaction.createdAt,
      expiresAt: interaction.expiresAt,
      resolution,
      runTerminal,
    };
  }
  const resolution: MeriHermesClarifyCard['resolution'] =
    interaction.resolved && interaction.decision ? { answer: interaction.decision, at: interaction.createdAt } : null;
  return {
    kind: 'clarification',
    runId,
    requestId: interaction.requestId,
    question: interaction.prompt,
    choices: interaction.choices,
    multiSelect: interaction.multiSelect,
    createdAt: interaction.createdAt,
    resolution,
    runTerminal,
  };
}

/**
 * Merge freshly-projected interactions (from a run GET, used on reconnect)
 * into the existing card list — unresolved projected rows upsert by request
 * id; nothing local is ever deleted here, so a card resolved an instant ago
 * (server write not yet visible to this read) cannot flicker back to pending.
 */
export function mergeHermesInteractionsFromProjection(
  prev: MeriHermesInteractionCard[],
  projected: RawHermesProjectedInteraction[],
  runId: string,
  runTerminal = false,
): MeriHermesInteractionCard[] {
  return projected.reduce(
    (acc, row) => upsertHermesInteraction(acc, hermesInteractionCardFromProjection(row, runId, runTerminal)),
    prev,
  );
}

// ---------------------------------------------------------------------------
// Discovery: GET /api/clio/hermes/conversations/:conversationId/active
//
// This replaces the old per-tab `sessionStorage` run pointer outright. A
// pointer written by one tab is invisible to a fresh tab, another browser or
// another device, so a run left in flight (or, worse, a question waiting for
// an answer) became undiscoverable the moment that tab went away. Discovery is
// server-side and owner-scoped, so any session of the same user recovers the
// same state. Nothing in the reconnect path reads browser storage any more.
// ---------------------------------------------------------------------------

/** The conversation's most recent NON-TERMINAL run, if any. */
export interface MeriHermesActiveRun {
  runId: string;
  status: MeriHermesRunStatus;
  finishReason: string | null;
  partial: boolean;
  detached: boolean;
  /** Assistant text accumulated so far, current as of `outputSeq`. */
  outputSnapshot: string;
  outputSeq: number;
  lastSeq: number;
  hermesRunId: string | null;
  hermesSessionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
}

/**
 * An unresolved interaction. `runId` is the run that ASKED — which may already
 * be terminal, so this is not necessarily the active run's id (that is exactly
 * the case a durable clarification outliving its run produces).
 */
export interface MeriHermesPendingInteraction {
  runId: string;
  requestId: string;
  kind: 'approval' | 'clarification';
  continuation: 'live_process' | 'durable_continuation';
  prompt: string;
  choices: string[];
  multiSelect: boolean;
  createdAt: string;
  expiresAt: string | null;
}

export interface MeriHermesActiveConversation {
  run: MeriHermesActiveRun | null;
  pendingInteractions: MeriHermesPendingInteraction[];
}

function readActiveRun(value: unknown): MeriHermesActiveRun | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.runId !== 'string' || !row.runId || !isKnownHermesStatus(row.status)) return null;
  return {
    runId: row.runId,
    status: row.status,
    finishReason: typeof row.finishReason === 'string' ? row.finishReason : null,
    partial: row.partial === true,
    detached: row.detached === true,
    outputSnapshot: typeof row.outputSnapshot === 'string' ? row.outputSnapshot : '',
    outputSeq: readSeq(row.outputSeq),
    lastSeq: readSeq(row.lastSeq),
    hermesRunId: typeof row.hermesRunId === 'string' ? row.hermesRunId : null,
    hermesSessionId: typeof row.hermesSessionId === 'string' ? row.hermesSessionId : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    finishedAt: typeof row.finishedAt === 'string' ? row.finishedAt : null,
  };
}

function readPendingInteraction(value: unknown): MeriHermesPendingInteraction | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== 'string' || !row.requestId) return null;
  if (typeof row.runId !== 'string' || !row.runId) return null;
  if (row.kind !== 'approval' && row.kind !== 'clarification') return null;
  return {
    runId: row.runId,
    requestId: row.requestId,
    kind: row.kind,
    continuation: row.continuation === 'live_process' ? 'live_process' : 'durable_continuation',
    prompt: typeof row.prompt === 'string' ? row.prompt : '',
    choices: Array.isArray(row.choices) ? row.choices.map(String) : [],
    multiSelect: row.multiSelect === true,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    expiresAt: typeof row.expiresAt === 'string' ? row.expiresAt : null,
  };
}

export function readHermesActiveConversation(value: unknown): MeriHermesActiveConversation | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const pending = Array.isArray(row.pendingInteractions) ? row.pendingInteractions : [];
  return {
    run: readActiveRun(row.run),
    pendingInteractions: pending
      .map(readPendingInteraction)
      .filter((x): x is MeriHermesPendingInteraction => x !== null),
  };
}

/**
 * Build a card from a discovered interaction. `activeRunId` is the id of the
 * conversation's live run (or null): anything asked by a DIFFERENT run has
 * outlived its producer, which is what `runTerminal` records — an approval
 * then renders as no-longer-actionable, while a clarification stays
 * answerable.
 */
export function hermesInteractionCardFromActive(
  interaction: MeriHermesPendingInteraction,
  activeRunId: string | null,
): MeriHermesInteractionCard {
  return hermesInteractionCardFromProjection(
    {
      requestId: interaction.requestId,
      kind: interaction.kind,
      prompt: interaction.prompt,
      choices: interaction.choices,
      multiSelect: interaction.multiSelect,
      continuation: interaction.continuation,
      createdAt: interaction.createdAt,
      expiresAt: interaction.expiresAt,
      resolved: false,
      decision: null,
    },
    interaction.runId,
    interaction.runId !== activeRunId,
  );
}

export function mergeHermesInteractionsFromActive(
  prev: MeriHermesInteractionCard[],
  active: MeriHermesActiveConversation,
): MeriHermesInteractionCard[] {
  return active.pendingInteractions.reduce(
    (acc, row) => upsertHermesInteraction(acc, hermesInteractionCardFromActive(row, active.run?.runId ?? null)),
    prev,
  );
}

// ---------------------------------------------------------------------------
// Control-surface URLs (contracts.md §5)
// ---------------------------------------------------------------------------

export function hermesActiveConversationUrl(apiBaseUrl: string, conversationId: string): string {
  return `${apiBaseUrl}/api/clio/hermes/conversations/${encodeURIComponent(conversationId)}/active`;
}
export function hermesRunUrl(apiBaseUrl: string, runId: string): string {
  return `${apiBaseUrl}/api/clio/hermes/runs/${encodeURIComponent(runId)}`;
}
export function hermesRunEventsUrl(apiBaseUrl: string, runId: string, afterSeq = 0): string {
  return `${hermesRunUrl(apiBaseUrl, runId)}/events?after=${Math.max(0, Math.trunc(afterSeq))}`;
}
export function hermesStopUrl(apiBaseUrl: string, runId: string): string {
  return `${hermesRunUrl(apiBaseUrl, runId)}/stop`;
}
export function hermesApprovalUrl(apiBaseUrl: string, runId: string): string {
  return `${hermesRunUrl(apiBaseUrl, runId)}/approval`;
}
export function hermesClarificationUrl(apiBaseUrl: string, runId: string): string {
  return `${hermesRunUrl(apiBaseUrl, runId)}/clarification`;
}
