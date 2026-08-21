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
    releaseLease: jest.fn(async () => undefined),
    saveFencedState: jest.fn(async ({ next }: Parameters<PublicCaptureStorePort['saveFencedState']>[0]) => {
      row = { ...row, ...next };
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
});
