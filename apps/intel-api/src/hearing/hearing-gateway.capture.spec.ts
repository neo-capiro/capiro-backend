/**
 * The gateway constructs a real DeepgramStreamManager, so the SDK is faked here
 * to keep the capture-lifecycle tests offline and deterministic. `__conns` gives
 * each test the connection the manager opened so it can emit Open/Close exactly
 * when the scenario requires.
 */
jest.mock('@deepgram/sdk', () => {
  const conns: Array<{
    on: (event: string, cb: (payload?: unknown) => void) => void;
    send: jest.Mock;
    requestClose: jest.Mock;
    emit: (event: string, payload?: unknown) => void;
  }> = [];
  return {
    __conns: conns,
    createClient: () => ({
      listen: {
        live: () => {
          const handlers = new Map<string, Array<(payload?: unknown) => void>>();
          const conn = {
            on: (event: string, cb: (payload?: unknown) => void) => {
              const list = handlers.get(event) ?? [];
              list.push(cb);
              handlers.set(event, list);
            },
            send: jest.fn(),
            requestClose: jest.fn(),
            emit: (event: string, payload?: unknown) => {
              for (const cb of handlers.get(event) ?? []) cb(payload);
            },
          };
          conns.push(conn);
          return conn;
        },
      },
    }),
    LiveTranscriptionEvents: {
      Open: 'open',
      Metadata: 'metadata',
      Transcript: 'transcript',
      Error: 'error',
      Close: 'close',
    },
  };
});

import { ConfigService } from '@nestjs/config';
import type { WebSocket } from 'ws';
import type { OrgTenantResolverService } from '../auth/org-tenant-resolver.service.js';
import type { FeatureFlagService } from '../feature-flags/feature-flag.service.js';
import type { BillHearingLinkerService } from '../linking/bill-hearing-linker.service.js';
import type { WatchlistMatchPromoterService } from '../linking/watchlist-match-promoter.service.js';
import type { WatchlistService } from '../watchlist/watchlist.service.js';
import type { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import type { OrchestratorClient } from './orchestrator.client.js';
import type { SegmentCommitService } from './segment-commit.service.js';
import { HearingGateway } from './hearing.gateway.js';
import type { HearingSessionService } from './hearing-session.service.js';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSocket() {
  const sent: unknown[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: jest.fn((value: unknown) => sent.push(value)),
    close: jest.fn(),
  } as unknown as WebSocket;
  return {
    socket,
    sentJson: () =>
      sent
        .filter((value): value is string => typeof value === 'string')
        .map((value) => JSON.parse(value)),
  };
}

function makeGateway(
  overrides: {
    claimCapture?: jest.Mock;
    activateCapture?: jest.Mock;
    releaseCapture?: jest.Mock;
    heartbeatCapture?: jest.Mock;
    promoteMatches?: jest.Mock;
    linkSession?: jest.Mock;
    sendAudio?: jest.Mock;
    extract?: jest.Mock;
  } = {},
) {
  const sessions = {
    assertCaptureAllowed: jest.fn(),
    claimCapture: overrides.claimCapture ?? jest.fn(),
    activateCapture: overrides.activateCapture ?? jest.fn(async () => true),
    heartbeatCapture: overrides.heartbeatCapture ?? jest.fn(async () => true),
    releaseCapture: overrides.releaseCapture ?? jest.fn(async () => true),
  } as unknown as HearingSessionService;
  const promoter = {
    promoteMatches: overrides.promoteMatches ?? jest.fn(async () => ({ alerts: 1 })),
  } as unknown as WatchlistMatchPromoterService;
  const linker = {
    linkSession: overrides.linkSession ?? jest.fn(async () => ({ combined: 1 })),
  } as unknown as BillHearingLinkerService;
  const commit = {
    maxEndMs: jest.fn(async () => 0),
    enrichFinal: jest.fn(async () => undefined),
  } as unknown as SegmentCommitService;
  const extract =
    overrides.extract ?? jest.fn(async () => ({ entityMentions: [], issueTags: [] }));
  const orchestrator = { extract } as unknown as OrchestratorClient;
  const watchlists = { matchAndPersist: jest.fn(async () => 0) } as unknown as WatchlistService;
  const config = {
    get: jest.fn((key: string) => (key === 'DEEPGRAM_API_KEY' ? 'dg-key' : undefined)),
  };

  const gateway = new HearingGateway(
    {} as OrgTenantResolverService,
    {} as FeatureFlagService,
    sessions,
    {} as HearingWsTicketService,
    commit,
    watchlists,
    orchestrator,
    linker,
    promoter,
    config as unknown as ConfigService,
  );
  return { gateway, sessions, promoter, linker, extract, commit };
}

function baseConn(socket: WebSocket) {
  return {
    ws: socket,
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    recordingPolicy: 'transcript_only',
    forceEncrypt: false,
    sessionContext: {
      clientId: 'client-9',
      issueIds: ['acquisition-reform'],
      billIds: ['hr-1234'],
      programElementIds: ['0604256F'],
      agencyIds: ['dod'],
      committeeId: 'hsas',
      hearingId: 'ch-77',
    },
    state: 'connected',
    timelineOffsetMs: 0,
    hasAudio: false,
    rawChain: Promise.resolve(),
    pendingEnrichment: new Set<Promise<void>>(),
    rateWindowStartedAt: Date.now(),
    bytesThisWindow: 0,
  };
}

const deepgramConns = (jest.requireMock('@deepgram/sdk') as {
  __conns: Array<{ emit: (event: string, payload?: unknown) => void; send: jest.Mock }>;
}).__conns;

/**
 * A claimed capture owns a heartbeat interval, a 12-hour duration cap and two
 * readiness timeouts. A test that inspects a mid-capture state without finalizing
 * must drop them, or jest force-exits the worker on leaked timers.
 */
function clearConnTimers(conn: Record<string, unknown>) {
  clearInterval(conn.heartbeatTimer as NodeJS.Timeout);
  clearTimeout(conn.startTimer as NodeJS.Timeout);
  clearTimeout(conn.firstAudioTimer as NodeJS.Timeout);
  clearTimeout(conn.durationTimer as NodeJS.Timeout);
}

describe('HearingGateway capture protocol', () => {
  beforeEach(() => {
    deepgramConns.length = 0;
  });

  it('returns SESSION_ALREADY_ACTIVE when another browser owns the DB capture lease', async () => {
    const claimCapture = jest.fn(async () => null);
    const { gateway } = makeGateway({ claimCapture });
    const ws = fakeSocket();
    const conn = baseConn(ws.socket);

    await (gateway as any).startCapture(conn, 'audio/webm;codecs=opus', 'browser');

    expect(claimCapture).toHaveBeenCalledWith('tenant-1', 'session-1');
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'SESSION_ALREADY_ACTIVE' }),
    );
    expect(conn.state).toBe('connected');
  });

  it('rejects binary audio until capture_ready has been reached', async () => {
    const { gateway } = makeGateway();
    const ws = fakeSocket();
    const conn = baseConn(ws.socket);

    await (gateway as any).onAudioFrame(conn, Buffer.from('not-ready'));

    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'AUDIO_BEFORE_READY' }),
    );
    expect(conn.hasAudio).toBe(false);
  });

  it('activates the DB lease on first audio before forwarding bytes to Deepgram', async () => {
    const order: string[] = [];
    const activateCapture = jest.fn(async () => {
      order.push('activate');
      return true;
    });
    const { gateway } = makeGateway({ activateCapture });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'ready',
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      deepgram: {
        sendAudio: jest.fn(() => {
          order.push('audio');
          return true;
        }),
      },
    };

    await (gateway as any).onAudioFrame(conn, Buffer.from('webm-audio'));

    expect(activateCapture).toHaveBeenCalledWith(
      'tenant-1',
      'session-1',
      conn.claimStartedAt,
    );
    expect(order).toEqual(['activate', 'audio']);
    expect(conn.hasAudio).toBe(true);
    expect(conn.state).toBe('capturing');
    expect(ws.sentJson()).toContainEqual({ type: 'status', status: 'capturing' });
  });

  it('fails closed when the first-audio lease activation cannot be proven', async () => {
    const activateCapture = jest.fn(async () => false);
    const releaseCapture = jest.fn(async () => true);
    const { gateway } = makeGateway({ activateCapture, releaseCapture });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'ready',
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      deepgram: {
        sendAudio: jest.fn(() => true),
        stopAndWait: jest.fn(async () => undefined),
      },
    };

    await (gateway as any).onAudioFrame(conn, Buffer.from('webm-audio'));

    expect(conn.deepgram.sendAudio).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'CAPTURE_LEASE_LOST' }),
    );
    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(conn.state).toBe('ended');
  });

  it('never silently discards audio that Deepgram is not ready to take', async () => {
    const releaseCapture = jest.fn(async () => true);
    const { gateway } = makeGateway({ releaseCapture });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'ready',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      // Deepgram refuses the frame (socket not open). Returning silently here
      // used to drop the analyst's audio while the room still showed "capturing".
      deepgram: { sendAudio: jest.fn(() => false), stopAndWait: jest.fn(async () => undefined) },
    };

    await (gateway as any).onAudioFrame(conn, Buffer.from('webm-audio'));

    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'TRANSCRIPTION_NOT_READY' }),
    );
    expect(conn.state).toBe('ended');
  });

  it('rejects an unsupported browser container before claiming the session', async () => {
    const claimCapture = jest.fn();
    const { gateway } = makeGateway({ claimCapture });
    const ws = fakeSocket();
    const conn = baseConn(ws.socket);

    await (gateway as any).startCapture(conn, 'audio/ogg', 'browser');

    expect(claimCapture).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'UNSUPPORTED_AUDIO_CONTAINER' }),
    );
  });

  it('stops the capture instead of accepting an oversized audio frame', async () => {
    const releaseCapture = jest.fn(async () => true);
    const { gateway } = makeGateway({ releaseCapture });
    const ws = fakeSocket();
    const sendAudio = jest.fn(() => true);
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      deepgram: { sendAudio, stopAndWait: jest.fn(async () => undefined) },
    };

    await (gateway as any).onAudioFrame(conn, Buffer.alloc(1_000_001));

    expect(sendAudio).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'AUDIO_FRAME_TOO_LARGE' }),
    );
    expect(conn.state).toBe('ended');
  });

  it('stops the capture when audio arrives faster than the browser capture rate', async () => {
    const { gateway } = makeGateway({ releaseCapture: jest.fn(async () => true) });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      // Already at the per-second ceiling; the next frame must trip the limit
      // rather than being buffered without bound.
      bytesThisWindow: 512 * 1024,
      deepgram: { sendAudio: jest.fn(() => true), stopAndWait: jest.fn(async () => undefined) },
    };

    await (gateway as any).onAudioFrame(conn, Buffer.alloc(4_096));

    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'AUDIO_RATE_EXCEEDED' }),
    );
    expect(conn.state).toBe('ended');
  });

  it('only signals capture_ready once Deepgram is open, never on socket connect alone', async () => {
    const claimCapture = jest.fn(async () => ({
      startedAt: new Date('2026-07-28T16:00:00.000Z'),
    }));
    const { gateway } = makeGateway({ claimCapture });
    const ws = fakeSocket();
    const conn = baseConn(ws.socket);

    await (gateway as any).startCapture(conn, 'audio/webm;codecs=opus', 'browser');

    // Claimed and preparing, but NOT ready: the browser must not record yet.
    expect(conn.state).toBe('starting');
    expect(ws.sentJson()).toContainEqual({ type: 'status', status: 'preparing_transcription' });
    expect(ws.sentJson()).not.toContainEqual({ type: 'status', status: 'capture_ready' });

    deepgramConns[0]!.emit('open');

    expect(conn.state).toBe('ready');
    expect(ws.sentJson()).toContainEqual({ type: 'status', status: 'capture_ready' });
    clearConnTimers(conn);
  });

  it('terminates safely when Deepgram never becomes ready', async () => {
    jest.useFakeTimers();
    try {
      const releaseCapture = jest.fn(async () => true);
      const claimCapture = jest.fn(async () => ({
        startedAt: new Date('2026-07-28T16:00:00.000Z'),
      }));
      const { gateway } = makeGateway({ claimCapture, releaseCapture });
      const ws = fakeSocket();
      const conn = baseConn(ws.socket);

      await (gateway as any).startCapture(conn, 'audio/webm;codecs=opus', 'browser');
      await jest.advanceTimersByTimeAsync(15_000);
      // Finalization gives Deepgram a bounded window to close before discarding
      // the socket, so let that window elapse too.
      await jest.advanceTimersByTimeAsync(3_000);

      expect(ws.sentJson()).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'TRANSCRIPTION_START_TIMEOUT' }),
      );
      // The lease is released rather than held for the whole session cap.
      expect(releaseCapture).toHaveBeenCalledTimes(1);
      expect(conn.state).toBe('ended');
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when the lease heartbeat cannot reach the database', async () => {
    jest.useFakeTimers();
    try {
      const heartbeatCapture = jest.fn(async () => {
        throw new Error('connection pool exhausted');
      });
      const releaseCapture = jest.fn(async () => true);
      const claimCapture = jest.fn(async () => ({
        startedAt: new Date('2026-07-28T16:00:00.000Z'),
      }));
      const { gateway } = makeGateway({ heartbeatCapture, releaseCapture, claimCapture });
      const ws = fakeSocket();
      const conn = baseConn(ws.socket);

      await (gateway as any).startCapture(conn, 'audio/webm;codecs=opus', 'browser');
      deepgramConns[0]!.emit('open');
      // A healthy, actively capturing session — the only thing that fails is the
      // ownership check itself.
      conn.state = 'capturing';
      conn.hasAudio = true;

      await jest.advanceTimersByTimeAsync(30_000);
      await jest.advanceTimersByTimeAsync(3_000);

      expect(heartbeatCapture).toHaveBeenCalledTimes(1);
      expect(ws.sentJson()).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'CAPTURE_LEASE_UNAVAILABLE' }),
      );
      expect(conn.state).toBe('ended');
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends the capture with a restart requirement when Deepgram closes mid-WebM', async () => {
    const releaseCapture = jest.fn(async () => true);
    const claimCapture = jest.fn(async () => ({
      startedAt: new Date('2026-07-28T16:00:00.000Z'),
    }));
    const { gateway } = makeGateway({ claimCapture, releaseCapture });
    const ws = fakeSocket();
    const conn = baseConn(ws.socket);

    await (gateway as any).startCapture(conn, 'audio/webm;codecs=opus', 'browser');
    deepgramConns[0]!.emit('open');
    conn.state = 'capturing';
    conn.hasAudio = true;

    deepgramConns[0]!.emit('close', { code: 1011, reason: 'upstream reset' });
    await new Promise((resolve) => setImmediate(resolve));

    // No transparent reconnect: a second socket would resume mid-container with
    // no WebM header. The analyst is told to restart instead.
    expect(deepgramConns).toHaveLength(1);
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'TRANSCRIPTION_RESTART_REQUIRED' }),
    );
    expect(ws.sentJson()).toContainEqual({
      type: 'status',
      status: 'capture_restart_required',
    });

    // Let finalization finish: the manager already saw its Close, so replay it to
    // release the bounded close-wait instead of leaking that timer past the test.
    deepgramConns[0]!.emit('close', { code: 1000, reason: 'normal' });
    await (conn as any).finalizePromise;
  });

  it('never emits hearing-end alerts from a stale socket that no longer owns the lease', async () => {
    // A socket whose lease was taken over cannot match its own started_at token.
    // Promoting matches or linking bills here would attribute a REPLACEMENT
    // capture's transcript to a capture that is already dead.
    const releaseCapture = jest.fn(async () => false);
    const promoteMatches = jest.fn(async () => ({ alerts: 1 }));
    const linkSession = jest.fn(async () => ({ combined: 1 }));
    const { gateway } = makeGateway({ releaseCapture, promoteMatches, linkSession });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      deepgram: { stopAndWait: jest.fn(async () => undefined) },
    };

    await (gateway as any).finalize(conn, 'ended', false);

    expect(promoteMatches).not.toHaveBeenCalled();
    expect(linkSession).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual({ type: 'status', status: 'failed' });
  });

  it('sends each raw final in arrival order and keeps enrichment off that path', async () => {
    const order: string[] = [];
    const slowEnrichment = deferred<void>();
    const { gateway } = makeGateway();
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
    };
    // Raw persistence resolves out of order on purpose; the browser must still
    // see segment 1 before segment 2.
    const commit = {
      commitRawFinal: jest
        .fn()
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('raw-1');
          return { id: 'segment-1', created: true };
        })
        .mockImplementationOnce(async () => {
          order.push('raw-2');
          return { id: 'segment-2', created: true };
        }),
    };
    (gateway as any).commit = commit;
    (gateway as any).enrichFinal = jest.fn(async () => {
      order.push('enrich');
      await slowEnrichment.promise;
    });

    (gateway as any).enqueueFinal(conn, { startMs: 0, endMs: 1_000, text: 'one' });
    (gateway as any).enqueueFinal(conn, { startMs: 1_000, endMs: 2_000, text: 'two' });
    await conn.rawChain;

    // Raw writes stay in arrival order even though the first one resolves slower.
    expect(order.filter((step) => step.startsWith('raw'))).toEqual(['raw-1', 'raw-2']);
    // Enrichment for segment 1 was STARTED before segment 2's raw write, and did
    // not block it — that is what keeps AI off the live transcript path.
    expect(order.indexOf('enrich')).toBeLessThan(order.lastIndexOf('raw-2'));
    expect(ws.sentJson().filter((m) => m.type === 'final').map((m) => m.segment.text)).toEqual([
      'one',
      'two',
    ]);
    // Enrichment is still outstanding — it did not gate the live transcript.
    expect(conn.pendingEnrichment.size).toBe(2);
    slowEnrichment.resolve();
  });

  it('passes the whole government-affairs frame to Meri without inventing any of it', async () => {
    const { gateway, extract } = makeGateway();
    const ws = fakeSocket();
    const conn = { ...baseConn(ws.socket), state: 'capturing', hasAudio: true };
    const segment = { startMs: 0, endMs: 1_000, text: 'testimony' };

    await (gateway as any).enrichFinal(conn, 'segment-1', segment);

    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        clerkUserId: 'user-1',
        segment,
        sessionContext: {
          clientId: 'client-9',
          issueIds: ['acquisition-reform'],
          billIds: ['hr-1234'],
          programElementIds: ['0604256F'],
          // Agencies and the scheduled hearing id used to be silently dropped.
          agencyIds: ['dod'],
          committeeId: 'hsas',
          hearingId: 'ch-77',
        },
      }),
    );
  });

  it('keeps the raw transcript flowing when Meri is unavailable', async () => {
    const extract = jest.fn(async () => {
      throw new Error('orchestrator unreachable');
    });
    const { gateway } = makeGateway({ extract });
    const ws = fakeSocket();
    const conn = { ...baseConn(ws.socket), state: 'capturing', hasAudio: true };
    (gateway as any).commit = {
      commitRawFinal: jest.fn(async () => ({ id: 'segment-1', created: true })),
    };

    (gateway as any).enqueueFinal(conn, { startMs: 0, endMs: 1_000, text: 'testimony' });
    await conn.rawChain;
    await Promise.allSettled([...conn.pendingEnrichment]);

    // The segment still reached the browser; only the enrichment failed, and it
    // was logged rather than surfaced as a transcript error.
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: 'final', segmentId: 'segment-1' }),
    );
    expect(ws.sentJson()).not.toContainEqual(
      expect.objectContaining({ code: 'TRANSCRIPT_PERSIST_FAILED' }),
    );
  });

  it('persists and sends the tail segment that arrives during a graceful stop', async () => {
    const releaseCapture = jest.fn(async () => true);
    const { gateway } = makeGateway({ releaseCapture });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
    };
    const commitRawFinal = jest.fn(async () => ({ id: 'segment-tail', created: false }));
    (gateway as any).commit = { commitRawFinal };
    // Deepgram flushes its last utterance while we are waiting for its close.
    (conn as any).deepgram = {
      stopAndWait: jest.fn(async () => {
        (gateway as any).enqueueFinal(conn, {
          startMs: 9_000,
          endMs: 10_000,
          text: 'closing statement',
        });
      }),
    };

    await (gateway as any).finalize(conn, 'ended', false);

    expect(commitRawFinal).toHaveBeenCalledTimes(1);
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({
        type: 'final',
        segment: expect.objectContaining({ text: 'closing statement' }),
      }),
    );
    expect(releaseCapture).toHaveBeenCalledTimes(1);
  });

  it('drains raw writes and enrichment before releasing the lease and linking the hearing', async () => {
    const raw = deferred<void>();
    const enrichment = deferred<void>();
    const releaseCapture = jest.fn(async () => true);
    const promoteMatches = jest.fn(async () => ({ alerts: 1 }));
    const linkSession = jest.fn(async () => ({ combined: 1 }));
    const { gateway } = makeGateway({ releaseCapture, promoteMatches, linkSession });
    const ws = fakeSocket();
    const conn = {
      ...baseConn(ws.socket),
      state: 'capturing',
      hasAudio: true,
      claimStartedAt: new Date('2026-07-28T16:00:00.000Z'),
      rawChain: raw.promise,
      pendingEnrichment: new Set<Promise<void>>([enrichment.promise]),
      deepgram: { stopAndWait: jest.fn(async () => undefined) },
    };

    const finalizing = (gateway as any).finalize(conn, 'ended', false) as Promise<void>;
    await Promise.resolve();
    expect(releaseCapture).not.toHaveBeenCalled();

    raw.resolve();
    await Promise.resolve();
    expect(releaseCapture).not.toHaveBeenCalled();

    enrichment.resolve();
    await finalizing;

    expect(releaseCapture).toHaveBeenCalledTimes(1);
    expect(promoteMatches).toHaveBeenCalledWith('tenant-1', 'session-1');
    expect(linkSession).toHaveBeenCalledWith('tenant-1', 'session-1');
    expect(conn.state).toBe('ended');
  });
});
