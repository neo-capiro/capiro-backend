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
  transcriptItems: [] as Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    speakerLabel?: string;
  }>,
}));

vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => 'test-scope' }));
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.apiGet, post: mocks.apiPost }),
}));

vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: (feature: string) =>
    ['hearing_watch', 'legiwatch_hearing_recording_v1'].includes(feature),
}));

vi.mock('../../lib/hearing-watch-api.js', () => ({
  briefToMarkdown: () => '# recap',
  isMediaUrl: () => false,
  mediaKindOf: () => 'unknown',
  mintWsTicket: (...args: unknown[]) => mocks.mintWsTicket(...args),
  useConfirmConsent: () => ({ mutate: vi.fn(), isPending: false }),
  useGenerateBrief: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveRecap: () => ({ mutate: vi.fn(), isPending: false }),
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
    mocks.mintWsTicket.mockResolvedValue({ ticket: 'ticket-1', expiresAt: '2030-01-01T00:00:00Z' });
    mocks.apiGet.mockResolvedValue({ data: [] });
    mocks.getDisplayMedia.mockResolvedValue(
      new FakeStream([new FakeTrack()], [new FakeTrack('browser')]),
    );
    browserSetup();
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
});
