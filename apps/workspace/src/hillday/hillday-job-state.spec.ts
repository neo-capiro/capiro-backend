import { describe, expect, it } from '@jest/globals';
import {
  LEASE_LOST_REASON,
  PROVIDER_UNCERTAIN_REASON,
  claimFence,
  finalLifecycle,
  isTerminalLifecycle,
  isUncertainProviderReason,
  jobQuality,
  recoverInterruptedUnits,
  requeueFailedUnits,
  retryableUnits,
  runnableUnits,
  unitStateForFailure,
} from './hillday-job-state.js';
import type { JobUnit } from './hillday.types.js';

/** A unit as the worker persists it. */
function unit(meetingId: string, state: JobUnit['state'], reason: string | null = null): JobUnit {
  return { meetingId, state, sectionId: meetingId, reason, at: '2026-10-26T00:00:00.000Z' };
}

const AT = '2026-10-26T12:00:00.000Z';

describe('WS-10 durable job state — restart recovery', () => {
  it('parks a unit left running by a previous holder as unknown, never as queued', () => {
    const { units, recovered } = recoverInterruptedUnits([unit('m-1', 'running')], AT);
    expect(recovered).toEqual(['m-1']);
    expect(units[0]).toMatchObject({ meetingId: 'm-1', state: 'unknown', reason: LEASE_LOST_REASON, at: AT });
  });

  it('never re-runs a unit whose provider outcome is unknown (lease expiry is not evidence of failure)', () => {
    // This is the acceptance invariant: a second process must not assume the
    // first stopped and issue the paid call again.
    const { units } = recoverInterruptedUnits([unit('m-1', 'running')], AT);
    expect(runnableUnits(units)).toEqual([]);
    expect(retryableUnits(units).map((u) => u.meetingId)).toEqual(['m-1']);
  });

  it('keeps done units untouched and does not re-run them on resume', () => {
    const { units, recovered } = recoverInterruptedUnits(
      [unit('m-1', 'done'), unit('m-2', 'running'), unit('m-3', 'failed', 'provider_unavailable')],
      AT,
    );
    expect(recovered).toEqual(['m-2']);
    expect(units.map((u) => u.state)).toEqual(['done', 'unknown', 'failed']);
    expect(runnableUnits(units)).toEqual([]);
  });

  it('runs only units nothing has started yet — a live unit is never picked up', () => {
    const units = [unit('m-1', 'done'), unit('m-2', 'queued'), unit('m-3', 'unknown'), unit('m-4', 'failed'), unit('m-5', 'running')];
    expect(runnableUnits(units).map((u) => u.meetingId)).toEqual(['m-2']);
  });

  it('a bare running unit is not runnable on its own, without any recovery step', () => {
    // The no-duplicate-charge guarantee must not depend on recovery having run
    // first: `runnableUnits` itself has to exclude a unit that is in flight.
    expect(runnableUnits([unit('m-1', 'running')])).toEqual([]);
  });

  it('reports no recovery for a first claim', () => {
    const { recovered } = recoverInterruptedUnits([unit('m-1', 'queued'), unit('m-2', 'queued')], AT);
    expect(recovered).toEqual([]);
  });
});

describe('WS-10 durable job state — deliberate retry', () => {
  it('re-queues only failed and unknown units, preserving done units verbatim', () => {
    const before = [unit('m-1', 'done'), unit('m-2', 'failed', 'provider_timeout'), unit('m-3', 'unknown', LEASE_LOST_REASON)];
    const { units, requeued } = requeueFailedUnits(before, AT);
    expect(requeued).toEqual(['m-2', 'm-3']);
    expect(units.map((u) => u.state)).toEqual(['done', 'queued', 'queued']);
    expect(units[0]).toEqual(before[0]); // the successful unit is byte-identical
    expect(units[1]).toMatchObject({ reason: null, at: AT });
    expect(before[1]).toMatchObject({ state: 'failed' }); // input not mutated
  });

  it('re-queues nothing when every unit succeeded', () => {
    const { requeued, units } = requeueFailedUnits([unit('m-1', 'done'), unit('m-2', 'done')], AT);
    expect(requeued).toEqual([]);
    expect(units.every((u) => u.state === 'done')).toBe(true);
  });

  it('does not re-queue a unit that is still running for the current holder', () => {
    const { requeued } = requeueFailedUnits([unit('m-1', 'running')], AT);
    expect(requeued).toEqual([]);
  });
});

describe('WS-10 durable job state — lifecycle and quality', () => {
  it('reports cancelled when the worker observed the cancellation', () => {
    expect(finalLifecycle(true)).toBe('cancelled');
  });

  it('reports complete for a finished pass', () => {
    expect(finalLifecycle(false)).toBe('complete');
  });

  it('measures quality as the done share of units', () => {
    expect(jobQuality([unit('m-1', 'done'), unit('m-2', 'done'), unit('m-3', 'failed'), unit('m-4', 'unknown')])).toBe(0.5);
    expect(jobQuality([unit('m-1', 'done')])).toBe(1);
    expect(jobQuality([])).toBe(0);
  });

  it('treats only complete, failed and cancelled as terminal', () => {
    expect(['complete', 'failed', 'cancelled'].map(isTerminalLifecycle)).toEqual([true, true, true]);
    expect(['queued', 'running'].map(isTerminalLifecycle)).toEqual([false, false]);
  });
});

describe('WS-10 durable job state — claim fencing', () => {
  it('fences on the holder AND the claim generation, so a later claim in the same process cannot match', () => {
    const first = claimFence('job-1', { holder: 'worker-1', attempt: 1 });
    const later = claimFence('job-1', { holder: 'worker-1', attempt: 2 });
    // Same process (holder), a new claim: the fence must still differ, otherwise a
    // superseded invocation would keep writing over its own successor.
    expect(first).not.toEqual(later);
    expect(first).toMatchObject({ id: 'job-1', leaseHolder: 'worker-1', attemptCount: 1, status: 'running' });
    expect(later).toMatchObject({ attemptCount: 2 });
  });

  it('fences on the running status, so a terminal job cannot be written again', () => {
    expect(claimFence('job-1', { holder: 'w', attempt: 3 }).status).toBe('running');
  });
});

describe('WS-10 durable job state — provider uncertainty', () => {
  it('parks a transport-uncertain failure as unknown instead of re-runnable failed', () => {
    expect(unitStateForFailure(PROVIDER_UNCERTAIN_REASON)).toBe('unknown');
    expect(unitStateForFailure('provider_timeout')).toBe('unknown');
  });

  it('keeps a definitive provider refusal as failed', () => {
    expect(unitStateForFailure('provider_unavailable')).toBe('failed');
    expect(unitStateForFailure(null)).toBe('failed');
    expect(unitStateForFailure(undefined)).toBe('failed');
  });

  it('classifies only genuinely ambiguous reasons as uncertain', () => {
    expect(isUncertainProviderReason(PROVIDER_UNCERTAIN_REASON)).toBe(true);
    expect(isUncertainProviderReason('provider_unavailable')).toBe(false);
    expect(isUncertainProviderReason(null)).toBe(false);
  });

  it('never makes an uncertain unit automatically runnable', () => {
    expect(runnableUnits([unit('m-1', unitStateForFailure(PROVIDER_UNCERTAIN_REASON))])).toEqual([]);
  });
});
