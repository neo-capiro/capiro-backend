import { nextStreamPreflightAt } from './stream-preflight-policy.js';
import {
  PublicCaptureOrchestrator,
  PublicCaptureWorkerCoordinator,
  type PublicCaptureRecord,
  type PublicCaptureStorePort,
} from './public-capture.orchestrator.js';
import {
  acquireCaptureLease,
  transitionCapture,
  type CaptureLease,
} from './public-hearing-capture-state.js';

function capture(): PublicCaptureRecord {
  return {
    id: 'capture-1',
    hearingId: 'hearing-1',
    status: 'SCHEDULED',
    version: 0,
    updatedAt: new Date('2026-08-20T13:00:00Z'),
    resolutionState: 'NOT_CHECKED',
    consecutiveSourceErrors: 0,
    capturedMs: 0,
    gaps: [],
  };
}

function storeHarness() {
  let row = capture();
  let lease: CaptureLease | undefined;
  const store: PublicCaptureStorePort = {
    getHearing: jest.fn(async () => ({
      id: 'hearing-1',
      eventStatus: 'SCHEDULED',
      publicAccess: 'PUBLIC',
      scheduledStart: new Date('2026-08-20T14:00:00Z'),
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
    })),
    getDemand: jest.fn(async () => ({ activeSubscriptionCount: 2, globalCoverageRequested: false })),
    ensureCapture: jest.fn(async () => row),
    saveState: jest.fn(async ({ next }: Parameters<PublicCaptureStorePort['saveState']>[0]) => {
      row = { ...row, ...next };
      return row;
    }),
    recordResolution: jest.fn(async ({ classified, attemptedAt, nextPreflightAt }: Parameters<PublicCaptureStorePort['recordResolution']>[0]) => {
      row = {
        ...row,
        version: row.version + 1,
        resolutionState: classified.state,
        lastResolutionAt: attemptedAt,
        nextPreflightAt,
        consecutiveSourceErrors: classified.state === 'SOURCE_ERROR' ? row.consecutiveSourceErrors + 1 : 0,
      };
      return row;
    }),
    recordFencedResolution: jest.fn(async ({ classified, attemptedAt, nextPreflightAt }: Parameters<PublicCaptureStorePort['recordFencedResolution']>[0]) => {
      row = {
        ...row,
        version: row.version + 1,
        resolutionState: classified.state,
        lastResolutionAt: attemptedAt,
        nextPreflightAt,
        consecutiveSourceErrors: classified.state === 'SOURCE_ERROR' ? row.consecutiveSourceErrors + 1 : 0,
      };
      return row;
    }),
    tryAcquireLease: jest.fn(async ({ ownerId, now, leaseDurationMs }: Parameters<PublicCaptureStorePort['tryAcquireLease']>[0]) => {
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
        return { acquired: false, capture: row };
      }
      lease = acquireCaptureLease(lease, ownerId, now, leaseDurationMs);
      row = { ...row, lease };
      return { acquired: true, capture: row, lease };
    }),
    renewLease: jest.fn(async () => lease!),
    releaseLease: jest.fn(async ({ ownerId, fencingToken }: Parameters<PublicCaptureStorePort['releaseLease']>[0]) => {
      if (lease?.ownerId === ownerId && lease.fencingToken === fencingToken) lease = undefined;
    }),
    saveFencedState: jest.fn(async ({ next, capturedMs, gaps }: Parameters<PublicCaptureStorePort['saveFencedState']>[0]) => {
      row = {
        ...row,
        ...next,
        ...(capturedMs === undefined ? {} : { capturedMs }),
        ...(gaps === undefined ? {} : { gaps }),
      };
      return row;
    }),
  };
  return { store, getRow: () => row, setRow: (next: PublicCaptureRecord) => (row = next) };
}

const firstPartyResolution = {
  status: 'resolved' as const,
  media: {
    url: 'https://www-senate-gov-media-srs.akamaized.net/hls/live/1/armed/file/master.m3u8',
    kind: 'hls' as const,
    provider: 'senate-isvp',
  },
};

describe('public capture orchestration', () => {
  it('enqueues one global job without tenant context or a resolved media URL', async () => {
    const h = storeHarness();
    const enqueue = jest.fn(async () => ({ enqueued: true, jobId: 'job-1' }));
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve: jest.fn(async () => firstPartyResolution) },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => new Date('2026-08-20T13:59:50Z') },
    );
    const outcome = await orchestrator.reconcile('hearing-1');
    expect(outcome).toEqual(
      expect.objectContaining({ action: 'CAPTURE_JOB_ENQUEUED', captureId: 'capture-1' }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      dedupeKey: 'public-hearing-capture:v1:hearing-1',
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      mustReresolve: true,
    });
  });

  it('resolves the current official page and persists the classified resolution', async () => {
    const h = storeHarness();
    h.store.getHearing = jest.fn(async () => ({
      id: 'hearing-1',
      eventStatus: 'SCHEDULED',
      publicAccess: 'PUBLIC',
      scheduledStart: new Date('2026-08-20T14:00:00Z'),
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      videos: [
        { url: 'https://www.youtube.com/watch?v=example', providerHint: 'youtube' },
        {
          url: firstPartyResolution.media.url,
          providerHint: 'senate-isvp',
        },
      ],
    }));
    const resolve = jest.fn(async ({ pageUrl }: { pageUrl?: string }) => ({
      ...firstPartyResolution,
      media: { ...firstPartyResolution.media, url: pageUrl! },
    }));
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue: jest.fn(async () => ({ enqueued: true })), schedulePreflight: jest.fn() },
      { now: () => new Date('2026-08-20T13:59:50Z') },
    );

    expect(await orchestrator.reconcile('hearing-1')).toEqual(
      expect.objectContaining({ action: 'CAPTURE_JOB_ENQUEUED' }),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      pageUrl: 'https://www.armed-services.senate.gov/hearings/example',
    }));
    expect(h.store.recordResolution).toHaveBeenCalledWith(
      expect.objectContaining({ classified: expect.objectContaining({ state: 'READY_FOR_SERVER_CAPTURE' }) }),
    );
  });

  it('marks YouTube as browser-only rather than launching server capture', async () => {
    const h = storeHarness();
    const enqueue = jest.fn();
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      {
        resolve: jest.fn(async () => ({
          status: 'resolved' as const,
          media: {
            url: 'https://www.youtube.com/watch?v=example',
            kind: 'hls' as const,
            provider: 'youtube-live',
          },
        })),
      },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => new Date('2026-08-20T13:59:50Z') },
    );
    expect(await orchestrator.reconcile('hearing-1')).toEqual(
      expect.objectContaining({ action: 'BROWSER_ONLY' }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('lets only one worker hold the fenced capture lease', async () => {
    const h = storeHarness();
    h.setRow({
      ...h.getRow(),
      status: 'READY',
      resolutionState: 'READY_FOR_SERVER_CAPTURE',
    });
    const runtime = { run: jest.fn(async () => ({ capturedMs: 60_000, gaps: [] })) };
    const resolver = { resolve: jest.fn(async () => firstPartyResolution) };
    const workerA = new PublicCaptureWorkerCoordinator(h.store, resolver, runtime, {
      now: () => new Date('2026-08-20T14:00:00Z'),
      leaseRenewIntervalMs: 60_000,
    });
    const workerB = new PublicCaptureWorkerCoordinator(h.store, resolver, runtime, {
      now: () => new Date('2026-08-20T14:00:01Z'),
      leaseRenewIntervalMs: 60_000,
    });

    const first = workerA.run({ captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-a' });
    const second = await workerB.run({ captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-b' });
    expect(second.action).toBe('LEASE_HELD_BY_OTHER');
    expect((await first).action).toBe('COMPLETE');
    expect(runtime.run).toHaveBeenCalledTimes(1);
  });

  it('records a runtime gap, schedules one bounded follow-on attempt, and resumes the same capture', async () => {
    const h = storeHarness();
    h.setRow({
      ...h.getRow(),
      status: 'READY',
      resolutionState: 'READY_FOR_SERVER_CAPTURE',
      capturedMs: 10_000,
    });
    const runtime = {
      run: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('FFmpeg exited with code 1'), {
            captureGaps: [{ startMs: 10_000, endMs: 12_000, reason: 'MEDIA_DISCONNECT' as const }],
            capturedMs: 12_000,
          }),
        )
        .mockResolvedValueOnce({ capturedMs: 32_000, gaps: [] }),
    };
    let recordedAttemptCount = 0;
    const attempts = {
      recordAttempt: jest.fn(async (input: Record<string, unknown>) => {
        recordedAttemptCount += 1;
        return {
          id: `attempt-${recordedAttemptCount}`,
          attemptNumber: recordedAttemptCount,
          createdAt: new Date(),
          ...input,
        };
      }),
      countAttempts: jest.fn(async () => recordedAttemptCount),
    };
    const scheduleRetry = jest.fn(async () => undefined);
    const worker = new PublicCaptureWorkerCoordinator(h.store, { resolve: jest.fn(async () => firstPartyResolution) }, runtime, {
      now: () => new Date('2026-08-20T14:00:00Z'),
      leaseRenewIntervalMs: 60_000,
      attempts,
      retryQueue: { scheduleRetry },
      maxAttempts: 3,
      initialRetryDelayMs: 1_000,
      maxRetryDelayMs: 5_000,
    });

    const first = await worker.run({ captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-a' });
    expect(first.action).toBe('RECOVERING');
    expect(attempts.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', failureCode: 'CAPTURE_RUNTIME_FAILED' }),
    );
    expect(scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: 'capture-1', hearingId: 'hearing-1', dueAt: expect.any(Date) }),
    );
    expect(h.store.saveFencedState).toHaveBeenCalledWith(
      expect.objectContaining({ gaps: [{ startMs: 10_000, endMs: 12_000, reason: 'MEDIA_DISCONNECT' }] }),
    );

    const second = await worker.run({ captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-b' });
    expect(second.action).toBe('COMPLETE');
    expect(attempts.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'succeeded', capturedMs: 32_000 }),
    );
    expect(runtime.run).toHaveBeenNthCalledWith(2, expect.objectContaining({ timelineOffsetMs: 12_000 }));
  });

  it('terminalizes a repeated runtime failure at the configured attempt ceiling', async () => {
    const h = storeHarness();
    h.setRow({ ...h.getRow(), status: 'READY', resolutionState: 'READY_FOR_SERVER_CAPTURE' });
    const runtime = { run: jest.fn(async () => { throw new Error('media unavailable'); }) };
    const attempts = {
      recordAttempt: jest.fn(async () => undefined),
      countAttempts: jest.fn(async () => 2),
    };
    const scheduleRetry = jest.fn(async () => undefined);
    const worker = new PublicCaptureWorkerCoordinator(h.store, { resolve: jest.fn(async () => firstPartyResolution) }, runtime, {
      now: () => new Date('2026-08-20T14:00:00Z'),
      leaseRenewIntervalMs: 60_000,
      attempts,
      retryQueue: { scheduleRetry },
      maxAttempts: 3,
    });

    const outcome = await worker.run({ captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-c' });
    expect(outcome.action).toBe('FAILED');
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(h.getRow().status).toBe('FAILED');
  });
});

describe('capture/preflight reschedule propagation (2026-09-04 field-hearing correction)', () => {
  function correctedHearing(hearingStart: Date) {
    return {
      id: 'hearing-1',
      eventStatus: 'SCHEDULED',
      publicAccess: 'PUBLIC',
      scheduledStart: hearingStart,
      officialPageUrl: 'https://www.congress.gov/event/119th-Congress/house-event/119533',
    };
  }

  it('REGRESSION: reconcile() pushes the CORRECTED official start into the capture row via ensureCapture', async () => {
    // The capture was created while the canonical row said 17:00Z; the official
    // correction moved the hearing to 20:00Z. The orchestrator must hand the
    // CORRECTED hearing.scheduledStart to ensureCapture — the store then
    // propagates it into the existing row (allowlisted states only).
    const h = storeHarness();
    const ensureCapture = h.store.ensureCapture as jest.Mock;
    ensureCapture.mockClear();
    h.store.getHearing = jest.fn(async () => correctedHearing(new Date('2026-09-04T20:00:00Z')));
    const schedulePreflight = jest.fn();
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve: jest.fn(async () => ({ status: 'unresolvable' as const, note: 'not advertised yet' })) },
      { enqueue: jest.fn(), schedulePreflight },
      { now: () => new Date('2026-09-03T15:00:00Z') }, // ~29h before the corrected start
    );
    const outcome = await orchestrator.reconcile('hearing-1');
    expect(ensureCapture).toHaveBeenCalledWith(
      expect.objectContaining({ hearingId: 'hearing-1', scheduledStart: new Date('2026-09-04T20:00:00Z') }),
    );
    expect(outcome.action).toBe('PREFLIGHT_SCHEDULED');
    // The queued preflight job is the SAME dedupe-keyed job — no duplicate rows.
    expect(schedulePreflight).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'hearing-stream-preflight:v1:hearing-1' }),
    );
    // The next checkpoint is computed from the CORRECTED start: 24h lead = Sep 3 20:00Z.
    const due = (outcome as { dueAt?: Date }).dueAt;
    expect(due).toBeDefined();
    expect(due!.toISOString()).toBe('2026-09-03T20:00:00.000Z');
  });

  it('preflight policy: a checkpoint moves to the corrected start, not the stale one', async () => {
    // Prove the scheduling math directly: next checkpoint from the corrected
    // 20:00Z start (24h lead) vs the stale 17:00Z start.
    const now = new Date('2026-09-03T15:00:00Z');
    const corrected = nextStreamPreflightAt({
      now,
      scheduledStart: new Date('2026-09-04T20:00:00Z'),
      resolutionState: 'NOT_CHECKED',
    });
    const stale = nextStreamPreflightAt({
      now,
      scheduledStart: new Date('2026-09-04T17:00:00Z'),
      resolutionState: 'NOT_CHECKED',
    });
    expect(corrected!.toISOString()).toBe('2026-09-03T20:00:00.000Z'); // 24h before corrected start
    expect(stale!.toISOString()).toBe('2026-09-03T17:00:00.000Z'); // 24h before stale start
    expect(corrected!.getTime()).not.toBe(stale!.getTime());
  });
});
