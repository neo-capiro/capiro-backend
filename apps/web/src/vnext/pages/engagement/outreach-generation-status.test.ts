import { describe, expect, it } from 'vitest';
import type { OutreachV3GenerationJob } from './engagement-api.js';
import { outreachV3FullGenerationRequestKey } from './engagement-api.js';
import {
  formatOutreachGenerationEta,
  outreachGenerationEta,
  outreachGenerationItemCode,
  outreachGenerationLivePreviewSnippet,
  outreachGenerationPollMs,
  outreachGenerationProgress,
  outreachGenerationRetryOf,
  outreachGenerationState,
} from './outreach-generation-status.js';

function job(
  status: string,
  items: Array<{ status: string; error?: unknown; livePreview?: string | null }>,
  id = '77675445-47eb-4aee-bf89-26ae4f6c28e7',
  timing: { startedAt?: string | null; createdAt?: string } = {},
): OutreachV3GenerationJob {
  return {
    id,
    status,
    startedAt: timing.startedAt ?? null,
    createdAt: timing.createdAt ?? '2026-08-31T00:00:00.000Z',
    items: items.map((item, index) => ({
      id: `i${index}`,
      generationKey: `k${index}`,
      attempt: 1,
      status: item.status,
      error: item.error ?? null,
      livePreview: item.livePreview ?? null,
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

describe('outreachGenerationEta', () => {
  const NOW = new Date('2026-08-31T00:20:00.000Z').getTime();

  it('has nothing to estimate before any item has finished', () => {
    const running = job('running', [{ status: 'pending' }, { status: 'pending' }], undefined, {
      startedAt: '2026-08-31T00:00:00.000Z',
    });
    const eta = outreachGenerationEta(running, outreachGenerationProgress(running), NOW);
    expect(eta.estimatedSecondsRemaining).toBeNull();
  });

  it('extrapolates from elapsed-time-so-far divided by items done, not a fixed per-draft constant', () => {
    // Started 20 minutes ago (1200s); 1 of 4 done → 1200s/item → 3 remaining × 1200s.
    const running = job(
      'running',
      [{ status: 'done' }, { status: 'pending' }, { status: 'pending' }, { status: 'pending' }],
      undefined,
      { startedAt: '2026-08-31T00:00:00.000Z' },
    );
    const eta = outreachGenerationEta(running, outreachGenerationProgress(running), NOW);
    expect(eta.estimatedSecondsRemaining).toBe(3600);
  });

  it('falls back to createdAt when the job has no startedAt yet', () => {
    const running = job('running', [{ status: 'done' }, { status: 'pending' }], undefined, {
      startedAt: null,
      createdAt: '2026-08-31T00:10:00.000Z',
    });
    // 10 minutes elapsed, 1 of 2 done → 600s/item → 1 remaining × 600s.
    const eta = outreachGenerationEta(running, outreachGenerationProgress(running), NOW);
    expect(eta.estimatedSecondsRemaining).toBe(600);
  });

  it('reports zero once nothing is left, without needing a timestamp', () => {
    const done = job('running', [{ status: 'done' }], undefined, { startedAt: null, createdAt: undefined });
    const eta = outreachGenerationEta(done, outreachGenerationProgress(done), NOW);
    expect(eta.estimatedSecondsRemaining).toBe(0);
  });

  it('flows through outreachGenerationState so callers get it for free', () => {
    const running = job('running', [{ status: 'done' }, { status: 'pending' }], undefined, {
      startedAt: '2026-08-31T00:10:00.000Z',
    });
    const state = outreachGenerationState(running, 0, NOW);
    expect(state.kind).toBe('running');
    expect(state.kind === 'running' && state.eta.estimatedSecondsRemaining).toBe(600);
  });
});

describe('formatOutreachGenerationEta', () => {
  it('never claims false precision — whole minutes or hours only', () => {
    expect(formatOutreachGenerationEta(null)).toBe('Estimating time remaining…');
    expect(formatOutreachGenerationEta(0)).toBe('Finishing up…');
    expect(formatOutreachGenerationEta(20)).toBe('Finishing up…');
    expect(formatOutreachGenerationEta(45)).toBe('Under a minute remaining.');
    expect(formatOutreachGenerationEta(90)).toBe('About 2 min remaining.');
    expect(formatOutreachGenerationEta(12 * 60)).toBe('About 12 min remaining.');
    expect(formatOutreachGenerationEta(90 * 60)).toBe('About 1 hr 30 min remaining.');
    expect(formatOutreachGenerationEta(3 * 3600)).toBe('About 3 hr remaining.');
  });
});

describe('outreachGenerationLivePreviewSnippet', () => {
  it('returns null with no job, no items, or nothing streaming yet', () => {
    expect(outreachGenerationLivePreviewSnippet(null)).toBeNull();
    expect(outreachGenerationLivePreviewSnippet(job('running', []))).toBeNull();
    expect(
      outreachGenerationLivePreviewSnippet(job('running', [{ status: 'pending' }])),
    ).toBeNull();
  });

  it('returns the first in-flight item that has a live preview', () => {
    const running = job('running', [
      { status: 'pending', livePreview: null },
      { status: 'pending', livePreview: 'Dear Representative, thank you' },
      { status: 'pending', livePreview: 'a second one that should not win' },
    ]);
    expect(outreachGenerationLivePreviewSnippet(running)).toBe(
      'Dear Representative, thank you',
    );
  });

  it('trims whitespace and treats an all-whitespace preview as none', () => {
    const running = job('running', [
      { status: 'pending', livePreview: '   ' },
      { status: 'pending', livePreview: '  Hello there  ' },
    ]);
    expect(outreachGenerationLivePreviewSnippet(running)).toBe('Hello there');
  });

  it('truncates a long preview with an ellipsis rather than showing it in full', () => {
    const long = 'x'.repeat(200);
    const running = job('running', [{ status: 'pending', livePreview: long }]);
    const snippet = outreachGenerationLivePreviewSnippet(running)!;
    expect(snippet.length).toBe(141); // 140 chars + the ellipsis character
    expect(snippet.endsWith('…')).toBe(true);
  });
});

describe('outreachGenerationPollMs', () => {
  it('polls only while a job is in flight', () => {
    expect(
      outreachGenerationPollMs({
        kind: 'running',
        progress: { done: 0, total: 2, failed: 0, codes: [] },
        eta: { estimatedSecondsRemaining: null },
      }),
    ).toBe(4000);
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
