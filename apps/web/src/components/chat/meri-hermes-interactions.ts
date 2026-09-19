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
 * A third source is the reconnect projection `GET .../runs/:runId`
 * (MeriHermesController.projectRun), whose `pendingInteractions[]` covers
 * both kinds in one shape — used to rebuild cards that must "reappear after
 * reload" (Phase 1 backlog ticket 4 acceptance criterion).
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

/** Insert-or-replace by requestId — same contract as meri-pending-approvals'
 * upsertProposal: identity is the opaque request id, never re-derived. */
export function upsertHermesInteraction(
  prev: MeriHermesInteractionCard[],
  next: MeriHermesInteractionCard,
): MeriHermesInteractionCard[] {
  const index = prev.findIndex((c) => c.requestId === next.requestId);
  if (index === -1) return [...prev, next];
  const copy = [...prev];
  copy[index] = next;
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
  pendingInteractions: RawHermesProjectedInteraction[];
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
    pendingInteractions: pending
      .map(readProjectedInteraction)
      .filter((x): x is RawHermesProjectedInteraction => x !== null),
  };
}

export function hermesInteractionCardFromProjection(
  interaction: RawHermesProjectedInteraction,
  runId: string,
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
): MeriHermesInteractionCard[] {
  return projected.reduce(
    (acc, row) => upsertHermesInteraction(acc, hermesInteractionCardFromProjection(row, runId)),
    prev,
  );
}

// ---------------------------------------------------------------------------
// sessionStorage run pointer — lets THIS TAB find an in-flight run again
// after a reload. Scoped to sessionStorage (not localStorage) deliberately:
// it is a per-tab convenience, not shared state, and a stale pointer from a
// closed tab should not resurrect a long-finished run in a new one. There is
// currently no backend "list active runs for a conversation" route (only
// by-runId lookups exist — contracts.md §5), so cross-device / cross-tab
// reconnect discovery is a known gap; see useMeriChatController.ts's
// reconnect effect for how this is used and its documented limitation.
// ---------------------------------------------------------------------------

export interface MeriHermesRunPointer {
  runId: string;
}

const POINTER_PREFIX = 'meri-hermes-run:';

export interface MeriHermesStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function pointerKey(conversationId: string): string {
  return `${POINTER_PREFIX}${conversationId}`;
}

export function readHermesRunPointer(
  storage: MeriHermesStorageLike | null | undefined,
  conversationId: string | null | undefined,
): MeriHermesRunPointer | null {
  if (!storage || !conversationId) return null;
  try {
    const raw = storage.getItem(pointerKey(conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { runId?: unknown };
    return typeof parsed.runId === 'string' && parsed.runId ? { runId: parsed.runId } : null;
  } catch {
    return null;
  }
}

export function writeHermesRunPointer(
  storage: MeriHermesStorageLike | null | undefined,
  conversationId: string | null | undefined,
  pointer: MeriHermesRunPointer,
): void {
  if (!storage || !conversationId) return;
  try {
    storage.setItem(pointerKey(conversationId), JSON.stringify(pointer));
  } catch {
    // Best-effort: a private window or a full quota just disables
    // cross-reload resume, never breaks the live turn itself.
  }
}

export function clearHermesRunPointer(
  storage: MeriHermesStorageLike | null | undefined,
  conversationId: string | null | undefined,
): void {
  if (!storage || !conversationId) return;
  try {
    storage.removeItem(pointerKey(conversationId));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Control-surface URLs (contracts.md §5)
// ---------------------------------------------------------------------------

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
