import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ArrowLeftOutlined, AudioOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { useHearingWakeLock } from '../../lib/use-hearing-wake-lock.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import { useApiScope } from '../../lib/use-api-scope.js';
import {
  HearingRecordingTransport,
  type AudioSaved,
} from '../../lib/hearing-recording-transport.js';
import { HearingRecordingPanel } from './HearingRecordingPanel.js';
import { HearingPublicationsPanel } from './HearingPublicationsPanel.js';
import { HearingPublishedRecordsPanel } from './HearingPublishedRecordsPanel.js';
import '../radar/legiwatch.css';
import {
  briefToMarkdown,
  isMediaUrl,
  mediaKindOf,
  mintWsTicket,
  useConfirmConsent,
  useGenerateBrief,
  useHearingSession,
  useHearingTranscript,
  useSaveRecap,
  type HearingBrief,
  type HearingTranscriptItem,
} from '../../lib/hearing-watch-api.js';

const { Title, Text, Paragraph } = Typography;
const RECORDER_MIME = 'audio/webm;codecs=opus';
const CAPTURE_READY_TIMEOUT_MS = 15_000;
const SERVER_END_TIMEOUT_MS = 30_000;
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;

type Phase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'requesting_share'
  | 'preparing'
  | 'capturing'
  | 'stopping'
  | 'ended';

interface LiveSegment extends HearingTranscriptItem {}
interface Card_ {
  id: string;
  cardType: string;
  title: string;
  body?: string;
  startMs?: number;
}

/** Presentation boundary: both rooms use the same capture/recovery lifecycle. */
export interface HearingRoomViewModel {
  session: ReturnType<typeof useHearingSession>['data'];
  loading: boolean;
  unavailable: boolean;
  retry: () => void;
  phase: Phase;
  captureActive: boolean;
  sessionEnded: boolean;
  segments: HearingTranscriptItem[];
  interim: string;
  cards: Card_[];
  transcriptLoading: boolean;
  transcriptError: boolean;
  transcriptionDelayed?: boolean;
  intelligenceError: boolean;
  error: string | null;
  dismissError: () => void;
  statusText: string | null;
  bytesSent: number;
  bytesSaved?: number;
  recordingPanel?: ReactNode;
  publicationsPanel?: ReactNode;
  playEvidence?: (ms: number) => void;
  captureStartedAt?: number;
  captureOffsetMs?: number;
  capturedElapsedMs?: number;
  lastTranscriptAt: number | null;
  wakeLock: ReturnType<typeof useHearingWakeLock>;
  sourcePlayer: ReactNode;
  connect: () => void;
  disconnect: () => void;
  startCapture: () => void;
  endSession: () => void;
  goBack: () => void;
  confirmConsent: () => void;
  confirmingConsent: boolean;
  saveRecap: () => void;
}

const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{6,}$/;

/** youtube.com/watch?v=, youtube.com/live/, youtube.com/embed/, or youtu.be/
 *  short links — anything else returns null (not embeddable via this path).
 *  Parses the URL properly rather than pattern-matching the raw string: a
 *  watch URL shared from a playlist commonly has `list=` before `v=`
 *  (`?list=PL...&v=ID`), which a "watch?v=" prefix match would miss. */
function extractYouTubeVideoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1);
    return YOUTUBE_ID_RE.test(id) ? id : null;
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v');
    return id && YOUTUBE_ID_RE.test(id) ? id : null;
  }
  const m = /^\/(?:live|embed)\/([a-zA-Z0-9_-]{6,})/.exec(u.pathname);
  return m?.[1] ?? null;
}

/** Plays an HLS (.m3u8) stream in a plain <video> — native on Safari, hls.js
 *  everywhere else. Unmuted, no autoplay: this IS the audio source for
 *  transcription (there is no server-side ingestion), so the analyst presses
 *  play, then shares THIS TAB's audio via "Start transcription" below —
 *  autoplay-with-sound is browser-blocked without a user gesture anyway, and the
 *  native play button doubles as that gesture.
 *
 *  A browser's own fetch of this URL is CORS-gated even though a raw server pull
 *  isn't — government/committee CDNs commonly lack permissive CORS for playback.
 *  Surface that as a clear message rather than a silently-black video box. */
function HlsPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setUnavailable(false);
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setUnavailable(true);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      setUnavailable(true);
    }
    return () => hls?.destroy();
  }, [src]);

  if (unavailable) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Preview unavailable"
        description="Open the source in another tab and share that tab's audio instead."
      />
    );
  }
  return (
    <video
      ref={videoRef}
      controls
      playsInline
      onError={() => setUnavailable(true)}
      style={{
        width: '100%',
        maxHeight: 320,
        background: '#000',
        borderRadius: 8,
        display: 'block',
      }}
    />
  );
}

/** Routes by media KIND. A progressive MP4 or an MP3 pushed through hls.js dies
 *  on a manifest parse error, so only real HLS goes to HlsPlayer. */
function MediaPlayer({ src }: { src: string }) {
  const kind = mediaKindOf(src);
  if (kind === 'hls') return <HlsPlayer src={src} />;
  if (kind === 'audio') {
    return <audio src={src} controls style={{ width: '100%', display: 'block' }} />;
  }
  return (
    <video
      src={src}
      controls
      playsInline
      style={{
        width: '100%',
        maxHeight: 320,
        background: '#000',
        borderRadius: 8,
        display: 'block',
      }}
    />
  );
}

// Gateway listens at /intel-api/live. A WebSocket cannot set an Authorization
// header, so the browser presents a SINGLE-USE, 60-second ticket minted over
// authenticated HTTPS (POST /intel-api/hearings/:id/ws-ticket) instead of the
// Clerk JWT. Query strings end up in ALB access logs, proxies and browser
// history — a ticket that dies on first use is safe there; a session token valid
// for the whole socket lifetime was not.
function wsUrl(sessionId: string, ticket: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/intel-api/live?sessionId=${encodeURIComponent(
    sessionId,
  )}&ticket=${encodeURIComponent(ticket)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Reopening a session hydrates its persisted transcript, and a resumed capture
 * then streams new finals on top. Keying by segment id (falling back to the
 * start:end pair the server's unique index is built on) means a segment that
 * appears in BOTH sources renders once, and the sort keeps the reading order
 * deterministic regardless of which source arrived first.
 */
export function TranscriptList({
  segments,
  interim,
  playEvidence,
}: {
  segments: LiveSegment[];
  interim: string;
  playEvidence?: (ms: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = segments.length > 200;
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 12,
    enabled: shouldVirtualize,
  });
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [segments.length, interim]);
  const renderSegment = (s: LiveSegment) => (
    <Paragraph key={s.id || `${s.startMs}:${s.endMs}`} style={{ marginBottom: 8 }}>
      {(s.resolvedSpeakerName || s.speakerLabel) && (
        <Text strong>{s.resolvedSpeakerName ?? s.speakerLabel}: </Text>
      )}
      <Text>{s.text}</Text>{' '}
      <Text type="secondary" style={{ fontSize: 11 }}>
        [{Math.floor(s.startMs / 1000)}s]
      </Text>
      {playEvidence && (
        <Button type="link" size="small" onClick={() => playEvidence(s.startMs)}>
          Play audio here
        </Button>
      )}
    </Paragraph>
  );
  return (
    <div
      ref={parentRef}
      style={{ maxHeight: 560, overflowY: 'auto' }}
      tabIndex={0}
      role="log"
      aria-label="Hearing transcript"
    >
      {shouldVirtualize ? (
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={
                segments[item.index]!.id ||
                `${segments[item.index]!.startMs}:${segments[item.index]!.endMs}`
              }
              ref={virtualizer.measureElement}
              data-index={item.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
            >
              {renderSegment(segments[item.index]!)}
            </div>
          ))}
        </div>
      ) : (
        segments.map(renderSegment)
      )}
      {interim ? (
        <Paragraph style={{ marginBottom: 8, opacity: 0.6 }}>
          <Text italic>{interim}</Text>
        </Paragraph>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

function mergeSegments(persisted: HearingTranscriptItem[], live: LiveSegment[]): LiveSegment[] {
  const map = new Map<string, LiveSegment>();
  for (const s of persisted) map.set(s.id || `${s.startMs}:${s.endMs}`, s);
  for (const s of live) map.set(s.id || `${s.startMs}:${s.endMs}`, s);
  return [...map.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function LiveHearingRoomPage({
  sessionId,
  presentation = 'canonical',
  renderRoom,
}: {
  sessionId?: string;
  presentation?: 'canonical' | 'vnext';
  renderRoom?: (model: HearingRoomViewModel) => ReactNode;
} = {}) {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const recordingEnabled = useIntelFeatureEnabled('legiwatch_hearing_recording_v1');
  const updatesEnabled = useIntelFeatureEnabled('legiwatch_hearing_updates_v1');
  const recapsEnabled = useIntelFeatureEnabled('legiwatch_hearing_recaps_v1');
  const smsEnabled = useIntelFeatureEnabled('legiwatch_hearing_sms_v1');
  const apiScope = useApiScope();
  const params = useParams();
  const id = sessionId ?? params.id ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();
  const api = useApi();
  const confirmConsent = useConfirmConsent();
  const session = useHearingSession(id);
  const transcript = useHearingTranscript(id);
  // Clients (id→name) to resolve the recap's target client + label the picker.
  const clientsQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['clients', apiScope],
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/api/clients')).data,
    staleTime: 60_000,
  });

  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const setPhaseNow = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const [recapOpen, setRecapOpen] = useState(false);
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [liveCards, setCards] = useState<Card_[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [transcriptionDelayed, setTranscriptionDelayed] = useState(false);
  const transcriptionDelayedRef = useRef(false);
  const [bytesSent, setBytesSent] = useState(0);
  const [bytesSaved, setBytesSaved] = useState(0);
  const [evidenceTime, setEvidenceTime] = useState<{ ms: number; revision: number }>();
  const [captureClock, setCaptureClock] = useState<{ wallMs: number; offsetMs: number }>();
  const [capturedElapsedMs, setCapturedElapsedMs] = useState(0);
  const [savedRecording, setSavedRecording] = useState<{
    scope: string;
    sessionId: string;
    endMs: number;
    bytes: number;
  } | null>(null);
  const onRecordingProgress = useCallback(
    (progress: { endMs: number; bytes: number } | null) =>
      setSavedRecording(progress ? { ...progress, scope: apiScope, sessionId: id } : null),
    [apiScope, id],
  );
  const currentSavedRecording =
    savedRecording?.scope === apiScope && savedRecording.sessionId === id ? savedRecording : null;
  const [lastTranscriptAt, setLastTranscriptAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const connectTimerRef = useRef<number | null>(null);
  const socketGenerationRef = useRef(0);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const captureReadyRef = useRef<{ resolve: () => void; reject: (err: Error) => void } | null>(
    null,
  );
  const serverEndedRef = useRef<{ resolve: () => void } | null>(null);
  const stoppingRef = useRef(false);
  const recordingTransportRef = useRef<HearingRecordingTransport | null>(null);
  const recordingEpochRef = useRef<{ epochId: string; startMs: number } | null>(null);

  const persistedSegments = useMemo(
    () => transcript.data?.pages.flatMap((p) => p.items) ?? [],
    [transcript.data],
  );
  const segments = useMemo(
    () => mergeSegments(persistedSegments, liveSegments),
    [persistedSegments, liveSegments],
  );

  const sourceUrl = session.data?.sourceUrl ?? undefined;
  const referenceUrl = sourceUrl && !isMediaUrl(sourceUrl) ? sourceUrl : undefined;
  const embeddableUrl = sourceUrl && isMediaUrl(sourceUrl) ? sourceUrl : undefined;
  const youtubeVideoId = referenceUrl ? extractYouTubeVideoId(referenceUrl) : null;
  const sessionEnded =
    phase === 'ended' || session.data?.status === 'ended' || session.data?.status === 'failed';
  const captureActive = ['requesting_share', 'preparing', 'capturing', 'stopping'].includes(phase);
  const wakeLock = useHearingWakeLock(captureActive);
  const summary = useQuery<{ cards?: Card_[] }>({
    queryKey: ['intel', 'hearing', id, 'summary', apiScope],
    queryFn: async () =>
      (await api.get<{ cards?: Card_[] }>(`/intel-api/hearings/${encodeURIComponent(id)}/summary`))
        .data,
    enabled: enabled && Boolean(id),
    retry: false,
    refetchInterval: captureActive || session.data?.status === 'live' ? 15_000 : false,
    refetchIntervalInBackground: true,
  });
  const cards = useMemo(() => {
    const merged = new Map<string, Card_>();
    for (const card of [...(summary.data?.cards ?? []), ...liveCards]) {
      const key = card.id || `${card.cardType}:${card.startMs}:${card.title}`;
      merged.set(key, { ...card, id: key });
    }
    return [...merged.values()].sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
  }, [summary.data, liveCards]);
  const refreshPersisted = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['intel', 'hearing', id] });
  }, [queryClient, id]);

  // Reopened sessions and a refreshed first page may expose additional history.
  // Drain it automatically so a four-hour room never stops at 500 segments.
  useEffect(() => {
    if (transcript.hasNextPage && !transcript.isFetchingNextPage && !transcript.isError) {
      void transcript.fetchNextPage();
    }
  }, [
    transcript.hasNextPage,
    transcript.isFetchingNextPage,
    transcript.isError,
    transcript.fetchNextPage,
  ]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshPersisted();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refreshPersisted);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refreshPersisted);
    };
  }, [refreshPersisted]);

  /**
   * Tear down everything that can still produce or hold audio. Dropping the
   * recorder reference alone is not enough: an un-stopped MediaRecorder keeps
   * firing `dataavailable` (and keeps the tab's recording indicator lit) until
   * its tracks happen to end, so a terminal failure could leave the microphone
   * chip showing after the UI claimed the capture was over. Stop the recorder
   * first, then the tracks.
   */
  const cleanupCaptureTracks = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // A recorder that already ended throws InvalidStateError — nothing to do.
      }
    }
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  const disconnectSocket = useCallback(() => {
    recordingTransportRef.current?.stop();
    recordingTransportRef.current = null;
    if (connectTimerRef.current !== null) window.clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
    socketGenerationRef.current += 1;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    if (phaseRef.current === 'connected' || phaseRef.current === 'connecting') {
      setPhaseNow('idle');
      setStatusText(null);
    }
  }, [setPhaseNow]);

  const stopRecorderAndFlush = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      await sendChainRef.current;
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      recorder.addEventListener('stop', finish, { once: true });
      window.setTimeout(finish, 1_500);
      try {
        if (recorder.state === 'recording' || recorder.state === 'paused') {
          recorder.requestData();
          recorder.stop();
        } else {
          finish();
        }
      } catch {
        finish();
      }
    });
    await sendChainRef.current;
  }, []);

  const endSession = useCallback(async () => {
    if (stoppingRef.current || phaseRef.current === 'ended') return;
    stoppingRef.current = true;
    setPhaseNow('stopping');
    setStatusText('Finishing transcript…');
    let confirmedEnd = false;
    try {
      await stopRecorderAndFlush();
      cleanupCaptureTracks();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        const ended = new Promise<void>((resolve) => {
          serverEndedRef.current = { resolve: () => resolve() };
        });
        ws.send(
          JSON.stringify({
            type: 'capture_stop',
            finalSequence: recordingTransportRef.current?.finalSequence,
          }),
        );
        await withTimeout(
          ended,
          SERVER_END_TIMEOUT_MS,
          'The server did not confirm the session end.',
        )
          .then(() => {
            confirmedEnd = true;
          })
          .catch(() => undefined);
      }
    } catch (err) {
      setError((err as Error).message || 'The last browser audio could not be uploaded.');
    } finally {
      disconnectSocket();
      captureReadyRef.current = null;
      serverEndedRef.current = null;
      setInterim('');
      setStatusText(
        confirmedEnd
          ? 'Session ended'
          : 'Capture stopped. Server finalization has not been confirmed; refresh to check the saved transcript.',
      );
      setPhaseNow('ended');
      stoppingRef.current = false;
      refreshPersisted();
    }
  }, [cleanupCaptureTracks, disconnectSocket, setPhaseNow, stopRecorderAndFlush, refreshPersisted]);

  useEffect(() => {
    cleanupCaptureTracks();
    disconnectSocket();
    recordingEpochRef.current = null;
    setLiveSegments([]);
    setCards([]);
    setInterim('');
    setBytesSaved(0);
    setBytesSent(0);
    setEvidenceTime(undefined);
    setCaptureClock(undefined);
    setCapturedElapsedMs(0);
    transcriptionDelayedRef.current = false;
    setTranscriptionDelayed(false);
    setPhaseNow('idle');
  }, [apiScope, id]);

  const connect = useCallback(async () => {
    if (phaseRef.current !== 'idle' && phaseRef.current !== 'ended') return;
    setError(null);
    setStatusText('Authorizing connection…');
    setPhaseNow('connecting');
    const generation = ++socketGenerationRef.current;
    try {
      const ticket = (await mintWsTicket(api, id)).ticket;
      if (generation !== socketGenerationRef.current) return;
      const ws = new WebSocket(wsUrl(id, ticket));
      wsRef.current = ws;
      connectTimerRef.current = window.setTimeout(() => {
        if (wsRef.current !== ws || ws.readyState === WebSocket.OPEN) return;
        setError('The hearing connection timed out. Check your connection and try again.');
        disconnectSocket();
      }, CAPTURE_READY_TIMEOUT_MS);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        if (connectTimerRef.current !== null) window.clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
        setPhaseNow('connected');
        setStatusText('Connected — ready to choose the hearing tab.');
        refreshPersisted();
      };
      // A drop for any reason (max-duration cutoff, network blip, auth expiry,
      // lost lease) must tear down browser capture too — otherwise a running
      // MediaRecorder keeps producing chunks with nowhere to send them and the
      // browser's "sharing this tab" indicator stays on. A stale recorder from a
      // dead connection would also bleed into whatever socket a later reconnect
      // creates.
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        if (connectTimerRef.current !== null) window.clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
        wsRef.current = null;
        captureReadyRef.current?.reject(
          new Error('Connection closed before capture became ready.'),
        );
        captureReadyRef.current = null;
        cleanupCaptureTracks();
        if (phaseRef.current !== 'ended' && phaseRef.current !== 'stopping') {
          setError(
            'Connection interrupted. Reconnect and share the hearing tab again to resume transcription.',
          );
          setStatusText(
            'Capture stopped. Previously saved transcript and intelligence remain available.',
          );
          setPhaseNow('idle');
        }
        setInterim('');
        refreshPersisted();
      };
      ws.onerror = () => {
        if (wsRef.current === ws) setError('WebSocket connection error');
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'recording_epoch') {
            recordingEpochRef.current = { epochId: msg.epochId, startMs: msg.startMs };
          } else if (msg.type === 'audio_saved') {
            recordingTransportRef.current?.acknowledge(msg as AudioSaved);
            setError((current) =>
              current?.startsWith('Audio storage is delayed.') ? null : current,
            );
          } else if (msg.type === 'interim') {
            setInterim(msg.segment?.text ?? '');
          } else if (msg.type === 'final' && msg.segment) {
            setInterim('');
            setLastTranscriptAt(Date.now());
            setLiveSegments((current) => {
              const next: LiveSegment = {
                id: msg.segmentId || `${msg.segment.startMs}:${msg.segment.endMs}`,
                ...msg.segment,
              };
              return mergeSegments(current, [next]);
            });
          } else if (msg.type === 'card' && msg.card) {
            setCards((current) => [msg.card, ...current.filter((c) => c.id !== msg.card.id)]);
          } else if (msg.type === 'error') {
            const err = new Error(msg.message ?? 'Transcription error');
            setError(err.message);
            if (msg.code === 'TRANSCRIPTION_DELAYED') {
              transcriptionDelayedRef.current = true;
              setTranscriptionDelayed(true);
              setStatusText('Audio is saving. Live transcription is interrupted.');
              return;
            }
            captureReadyRef.current?.reject(err);
            captureReadyRef.current = null;
            if (msg.code === 'TRANSCRIPTION_RESTART_REQUIRED') {
              cleanupCaptureTracks();
              disconnectSocket();
              setPhaseNow('idle');
              setStatusText('Capture stopped — reconnect and share the hearing tab again.');
            }
          } else if (msg.type === 'status') {
            const status = String(msg.status ?? '');
            if (status === 'connected') {
              setStatusText('Connected — ready to choose the hearing tab.');
            } else if (status === 'preparing_transcription') {
              setStatusText('Preparing transcription…');
            } else if (status === 'capture_ready') {
              setStatusText(
                transcriptionDelayedRef.current
                  ? 'Audio storage ready — starting browser capture. Transcription is interrupted.'
                  : 'Transcription ready — starting browser audio capture…',
              );
              captureReadyRef.current?.resolve();
              captureReadyRef.current = null;
            } else if (status === 'capturing') {
              setStatusText(
                transcriptionDelayedRef.current
                  ? 'Audio is saving. Live transcription is interrupted.'
                  : 'Capturing and transcribing browser-tab audio…',
              );
            } else if (status === 'capture_restart_required') {
              setStatusText('Capture stopped — reconnect and start again to resume safely.');
              cleanupCaptureTracks();
              disconnectSocket();
              setPhaseNow('idle');
            } else if (status === 'max_duration_reached') {
              setStatusText('Session reached the maximum duration and is being finalized.');
            } else if (status === 'ended' || status === 'failed') {
              cleanupCaptureTracks();
              serverEndedRef.current?.resolve();
              serverEndedRef.current = null;
              setPhaseNow('ended');
              setStatusText(status === 'ended' ? 'Session ended' : 'Session ended with an error');
              refreshPersisted();
            } else if (status) {
              setStatusText(status);
            }
          }
        } catch {
          // Ignore a malformed server frame; the next valid status remains usable.
        }
      };
    } catch (err) {
      if (generation !== socketGenerationRef.current) return;
      setError((err as Error).message || 'Not authenticated');
      setStatusText(null);
      setPhaseNow('idle');
    }
  }, [api, cleanupCaptureTracks, disconnectSocket, id, setPhaseNow, refreshPersisted]);

  /**
   * Chamber-agnostic capture path: the analyst opens/plays the hearing (the embed
   * above, or a separate tab for anything that can't be embedded), picks that tab
   * here with "Share tab audio" checked, and MediaRecorder streams WebM/Opus
   * chunks over the WebSocket. This captures audio already being rendered on the
   * analyst's own machine. Scheduled server attendance is a separate capture
   * lifecycle and is never stopped by leaving this browser room.
   *
   * The recorder is NOT started when the picker resolves. It starts only after
   * the server has claimed the session lease, opened Deepgram and answered
   * `capture_ready` — audio sent before that was accepted by the socket and then
   * dropped on the floor, which looked exactly like a working capture producing
   * no transcript.
   */
  const startBrowserCapture = useCallback(async () => {
    if (phaseRef.current !== 'connected') return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Connect first, then start transcription.');
      return;
    }
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(RECORDER_MIME)) {
      setError('This browser cannot record WebM/Opus audio. Use current Chrome or Edge.');
      return;
    }

    setError(null);
    setPhaseNow('requesting_share');
    transcriptionDelayedRef.current = false;
    setTranscriptionDelayed(false);
    // The hearing plays in the embed on THIS page unless the source is
    // reference-only, in which case the analyst opened it in another tab.
    const capturesThisTab = Boolean(embeddableUrl || youtubeVideoId);
    setStatusText(
      capturesThisTab
        ? 'Choose This tab and enable Share tab audio.'
        : 'Choose the browser tab playing the hearing and enable Share tab audio.',
    );
    const generation = socketGenerationRef.current;
    let captureRequested = false;
    try {
      // video:true is required by the browser to offer a "Tab" source with a
      // "Share tab audio" checkbox; the video track is discarded immediately.
      //
      // The two source paths need DIFFERENT pickers, and conflating them was the
      // 2026-09-08 dead end: when the hearing plays in the embed on this page,
      // the copy says "choose This tab" — but Chromium excludes the CALLING tab
      // from the generic tab list by default (selfBrowserSurface defaults to
      // exclude), so the one tab the analyst was told to pick was the one tab
      // not offered. `preferCurrentTab` is the purpose-built opt-in for that.
      // It must stay OFF for a reference-only source, which genuinely lives in
      // a DIFFERENT tab the analyst opened — narrowing the picker to this tab
      // would make that path uncapturable instead.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        ...(capturesThisTab ? { preferCurrentTab: true } : {}),
      } as DisplayMediaStreamOptions);
      // Re-check live state: the browser's picker can sit open for a while, and a
      // disconnect (or a second Start attempt) may have happened while we waited.
      const phaseAfterPicker = phaseRef.current as Phase;
      if (phaseAfterPicker !== 'requesting_share' || wsRef.current?.readyState !== WebSocket.OPEN) {
        display.getTracks().forEach((t) => t.stop());
        throw new Error('Connection state changed while the share picker was open. Try again.');
      }

      const videoTrack = display.getVideoTracks()[0];
      const displaySurface = videoTrack?.getSettings().displaySurface;
      if (displaySurface && displaySurface !== 'browser') {
        display.getTracks().forEach((t) => t.stop());
        throw new Error('Choose a browser tab, not an entire screen or application window.');
      }
      const audioTracks = display.getAudioTracks();
      if (!audioTracks.length) {
        display.getTracks().forEach((t) => t.stop());
        throw new Error('No audio was shared. Check Share tab audio in the browser picker.');
      }

      displayStreamRef.current = display;
      setPhaseNow('preparing');
      const captureSocket = wsRef.current;
      const ready = new Promise<void>((resolve, reject) => {
        captureReadyRef.current = { resolve: () => resolve(), reject };
      });
      captureRequested = true;
      captureSocket.send(
        JSON.stringify({
          type: 'capture_start',
          mimeType: RECORDER_MIME,
          displaySurface: displaySurface ?? 'unknown',
          recordingProtocol:
            session.data?.recordingPolicy === 'audio_and_transcript' ? 1 : undefined,
        }),
      );
      await withTimeout(
        ready,
        CAPTURE_READY_TIMEOUT_MS,
        'Transcription did not become ready. Try again.',
      );
      const phaseAfterReady = phaseRef.current as Phase;
      if (
        generation !== socketGenerationRef.current ||
        phaseAfterReady !== 'preparing' ||
        wsRef.current !== captureSocket ||
        captureSocket.readyState !== WebSocket.OPEN
      ) {
        display.getTracks().forEach((track) => track.stop());
        return;
      }

      display.getVideoTracks().forEach((t) => t.stop());
      const recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType: RECORDER_MIME });
      mediaRecorderRef.current = recorder;
      sendChainRef.current = Promise.resolve();
      const epoch = recordingEpochRef.current;
      const retained = session.data?.recordingPolicy === 'audio_and_transcript';
      if (retained && !epoch)
        throw new Error('The server did not establish a durable recording attempt.');
      const transport = retained
        ? new HearingRecordingTransport(captureSocket, epoch!.epochId, (ack) =>
            setBytesSaved(ack.durableBytes),
          )
        : null;
      recordingTransportRef.current = transport;
      const recorderStartedAt = performance.now();
      setCaptureClock({ wallMs: Date.now(), offsetMs: epoch?.startMs ?? 0 });

      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        setCapturedElapsedMs(
          (epoch?.startMs ?? 0) + Math.round(performance.now() - recorderStartedAt),
        );
        if (transport) {
          sendChainRef.current = transport.enqueue(
            event.data,
            Math.round(performance.now() - recorderStartedAt),
          );
          setBytesSent((n) => n + event.data.size);
          sendChainRef.current.catch((err) => {
            if (generation !== socketGenerationRef.current) return;
            setError((err as Error).message);
            cleanupCaptureTracks();
            disconnectSocket();
            setPhaseNow('idle');
          });
          return;
        }
        sendChainRef.current = sendChainRef.current.then(async () => {
          const ws = wsRef.current;
          // 'stopping' is still a sending phase — that is the final flushed chunk,
          // which must reach the server before capture_stop. 'ended' is not.
          if (phaseRef.current === 'ended') return;
          if (ws !== captureSocket || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount + event.data.size > MAX_WS_BUFFERED_BYTES) {
            throw new Error(
              'Network upload is falling behind. The capture was stopped to prevent data loss.',
            );
          }
          const buffer = await event.data.arrayBuffer();
          if (
            wsRef.current !== ws ||
            ws.readyState !== WebSocket.OPEN ||
            generation !== socketGenerationRef.current
          )
            return;
          ws.send(buffer);
          setBytesSent((n) => n + buffer.byteLength);
        });
        sendChainRef.current.catch((err) => {
          if (generation !== socketGenerationRef.current) return;
          setError((err as Error).message);
          cleanupCaptureTracks();
          disconnectSocket();
          setPhaseNow('idle');
        });
      };
      recorder.onerror = () => {
        setError('The browser audio recorder stopped unexpectedly.');
        void endSession();
      };
      // The browser's own "Stop sharing" control ends the track directly — treat
      // it as an intentional end so the tail utterance still gets finalized.
      audioTracks[0]?.addEventListener('ended', () => {
        if (!stoppingRef.current && phaseRef.current === 'capturing') void endSession();
      });
      recorder.start(500);
      setPhaseNow('capturing');
      setStatusText(
        transcriptionDelayedRef.current
          ? 'Audio is saving. Live transcription is interrupted.'
          : 'Capturing and transcribing browser-tab audio…',
      );
    } catch (err) {
      const phaseAfterError = phaseRef.current as Phase;
      if (
        generation !== socketGenerationRef.current ||
        phaseAfterError === 'ended' ||
        phaseAfterError === 'stopping'
      )
        return;
      captureReadyRef.current = null;
      cleanupCaptureTracks();
      // Once the handshake has begun, close that transport before a retry. A
      // late capture_ready must never attach a recorder after a timeout/stop.
      if (captureRequested) disconnectSocket();
      setError(`Could not start browser capture: ${(err as Error).message}`);
      setStatusText(
        wsRef.current?.readyState === WebSocket.OPEN ? 'Connected — ready to try again.' : null,
      );
      setPhaseNow(wsRef.current?.readyState === WebSocket.OPEN ? 'connected' : 'idle');
    }
  }, [
    cleanupCaptureTracks,
    disconnectSocket,
    embeddableUrl,
    endSession,
    session.data?.recordingPolicy,
    setPhaseNow,
    youtubeVideoId,
  ]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!['requesting_share', 'preparing', 'capturing', 'stopping'].includes(phaseRef.current)) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    return () => {
      // Bump the generation so an in-flight ticket mint cannot open a socket
      // into an unmounted component.
      socketGenerationRef.current += 1;
      cleanupCaptureTracks();
      disconnectSocket();
    };
  }, [cleanupCaptureTracks, disconnectSocket]);

  const goBack = useCallback(async () => {
    if (captureActive) {
      const confirmed = window.confirm(
        'Leaving will end this live hearing transcription. Continue?',
      );
      if (!confirmed) return;
      await endSession();
    } else {
      disconnectSocket();
    }
    navigate(presentation === 'vnext' ? '/legiwatch?tab=hearings' : '/intelligence/hearing-watch');
  }, [captureActive, disconnectSocket, endSession, navigate, presentation]);

  const cardColor = useMemo(
    () =>
      ({
        watchlist_match: 'red',
        bill_mention: 'blue',
        client_mention: 'purple',
        opposition: 'volcano',
        potential_ask: 'gold',
      }) as Record<string, string>,
    [],
  );

  if (!enabled) {
    return (
      <div className="lw-root redesign" style={{ padding: '22px 32px 80px', minHeight: '100%' }}>
        <div className="guide plain">
          <h4>Hearing Watch is not enabled</h4>
          <p>This workspace doesn’t have Hearing Watch turned on yet.</p>
        </div>
      </div>
    );
  }

  const unofficialPublicationsPanel =
    (updatesEnabled || recapsEnabled) &&
    session.data &&
    session.data.recordingPolicy !== 'no_storage' ? (
      <HearingPublicationsPanel
        key={`publications:${apiScope}:${id}`}
        sessionId={id}
        eventId={session.data.hearingId ?? undefined}
        title={session.data.title}
        defaultClientId={session.data.clientId ?? undefined}
        clients={clientsQuery.data ?? []}
        updatesEnabled={updatesEnabled}
        recapsEnabled={recapsEnabled}
        smsEnabled={smsEnabled}
        recapRequested={recapOpen}
        onRecapOpened={() => setRecapOpen(false)}
        playEvidence={(ms) =>
          setEvidenceTime((current) => ({ ms, revision: (current?.revision ?? 0) + 1 }))
        }
      />
    ) : null;
  const publicationsPanel = (
    <>
      {unofficialPublicationsPanel}
      {session.data?.hearingId ? (
        <HearingPublishedRecordsPanel
          eventId={session.data.hearingId}
          sessionId={session.data.recordingPolicy === 'no_storage' ? undefined : id}
          clientId={session.data.clientId ?? undefined}
        />
      ) : null}
    </>
  );
  if (renderRoom) {
    return (
      <>
        {renderRoom({
          session: session.data,
          loading: session.isLoading,
          unavailable: session.isError || !session.data,
          retry: () => {
            void session.refetch();
            refreshPersisted();
          },
          phase,
          captureActive,
          sessionEnded,
          segments,
          interim,
          cards,
          transcriptLoading: transcript.isLoading,
          transcriptError: transcript.isError,
          transcriptionDelayed,
          intelligenceError: summary.isError,
          error,
          dismissError: () => setError(null),
          statusText,
          bytesSent,
          lastTranscriptAt,
          wakeLock,
          bytesSaved:
            session.data?.recordingPolicy === 'audio_and_transcript'
              ? Math.max(bytesSaved, currentSavedRecording?.bytes ?? 0)
              : undefined,
          captureStartedAt: captureClock?.wallMs,
          captureOffsetMs: captureClock?.offsetMs,
          capturedElapsedMs: Math.max(capturedElapsedMs, currentSavedRecording?.endMs ?? 0),
          recordingPanel:
            recordingEnabled || session.data?.recordingPolicy === 'audio_and_transcript' ? (
              <HearingRecordingPanel
                key={`recording:${apiScope}:${id}`}
                sessionId={id}
                live={captureActive}
                canEnable={!captureActive && !session.data?.startedAt}
                evidenceTime={evidenceTime}
                onProgress={onRecordingProgress}
              />
            ) : null,
          publicationsPanel,
          playEvidence: (ms) =>
            setEvidenceTime((current) => ({ ms, revision: (current?.revision ?? 0) + 1 })),
          sourcePlayer: embeddableUrl ? (
            <MediaPlayer src={embeddableUrl} />
          ) : youtubeVideoId ? (
            <iframe
              src={`https://www.youtube.com/embed/${youtubeVideoId}`}
              title="Hearing video"
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : null,
          connect: () => {
            void connect();
          },
          disconnect: disconnectSocket,
          startCapture: () => {
            void startBrowserCapture();
          },
          endSession: () => {
            void endSession();
          },
          goBack: () => {
            void goBack();
          },
          confirmConsent: () =>
            confirmConsent.mutate(
              { id, attestation: 'Confirmed recording consent for this hearing.' },
              {
                onSuccess: () => message.success('Consent confirmed'),
                onError: (e: unknown) => message.error((e as Error).message),
              },
            ),
          confirmingConsent: confirmConsent.isPending,
          saveRecap: () => setRecapOpen(true),
        })}
        {recapOpen && !recapsEnabled && (
          <SaveRecapModal
            sessionId={id}
            sessionTitle={session.data?.title ?? 'Hearing'}
            defaultClientId={session.data?.clientId ?? undefined}
            clients={clientsQuery.data ?? []}
            onClose={() => setRecapOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div
      className={presentation === 'vnext' ? 'lw lw-liveroom' : 'lw-root redesign'}
      style={{ padding: '22px 32px 80px', background: 'var(--bg-canvas)', minHeight: '100%' }}
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => void goBack()}>
          Back
        </Button>
        <Title level={4} style={{ margin: 0 }}>
          <AudioOutlined /> {session.data?.title ?? 'Live Hearing Room'}
        </Title>
        <Badge
          status={
            phase === 'capturing'
              ? 'processing'
              : phase === 'idle' || phase === 'ended'
                ? 'default'
                : 'warning'
          }
          text={phase === 'capturing' ? 'Transcribing' : phase.replace('_', ' ')}
        />
      </Space>

      {error ? (
        <Alert
          type="error"
          showIcon
          closable
          message={error}
          style={{ marginBottom: 12 }}
          onClose={() => setError(null)}
        />
      ) : null}

      <Space style={{ marginBottom: 12 }} wrap>
        {(phase === 'idle' || phase === 'ended' || phase === 'connecting') && (
          <Button
            type="primary"
            onClick={() => void connect()}
            loading={phase === 'connecting'}
            disabled={phase === 'connecting'}
          >
            {sessionEnded ? 'Connect to resume' : 'Connect'}
          </Button>
        )}
        {phase === 'connected' && <Button onClick={() => disconnectSocket()}>Disconnect</Button>}
        {captureActive && (
          <Button danger loading={phase === 'stopping'} onClick={() => void endSession()}>
            End session
          </Button>
        )}
        {session.data?.consentStatus === 'needs_review' && (
          <Button
            onClick={() =>
              confirmConsent.mutate(
                { id, attestation: 'Confirmed recording consent for this hearing.' },
                {
                  onSuccess: () => message.success('Consent confirmed'),
                  onError: (e: unknown) => message.error((e as Error).message),
                },
              )
            }
            loading={confirmConsent.isPending}
          >
            Confirm consent
          </Button>
        )}
      </Space>

      {sessionEnded && segments.length > 0 && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Text type="secondary">Session ended — act on it:</Text>
          <Button type="primary" icon={<SaveOutlined />} onClick={() => setRecapOpen(true)}>
            Save recap
          </Button>
        </Space>
      )}

      {(embeddableUrl || referenceUrl) && (
        <Card size="small" title="Hearing source" style={{ marginBottom: 12, maxWidth: 760 }}>
          {embeddableUrl ? (
            <>
              <MediaPlayer src={embeddableUrl} />
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                Press play, connect, then start transcription and choose{' '}
                <Text strong>This tab</Text>.
              </Text>
            </>
          ) : youtubeVideoId ? (
            <>
              <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
                <iframe
                  src={`https://www.youtube.com/embed/${youtubeVideoId}`}
                  title="Hearing video"
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    border: 0,
                    borderRadius: 8,
                  }}
                />
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                Press play, connect, then start transcription and choose{' '}
                <Text strong>This tab</Text>.
              </Text>
            </>
          ) : (
            <>
              <Text type="secondary">This source opens outside Capiro.</Text>{' '}
              <Button
                type="link"
                href={referenceUrl}
                target="_blank"
                rel="noreferrer"
                style={{ padding: 0 }}
              >
                Open hearing source in a new tab ↗
              </Button>
            </>
          )}
        </Card>
      )}

      <Card size="small" title="Capture" style={{ marginBottom: 12, maxWidth: 760 }}>
        <Space direction="vertical" size={6}>
          <Tooltip title={phase !== 'connected' ? 'Connect first.' : undefined}>
            <span>
              <Button
                type="primary"
                onClick={() => void startBrowserCapture()}
                disabled={phase !== 'connected'}
                loading={phase === 'requesting_share' || phase === 'preparing'}
              >
                Start transcription
              </Button>
            </span>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Choose the browser tab playing the hearing and enable Share tab audio. Chrome or Edge is
            required.
          </Text>
          {captureActive && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {wakeLock === 'active'
                ? 'Screen wake lock active.'
                : 'Keep this device awake while sharing audio.'}{' '}
              Browser transcription needs this tab and device to stay open. Scheduled Capiro
              attendance runs on the server.
            </Text>
          )}
          {statusText && <Badge status="processing" text={statusText} />}
          <Text type="secondary" style={{ fontSize: 11 }}>
            Sent {(bytesSent / 1024 / 1024).toFixed(2)} MB
            {lastTranscriptAt
              ? ` · last transcript ${Math.max(0, Math.round((Date.now() - lastTranscriptAt) / 1000))}s ago`
              : ''}
          </Text>
        </Space>
      </Card>

      {(recordingEnabled || session.data?.recordingPolicy === 'audio_and_transcript') && (
        <HearingRecordingPanel
          key={`recording:${apiScope}:${id}`}
          sessionId={id}
          live={captureActive}
          canEnable={!captureActive && !session.data?.startedAt}
          evidenceTime={evidenceTime}
          onProgress={onRecordingProgress}
        />
      )}
      {publicationsPanel}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
          gap: 16,
        }}
      >
        <Card title="Transcript" size="small" style={{ minHeight: 420 }}>
          {transcript.isError && (
            <Alert type="warning" message="Saved transcript could not be refreshed." />
          )}
          {transcript.isLoading && segments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : segments.length === 0 && !interim ? (
            <Empty
              description={
                statusText ??
                'No transcript yet. Connect, play the hearing, and start transcription.'
              }
            />
          ) : (
            <TranscriptList
              segments={segments}
              interim={interim}
              playEvidence={
                session.data?.recordingPolicy === 'audio_and_transcript'
                  ? (ms) => setEvidenceTime({ ms, revision: Date.now() })
                  : undefined
              }
            />
          )}
          {transcript.hasNextPage && (
            <Button
              size="small"
              style={{ marginTop: 8 }}
              loading={transcript.isFetchingNextPage}
              onClick={() => void transcript.fetchNextPage()}
            >
              Load more transcript
            </Button>
          )}
        </Card>

        <Card title="Intelligence cards" size="small" style={{ minHeight: 420 }}>
          {summary.isError && (
            <Alert type="warning" message="Saved intelligence could not be refreshed." />
          )}
          {cards.length === 0 ? (
            <Empty description="Relevant moments will appear here." />
          ) : (
            <div style={{ maxHeight: 560, overflowY: 'auto' }}>
              {cards.map((c) => (
                <Card key={c.id} size="small" style={{ marginBottom: 8 }}>
                  <Space direction="vertical" size={2}>
                    <Tag color={cardColor[c.cardType] ?? 'default'}>{c.cardType}</Tag>
                    <Text strong>{c.title}</Text>
                    {c.body && <Text type="secondary">{c.body}</Text>}
                    {c.startMs != null && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        [{Math.floor(c.startMs / 1000)}s]
                      </Text>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          )}
        </Card>
      </div>

      {recapOpen && !recapsEnabled && (
        <SaveRecapModal
          sessionId={id}
          sessionTitle={session.data?.title ?? 'Hearing'}
          defaultClientId={session.data?.clientId ?? undefined}
          clients={clientsQuery.data ?? []}
          onClose={() => setRecapOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * L6 — Save Recap. Client FIRST, then generation: the brief is written FOR the
 * chosen client — intel-api grounds risks/opportunities in the firm's stored
 * relevance for this hearing × client, and the orchestrator compiles that
 * client's steering — so it cannot be generated before the client is known, and
 * it regenerates when the client changes. (It used to generate on mount, before
 * the picker rendered, so the "client" only ever chose where a generic recap
 * was filed.) The preview carries honest labels — Meri synthesis vs
 * source-verified assembly; client context applied vs unavailable — because the
 * two look identical otherwise. Saving files the recap to the client's Documents
 * (auto-indexed into that client's Meri knowledge) through the dedicated
 * hearing-recap endpoint, carrying the sessionId so the server can prove tenant
 * ownership and private-session access.
 *
 * Exported for the recap tests; only LiveHearingRoomPage renders it.
 */
export function SaveRecapModal({
  sessionId,
  sessionTitle,
  defaultClientId,
  clients,
  onClose,
}: {
  sessionId: string;
  sessionTitle: string;
  defaultClientId?: string;
  clients: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const gen = useGenerateBrief();
  const save = useSaveRecap();
  const [brief, setBrief] = useState<HearingBrief | null>(null);
  const [failed, setFailed] = useState(false);
  const [clientId, setClientId] = useState(defaultClientId ?? '');

  // Generation is async and the client can change mid-flight. Only the LATEST
  // request may populate the preview: a stale success would label a recap that
  // was written for client A as the one for client B. The mutate ref keeps the
  // effect's dependency list to the two facts that define a request.
  const requestRef = useRef(0);
  const mutateRef = useRef(gen.mutate);
  mutateRef.current = gen.mutate;

  const generate = useCallback(
    (forClientId: string) => {
      const requestId = ++requestRef.current;
      setBrief(null);
      setFailed(false);
      mutateRef.current(
        { sessionId, clientId: forClientId },
        {
          onSuccess: (value) => {
            if (requestRef.current !== requestId) return;
            if (value) setBrief(value);
            else setFailed(true);
          },
          onError: () => {
            if (requestRef.current !== requestId) return;
            setFailed(true);
          },
        },
      );
    },
    [sessionId],
  );

  useEffect(() => {
    if (!clientId) {
      // No client, no recap — and any in-flight request is now stale.
      requestRef.current += 1;
      setBrief(null);
      setFailed(false);
      return;
    }
    generate(clientId);
  }, [sessionId, clientId, generate]);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
  const generating = Boolean(clientId) && !brief && !failed;
  const synthesized = brief?.synthesisSource === 'orchestrator';
  const clientContext = brief?.clientContext;
  const matchedBand =
    clientContext?.relevanceBand && ['HIGH', 'MEDIUM', 'LOW'].includes(clientContext.relevanceBand)
      ? clientContext.relevanceBand
      : null;
  const onSave = () => {
    if (!brief || !clientId) return;
    save.mutate(
      {
        sessionId,
        clientId,
        title: `Hearing recap — ${sessionTitle}`,
        markdown: briefToMarkdown(brief),
      },
      {
        onSuccess: () => {
          message.success(`Recap saved to ${clientName}'s Documents and added to Meri's knowledge`);
          onClose();
        },
        onError: (e: unknown) => {
          const detail = (e as { response?: { data?: { message?: string | string[] } } })?.response
            ?.data?.message;
          message.error(
            `Could not save recap: ${
              Array.isArray(detail) ? detail.join('; ') : (detail ?? (e as Error).message)
            }`,
          );
        },
      },
    );
  };

  return (
    <Modal
      open
      onCancel={onClose}
      title="Save hearing recap"
      width={640}
      destroyOnHidden
      rootClassName="redesign"
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="save"
          type="primary"
          icon={<SaveOutlined />}
          loading={save.isPending}
          disabled={!brief || !clientId}
          onClick={onSave}
        >
          Save to Client Profile
        </Button>,
      ]}
    >
      <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--muted, #8a8a96)' }}>
        Written for
      </div>
      <Select
        aria-label="Recap client"
        style={{ minWidth: 300 }}
        placeholder="Choose a client"
        value={clientId || undefined}
        options={clients.map((c) => ({ value: c.id, label: c.name }))}
        onChange={setClientId}
        showSearch
        optionFilterProp="label"
      />
      <Divider style={{ margin: '12px 0' }} />
      {!clientId ? (
        <Alert
          type="info"
          showIcon
          message="Choose the client this recap is for"
          description="Meri writes the recap against that client's priorities and the firm's stored relevance for this hearing. Pick a client to generate it."
        />
      ) : generating ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
          <div style={{ marginTop: 12 }}>
            Meri is writing the recap for {clientName || 'this client'}…
          </div>
        </div>
      ) : failed ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="No recap available yet"
            description="This session has no transcribed content to summarize."
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => generate(clientId)}>
            Try again
          </Button>
        </Space>
      ) : (
        <div>
          <Space wrap size={6} style={{ marginBottom: 8 }}>
            {synthesized ? (
              <Tag color="green">Meri synthesis</Tag>
            ) : (
              <Tag color="orange">Unofficial transcript-based recap — Meri was unavailable</Tag>
            )}
            {clientContext?.status === 'applied' ? (
              <Tag color="blue">
                {clientName || 'Client'} priorities applied
                {matchedBand ? ` · relevance ${matchedBand}` : ''}
              </Tag>
            ) : clientContext?.status === 'unavailable' ? (
              <Tag>No client context available — general recap</Tag>
            ) : null}
            <Button
              size="small"
              type="link"
              icon={<ReloadOutlined />}
              onClick={() => generate(clientId)}
              style={{ padding: 0 }}
            >
              Regenerate
            </Button>
          </Space>
          {!synthesized && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message="This recap was assembled from the transcript, not analysed"
              description="Meri's synthesis was unavailable when it ran. It is fully sourced, so you can still save it — or regenerate to retry."
            />
          )}
          <Paragraph strong style={{ marginBottom: 6 }}>
            {brief!.title}
          </Paragraph>
          <Paragraph
            type="secondary"
            style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', fontSize: 12.5 }}
          >
            {briefToMarkdown(brief!)}
          </Paragraph>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Saving files this recap into the client’s Documents and indexes it for Meri.
          </Text>
        </div>
      )}
    </Modal>
  );
}

export default LiveHearingRoomPage;
