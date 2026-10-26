/**
 * Durable Hill Day job state decisions (WS-10).
 *
 * Pure functions only: no Prisma, no IO, no clock of their own. The service,
 * the worker and the focused tests therefore read the SAME rule, and the rules
 * that keep a paid provider call from being issued twice can be tested without
 * a database.
 *
 * The one rule everything else follows from: a unit whose provider call may
 * already have been issued (it was `running` when its worker lost the lease)
 * has an UNKNOWN outcome. It is parked as `unknown` and only a deliberate retry
 * re-runs it — a lease expiring is not evidence that the provider call failed.
 */

import type { JobLifecycle, JobUnit, UnitState } from './hillday.types.js';

export type { JobLifecycle, UnitState };

/** Why a unit is parked instead of re-run: the provider may have been charged. */
export const LEASE_LOST_REASON = 'lease_lost_provider_uncertain';

/** A provider call whose outcome we cannot know: it may have been accepted and charged. */
export const PROVIDER_UNCERTAIN_REASON = 'provider_uncertain';

/**
 * Failure reasons that do NOT prove the provider refused the work. A thrown
 * transport error or a timeout happens after the request may already have been
 * accepted and charged, so those units must be parked, never automatically
 * replayed.
 */
export const UNCERTAIN_PROVIDER_REASONS: readonly string[] = [
  PROVIDER_UNCERTAIN_REASON,
  'provider_timeout',
];

/** True when a failure reason leaves the provider outcome genuinely unknown. */
export function isUncertainProviderReason(reason: string | null | undefined): boolean {
  return reason != null && UNCERTAIN_PROVIDER_REASONS.includes(reason);
}

/**
 * Unit state for a failed unit: `unknown` when the provider outcome is
 * uncertain (never auto-replayed, only a deliberate retry re-runs it),
 * otherwise a definitive `failed`.
 */
export function unitStateForFailure(reason: string | null | undefined): UnitState {
  return isUncertainProviderReason(reason) ? 'unknown' : 'failed';
}

/**
 * The identity of ONE claim: the lease holder plus the claim generation
 * (`attempt_count`, bumped by the conditional claim). A holder id alone is
 * process-wide, so a later claim by the SAME process would be indistinguishable
 * from the previous invocation; the attempt makes every claim unique.
 */
export interface JobClaim {
  holder: string;
  attempt: number;
}

/**
 * The where-clause that fences every write a claim performs. A write built on
 * this predicate only lands while the claim is still the job's current,
 * running owner — a superseded holder (same process or another) matches
 * nothing and must stop rather than publish a late result.
 */
export function claimFence(jobId: string, claim: JobClaim) {
  return {
    id: jobId,
    leaseHolder: claim.holder,
    attemptCount: claim.attempt,
    status: 'running',
  };
}

/**
 * Recover units a previous lease holder left `running`. Their outcome is
 * genuinely unknown — the process died after the call may have been issued —
 * so they are parked as `unknown` rather than re-queued. `done` units are
 * untouched (success is never discarded).
 */
export function recoverInterruptedUnits(
  units: readonly JobUnit[],
  at: string,
): { units: JobUnit[]; recovered: string[] } {
  const recovered: string[] = [];
  const next = units.map((unit) => {
    if (unit.state !== 'running') return { ...unit };
    recovered.push(unit.meetingId);
    return { ...unit, state: 'unknown' as UnitState, reason: LEASE_LOST_REASON, at };
  });
  return { units: next, recovered };
}

/**
 * Units a claiming worker may run without asking: only ones nothing has
 * started yet. A `running` unit is deliberately excluded — that is the whole
 * no-duplicate-charge guarantee.
 */
export function runnableUnits(units: readonly JobUnit[]): JobUnit[] {
  return units.filter((unit) => unit.state === 'queued');
}

/** Units a deliberate retry re-queues: definitively failed, or unknown outcome. */
export function retryableUnits(units: readonly JobUnit[]): JobUnit[] {
  return units.filter((unit) => unit.state === 'failed' || unit.state === 'unknown');
}

/**
 * Rewrite the units array for a deliberate retry: `failed`/`unknown` units go
 * back to `queued`; `done` units are preserved verbatim so successful content
 * and hand-edited sections are never regenerated.
 */
export function requeueFailedUnits(
  units: readonly JobUnit[],
  at: string,
): { units: JobUnit[]; requeued: string[] } {
  const requeued: string[] = [];
  const next = units.map((unit) => {
    if (unit.state !== 'failed' && unit.state !== 'unknown') return { ...unit };
    requeued.push(unit.meetingId);
    return { ...unit, state: 'queued' as UnitState, reason: null, at };
  });
  return { units: next, requeued };
}

/** Share of units whose section was generated, mirroring the accepted metric. */
export function jobQuality(units: readonly JobUnit[]): number {
  if (!units.length) return 0;
  const done = units.filter((unit) => unit.state === 'done').length;
  return Number((done / units.length).toFixed(2));
}

/**
 * Terminal lifecycle for a finished pass. A cancellation the worker actually
 * observed wins: the job reports `cancelled`, never `complete`. Otherwise the
 * pass is `complete` even when units failed or are unknown — that is the
 * accepted convention (quality carries the shortfall and the document carries
 * `partial`), and it keeps `complete` meaning "this pass finished".
 */
export function finalLifecycle(cancelRequested: boolean): JobLifecycle {
  return cancelRequested ? 'cancelled' : 'complete';
}

/** True once the job's own status is one the worker will not advance again. */
export function isTerminalLifecycle(status: string): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}
