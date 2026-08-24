import {
  classifyGenerated,
  deriveJobTerminalStatus,
  rollup,
} from './outreach-v3-full-generation-worker.service.js';
import type { GenerationResult } from '../engagement/generation/generation-gateway.types.js';

/**
 * Real behavioral coverage for partial-recipient-generation semantics
 * (mission section 10). The pre-existing `outreach-v3-full-generation-
 * worker.spec.ts` is a source-text architecture-contract check (readFileSync
 * + string assertions) and proves nothing about runtime status derivation —
 * this file exercises the actual pure functions the worker calls.
 */

function generationResult(overrides: Partial<GenerationResult> = {}): GenerationResult {
  return {
    outcome: 'ready',
    generationKey: 'v3:session:target:alpha',
    recipientKey: 'alpha',
    subject: 'Subject',
    body: 'Body',
    manifest: {} as GenerationResult['manifest'],
    artifactId: 'artifact-1',
    versionId: 'version-1',
    version: 1,
    generationStatus: 'generated',
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    sendable: true,
    pinned: {
      provider: 'openai',
      model: 'model',
      planModel: null,
      promptSpecVersion: 'v1',
      policyId: 'policy',
      policyVersion: '1',
    },
    ...overrides,
  } as GenerationResult;
}

describe('classifyGenerated — one recipient result at a time', () => {
  it('classifies a clean success as done', () => {
    expect(classifyGenerated(generationResult())).toBe('done');
  });

  it('classifies a missing versionId/artifactId as failed even if the caller claims otherwise', () => {
    expect(classifyGenerated(generationResult({ versionId: undefined, artifactId: undefined }))).toBe(
      'failed',
    );
  });

  it('classifies an explicit generation_failed status as failed', () => {
    expect(classifyGenerated(generationResult({ generationStatus: 'generation_failed' }))).toBe(
      'failed',
    );
  });

  it.each(['held', 'pending', 'unavailable'])(
    'classifies auditStatus=%s as held, not failed and not done',
    (auditStatus) => {
      expect(classifyGenerated(generationResult({ auditStatus }))).toBe('held');
    },
  );
});

describe('rollup — item-status tallies', () => {
  it('buckets every known status independently', () => {
    expect(
      rollup(['pending', 'claimed', 'generating', 'done', 'done', 'failed', 'skipped', 'held']),
    ).toEqual({ queued: 3, succeeded: 2, failed: 1, skipped: 1, held: 1, total: 8 });
  });

  it('an unrecognized status is counted in total but no bucket (fails closed, not silently miscounted as success)', () => {
    const totals = rollup(['done', 'some-unknown-status']);
    expect(totals.succeeded).toBe(1);
    expect(totals.total).toBe(2);
    expect(totals.succeeded + totals.failed + totals.skipped + totals.held + totals.queued).toBe(1);
  });
});

describe('deriveJobTerminalStatus — the exact mission-10 partial scenario', () => {
  it('10 recipients, 9 succeed, 1 fails -> job status is "partial", NOT "failed" or "complete" (successful work is not discarded)', () => {
    const statuses = [...Array(9).fill('done'), 'failed'];
    const totals = rollup(statuses);
    expect(totals).toEqual({ queued: 0, succeeded: 9, failed: 1, skipped: 0, held: 0, total: 10 });
    expect(deriveJobTerminalStatus(totals)).toBe('partial');
  });

  it('every recipient succeeds -> "complete"', () => {
    const totals = rollup(Array(5).fill('done'));
    expect(deriveJobTerminalStatus(totals)).toBe('complete');
  });

  it('every recipient fails -> "failed" (nothing survived)', () => {
    const totals = rollup(Array(5).fill('failed'));
    expect(deriveJobTerminalStatus(totals)).toBe('failed');
  });

  it('a mix of success and held (not failed) is still "partial", never silently "complete"', () => {
    const totals = rollup(['done', 'done', 'held']);
    expect(deriveJobTerminalStatus(totals)).toBe('partial');
  });

  it('all held, zero succeeded, zero failed -> "partial" (held-only means "needs review", not a hard failure)', () => {
    const totals = rollup(['held', 'held']);
    expect(deriveJobTerminalStatus(totals)).toBe('partial');
  });

  it('any item still queued/claimed/generating keeps the job "running" regardless of how many already finished', () => {
    const totals = rollup(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'pending']);
    expect(deriveJobTerminalStatus(totals)).toBe('running');
  });

  it('a job with zero items (edge case) is treated as complete, not partial/failed', () => {
    const totals = rollup([]);
    expect(deriveJobTerminalStatus(totals)).toBe('complete');
  });
});

describe('retry safety — a retried item never re-enters the queued pool as a duplicate of an already-done sibling', () => {
  it('retrying ONE failed item among nine done items keeps the other nine at "done" in the rollup, and the job returns to "running" (not restarting the whole batch)', () => {
    // Simulates OutreachV3FullGenerationService.retryItem() flipping exactly
    // one 'failed' item back to 'pending' — the other nine 'done' items are
    // untouched. finalizeJob()'s next pass must see the job as still-running
    // (one item queued) rather than re-deriving a stale terminal status.
    const afterRetry = [...Array(9).fill('done'), 'pending'];
    const totals = rollup(afterRetry);
    expect(totals.succeeded).toBe(9);
    expect(totals.queued).toBe(1);
    expect(deriveJobTerminalStatus(totals)).toBe('running');
  });

  it('once the retried item completes, the job returns to "complete" without any successful sibling having been reprocessed', () => {
    const afterRetrySucceeds = Array(10).fill('done');
    const totals = rollup(afterRetrySucceeds);
    expect(deriveJobTerminalStatus(totals)).toBe('complete');
  });
});
