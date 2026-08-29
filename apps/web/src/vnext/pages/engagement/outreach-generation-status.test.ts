import { describe, expect, it } from 'vitest';
import type { OutreachV3GenerationJob } from './engagement-api.js';
import { outreachV3FullGenerationRequestKey } from './engagement-api.js';
import {
  outreachGenerationItemCode,
  outreachGenerationPollMs,
  outreachGenerationProgress,
  outreachGenerationRetryOf,
  outreachGenerationState,
} from './outreach-generation-status.js';

function job(
  status: string,
  items: Array<{ status: string; error?: unknown }>,
  id = '77675445-47eb-4aee-bf89-26ae4f6c28e7',
): OutreachV3GenerationJob {
  return {
    id,
    status,
    items: items.map((item, index) => ({
      id: `i${index}`,
      generationKey: `k${index}`,
      attempt: 1,
      status: item.status,
      error: item.error ?? null,
    })),
  } as unknown as OutreachV3GenerationJob;
}

describe('outreachGenerationItemCode', () => {
  it('reads the STRING the server actually sends, not the object the type claims', () => {
    // `safeError()` in outreach-v3-full-generation.service.ts returns a plain
    // truncated string; the wire type declares `{ code?, message? }`. Trusting
    // the type is how a code renders as "[object Object]".
    expect(outreachGenerationItemCode(job('failed', [{ status: 'failed', error: 'PLAN_GENERATION_FAILED' }]).items[0]!)).toBe(
      'PLAN_GENERATION_FAILED',
    );
  });

  it('still reads the declared object shape, preferring code over message', () => {
    const item = job('failed', [
      { status: 'failed', error: { code: 'BLOCKED', message: 'something else' } },
    ]).items[0]!;
    expect(outreachGenerationItemCode(item)).toBe('BLOCKED');
  });

  it('falls back to message, and treats empty or absent as no code', () => {
    const withMessage = job('failed', [{ status: 'failed', error: { message: 'upstream 500' } }])
      .items[0]!;
    expect(outreachGenerationItemCode(withMessage)).toBe('upstream 500');
    expect(outreachGenerationItemCode(job('failed', [{ status: 'failed', error: '  ' }]).items[0]!)).toBeNull();
    expect(outreachGenerationItemCode(job('failed', [{ status: 'failed' }]).items[0]!)).toBeNull();
  });
});

describe('outreachGenerationProgress', () => {
  it('counts every terminal item as done, not just the successful ones', () => {
    const progress = outreachGenerationProgress(
      job('partial', [
        { status: 'done' },
        { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
        { status: 'skipped' },
        { status: 'pending' },
      ]),
    );
    expect(progress).toEqual({
      done: 3,
      total: 4,
      failed: 1,
      codes: ['PLAN_GENERATION_FAILED'],
    });
  });

  it('collapses repeated codes so two recipients failing the same way read as one cause', () => {
    const progress = outreachGenerationProgress(
      job('failed', [
        { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
        { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
      ]),
    );
    expect(progress.codes).toEqual(['PLAN_GENERATION_FAILED']);
    expect(progress.failed).toBe(2);
  });
});

describe('outreachGenerationState', () => {
  it('distinguishes never-started from in-flight from failed', () => {
    expect(outreachGenerationState(null, 0)).toEqual({ kind: 'none' });
    expect(outreachGenerationState(job('running', [{ status: 'pending' }]), 0).kind).toBe('running');
    expect(outreachGenerationState(job('queued', [{ status: 'pending' }]), 0).kind).toBe('running');
  });

  it('calls a finished job with no drafts a failure — this is the live 2026-08-29 case', () => {
    // Both items failed with PLAN_GENERATION_FAILED (no upstream credits) and
    // the step showed "Accept the packet on the review step" for half an hour.
    const state = outreachGenerationState(
      job('failed', [
        { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
        { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
      ]),
      0,
    );
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' && state.progress.codes).toEqual(['PLAN_GENERATION_FAILED']);
  });

  it('trusts the draft count over the job status in both directions', () => {
    // A `complete` job that produced nothing is still a failure...
    expect(outreachGenerationState(job('complete', [{ status: 'done' }]), 0).kind).toBe('failed');
    // ...and a `partial` job whose drafts all landed needs no warning.
    expect(outreachGenerationState(job('partial', [{ status: 'done' }]), 1).kind).toBe('ready');
  });

  it('reports partial when some recipients have drafts and some do not', () => {
    const state = outreachGenerationState(
      job('partial', [{ status: 'done' }, { status: 'failed', error: 'PLAN_GENERATION_FAILED' }]),
      1,
    );
    expect(state.kind).toBe('partial');
  });
});

describe('outreachGenerationPollMs', () => {
  it('polls only while a job is in flight', () => {
    expect(outreachGenerationPollMs({ kind: 'running', progress: { done: 0, total: 2, failed: 0, codes: [] } })).toBe(4000);
    for (const kind of ['none', 'ready'] as const) {
      expect(outreachGenerationPollMs({ kind })).toBe(false);
    }
    expect(
      outreachGenerationPollMs({ kind: 'failed', progress: { done: 2, total: 2, failed: 2, codes: [] } }),
    ).toBe(false);
  });
});

describe('retrying a failed generation', () => {
  const HASH = 'a'.repeat(64);
  const SESSION = '6c991293-7d02-4785-990c-fc5fced880da';

  it('keeps the first-attempt key unchanged so existing jobs still resolve', () => {
    expect(outreachV3FullGenerationRequestKey(SESSION, HASH)).toBe(`${SESSION}:${HASH}`);
    expect(outreachV3FullGenerationRequestKey(SESSION, HASH, null)).toBe(`${SESSION}:${HASH}`);
  });

  it('gives a failed job a NEW key — submit() returns the existing job otherwise', () => {
    const failed = job('failed', [{ status: 'failed', error: 'PLAN_GENERATION_FAILED' }]);
    const retryOf = outreachGenerationRetryOf(failed, 0);
    expect(retryOf).toBe('77675445-47e');
    const key = outreachV3FullGenerationRequestKey(SESSION, HASH, retryOf);
    expect(key).not.toBe(`${SESSION}:${HASH}`);
    // The server rejects anything outside 8–128 characters.
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it('is itself idempotent — retrying one failed job twice cannot mint two jobs', () => {
    const failed = job('failed', [{ status: 'failed', error: 'PLAN_GENERATION_FAILED' }]);
    expect(outreachGenerationRetryOf(failed, 0)).toBe(outreachGenerationRetryOf(failed, 0));
  });

  it('does not retry a job that is still running or that produced every draft', () => {
    expect(outreachGenerationRetryOf(job('running', [{ status: 'pending' }]), 0)).toBeNull();
    expect(outreachGenerationRetryOf(job('complete', [{ status: 'done' }]), 1)).toBeNull();
    expect(outreachGenerationRetryOf(null, 0)).toBeNull();
  });

  it('retries a partial job, since some recipients still have no draft', () => {
    const partial = job('partial', [
      { status: 'done' },
      { status: 'failed', error: 'PLAN_GENERATION_FAILED' },
    ]);
    expect(outreachGenerationRetryOf(partial, 1)).toBe('77675445-47e');
  });
});
