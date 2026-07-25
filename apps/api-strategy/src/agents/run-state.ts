/*
 * Run/mission lifecycle state machines. PURE module (no Nest imports): assert
 * helpers throw plain Errors; the services wrap illegal transitions in
 * BadRequestException. Mirrors the SpRunState / SpMissionState Prisma enums —
 * the schema is authoritative for the value sets; this module is authoritative
 * for which moves between them are legal, what each state MEANS to a user, when
 * a run in it is considered stranded, and what a user may do from it.
 *
 * ---- P0-2 (deep-audit critical finding) --------------------------------------
 * "Execution runs can become permanently stranded." The pre-P0-2 machine had 8
 * states, one undifferentiated `failed`, no timeout or heartbeat concept, and no
 * notion of which actions a state permits — so a run that died between the
 * external artifact hop and its back-link write sat in `executing` or
 * `waiting_for_input` forever with no retry, cancel, reconcile or repair path,
 * and the idempotency key blocked a fresh attempt.
 *
 * This module now carries the audit's full vocabulary:
 *  - `approved`           — the exact payload was authorised (WRITTEN BY P0-3's
 *                           approve action; P0-2 only makes the state legal)
 *  - `staged`             — the Workspace/Outreach artifact exists and is linked
 *  - `failed_recoverable` — failed, but a retry/reconcile can still fix it. NOT
 *                           terminal: the reconciler can drive it to staged or
 *                           completed once it establishes what really happened
 *  - `failed_terminal`    — failed for good; only a NEW attempt can follow
 *  - `superseded`         — this attempt was abandoned in favour of a retry
 *
 * `failed` is RETAINED as a LEGACY value: pre-P0-2 rows carry it, so it must
 * stay in the enum and read as terminal, but nothing transitions INTO it any
 * more (see the run-state.spec "no dead states" exemption).
 *
 * DELIBERATELY NOT RENAMED: `canceled` keeps its existing spelling. The audit's
 * prose says `cancelled`, but this is a live enum value with rows in production;
 * renaming it would churn every reference and every stored findings blob for a
 * spelling preference.
 */

export const RUN_STATES = [
  'queued',
  'planning',
  'waiting_for_input',
  'ready_for_review',
  'approved',
  'executing',
  'staged',
  'completed',
  'failed',
  'failed_recoverable',
  'failed_terminal',
  'canceled',
  'superseded',
] as const;
export type RunStateValue = (typeof RUN_STATES)[number];

export const MISSION_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'canceled',
] as const;
export type MissionStateValue = (typeof MISSION_STATES)[number];

/**
 * Legal run-state moves.
 *
 * planning -> ready_for_review is the Stage F CHECK-RUN shape: a Watcher check
 * has no external execution phase (suggest-only — it only reads state and
 * proposes change-sets), so it skips 'executing' and goes straight to review.
 *
 * ready_for_review -> executing (Stage G): a Do-mode plan is REVIEWED in
 * ready_for_review (nothing staged yet), and only when the human approves the
 * plan does ExecutionService.execute drive it into 'executing' to stage the
 * artifacts. ready_for_review -> waiting_for_input (Stage G): execute PARKS a
 * reviewed run before staging when the mandatory interactive caller bearer is
 * absent ('execution requires an interactive session') — a reviewed plan must
 * never perform a bearerless external hop, so it waits for input instead of
 * proceeding.
 *
 * ready_for_review -> approved (P0-3): the reviewer authorises the EXACT
 * generated payload. approved -> executing is then the only route into staging
 * for an approval-bound run.
 *
 * executing -> staged (P0-2): the artifact exists AND its node back-link is
 * committed. staged -> completed is the separate, explicit finish — so
 * "an artifact was created" can never be mistaken for "the work is done".
 *
 * -> failed_recoverable from every active state (P0-2): the reconciler's landing
 * zone for a stranded run. failed_recoverable keeps OUTGOING edges on purpose —
 * once reconciliation establishes what actually happened it drives the run to
 * staged/completed (artifact found) or failed_terminal (nothing to recover).
 *
 * -> superseded (P0-2) only from the states where an attempt is still OPEN.
 * Retrying a genuinely terminal run (completed/failed_terminal/canceled) does
 * NOT rewrite that row; the new attempt just records retryOfRunId. That keeps
 * terminal states truly terminal.
 */
export const RUN_TRANSITIONS: Record<RunStateValue, readonly RunStateValue[]> = {
  queued: ['planning', 'canceled'],
  planning: [
    'executing',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  waiting_for_input: [
    'planning',
    'executing',
    'ready_for_review',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  ready_for_review: [
    'approved',
    'executing',
    'waiting_for_input',
    'staged',
    'completed',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  approved: ['executing', 'waiting_for_input', 'failed_recoverable', 'failed_terminal', 'canceled'],
  executing: [
    'staged',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  staged: [
    'completed',
    'ready_for_review',
    'waiting_for_input',
    'failed_recoverable',
    'failed_terminal',
    'canceled',
  ],
  failed_recoverable: [
    'planning',
    'executing',
    'staged',
    'completed',
    'failed_terminal',
    'canceled',
    'superseded',
  ],
  completed: [],
  // LEGACY: pre-P0-2 rows only. Terminal, and no longer a transition target.
  failed: [],
  failed_terminal: [],
  canceled: [],
  superseded: [],
};

/**
 * Legal mission-state moves. completed/failed/canceled are terminal. `failed`
 * is reachable from active/paused (e.g. the scheduler failing a mission after
 * repeated run failures) — never from draft, which cancels instead.
 */
export const MISSION_TRANSITIONS: Record<MissionStateValue, readonly MissionStateValue[]> = {
  draft: ['active', 'canceled'],
  active: ['paused', 'completed', 'failed', 'canceled'],
  paused: ['active', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export const RUN_TERMINAL_STATES: ReadonlySet<string> = new Set(
  RUN_STATES.filter((s) => RUN_TRANSITIONS[s].length === 0),
);

/** The failure states (legacy `failed` included) — used for error stamping. */
export const RUN_FAILURE_STATES: ReadonlySet<string> = new Set([
  'failed',
  'failed_recoverable',
  'failed_terminal',
]);

/**
 * States from which a RETRY marks the prior attempt `superseded`. Retrying from
 * anywhere else (a genuinely terminal run) leaves that row alone and only records
 * the new attempt's lineage.
 */
export const RUN_SUPERSEDABLE_STATES: ReadonlySet<string> = new Set([
  'waiting_for_input',
  'ready_for_review',
  'failed_recoverable',
]);

// ---- P0-2 per-state policy ----------------------------------------------------

/**
 * Everything a user (or the reconciler) may do to a run. These drive BOTH the
 * API's allowed-action check and the recovery controls the review UI renders, so
 * the buttons on screen cannot drift from what the server will accept.
 */
export const RUN_ACTIONS = [
  'execute',
  'approve',
  'resume',
  'resolve_input',
  'retry',
  'cancel',
  'reconcile',
  'mark_failed',
  'open_artifact',
  'return_to_node',
  'compare',
] as const;
export type RunActionValue = (typeof RUN_ACTIONS)[number];

export interface RunStatePolicy {
  terminal: boolean;
  /**
   * Minutes without a heartbeat after which the reconciler treats a run in this
   * state as STRANDED. null means "no timeout": the run is legitimately parked
   * on a human (or already terminal), so elapsed time proves nothing.
   */
  timeoutMinutes: number | null;
  /** What may be done from here — the audit's "allowed-next-actions list". */
  actions: readonly RunActionValue[];
  /** The audit's "user-readable reason": what this state means, in plain words. */
  reason: string;
}

/**
 * The audit's requirement: "Every nonterminal state should have a timeout,
 * heartbeat, allowed-next-actions list, reconciliation rule, and user-readable
 * reason." Timeouts are generous — they are a stranded-run detector, not an SLA.
 *
 * Note which states have NO timeout: waiting_for_input, ready_for_review, staged
 * and failed_recoverable are all parked on a HUMAN. Ageing them out would turn
 * "nobody has looked at this yet" into "this run is broken", which is exactly the
 * kind of misleading state the audit is about.
 */
export const RUN_STATE_POLICY: Record<RunStateValue, RunStatePolicy> = {
  queued: {
    terminal: false,
    timeoutMinutes: 15,
    actions: ['cancel'],
    reason: 'Queued — waiting for an agent worker to pick it up.',
  },
  planning: {
    terminal: false,
    timeoutMinutes: 15,
    actions: ['cancel'],
    reason: 'Planning — checking eligibility and building the task list. Nothing has been created.',
  },
  waiting_for_input: {
    terminal: false,
    timeoutMinutes: null,
    // `approve` belongs here (P0-3): when an approval is INVALIDATED the run parks
    // in this state, and re-approving the CURRENT payload is the whole remediation.
    // Omitting it made invalidation a dead end — the user could see why their
    // approval died but had no way to grant a new one.
    actions: [
      'resume',
      'resolve_input',
      'approve',
      'retry',
      'reconcile',
      'cancel',
      'return_to_node',
    ],
    reason: 'Blocked — it needs something from you before it can continue.',
  },
  ready_for_review: {
    terminal: false,
    timeoutMinutes: null,
    actions: ['execute', 'approve', 'retry', 'cancel', 'return_to_node'],
    reason: 'Ready for your review — the plan is prepared but nothing has been created yet.',
  },
  approved: {
    terminal: false,
    timeoutMinutes: 30,
    actions: ['execute', 'cancel', 'return_to_node'],
    reason: 'Approved — the exact payload is authorised and staging can proceed.',
  },
  executing: {
    terminal: false,
    timeoutMinutes: 15,
    actions: ['cancel', 'reconcile'],
    reason: 'Working — creating the Workspace draft or Outreach record now.',
  },
  staged: {
    terminal: false,
    timeoutMinutes: null,
    actions: ['open_artifact', 'return_to_node', 'cancel'],
    reason:
      'Staged — the draft or record exists and is linked to the step. Nothing was sent. Confirm to finish.',
  },
  completed: {
    terminal: true,
    timeoutMinutes: null,
    actions: ['open_artifact', 'return_to_node', 'compare'],
    reason: 'Completed — this run is finished.',
  },
  failed: {
    terminal: true,
    timeoutMinutes: null,
    actions: ['retry', 'return_to_node'],
    reason: 'Failed. (Recorded before failures were split into recoverable and terminal.)',
  },
  failed_recoverable: {
    terminal: false,
    timeoutMinutes: null,
    actions: ['retry', 'reconcile', 'mark_failed', 'cancel', 'return_to_node', 'compare'],
    reason:
      'Failed part-way, but recoverable — reconcile to find out what was actually created, or retry.',
  },
  failed_terminal: {
    terminal: true,
    timeoutMinutes: null,
    actions: ['retry', 'return_to_node', 'compare'],
    reason: 'Failed and cannot be recovered — start a new attempt if you still need this.',
  },
  canceled: {
    terminal: true,
    timeoutMinutes: null,
    actions: ['retry', 'return_to_node', 'compare'],
    reason: 'Canceled — this run was stopped before it finished. Nothing was sent.',
  },
  superseded: {
    terminal: true,
    timeoutMinutes: null,
    actions: ['return_to_node', 'compare'],
    reason: 'Superseded by a later attempt.',
  },
};

/** Whether `action` is permitted from `state` (unknown state => nothing). */
export function isActionAllowed(state: string, action: RunActionValue): boolean {
  const policy = (RUN_STATE_POLICY as Record<string, RunStatePolicy | undefined>)[state];
  return !!policy && policy.actions.includes(action);
}

/** The plain-words meaning of a state, for user-facing surfaces. */
export function reasonForState(state: string): string {
  return (
    (RUN_STATE_POLICY as Record<string, RunStatePolicy | undefined>)[state]?.reason ??
    `Run is in an unrecognised state (${state}).`
  );
}

/**
 * Whether a run in `state`, last seen at `lastActivityAt`, has blown its state's
 * timeout — the reconciler's "runs inactive beyond a threshold" detection.
 * States with a null timeout (parked on a human) NEVER age out.
 */
export function isStranded(
  state: string,
  lastActivityAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  const policy = (RUN_STATE_POLICY as Record<string, RunStatePolicy | undefined>)[state];
  if (!policy || policy.terminal || policy.timeoutMinutes == null) return false;
  // No heartbeat at all on an active run: treat the row as stranded only if we
  // have SOME timestamp to measure from; a caller that passes null is telling us
  // it cannot date the run, and guessing "stranded" would fail runs at random.
  if (lastActivityAt == null) return false;
  const elapsedMs = nowMs - new Date(lastActivityAt).getTime();
  return elapsedMs > policy.timeoutMinutes * 60_000;
}

export function isLegalTransition(from: string, to: string): boolean {
  const allowed = (RUN_TRANSITIONS as Record<string, readonly string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Throws a plain Error on an illegal run transition (service wraps in 400). */
export function assertTransition(from: string, to: string): void {
  if (!isLegalTransition(from, to)) {
    const allowed = (RUN_TRANSITIONS as Record<string, readonly string[]>)[from];
    throw new Error(
      allowed === undefined
        ? `Unknown run state '${from}'`
        : allowed.length === 0
          ? `Run is ${from} (terminal) — no further transitions`
          : `Cannot transition run from '${from}' to '${to}' (allowed: ${allowed.join(', ')})`,
    );
  }
}

export function isLegalMissionTransition(from: string, to: string): boolean {
  const allowed = (MISSION_TRANSITIONS as Record<string, readonly string[]>)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Throws a plain Error on an illegal mission transition (service wraps in 400). */
export function assertMissionTransition(from: string, to: string): void {
  if (!isLegalMissionTransition(from, to)) {
    const allowed = (MISSION_TRANSITIONS as Record<string, readonly string[]>)[from];
    throw new Error(
      allowed === undefined
        ? `Unknown mission state '${from}'`
        : allowed.length === 0
          ? `Mission is ${from} (terminal) — no further transitions`
          : `Cannot transition mission from '${from}' to '${to}' (allowed: ${allowed.join(', ')})`,
    );
  }
}
