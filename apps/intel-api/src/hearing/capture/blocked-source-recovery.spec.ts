import { PublicCaptureAutomaticResolverAdapter } from './public-capture-automatic-resolver.adapter.js';
import { PublicCaptureOrchestrator } from './public-capture.orchestrator.js';
import { PublicHearingCaptureStore } from './public-hearing-capture.store.js';
import { blockedRecoveryTarget, type BlockedRecoveryCandidate } from './blocked-source-recovery.js';

const now = new Date('2026-10-06T14:00:00Z');
const candidate: BlockedRecoveryCandidate = {
  id: 'new-source',
  hearingId: 'hearing',
  sourceId: 'official',
  officialPageUrl: 'https://www.senate.gov/hearing/new',
  mediaUrl: null,
  firstSeenAt: '2026-10-06 13:59:00.123456+00',
  updatedAt: '2026-10-06 13:59:00.654321+00',
};
const media = {
  url: 'https://www-senate-gov-media-srs.akamaized.net/live/master.m3u8',
  kind: 'hls' as const,
  provider: 'senate-isvp',
};

describe('late first-party source recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });
  afterEach(() => jest.useRealTimers());

  it.each([
    'https://youtube.com/watch?v=123',
    'https://c-span.org/program/123',
    'https://senate.gov.evil.example/live.m3u8',
    'https://user:secret@www.senate.gov/live',
  ])('does not admit third-party or unsafe target %s', (url) => {
    expect(blockedRecoveryTarget({ ...candidate, mediaUrl: url })).toBeUndefined();
  });

  it('probes only the exact new target and persists no sibling approval or signed media', async () => {
    const read = jest
      .fn()
      .mockResolvedValue([
        { id: 'hearing', publicAccess: 'PUBLIC', eventStatus: 'scheduled', scheduledStart: now },
      ]);
    const write = jest.fn().mockResolvedValue(1);
    const resolve = jest.fn().mockResolvedValue({ status: 'resolved', media });
    const adapter = new PublicCaptureAutomaticResolverAdapter(
      { $queryRawUnsafe: read, $executeRawUnsafe: write } as never,
      { resolve } as never,
    );
    const result = await adapter.probeBlockedRecoveryCandidate(candidate);
    expect(resolve).toHaveBeenCalledWith({
      pageUrl: candidate.officialPageUrl,
      hearingId: candidate.hearingId,
    });
    expect(result?.classified).toMatchObject({
      state: 'READY_FOR_SERVER_CAPTURE',
      capturePolicy: 'SERVER_CAPTURE_ALLOWED',
    });
    expect(write.mock.calls[0][0]).toContain(
      'WHERE id=$1 AND hearing_id=$2 AND source_id=$3 AND first_seen_at=$4',
    );
    expect(write.mock.calls[0][0]).not.toContain('OR media_url');
    expect(write.mock.calls[0][4]).toBe('2026-10-06 13:59:00.123456+00');
    expect(write.mock.calls[0][11]).toBe('2026-10-06 13:59:00.654321+00');
    expect(write.mock.calls[0][0]).toContain('AND updated_at=$11::timestamptz');
    expect(JSON.stringify(write.mock.calls)).not.toContain(media.url);
  });

  it('ignores a reviewed-permission marker and refuses YouTube returned from an official page', async () => {
    const adapter = new PublicCaptureAutomaticResolverAdapter(
      {
        $queryRawUnsafe: jest
          .fn()
          .mockResolvedValue([
            { publicAccess: 'PUBLIC', eventStatus: 'scheduled', scheduledStart: now },
          ]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      } as never,
      {
        resolve: jest.fn().mockResolvedValue({
          status: 'resolved',
          reviewedSourcePermission: true,
          media: { ...media, url: 'https://youtube.com/watch?v=123', provider: 'youtube' },
        }),
      } as never,
    );
    const result = await adapter.probeBlockedRecoveryCandidate(candidate);
    expect(result?.classified.state).toBe('BROWSER_CAPTURE_ONLY');
  });

  it('does not claim a probe if its exact candidate audit write loses a race', async () => {
    const adapter = new PublicCaptureAutomaticResolverAdapter(
      {
        $queryRawUnsafe: jest
          .fn()
          .mockResolvedValue([
            { publicAccess: 'PUBLIC', eventStatus: 'scheduled', scheduledStart: now },
          ]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      } as never,
      { resolve: jest.fn().mockResolvedValue({ status: 'resolved', media }) } as never,
    );
    expect(await adapter.probeBlockedRecoveryCandidate(candidate)).toBeNull();
  });

  it.each(['FAILED', 'COMPLETE', 'COMPLETE_WITH_GAPS', 'CANCELED'])(
    'does not probe terminal %s history',
    async (status) => {
      const probe = jest.fn();
      const store = {
        getHearing: async () => ({ id: 'hearing' }),
        getDemand: async () => ({ globalCoverageRequested: true }),
        ensureCapture: async () => ({ id: 'capture', status }),
        getBlockedRecoveryCandidate: jest.fn(),
        reopenBlockedCapture: jest.fn(),
      };
      const orchestrator = new PublicCaptureOrchestrator(
        store as never,
        { resolve: jest.fn(), probeBlockedRecoveryCandidate: probe },
        {} as never,
      );
      expect(await orchestrator.reconcile('hearing')).toMatchObject({ action: 'TERMINAL', status });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it('keeps a browser-only recovery probe blocked without changing capture state or queuing', async () => {
    const reopen = jest.fn(),
      enqueue = jest.fn(),
      resolve = jest.fn();
    const store = {
      getHearing: async () => ({ id: 'hearing' }),
      getDemand: async () => ({ globalCoverageRequested: true }),
      ensureCapture: async () => ({ id: 'capture', status: 'BLOCKED' }),
      getBlockedRecoveryCandidate: async () => candidate,
      reopenBlockedCapture: reopen,
    };
    const orchestrator = new PublicCaptureOrchestrator(
      store as never,
      {
        resolve,
        probeBlockedRecoveryCandidate: async () => ({
          candidate,
          attemptedAt: now,
          classified: { state: 'BROWSER_CAPTURE_ONLY' } as never,
        }),
      },
      { enqueue } as never,
    );
    expect(await orchestrator.reconcile('hearing')).toMatchObject({
      action: 'TERMINAL',
      status: 'BLOCKED',
    });
    expect(reopen).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses stale or non-first-party success before touching persistence', async () => {
    const system = jest.fn();
    const store = new PublicHearingCaptureStore({ withSystem: system } as never);
    const classified = {
      state: 'READY_FOR_SERVER_CAPTURE',
      capturePolicy: 'SERVER_CAPTURE_ALLOWED',
      reasonCode: 'SOURCE_PERMISSION_REVIEWED',
      media,
    } as const;
    expect(
      await store.reopenBlockedCapture({
        captureId: 'capture',
        expectedVersion: 1,
        now,
        probe: { candidate, classified: classified as never, attemptedAt: now },
      }),
    ).toBeNull();
    expect(
      await store.reopenBlockedCapture({
        captureId: 'capture',
        expectedVersion: 1,
        now,
        probe: {
          candidate,
          classified: { ...classified, reasonCode: 'FIRST_PARTY_STREAM_READY' } as never,
          attemptedAt: new Date(now.getTime() - 60_001),
        },
      }),
    ).toBeNull();
    expect(system).not.toHaveBeenCalled();
  });
});
