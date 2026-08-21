/**
 * Phase 8 Session 10 — production schedule ownership, pure domain half.
 *
 * Sessions 7 and 8 already built everything a safe scheduler needs to lean on:
 * a single-owner adapter lease acquired in one atomic statement
 * (`canAcquireWatcherLease`), a seasonal + exponential backoff `nextCheckAt`
 * (`nextWatcherCheckAt`), and a persisted `next_check_at` column that nothing
 * has ever read as a scheduling signal. What did not exist anywhere in the
 * repository is the loop that walks the registered adapters, decides which of
 * them are actually due, and keeps one adapter's exception from ever touching
 * the loop driving the other thirteen. That loop — and nothing about leasing,
 * backoff or idempotency, all of which stay exactly where Session 7 left them
 * — is what this module and its service-layer caller add.
 *
 * Deliberately absent: any notion of "current year". Due-ness is a pure
 * function of `adapterId` and two ISO instants; fiscal-year resolution stays
 * where Session 7 put it, inside the classifier, from document content.
 */

// ── Due-ness ─────────────────────────────────────────────────────────────────

export interface AdapterNextCheck {
  readonly nextCheckAt: string | null;
}

export interface AdapterDueDecision {
  readonly adapterId: string;
  readonly due: boolean;
  readonly reason: string;
}

/**
 * An adapter with no persisted state (`state === null`) or no `nextCheckAt`
 * yet is due now: a fiscal year, or the repository itself, must be operable
 * from a cold start with no engineer pre-seeding a schedule.
 */
export function evaluateAdapterDue(input: {
  readonly adapterId: string;
  readonly state: AdapterNextCheck | null;
  readonly nowIso: string;
}): AdapterDueDecision {
  const now = new Date(input.nowIso).getTime();
  if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);

  if (!input.state || !input.state.nextCheckAt) {
    return Object.freeze({
      adapterId: input.adapterId,
      due: true,
      reason: 'no prior next_check_at recorded; due on first tick',
    });
  }

  const nextCheckAtMs = new Date(input.state.nextCheckAt).getTime();
  if (Number.isNaN(nextCheckAtMs)) {
    throw new RangeError(`Invalid nextCheckAt for ${input.adapterId}: ${input.state.nextCheckAt}`);
  }

  if (nextCheckAtMs <= now) {
    return Object.freeze({
      adapterId: input.adapterId,
      due: true,
      reason: `next_check_at ${input.state.nextCheckAt} has passed`,
    });
  }

  return Object.freeze({
    adapterId: input.adapterId,
    due: false,
    reason: `not due until ${input.state.nextCheckAt}`,
  });
}

/**
 * Evaluate every registered adapter against one instant.
 *
 * However overdue an adapter's `next_check_at` is — a process down for a
 * month leaves it far in the past — this still yields exactly one decision per
 * adapter. Bounded catch-up is a property of calling this once per tick and
 * letting `nextWatcherCheckAt` re-anchor to `nowIso` afterwards, never of this
 * function looping to "catch up" on missed intervals itself.
 */
export function selectDueAdapters(input: {
  readonly adapterIds: readonly string[];
  readonly states: ReadonlyMap<string, AdapterNextCheck>;
  readonly nowIso: string;
}): readonly AdapterDueDecision[] {
  return Object.freeze(
    input.adapterIds.map((adapterId) =>
      evaluateAdapterDue({
        adapterId,
        state: input.states.get(adapterId) ?? null,
        nowIso: input.nowIso,
      }),
    ),
  );
}

// ── Failure handling ─────────────────────────────────────────────────────────

const MAX_FAILURE_REASON_LENGTH = 500;

/**
 * Bound whatever an underlying error says before it can reach an audit row.
 * Nothing on the path a scheduled tick actually touches (adapter registry,
 * lease SQL, the domain classifier) carries a provider credential, so this is
 * a length bound rather than the recursive secret-shaped-value walk Session 9
 * needed for its provider audit — a different table with a different threat
 * model. `[object Object]`-style non-Error throws still produce a bounded,
 * readable string rather than propagating.
 */
export function sanitizeScheduleFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_FAILURE_REASON_LENGTH);
}

// ── Tick summary ─────────────────────────────────────────────────────────────

export type AdapterTickOutcome =
  | 'ran_succeeded'
  | 'ran_failed'
  | 'skipped_not_due'
  | 'skipped_lease_lost';

export interface AdapterTickAttempt {
  readonly adapterId: string;
  readonly outcome: AdapterTickOutcome;
  readonly detail: string;
}

export type ScheduleTickOutcome = 'completed' | 'failed';

export interface ScheduleTickSummary {
  readonly workerId: string;
  readonly tickKey: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: ScheduleTickOutcome;
  readonly horizonBootstrapped: boolean;
  readonly adaptersConsidered: number;
  readonly adaptersDue: number;
  readonly adaptersSucceeded: number;
  readonly adaptersFailed: number;
  readonly adaptersSkippedLease: number;
  readonly committed: boolean;
  readonly failureReason: string | null;
}

export class InvalidScheduleTickSummaryError extends Error {
  constructor(detail: string) {
    super(`Invalid schedule tick summary: ${detail}`);
    this.name = 'InvalidScheduleTickSummaryError';
  }
}

/**
 * Validate and aggregate one tick's per-adapter attempts into the row that
 * gets audited. `outcome: 'failed'` is reserved for the tick machinery itself
 * (the rolling-horizon bootstrap threw, or adapter state could not even be
 * read) — an individual adapter throwing is bucketed into `adaptersFailed`
 * and the tick otherwise still `completed`, because one bad adapter must not
 * read as "the scheduler is down".
 */
export function buildScheduleTickSummary(input: {
  readonly workerId: string;
  readonly tickKey: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly horizonBootstrapped: boolean;
  readonly adaptersConsidered: number;
  readonly attempts: readonly AdapterTickAttempt[];
  readonly committed: boolean;
  readonly failureReason?: string | null;
}): ScheduleTickSummary {
  if (!input.workerId.trim()) {
    throw new InvalidScheduleTickSummaryError('workerId must not be blank');
  }
  if (!input.tickKey.trim()) {
    throw new InvalidScheduleTickSummaryError('tickKey must not be blank');
  }
  const startedAtMs = new Date(input.startedAt).getTime();
  const finishedAtMs = new Date(input.finishedAt).getTime();
  if (Number.isNaN(startedAtMs)) {
    throw new InvalidScheduleTickSummaryError(`invalid startedAt: ${input.startedAt}`);
  }
  if (Number.isNaN(finishedAtMs)) {
    throw new InvalidScheduleTickSummaryError(`invalid finishedAt: ${input.finishedAt}`);
  }
  if (finishedAtMs < startedAtMs) {
    throw new InvalidScheduleTickSummaryError('finishedAt precedes startedAt');
  }
  if (input.adaptersConsidered < 0) {
    throw new InvalidScheduleTickSummaryError('adaptersConsidered must not be negative');
  }

  const due = input.attempts.filter((attempt) => attempt.outcome !== 'skipped_not_due');
  if (due.length > input.adaptersConsidered) {
    throw new InvalidScheduleTickSummaryError('due attempts exceed adaptersConsidered');
  }

  const succeeded = due.filter((attempt) => attempt.outcome === 'ran_succeeded').length;
  const failed = due.filter((attempt) => attempt.outcome === 'ran_failed').length;
  const skippedLease = due.filter((attempt) => attempt.outcome === 'skipped_lease_lost').length;
  if (succeeded + failed + skippedLease !== due.length) {
    throw new InvalidScheduleTickSummaryError(
      'due attempts do not partition into succeeded/failed/skipped-lease',
    );
  }

  const failureReason = input.failureReason?.trim() ? input.failureReason : null;
  const outcome: ScheduleTickOutcome = failureReason ? 'failed' : 'completed';

  return Object.freeze({
    workerId: input.workerId,
    tickKey: input.tickKey,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome,
    horizonBootstrapped: input.horizonBootstrapped,
    adaptersConsidered: input.adaptersConsidered,
    adaptersDue: due.length,
    adaptersSucceeded: succeeded,
    adaptersFailed: failed,
    adaptersSkippedLease: skippedLease,
    committed: input.committed,
    failureReason,
  });
}
