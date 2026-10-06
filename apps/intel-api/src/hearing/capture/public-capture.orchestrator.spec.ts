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
    getCapture: jest.fn(async () => ({ ...row, lease })),
    getHearing: jest.fn(async () => ({
      id: 'hearing-1',
      eventStatus: 'SCHEDULED',
      publicAccess: 'PUBLIC',
      scheduledStart: new Date('2026-08-20T14:00:00Z'),
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
    })),
    getDemand: jest.fn(async () => ({
      activeSubscriptionCount: 2,
      globalCoverageRequested: false,
    })),
    ensureCapture: jest.fn(async () => row),
    saveState: jest.fn(async ({ next }: Parameters<PublicCaptureStorePort['saveState']>[0]) => {
      row = { ...row, ...next };
      return row;
    }),
    recordResolution: jest.fn(
      async ({
        classified,
        attemptedAt,
        nextPreflightAt,
      }: Parameters<PublicCaptureStorePort['recordResolution']>[0]) => {
        row = {
          ...row,
          version: row.version + 1,
          resolutionState: classified.state,
          lastResolutionAt: attemptedAt,
          nextPreflightAt,
          consecutiveSourceErrors:
            classified.state === 'SOURCE_ERROR' ? row.consecutiveSourceErrors + 1 : 0,
        };
        return row;
      },
    ),
    recordFencedResolution: jest.fn(
      async ({
        classified,
        attemptedAt,
        nextPreflightAt,
      }: Parameters<PublicCaptureStorePort['recordFencedResolution']>[0]) => {
        row = {
          ...row,
          version: row.version + 1,
          resolutionState: classified.state,
          lastResolutionAt: attemptedAt,
          nextPreflightAt,
          consecutiveSourceErrors:
            classified.state === 'SOURCE_ERROR' ? row.consecutiveSourceErrors + 1 : 0,
        };
        return row;
      },
    ),
    tryAcquireLease: jest.fn(
      async ({
        ownerId,
        now,
        leaseDurationMs,
      }: Parameters<PublicCaptureStorePort['tryAcquireLease']>[0]) => {
        if (lease && lease.ownerId !== ownerId && lease.expiresAt > now) {
          return { acquired: false, capture: row };
        }
        lease = acquireCaptureLease(lease, ownerId, now, leaseDurationMs);
        row = { ...row, lease };
        return { acquired: true, capture: row, lease };
      },
    ),
    renewLease: jest.fn(async () => lease!),
    releaseLease: jest.fn(
      async ({ ownerId, fencingToken }: Parameters<PublicCaptureStorePort['releaseLease']>[0]) => {
        if (lease?.ownerId === ownerId && lease.fencingToken === fencingToken) lease = undefined;
      },
    ),
    saveFencedState: jest.fn(
      async ({
        next,
        capturedMs,
        gaps,
      }: Parameters<PublicCaptureStorePort['saveFencedState']>[0]) => {
        row = {
          ...row,
          ...next,
          ...(capturedMs === undefined ? {} : { capturedMs }),
          ...(gaps === undefined ? {} : { gaps }),
        };
        return row;
      },
    ),
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

describe('long-running capture lease lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-20T14:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renews a single capture through four hours and finalizes after the runtime ends', async () => {
    const h = storeHarness();
    h.store.renewLease = jest.fn(async (input) => ({
      ownerId: input.ownerId,
      fencingToken: input.fencingToken,
      acquiredAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.leaseDurationMs),
    }));
    let finish!: (result: { capturedMs: number; gaps: [] }) => void;
    let signal!: AbortSignal;
    const runtime = {
      run: jest.fn(async (input) => {
        signal = input.signal;
        return new Promise<{ capturedMs: number; gaps: [] }>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const worker = new PublicCaptureWorkerCoordinator(
      h.store,
      { resolve: jest.fn(async () => firstPartyResolution) },
      runtime,
    );
    const running = worker.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-a',
    });
    await jest.advanceTimersByTimeAsync(4 * 60 * 60_000);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect(h.store.renewLease).toHaveBeenCalledTimes(720);
    expect(signal.aborted).toBe(false);
    finish({ capturedMs: 14_400_000, gaps: [] });
    await expect(running).resolves.toMatchObject({ action: 'COMPLETE', capturedMs: 14_400_000 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('aborts at the lease deadline when a renewal hangs without rejecting', async () => {
    const h = storeHarness();
    h.store.renewLease = jest.fn(() => new Promise<CaptureLease>(() => undefined));
    let signal!: AbortSignal;
    const runtime = {
      run: jest.fn(async (input) => {
        signal = input.signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
    };
    const worker = new PublicCaptureWorkerCoordinator(
      h.store,
      { resolve: jest.fn(async () => firstPartyResolution) },
      runtime,
    );
    const running = worker.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-a',
    });
    const failure = expect(running).rejects.toThrow('lease expired');
    await jest.advanceTimersByTimeAsync(59_999);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await failure;
    expect(signal.aborted).toBe(true);
    expect(h.getRow().status).toBe('CAPTURING');
    expect(h.store.renewLease).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('public capture orchestration', () => {
  it('retries a pending stream after T-5 and queues it when it becomes available at T-4', async () => {
    const h = storeHarness();
    let now = new Date('2026-08-20T13:55:00Z');
    const resolve = jest
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce(firstPartyResolution);
    const enqueue = jest.fn(async () => ({ enqueued: true, jobId: 'job-1' }));
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => now },
    );
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'WAITING_FOR_STREAM',
      dueAt: new Date('2026-08-20T13:55:20Z'),
    });
    now = new Date('2026-08-20T13:55:10Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'PREFLIGHT_SCHEDULED',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    now = new Date('2026-08-20T13:56:00Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'CAPTURE_JOB_ENQUEUED',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(h.getRow().resolutionState).toBe('READY_FOR_SERVER_CAPTURE');
  });

  it('honors source-error backoff without postponing elapsed retries on each scheduler pass', async () => {
    const h = storeHarness();
    let now = new Date('2026-08-20T13:55:00Z');
    const resolve = jest
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(firstPartyResolution);
    const enqueue = jest.fn(async () => ({ enqueued: true, jobId: 'job-1' }));
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => now },
    );
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'WAITING_FOR_STREAM',
      dueAt: new Date('2026-08-20T13:56:00Z'),
    });
    now = new Date('2026-08-20T13:55:30Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'PREFLIGHT_SCHEDULED',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    now = new Date('2026-08-20T13:56:00Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'WAITING_FOR_STREAM',
      dueAt: new Date('2026-08-20T13:58:00Z'),
    });
    now = new Date('2026-08-20T13:57:00Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'PREFLIGHT_SCHEDULED',
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    now = new Date('2026-08-20T13:58:00Z');
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'CAPTURE_JOB_ENQUEUED',
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('actually resolves each elapsed early checkpoint and does not probe again before the next one', async () => {
    const h = storeHarness();
    let now = new Date('2026-08-19T13:00:00Z');
    const resolve = jest.fn(async () => ({ status: 'pending' as const }));
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue: jest.fn(), schedulePreflight: jest.fn() },
      { now: () => now },
    );
    await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
      action: 'PREFLIGHT_SCHEDULED',
      dueAt: new Date('2026-08-19T14:00:00Z'),
    });
    expect(resolve).not.toHaveBeenCalled();
    for (const [checkpoint, next] of [
      ['2026-08-19T14:00:00Z', '2026-08-20T13:00:00Z'],
      ['2026-08-20T13:00:00Z', '2026-08-20T13:45:00Z'],
      ['2026-08-20T13:45:00Z', '2026-08-20T13:55:00Z'],
    ]) {
      now = new Date(checkpoint!);
      await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
        action: 'WAITING_FOR_STREAM',
        dueAt: new Date(next!),
      });
      const attempts = resolve.mock.calls.length;
      now = new Date(now.getTime() + 1_000);
      await expect(orchestrator.reconcile('hearing-1')).resolves.toMatchObject({
        action: 'PREFLIGHT_SCHEDULED',
        dueAt: new Date(next!),
      });
      expect(resolve).toHaveBeenCalledTimes(attempts);
    }
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('leaves an actively leased capture and its optimistic version unchanged during scheduler passes', async () => {
    const h = storeHarness();
    const now = new Date('2026-08-20T15:00:00Z');
    h.setRow({
      ...capture(),
      status: 'CAPTURING',
      version: 8,
      lease: {
        ownerId: 'worker-a',
        fencingToken: 1,
        acquiredAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
    });
    const resolver = { resolve: jest.fn(async () => firstPartyResolution) };
    const queue = { enqueue: jest.fn(), schedulePreflight: jest.fn() };
    const orchestrator = new PublicCaptureOrchestrator(h.store, resolver, queue, {
      now: () => now,
    });
    await expect(orchestrator.reconcile('hearing-1')).resolves.toEqual({
      action: 'CAPTURE_IN_PROGRESS',
      captureId: 'capture-1',
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(h.store.recordResolution).not.toHaveBeenCalled();
    expect(h.store.saveState).not.toHaveBeenCalled();
    expect(h.getRow().version).toBe(8);
  });

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
      dueAt: new Date('2026-08-20T13:59:50Z'),
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
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      }),
    );
    expect(h.store.recordResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        classified: expect.objectContaining({ state: 'READY_FOR_SERVER_CAPTURE' }),
      }),
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

    const first = workerA.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-a',
    });
    const second = await workerB.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-b',
    });
    expect(second.action).toBe('LEASE_HELD_BY_OTHER');
    expect((await first).action).toBe('COMPLETE');
    expect(runtime.run).toHaveBeenCalledTimes(1);
  });

  it('rejects a job whose capture id belongs to a different hearing', async () => {
    const h = storeHarness();
    h.setRow({
      ...h.getRow(),
      status: 'READY',
      resolutionState: 'READY_FOR_SERVER_CAPTURE',
    });
    const resolver = { resolve: jest.fn(async () => firstPartyResolution) };
    const runtime = { run: jest.fn(async () => ({ capturedMs: 60_000, gaps: [] })) };
    const worker = new PublicCaptureWorkerCoordinator(h.store, resolver, runtime, {
      now: () => new Date('2026-08-20T14:00:00Z'),
    });

    await expect(
      worker.run({
        captureId: 'capture-1',
        hearingId: 'substituted-hearing',
        workerId: 'worker-a',
      }),
    ).rejects.toThrow('STATE_CAPTURE_LINK_ONLY');
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(h.store.tryAcquireLease).not.toHaveBeenCalled();
    expect(h.store.releaseLease).not.toHaveBeenCalled();
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
    const worker = new PublicCaptureWorkerCoordinator(
      h.store,
      { resolve: jest.fn(async () => firstPartyResolution) },
      runtime,
      {
        now: () => new Date('2026-08-20T14:00:00Z'),
        leaseRenewIntervalMs: 60_000,
        attempts,
        retryQueue: { scheduleRetry },
        maxAttempts: 3,
        initialRetryDelayMs: 1_000,
        maxRetryDelayMs: 5_000,
      },
    );

    const first = await worker.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-a',
    });
    expect(first.action).toBe('RECOVERING');
    expect(attempts.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', failureCode: 'CAPTURE_RUNTIME_FAILED' }),
    );
    expect(scheduleRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: 'capture-1',
        hearingId: 'hearing-1',
        dueAt: expect.any(Date),
      }),
    );
    expect(h.store.saveFencedState).toHaveBeenCalledWith(
      expect.objectContaining({
        gaps: [{ startMs: 10_000, endMs: 12_000, reason: 'MEDIA_DISCONNECT' }],
      }),
    );

    const second = await worker.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-b',
    });
    expect(second.action).toBe('COMPLETE');
    expect(attempts.recordAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'succeeded', capturedMs: 32_000 }),
    );
    expect(runtime.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ timelineOffsetMs: 12_000 }),
    );
  });

  it('terminalizes a repeated runtime failure at the configured attempt ceiling', async () => {
    const h = storeHarness();
    h.setRow({ ...h.getRow(), status: 'READY', resolutionState: 'READY_FOR_SERVER_CAPTURE' });
    const runtime = {
      run: jest.fn(async () => {
        throw new Error('media unavailable');
      }),
    };
    const attempts = {
      recordAttempt: jest.fn(async () => undefined),
      countAttempts: jest.fn(async () => 2),
    };
    const scheduleRetry = jest.fn(async () => undefined);
    const worker = new PublicCaptureWorkerCoordinator(
      h.store,
      { resolve: jest.fn(async () => firstPartyResolution) },
      runtime,
      {
        now: () => new Date('2026-08-20T14:00:00Z'),
        leaseRenewIntervalMs: 60_000,
        attempts,
        retryQueue: { scheduleRetry },
        maxAttempts: 3,
      },
    );

    const outcome = await worker.run({
      captureId: 'capture-1',
      hearingId: 'hearing-1',
      workerId: 'worker-c',
    });
    expect(outcome.action).toBe('FAILED');
    expect(scheduleRetry).not.toHaveBeenCalled();
    expect(h.getRow().status).toBe('FAILED');
  });
});

describe('automatic capture start deferral', () => {
  const now = new Date('2026-08-19T14:00:00Z');
  const runInput = { captureId: 'capture-1', hearingId: 'hearing-1', workerId: 'worker-a' };
  it('uses an earlier start published during preflight when setting the queue deadline', async () => {
    const h = storeHarness();
    const enqueue = jest.fn(async () => ({ enqueued: true }));
    const resolve = jest.fn(async () => {
      (h.store.getHearing as jest.Mock).mockResolvedValue({
        id: 'hearing-1',
        publicAccess: 'PUBLIC',
        eventStatus: 'scheduled',
        scheduledStart: new Date('2026-08-19T15:00:00Z'),
        officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      });
      return firstPartyResolution;
    });
    await new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => now },
    ).reconcile('hearing-1');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: new Date('2026-08-19T14:55:00Z') }),
    );
  });
  it('queues an early published stream for T-5, without starting a recording', async () => {
    const h = storeHarness();
    const enqueue = jest.fn(async () => ({ enqueued: true }));
    const resolve = jest.fn(async () => firstPartyResolution);
    const orchestrator = new PublicCaptureOrchestrator(
      h.store,
      { resolve },
      { enqueue, schedulePreflight: jest.fn() },
      { now: () => now },
    );
    expect((await orchestrator.reconcile('hearing-1')).action).toBe('CAPTURE_JOB_ENQUEUED');
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: new Date('2026-08-20T13:55:00Z') }),
    );
    const runtime = { run: jest.fn() };
    const worker = new PublicCaptureWorkerCoordinator(h.store, { resolve }, runtime, {
      now: () => now,
    });
    expect(await worker.run(runInput)).toEqual({
      action: 'DEFERRED_UNTIL_START',
      dueAt: new Date('2026-08-20T13:55:00Z'),
    });
    expect(h.store.tryAcquireLease).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('does not count a scheduled unknown start as a media attempt', async () => {
    const h = storeHarness();
    (h.store.getHearing as jest.Mock).mockResolvedValue({
      id: 'hearing-1',
      publicAccess: 'PUBLIC',
      eventStatus: 'scheduled',
    });
    const runtime = { run: jest.fn() },
      resolve = jest.fn();
    const attempts = { countAttempts: jest.fn(), recordAttempt: jest.fn() };
    expect(
      await new PublicCaptureWorkerCoordinator(h.store, { resolve }, runtime, {
        now: () => now,
        attempts,
      }).run(runInput),
    ).toMatchObject({ action: 'DEFERRED_UNTIL_START' });
    expect(h.store.tryAcquireLease).not.toHaveBeenCalled();
    expect(attempts.countAttempts).not.toHaveBeenCalled();
    expect(attempts.recordAttempt).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('honors access revocation instead of silently waiting', async () => {
    const h = storeHarness();
    h.store.assertCaptureAllowed = jest.fn(async () => {
      throw Error('CAPTURE_ACCESS_OR_DEMAND_WITHDRAWN');
    });
    await expect(
      new PublicCaptureWorkerCoordinator(
        h.store,
        { resolve: jest.fn() },
        { run: jest.fn() },
        { now: () => now },
      ).run(runInput),
    ).rejects.toThrow('CAPTURE_ACCESS_OR_DEMAND_WITHDRAWN');
    expect(h.store.tryAcquireLease).not.toHaveBeenCalled();
  });
  it.each(['COMPLETE', 'BLOCKED', 'CANCELED'] as const)(
    'never reopens terminal %s for a future start',
    async (status) => {
      const h = storeHarness();
      h.setRow({ ...h.getRow(), status });
      expect(
        await new PublicCaptureWorkerCoordinator(
          h.store,
          { resolve: jest.fn() },
          { run: jest.fn() },
          { now: () => now },
        ).run(runInput),
      ).toEqual({ action: 'TERMINAL', status });
      expect(h.store.tryAcquireLease).not.toHaveBeenCalled();
    },
  );
  it('applies a schedule moved later during resolution before creating media or attempts', async () => {
    const h = storeHarness();
    const current = new Date('2026-08-20T14:00:00Z');
    const resolve = jest.fn(async () => {
      (h.store.getHearing as jest.Mock).mockResolvedValue({
        id: 'hearing-1',
        publicAccess: 'PUBLIC',
        eventStatus: 'scheduled',
        scheduledStart: new Date('2026-08-20T16:00:00Z'),
        officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
      });
      return firstPartyResolution;
    });
    const runtime = { run: jest.fn() },
      attempts = { countAttempts: jest.fn(async () => 0), recordAttempt: jest.fn() };
    expect(
      await new PublicCaptureWorkerCoordinator(h.store, { resolve }, runtime, {
        now: () => current,
        attempts,
      }).run(runInput),
    ).toEqual({ action: 'DEFERRED_UNTIL_START', dueAt: new Date('2026-08-20T15:55:00Z') });
    expect(runtime.run).not.toHaveBeenCalled();
    expect(attempts.recordAttempt).not.toHaveBeenCalled();
    expect(h.store.releaseLease).toHaveBeenCalled();
    expect(h.getRow().status).toBe('SCHEDULED');
  });
  it('starts an officially in-progress event despite a missing scheduled time', async () => {
    const h = storeHarness();
    (h.store.getHearing as jest.Mock).mockResolvedValue({
      id: 'hearing-1',
      publicAccess: 'PUBLIC',
      eventStatus: 'in_progress',
      officialPageUrl: 'https://www.armed-services.senate.gov/hearings/example',
    });
    const runtime = { run: jest.fn(async () => ({ capturedMs: 1_000, gaps: [] })) };
    expect(
      (
        await new PublicCaptureWorkerCoordinator(
          h.store,
          { resolve: jest.fn(async () => firstPartyResolution) },
          runtime,
          { now: () => now },
        ).run(runInput)
      ).action,
    ).toBe('COMPLETE');
    expect(runtime.run).toHaveBeenCalledTimes(1);
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
      {
        resolve: jest.fn(async () => ({
          status: 'unresolvable' as const,
          note: 'not advertised yet',
        })),
      },
      { enqueue: jest.fn(), schedulePreflight },
      { now: () => new Date('2026-09-03T15:00:00Z') }, // ~29h before the corrected start
    );
    const outcome = await orchestrator.reconcile('hearing-1');
    expect(ensureCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        hearingId: 'hearing-1',
        scheduledStart: new Date('2026-09-04T20:00:00Z'),
      }),
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
