import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { LiveHearingRoomPage } from './LiveHearingRoomPage.js';
import { LiveHearingRoomVNext } from '../../vnext/pages/legiwatch/live/LiveHearingRoomVNext.js';

const mocks = vi.hoisted(() => ({
  mintWsTicket: vi.fn(),
  getDisplayMedia: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  recordingPolicy: 'transcript_only',
  publicationsEnabled: false,
  transcriptItems: [] as Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    speakerLabel?: string;
  }>,
  sessionData: {} as Partial<{
    id: string;
    title: string;
    status: string;
    sourceType: string;
    audioSource: string;
    sourceUrl: string | null;
    consentStatus: string;
    recordingPolicy: string;
    hearingId: string | null;
    publicCaptureId: string | null;
  }>,
  publicTranscriptData: {
    pages: [{ items: [], total: 0, nextCursor: null, hasMore: false }],
    pageParams: [null],
    resumeCursor: undefined,
    captureId: undefined,
    reconciledAt: 0,
  } as {
    pages: Array<{
      items: Array<{
        id: string;
        sequence: number;
        startMs: number;
        endMs: number;
        text: string;
        speakerName?: string;
        speakerLabel?: string;
        confidence?: number;
        isFinal: boolean;
        gapBefore: boolean;
      }>;
      total: number;
      nextCursor: null;
      hasMore: false;
    }>;
    pageParams: Array<null>;
    resumeCursor: string | undefined;
    captureId: string | undefined;
    reconciledAt: number;
  },
  publicTranscriptLoading: false,
  publicTranscriptError: false,
  publicIntelItems: [] as Array<Record<string, unknown>>,
  publicIntelStatus: 'READY' as string,
  publicIntelJobs: undefined as { public?: Record<string, number> } | undefined,
  publicIntelLoading: false,
  publicIntelError: false,
}));

vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => 'test-scope' }));
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.apiGet, post: mocks.apiPost }),
}));

vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: (feature: string) =>
    ['hearing_watch', 'legiwatch_hearing_recording_v1'].includes(feature) ||
    (mocks.publicationsEnabled &&
      ['legiwatch_hearing_updates_v1', 'legiwatch_hearing_recaps_v1'].includes(feature)),
}));

vi.mock('../../lib/hearing-watch-api.js', () => ({
  briefToMarkdown: () => '# recap',
  isMediaUrl: () => false,
  mediaKindOf: () => 'unknown',
  mintWsTicket: (...args: unknown[]) => mocks.mintWsTicket(...args),
  useConfirmConsent: () => ({ mutate: vi.fn(), isPending: false }),
  useGenerateBrief: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveRecap: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveStream: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useHearingSession: () => ({
    data: {
      id: 'session-1',
      title: 'Armed Services hearing',
      status: 'scheduled',
      sourceType: 'hearing',
      audioSource: 'browser_mic',
      sourceUrl: null,
      consentStatus: 'not_required',
      recordingPolicy: mocks.recordingPolicy,
      ...mocks.sessionData,
    },
    isLoading: false,
  }),
  useHearingTranscript: () => ({
    data: {
      pages: [
        {
          items: mocks.transcriptItems,
          nextOffset: null,
          hasMore: false,
        },
      ],
    },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
}));

vi.mock('../../pages/radar/live-hearings/live-hearings-api.js', () => ({
  usePublicHearingTranscript: () => ({
    data: mocks.publicTranscriptData,
    isLoading: mocks.publicTranscriptLoading,
    isError: mocks.publicTranscriptError,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useHearingIntelligence: () => {
    const envelope = Object.assign(mocks.publicIntelItems, {
      status: mocks.publicIntelStatus,
      jobs: mocks.publicIntelJobs,
    });
    return {
      data: envelope,
      isLoading: mocks.publicIntelLoading,
      isError: mocks.publicIntelError,
    };
  },
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSED = FakeWebSocket.CLOSED;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

class FakeTrack {
  stopped = false;
  private ended?: () => void;

  constructor(private readonly displaySurface?: string) {}

  getSettings() {
    return this.displaySurface ? { displaySurface: this.displaySurface } : {};
  }

  addEventListener(type: string, cb: () => void) {
    if (type === 'ended') this.ended = cb;
  }

  stop() {
    this.stopped = true;
  }

  endFromBrowser() {
    this.ended?.();
  }
}

class FakeStream {
  constructor(
    private readonly audioTracks: FakeTrack[],
    private readonly videoTracks: FakeTrack[],
  ) {}

  getAudioTracks() {
    return this.audioTracks;
  }

  getVideoTracks() {
    return this.videoTracks;
  }

  getTracks() {
    return [...this.audioTracks, ...this.videoTracks];
  }
}

class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[]) {}
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  state: RecordingState = 'inactive';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private stopListeners: Array<() => void> = [];
  start = vi.fn(() => {
    this.state = 'recording';
  });
  requestData = vi.fn();
  stop = vi.fn(() => {
    this.state = 'inactive';
    queueMicrotask(() => this.stopListeners.splice(0).forEach((cb) => cb()));
  });

  constructor(
    readonly stream: FakeMediaStream,
    readonly options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    if (type === 'stop') this.stopListeners.push(cb);
  }
}

function browserSetup() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: mocks.getDisplayMedia },
  });
}

function renderRoom(vnext = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AntApp>
        <MemoryRouter initialEntries={['/intelligence/hearing-watch/session-1']}>
          <Routes>
            <Route
              path={
                vnext ? '/intelligence/hearing-watch/:sessionId' : '/intelligence/hearing-watch/:id'
              }
              element={
                vnext ? <LiveHearingRoomVNext sessionId="session-1" /> : <LiveHearingRoomPage />
              }
            />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

async function connectRoom(): Promise<FakeWebSocket> {
  fireEvent.click(screen.getByRole('button', { name: /^Connect$/i }));
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  act(() => socket.open());
  await screen.findByRole('button', { name: /Start transcription/i });
  return socket;
}

function sentJson(socket: FakeWebSocket) {
  return socket.sent
    .filter((value): value is string => typeof value === 'string')
    .map((value) => JSON.parse(value));
}

describe('LiveHearingRoomPage browser capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    FakeMediaRecorder.instances = [];
    mocks.transcriptItems = [];
    mocks.recordingPolicy = 'transcript_only';
    mocks.publicationsEnabled = false;
    mocks.sessionData = {};
    mocks.publicTranscriptData = {
      pages: [{ items: [], total: 0, nextCursor: null, hasMore: false }],
      pageParams: [null],
      resumeCursor: undefined,
      captureId: undefined,
      reconciledAt: 0,
    };
    mocks.publicTranscriptLoading = false;
    mocks.publicTranscriptError = false;
    mocks.publicIntelItems = [];
    mocks.publicIntelStatus = 'READY';
    mocks.publicIntelJobs = undefined;
    mocks.publicIntelLoading = false;
    mocks.publicIntelError = false;
    mocks.mintWsTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: '2030-01-01T00:00:00Z' });
    mocks.apiGet.mockResolvedValue({ data: [] });
    mocks.getDisplayMedia.mockResolvedValue(
      new FakeStream([new FakeTrack()], [new FakeTrack('browser')]),
    );
    browserSetup();
  });

  test('reopens the saved recording clock and total bytes past a silent transcript tail', async () => {
    mocks.recordingPolicy = 'audio_and_transcript';
    mocks.transcriptItems = [
      { id: 'early-final', startMs: 1000, endMs: 8000, text: 'Owned fixture.' },
    ];
    mocks.apiGet.mockImplementation(async (url: string) => ({
      data: url.endsWith('/recording')
        ? {
            recordingPolicy: 'audio_and_transcript',
            recording: {
              id: 'saved',
              state: 'partial',
              originAt: '2026-09-12T00:00:00Z',
              expiresAt: '2099-01-01',
              transcriptState: 'finalized',
              analysisState: 'ready',
              epochs: [
                {
                  id: 'first',
                  startMs: 0,
                  durableEndMs: 70000,
                  durableBytes: 1048576,
                  state: 'ready',
                  complete: false,
                  playable: true,
                  decodedDurationMs: 70000,
                },
                {
                  id: 'second',
                  startMs: 83000,
                  durableEndMs: 152000,
                  durableBytes: 1048576,
                  state: 'ready',
                  complete: true,
                  playable: true,
                  decodedDurationMs: 69000,
                },
              ],
            },
          }
        : [],
    }));
    renderRoom(true);
    await waitFor(() => expect(screen.getAllByText('00:02:32').length).toBeGreaterThan(0));
    expect(screen.getByText(/Sent 0.00 MB · Saved 2.00 MB/)).toBeInTheDocument();
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
  });

  test('restores persisted transcript history when a session is reopened', async () => {
    mocks.transcriptItems = [
      {
        id: 'segment-persisted',
        startMs: 5_000,
        endMs: 7_000,
        text: 'Persisted testimony from the prior session.',
        speakerLabel: 'Speaker 1',
      },
    ];
    renderRoom();
    expect(
      await screen.findByText('Persisted testimony from the prior session.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Speaker 1:')).toBeInTheDocument();
  });

  test('vNext routes the session id into the working browser capture controls', async () => {
    const { container } = renderRoom(true);
    expect(screen.getByRole('heading', { name: 'Source & capture' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live transcript' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Intelligence' })).toBeInTheDocument();
    expect(container.querySelector('.lw-status')).toBeInTheDocument();
    expect(container.querySelector('.lw-live__intel')).toBeInTheDocument();
    expect(container.querySelector('.ant-card')).not.toBeInTheDocument();
    const socket = await connectRoom();
    expect(mocks.mintWsTicket).toHaveBeenCalledWith(expect.anything(), 'session-1');
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
    await waitFor(() =>
      expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
    );
    act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
    await waitFor(() => expect(FakeMediaRecorder.instances[0]?.state).toBe('recording'));
  });

  test.each([false, true])(
    'keeps one audio panel when reviewed publications load alongside it (vNext=%s)',
    async (vnext) => {
      mocks.apiGet.mockImplementation(async (url: string) => ({
        data: url.includes('/publications/candidates') ? { evidence: [], candidates: [] } : [],
      }));
      renderRoom(vnext);
      const socket = await connectRoom();
      mocks.publicationsEnabled = true;
      act(() => socket.receive({ type: 'status', status: 'preparing_transcription' }));
      await screen.findByRole('region', { name: 'Reviewed hearing updates and recaps' });
      for (const status of ['preparing_transcription', 'capture_ready', 'capturing']) {
        act(() => socket.receive({ type: 'status', status }));
        expect(screen.getAllByRole('region', { name: 'Saved hearing audio' })).toHaveLength(1);
        expect(
          screen.getAllByRole('region', { name: 'Reviewed hearing updates and recaps' }),
        ).toHaveLength(1);
      }
    },
  );

  test.each([false, true])(
    'keeps retained startup alive when transcription is delayed before capture_ready (vNext=%s)',
    async (vnext) => {
      mocks.recordingPolicy = 'audio_and_transcript';
      renderRoom(vnext);
      const socket = await connectRoom();
      fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
      );
      act(() => {
        socket.receive({ type: 'recording_epoch', epochId: 'saved-epoch', startMs: 0 });
        socket.receive({
          type: 'error',
          code: 'TRANSCRIPTION_DELAYED',
          message: 'Audio continues saving; transcription is interrupted.',
        });
        socket.receive({ type: 'status', status: 'capture_ready' });
      });
      await waitFor(() => expect(FakeMediaRecorder.instances[0]?.state).toBe('recording'));
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
      expect(
        screen.getByText('Audio continues saving; transcription is interrupted.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Could not start browser capture/)).not.toBeInTheDocument();
      if (vnext) {
        expect(screen.getByText('INTERRUPTED')).toBeInTheDocument();
        expect(screen.getByText('RECORDING · TRANSCRIPT DELAYED')).toBeInTheDocument();
        expect(screen.queryByText('STREAMING')).not.toBeInTheDocument();
      }
      act(() => {
        FakeMediaRecorder.instances[0]!.ondataavailable?.({
          data: {
            size: 2048,
            slice: () => ({ arrayBuffer: async () => new ArrayBuffer(2048) }),
          },
        } as unknown as BlobEvent);
      });
      await waitFor(() =>
        expect(socket.sent.some((frame) => frame instanceof ArrayBuffer)).toBe(true),
      );
      act(() =>
        socket.receive({
          type: 'audio_saved',
          epochId: 'saved-epoch',
          sequence: 0,
          bytes: 2048,
          durableBytes: 2048,
          durableEndMs: 500,
        }),
      );
      expect(FakeMediaRecorder.instances[0]!.state).toBe('recording');
    },
  );

  test('uses the recording policy loaded after the page first renders', async () => {
    renderRoom(true);
    mocks.recordingPolicy = 'audio_and_transcript';
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }));
    await waitFor(() =>
      expect(sentJson(socket)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'capture_start', recordingProtocol: 1 }),
        ]),
      ),
    );
    act(() => {
      socket.receive({ type: 'recording_epoch', epochId: 'loaded-policy-epoch', startMs: 0 });
      socket.receive({ type: 'status', status: 'capture_ready' });
    });
    await waitFor(() => expect(FakeMediaRecorder.instances[0]?.state).toBe('recording'));
  });

  test.each([false, true])(
    'restores saved intelligence and deduplicates the same live card (vNext=%s)',
    async (vnext) => {
      const card = {
        id: 'segment-1',
        cardType: 'potential_ask',
        title: 'Persisted commitment',
        startMs: 20,
      };
      mocks.apiGet.mockImplementation(async (url: string) => ({
        data: url.endsWith('/summary') ? { cards: [card] } : [],
      }));
      renderRoom(vnext);
      expect(await screen.findByText('Persisted commitment')).toBeInTheDocument();
      const socket = await connectRoom();
      act(() => socket.receive({ type: 'card', card }));
      expect(screen.getAllByText('Persisted commitment')).toHaveLength(1);
    },
  );

  test('Disconnect returns to a reconnectable state without leaving inert capture controls', async () => {
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /^Disconnect$/i }));
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(screen.getByRole('button', { name: /^Connect$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Start transcription/i })).toBeDisabled();
  });

  test.each([false, true])(
    'a late capture_ready after stop cannot start a recorder (vNext=%s)',
    async (vnext) => {
      renderRoom(vnext);
      const socket = await connectRoom();
      fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
      );
      fireEvent.click(screen.getByRole('button', { name: /End session/i }));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_stop')).toBe(true),
      );
      act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
      act(() => socket.receive({ type: 'status', status: 'ended' }));
      await waitFor(() => expect(socket.readyState).toBe(FakeWebSocket.CLOSED));
      expect(FakeMediaRecorder.instances).toHaveLength(0);
    },
  );

  test('a rapid double-click mints only one WebSocket ticket', async () => {
    renderRoom();
    const connect = screen.getByRole('button', { name: /^Connect$/i });
    fireEvent.click(connect);
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.mintWsTicket).toHaveBeenCalledTimes(1));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test.each([false, true])(
    'waits for capture_ready before starting MediaRecorder and blocks duplicate share prompts (vNext=%s)',
    async (vnext) => {
      renderRoom(vnext);
      const socket = await connectRoom();
      const start = screen.getByRole('button', { name: /Start transcription/i });
      fireEvent.click(start);
      fireEvent.click(start);

      await waitFor(() => expect(mocks.getDisplayMedia).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(sentJson(socket)).toContainEqual(
          expect.objectContaining({ type: 'capture_start', mimeType: 'audio/webm;codecs=opus' }),
        ),
      );
      expect(FakeMediaRecorder.instances).toHaveLength(0);

      act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
      await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
      expect(FakeMediaRecorder.instances[0]!.start).toHaveBeenCalledWith(500);
    },
  );

  test.each([false, true])(
    'flushes the recorder before sending capture_stop and closes only after the server ends (vNext=%s)',
    async (vnext) => {
      renderRoom(vnext);
      const socket = await connectRoom();
      fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
      );
      act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
      await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: /End session/i }));
      const recorder = FakeMediaRecorder.instances[0]!;
      await waitFor(() => expect(recorder.requestData).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(recorder.stop).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_stop')).toBe(true),
      );
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);

      act(() => socket.receive({ type: 'status', status: 'ended' }));
      await waitFor(() => expect(socket.readyState).toBe(FakeWebSocket.CLOSED));
      expect((await screen.findAllByText('Session ended')).length).toBeGreaterThan(0);
    },
  );

  test.each([false, true])(
    'stops with a visible error when the upload falls irrecoverably behind (vNext=%s)',
    async (vnext) => {
      const audioTrack = new FakeTrack();
      mocks.getDisplayMedia.mockResolvedValue(
        new FakeStream([audioTrack], [new FakeTrack('browser')]),
      );
      renderRoom(vnext);
      const socket = await connectRoom();
      fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
      await waitFor(() =>
        expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
      );
      act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
      await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
      const recorder = FakeMediaRecorder.instances[0]!;

      // The socket's send buffer is past the bound: the alternative to erroring is
      // growing that buffer without limit (or dropping audio and still claiming to
      // be transcribing).
      socket.bufferedAmount = 4 * 1024 * 1024;
      await act(async () => {
        recorder.ondataavailable?.({
          data: { size: 2_048, arrayBuffer: async () => new ArrayBuffer(2_048) },
        } as unknown as BlobEvent);
      });

      expect(await screen.findByText(/Network upload is falling behind/i)).toBeInTheDocument();
      await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
      expect(audioTrack.stopped).toBe(true);
      // No audio frame was queued behind the bound.
      expect(socket.sent.some((value) => value instanceof ArrayBuffer)).toBe(false);
    },
  );

  test('a cancelled share picker leaves the room connected and retryable', async () => {
    mocks.getDisplayMedia.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));

    expect(await screen.findByText(/Could not start browser capture/i)).toBeInTheDocument();
    expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(false);
    // Still connected, so the analyst can pick the tab again without re-auth.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start transcription/i })).not.toBeDisabled(),
    );
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  test('a tab shared without audio explains the Share tab audio checkbox', async () => {
    mocks.getDisplayMedia.mockResolvedValue(new FakeStream([], [new FakeTrack('browser')]));
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));

    expect(await screen.findByText(/Check Share tab audio/i)).toBeInTheDocument();
    expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  test('a browser without WebM/Opus recording gets a Chrome/Edge message, not a silent failure', async () => {
    FakeMediaRecorder.isTypeSupported.mockReturnValueOnce(false);
    renderRoom();
    await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));

    expect(await screen.findByText(/Use current Chrome or Edge/i)).toBeInTheDocument();
    expect(mocks.getDisplayMedia).not.toHaveBeenCalled();
  });

  test('the browser ending the share stops the capture safely', async () => {
    const audioTrack = new FakeTrack();
    const videoTrack = new FakeTrack('browser');
    mocks.getDisplayMedia.mockResolvedValue(new FakeStream([audioTrack], [videoTrack]));
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
    await waitFor(() =>
      expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
    );
    act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));

    // "Stop sharing" from the browser's own capture bar.
    await act(async () => {
      audioTrack.endFromBrowser();
    });

    await waitFor(() => expect(sentJson(socket).some((m) => m.type === 'capture_stop')).toBe(true));
    expect(FakeMediaRecorder.instances[0]!.stop).toHaveBeenCalled();
    expect(audioTrack.stopped).toBe(true);
  });

  test('an unexpected socket close stops the recorder and the shared tracks', async () => {
    const audioTrack = new FakeTrack();
    const videoTrack = new FakeTrack('browser');
    mocks.getDisplayMedia.mockResolvedValue(new FakeStream([audioTrack], [videoTrack]));
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));
    await waitFor(() =>
      expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(true),
    );
    act(() => socket.receive({ type: 'status', status: 'capture_ready' }));
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    const recorder = FakeMediaRecorder.instances[0]!;

    // The server drops the connection (lease lost, deploy, network) without an
    // `ended` status. Nothing should keep recording the analyst's tab.
    await act(async () => {
      socket.close();
    });

    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
    expect(audioTrack.stopped).toBe(true);
    expect(videoTrack.stopped).toBe(true);
  });

  test('rejects a whole-screen selection before any capture_start is sent', async () => {
    mocks.getDisplayMedia.mockResolvedValue(
      new FakeStream([new FakeTrack()], [new FakeTrack('monitor')]),
    );
    renderRoom();
    const socket = await connectRoom();
    fireEvent.click(screen.getByRole('button', { name: /Start transcription/i }));

    expect(
      await screen.findByText(/Choose a browser tab, not an entire screen/i),
    ).toBeInTheDocument();
    expect(sentJson(socket).some((m) => m.type === 'capture_start')).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  describe('public review session transcript', () => {
    const publicItems = Array.from({ length: 37 }, (_, i) => ({
      id: `pub-seg-${i + 1}`,
      sequence: i + 1,
      startMs: (i + 1) * 1000,
      endMs: (i + 1) * 1000 + 500,
      text: `Public canonical segment ${i + 1}`,
      speakerName: `Speaker ${i + 1}`,
      speakerLabel: `speaker-${i + 1}`,
      confidence: 0.95,
      isFinal: true,
      gapBefore: false,
    }));

    test('renders canonical final segments for a public review session', async () => {
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-1',
      };
      mocks.publicTranscriptData = {
        pages: [{ items: publicItems, total: 37, nextCursor: null, hasMore: false }],
        pageParams: [null],
        resumeCursor: undefined,
        captureId: 'capture-1',
        reconciledAt: 0,
    };
      renderRoom(true);
      expect(
        await screen.findByText('Public canonical segment 37'),
      ).toBeInTheDocument();
      expect(screen.getAllByText(/public canonical segment/i).length).toBe(37);
    });

    test('ordinary browser session keeps private transcript path unchanged', async () => {
      mocks.sessionData = {};
      mocks.transcriptItems = [
        {
          id: 'private-1',
          startMs: 5000,
          endMs: 7000,
          text: 'Private browser transcript.',
          speakerLabel: 'PrivateSpeaker',
        },
      ];
      renderRoom(true);
      expect(
        await screen.findByText('Private browser transcript.'),
      ).toBeInTheDocument();
    });

    test('drops public data when the session changes to a different capture', async () => {
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-1',
      };
      mocks.publicTranscriptData = {
        pages: [{ items: publicItems, total: 37, nextCursor: null, hasMore: false }],
        pageParams: [null],
        resumeCursor: undefined,
        captureId: 'capture-1',
        reconciledAt: 0,
    };
      renderRoom(true);
      expect(
        await screen.findByText('Public canonical segment 1'),
      ).toBeInTheDocument();
      // Simulate the session switching to a different canonical capture. The
      // hook must not merge segments from the old capture.
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-2',
      };
      renderRoom(true);
      await waitFor(() =>
        expect(screen.queryByText('Public canonical segment 1')).not.toBeInTheDocument(),
      );
    });

    test('shows loading state while canonical transcript is loading', async () => {
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-1',
      };
      mocks.publicTranscriptLoading = true;
      renderRoom(true);
      expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    });

    test.each([false, true])(
      'Play audio here drives the canonical public capture player (vNext=%s)',
      async (vnext) => {
        mocks.sessionData = {
          hearingId: 'hearing-1',
          publicCaptureId: 'capture-1',
          status: 'ended',
          audioSource: 'stream_url',
        };
        mocks.publicTranscriptData = {
          pages: [{ items: publicItems, total: 37, nextCursor: null, hasMore: false }],
          pageParams: [null],
          resumeCursor: undefined,
          captureId: 'capture-1',
          reconciledAt: 0,
        };
        mocks.apiGet.mockImplementation(async (url: string) => ({
          data: url.includes('/public-hearings/hearing-1/audio')
            ? {
                epochs: [
                  {
                    id: 'epoch-1',
                    startMs: 0,
                    durableEndMs: 60000,
                    durableBytes: 320044,
                    state: 'ready',
                    transcriptState: 'finalized',
                    expiresAt: '2099-01-01',
                    reason: null,
                  },
                ],
              }
            : [],
        }));
        mocks.apiPost.mockImplementation(async (url: string, body: { positionMs: number }) => ({
          data: {
            partId: 'part-1',
            startMs: 0,
            endMs: 5000,
            url: 'https://private.example/part-1',
            expiresAt: '2099-01-01',
            requested: body.positionMs,
          },
        }));
        renderRoom(vnext);
        // The public player mounts instead of the tenant browser recorder.
        expect(
          await screen.findByRole('region', { name: 'Saved unattended audio' }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Saved hearing audio' })).toBeNull();
        await waitFor(() =>
          expect(mocks.apiGet).toHaveBeenCalledWith(
            '/intel-api/public-hearings/hearing-1/audio',
          ),
        );
        // No playback request before a user gesture.
        expect(mocks.apiPost).not.toHaveBeenCalled();
        const playButtons = await screen.findAllByRole('button', { name: 'Play audio here' });
        fireEvent.click(playButtons[0]!);
        await waitFor(() =>
          expect(mocks.apiPost).toHaveBeenCalledWith(
            '/intel-api/public-hearings/hearing-1/audio/epochs/epoch-1/playback',
            { positionMs: 1000 },
          ),
        );
        // Exactly one player, exactly one playback request for the click.
        expect(screen.getAllByRole('region', { name: 'Saved unattended audio' })).toHaveLength(1);
        expect(mocks.apiPost).toHaveBeenCalledTimes(1);
      },
    );

    test('a capture reassignment remounts the player instead of replaying stale state', async () => {
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-1',
        status: 'ended',
        audioSource: 'stream_url',
      };
      mocks.publicTranscriptData = {
        pages: [{ items: publicItems, total: 37, nextCursor: null, hasMore: false }],
        pageParams: [null],
        resumeCursor: undefined,
        captureId: 'capture-1',
        reconciledAt: 0,
      };
      mocks.apiGet.mockImplementation(async (url: string) => ({
        data: url.includes('/public-hearings/hearing-1/audio')
          ? {
              epochs: [
                {
                  id: 'epoch-1',
                  startMs: 0,
                  durableEndMs: 60000,
                  durableBytes: 320044,
                  state: 'ready',
                  transcriptState: 'finalized',
                  expiresAt: '2099-01-01',
                  reason: null,
                },
              ],
            }
          : [],
      }));
      mocks.apiPost.mockImplementation(async () => ({
        data: {
          partId: 'part-1',
          startMs: 0,
          endMs: 5000,
          url: 'https://private.example/part-1',
          expiresAt: '2099-01-01',
        },
      }));
      const { unmount } = renderRoom(true);
      expect(
        await screen.findByRole('region', { name: 'Saved unattended audio' }),
      ).toBeInTheDocument();
      unmount();
      // Session now points at a different canonical capture: the keyed player
      // must remount (fresh manifest fetch), never reuse the old capture's part.
      mocks.sessionData = {
        hearingId: 'hearing-1',
        publicCaptureId: 'capture-2',
        status: 'ended',
        audioSource: 'stream_url',
      };
      mocks.publicTranscriptData = {
        pages: [{ items: [], total: 0, nextCursor: null, hasMore: false }],
        pageParams: [null],
        resumeCursor: undefined,
        captureId: 'capture-2',
        reconciledAt: 1,
      };
      renderRoom(true);
      await screen.findByRole('region', { name: 'Saved unattended audio' });
      await waitFor(() =>
        expect(
          mocks.apiGet.mock.calls.filter(
            ([url]) => typeof url === 'string' && url.includes('/public-hearings/hearing-1/audio'),
          ).length,
        ).toBeGreaterThanOrEqual(2),
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();
    });
  });
});

// A saved session reviewing a shared PUBLIC capture carries canonical public
// insights, not private tenant cards: the room must render those genuine rows
// (and only those), from the same reconciled hook the hearing detail route
// uses, in BOTH presentations.
describe('LiveHearingRoomPage saved public review intelligence', () => {
  const hearingId = '4c575634-5154-4052-8f46-000000338740';
  const canonical7 = [
    { id: 'phi_552c61cf2d2e9076a6697b1165241f1c', insightType: 'QUESTION', title: 'Question from 0', summary: 'Is a patient in those investigations?', startMs: 0 },
    { id: 'phi_fe3993197b6cf5088ea8e3e8a0027c8c', insightType: 'QUESTION', title: 'Question from 0', summary: 'But you should be the lead on these investigations?', startMs: 8620 },
    { id: 'phi_a0ec53e93faefac89a5f0ecd76c4428c', insightType: 'QUESTION', title: 'Question from 0', summary: 'Can you comment on the status', startMs: 29850 },
    { id: 'phi_b5ebd50912eab13839d01e3f9462fc72', insightType: 'QUESTION', title: 'Question from 0', summary: 'Juan Sebastian Guerrero or Lorenzo Salgado Arajo or any of the 23 shootings involving ICER CBP?', startMs: 37690 },
    { id: 'phi_bee5274f6a610c24d3bde7d690f55426', insightType: 'KEY_QUOTE', title: 'Material statement from 1', summary: "I'll have to get back to you on those because, again, I'd have to go talk to my DHS boss. I know some of these", startMs: 44230 },
    { id: 'phi_cf9d0e94a355bf60947a8c40d63583ab', insightType: 'AGENCY_REFERENCE', title: 'Department of Homeland Security referenced', summary: "I'll have to get back to you on those because, again, I'd have to go talk to my DHS boss. I know some of these", startMs: 44230 },
    { id: 'phi_c7aaee33ee85b3a26f3f9d44ad2b81f6', insightType: 'QUESTION', title: 'Question from 0', summary: 'So why does it take so long?', startMs: 58250 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionData = {
      id: 'session-1',
      title: 'An oversight hearing to examine the Federal Bureau of Investigation.',
      status: 'ended',
      sourceType: 'hearing',
      audioSource: 'stream_url',
      hearingId,
      publicCaptureId: 'capture-1',
    };
    mocks.publicTranscriptData = {
      pages: [{ items: [], total: 0, nextCursor: null, hasMore: false }],
      pageParams: [null],
      resumeCursor: undefined,
      captureId: 'capture-1',
      reconciledAt: 0,
    };
    mocks.publicIntelItems = canonical7;
    mocks.publicIntelStatus = 'PROCESSING';
    mocks.publicIntelJobs = { public: { pending: 37 } };
    browserSetup();
  });

  test.each([false, true])(
    'restores all 7 existing public moments with real type and timestamp (vNext=%s)',
    async (vnext) => {
      renderRoom(vnext);
      await screen.findByText('An oversight hearing to examine the Federal Bureau of Investigation.');
      for (const item of canonical7) {
        expect(await screen.findAllByText(item.title)).not.toHaveLength(0);
        expect(screen.getAllByText(item.summary).length).toBeGreaterThan(0);
      }
      if (vnext) {
        expect(screen.getAllByText('QUESTION')).toHaveLength(5);
        expect(screen.getByText('KEY QUOTE')).toBeInTheDocument();
        expect(screen.getByText('AGENCY REFERENCE')).toBeInTheDocument();
        // Source timestamps map straight through.
        expect(screen.getAllByText('00:00:08').length).toBeGreaterThan(0);
        expect(screen.getAllByText('00:00:58').length).toBeGreaterThan(0);
        expect(screen.getByText(/7 intelligence moments/)).toBeInTheDocument();
      } else {
        expect(screen.getAllByText('QUESTION')).toHaveLength(5);
        expect(screen.getByText('KEY_QUOTE')).toBeInTheDocument();
        expect(screen.getByText('AGENCY_REFERENCE')).toBeInTheDocument();
        expect(screen.getAllByText('[8s]').length).toBeGreaterThan(0);
        expect(screen.getAllByText('[58s]').length).toBeGreaterThan(0);
      }
      // A public review must NOT hit the private tenant summary endpoint.
      expect(
        mocks.apiGet.mock.calls.some(
          ([url]) => typeof url === 'string' && url.includes('/intel-api/hearings/'),
        ),
      ).toBe(false);
    },
  );

  test('vNext jump control carries the canonical timestamp of the finding', async () => {
    renderRoom(true);
    await screen.findByText('An oversight hearing to examine the Federal Bureau of Investigation.');
    expect(
      (await screen.findAllByRole('button', { name: /^Jump to 00:00:08/ })).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: /^Jump to 00:00:58/ }).length,
    ).toBeGreaterThan(0);
  });

  test('private browser-capture sessions still read the tenant summary endpoint', async () => {
    mocks.sessionData = { id: 'session-1', title: 'Private session', status: 'ended' };
    mocks.apiGet.mockImplementation(async (url: string) => ({
      data: url.includes('/summary')
        ? { cards: [{ id: 'tenant-1', cardType: 'watchlist_match', title: 'Tenant card', startMs: 1000 }] }
        : [],
    }));
    renderRoom();
    expect(await screen.findByText('Tenant card')).toBeInTheDocument();
    expect(
      mocks.apiGet.mock.calls.some(
        ([url]) => typeof url === 'string' && url.includes('/intel-api/hearings/session-1/summary'),
      ),
    ).toBe(true);
  });

  test('no stale findings survive switching from a public review to another capture', async () => {
    const { unmount } = renderRoom();
    expect((await screen.findAllByText('Question from 0')).length).toBeGreaterThan(0);
    unmount();
    mocks.sessionData = { ...mocks.sessionData, id: 'session-2', publicCaptureId: 'capture-2' };
    mocks.publicTranscriptData = { ...mocks.publicTranscriptData, captureId: 'capture-2' };
    mocks.publicIntelItems = [];
    mocks.publicIntelStatus = 'READY';
    mocks.publicIntelJobs = undefined;
    renderRoom();
    await waitFor(() =>
      expect(screen.queryByText('Question from 0')).not.toBeInTheDocument(),
    );
  });

  test('same mounted tree swaps findings when the route moves to another public capture', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (sessionId: string) => (
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[`/intelligence/hearing-watch/${sessionId}`]}>
            <Routes>
              <Route path="/intelligence/hearing-watch/:id" element={<LiveHearingRoomPage />} />
            </Routes>
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>
    );
    const { rerender } = render(tree('session-1'));
    expect((await screen.findAllByText('Question from 0')).length).toBeGreaterThan(0);
    // Route to a DIFFERENT saved session in the same mounted tree.
    mocks.sessionData = { ...mocks.sessionData, id: 'session-2', publicCaptureId: 'capture-2' };
    mocks.publicTranscriptData = { ...mocks.publicTranscriptData, captureId: 'capture-2' };
    mocks.publicIntelItems = [
      { id: 'phi_new', insightType: 'KEY_QUOTE', title: 'Second capture quote', summary: 'Different finding.', startMs: 500 },
    ];
    rerender(tree('session-2'));
    expect(await screen.findByText('Second capture quote')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Is a patient in those investigations?')).not.toBeInTheDocument(),
    );
  });

  test('findings without a timestamp still render, with no jump control', async () => {
    mocks.publicIntelItems = [
      ...canonical7,
      { id: 'phi_no_ts', insightType: 'MENTION', title: 'Late mention', summary: 'No evidence timestamp on this one.' },
    ];
    renderRoom(true);
    expect(await screen.findByText('Late mention')).toBeInTheDocument();
    expect(screen.getByText('No evidence timestamp on this one.')).toBeInTheDocument();
    // The untimestamped row counts toward moments but has no jump control.
    expect(screen.getByText(/8 intelligence moments/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Late mention/ }),
    ).not.toBeInTheDocument();
  });

  test('extraction still pending is stated, never rendered as zero moments', async () => {
    mocks.publicIntelItems = [];
    renderRoom();
    expect(
      await screen.findByText(
        'Public intelligence is still being extracted from the canonical transcript.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Relevant moments will appear here.')).not.toBeInTheDocument();
  });

  test('public intelligence error surfaces honestly in both presentations', async () => {
    mocks.publicIntelError = true;
    mocks.publicIntelItems = [];
    renderRoom(true);
    expect(
      await screen.findByText('Saved intelligence could not be refreshed.'),
    ).toBeInTheDocument();
  });
});
