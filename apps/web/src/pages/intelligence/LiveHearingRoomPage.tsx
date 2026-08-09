import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
import { ArrowLeftOutlined, AudioOutlined, SaveOutlined } from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import '../radar/legiwatch.css';
import '../radar/legiwatch-v3.css';
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
const SERVER_END_TIMEOUT_MS = 8_000;
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

/** Offset within the hearing as mm:ss (or h:mm:ss past an hour). */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = `${m}`.padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${`${s}`.padStart(2, '0')}`;
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
}: {
  segments: LiveSegment[];
  interim: string;
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
  /**
   * v3 segment row: offset gutter, then speaker over the utterance. The mockup
   * also carries a matched-term chip and client tags per segment; watchlist
   * matches are stored with a startMs but no endpoint returns them per segment,
   * so those are not rendered rather than guessed.
   */
  const renderSegment = (s: LiveSegment) => {
    const speaker = s.resolvedSpeakerName ?? s.speakerLabel;
    return (
      <div className="lw-seg" key={s.id || `${s.startMs}:${s.endMs}`}>
        <div className="lw-seg-time">{fmtClock(s.startMs)}</div>
        <div className="lw-seg-main">
          {speaker && <div className="lw-seg-speaker">{speaker}</div>}
          <div className="lw-seg-text">{s.text}</div>
        </div>
      </div>
    );
  };
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
        <div className="lw-seg interim">
          <div className="lw-seg-time">live</div>
          <div className="lw-seg-main">
            <div className="lw-seg-text">{interim}</div>
          </div>
        </div>
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

export function LiveHearingRoomPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const api = useApi();
  const confirmConsent = useConfirmConsent();
  const session = useHearingSession(id);
  const transcript = useHearingTranscript(id);
  // Clients (id→name) to resolve the recap's target client + label the picker.
  const clientsQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['clients'],
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
  const [cards, setCards] = useState<Card_[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [bytesSent, setBytesSent] = useState(0);
  const [lastTranscriptAt, setLastTranscriptAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sendChainRef = useRef<Promise<void>>(Promise.resolve());
  const captureReadyRef = useRef<{ resolve: () => void; reject: (err: Error) => void } | null>(
    null,
  );
  const serverEndedRef = useRef<{ resolve: () => void } | null>(null);
  const stoppingRef = useRef(false);

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
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }, []);

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
    try {
      await stopRecorderAndFlush();
      cleanupCaptureTracks();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        const ended = new Promise<void>((resolve) => {
          serverEndedRef.current = { resolve: () => resolve() };
        });
        ws.send(JSON.stringify({ type: 'capture_stop' }));
        await withTimeout(
          ended,
          SERVER_END_TIMEOUT_MS,
          'The server did not confirm the session end.',
        ).catch(() => undefined);
      }
    } finally {
      disconnectSocket();
      captureReadyRef.current = null;
      serverEndedRef.current = null;
      setInterim('');
      setStatusText('Session ended');
      setPhaseNow('ended');
      stoppingRef.current = false;
    }
  }, [cleanupCaptureTracks, disconnectSocket, setPhaseNow, stopRecorderAndFlush]);

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

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        setPhaseNow('connected');
        setStatusText('Connected — ready to choose the hearing tab.');
      };
      // A drop for any reason (max-duration cutoff, network blip, auth expiry,
      // lost lease) must tear down browser capture too — otherwise a running
      // MediaRecorder keeps producing chunks with nowhere to send them and the
      // browser's "sharing this tab" indicator stays on. A stale recorder from a
      // dead connection would also bleed into whatever socket a later reconnect
      // creates.
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        captureReadyRef.current?.reject(
          new Error('Connection closed before capture became ready.'),
        );
        captureReadyRef.current = null;
        cleanupCaptureTracks();
        if (phaseRef.current !== 'ended' && phaseRef.current !== 'stopping') {
          setStatusText(null);
          setPhaseNow('idle');
        }
      };
      ws.onerror = () => {
        if (wsRef.current === ws) setError('WebSocket connection error');
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'interim') {
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
            captureReadyRef.current?.reject(err);
            captureReadyRef.current = null;
            if (msg.code === 'TRANSCRIPTION_RESTART_REQUIRED') cleanupCaptureTracks();
          } else if (msg.type === 'status') {
            const status = String(msg.status ?? '');
            if (status === 'connected') {
              setStatusText('Connected — ready to choose the hearing tab.');
            } else if (status === 'preparing_transcription') {
              setStatusText('Preparing transcription…');
            } else if (status === 'capture_ready') {
              setStatusText('Transcription ready — starting browser audio capture…');
              captureReadyRef.current?.resolve();
              captureReadyRef.current = null;
            } else if (status === 'capturing') {
              setStatusText('Capturing and transcribing browser-tab audio…');
            } else if (status === 'capture_restart_required') {
              setStatusText('Capture stopped — reconnect and start again to resume safely.');
              cleanupCaptureTracks();
            } else if (status === 'max_duration_reached') {
              setStatusText('Session reached the maximum duration and is being finalized.');
            } else if (status === 'ended' || status === 'failed') {
              serverEndedRef.current?.resolve();
              serverEndedRef.current = null;
              setPhaseNow('ended');
              setStatusText(status === 'ended' ? 'Session ended' : 'Session ended with an error');
            } else if (status) {
              setStatusText(status);
            }
          }
        } catch {
          // Ignore a malformed server frame; the next valid status remains usable.
        }
      };
    } catch (err) {
      setError((err as Error).message || 'Not authenticated');
      setStatusText(null);
      setPhaseNow('idle');
    }
  }, [api, cleanupCaptureTracks, id, setPhaseNow]);

  /**
   * Chamber-agnostic capture path: the analyst opens/plays the hearing (the embed
   * above, or a separate tab for anything that can't be embedded), picks that tab
   * here with "Share tab audio" checked, and MediaRecorder streams WebM/Opus
   * chunks over the WebSocket. This captures audio already being rendered on the
   * analyst's own machine; it never touches the source platform's servers, and
   * there is no server-side stream ingestion — this is the only transcription
   * path.
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
    setStatusText('Choose the browser tab playing the hearing and enable Share tab audio.');
    try {
      // video:true is required by the browser to offer a "Tab" source with a
      // "Share tab audio" checkbox; the video track is discarded immediately.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
      const ready = new Promise<void>((resolve, reject) => {
        captureReadyRef.current = { resolve: () => resolve(), reject };
      });
      wsRef.current.send(
        JSON.stringify({
          type: 'capture_start',
          mimeType: RECORDER_MIME,
          displaySurface: displaySurface ?? 'unknown',
        }),
      );
      await withTimeout(
        ready,
        CAPTURE_READY_TIMEOUT_MS,
        'Transcription did not become ready. Try again.',
      );

      display.getVideoTracks().forEach((t) => t.stop());
      const recorder = new MediaRecorder(new MediaStream(audioTracks), { mimeType: RECORDER_MIME });
      mediaRecorderRef.current = recorder;
      sendChainRef.current = Promise.resolve();

      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        sendChainRef.current = sendChainRef.current.then(async () => {
          const ws = wsRef.current;
          // 'stopping' is still a sending phase — that is the final flushed chunk,
          // which must reach the server before capture_stop. 'ended' is not.
          if (phaseRef.current === 'ended') return;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
            throw new Error(
              'Network upload is falling behind. The capture was stopped to prevent data loss.',
            );
          }
          const buffer = await event.data.arrayBuffer();
          ws.send(buffer);
          setBytesSent((n) => n + buffer.byteLength);
        });
        sendChainRef.current.catch((err) => {
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
      setStatusText('Capturing and transcribing browser-tab audio…');
    } catch (err) {
      captureReadyRef.current = null;
      cleanupCaptureTracks();
      setError(`Could not start browser capture: ${(err as Error).message}`);
      setStatusText(
        wsRef.current?.readyState === WebSocket.OPEN ? 'Connected — ready to try again.' : null,
      );
      setPhaseNow(wsRef.current?.readyState === WebSocket.OPEN ? 'connected' : 'idle');
    }
  }, [cleanupCaptureTracks, disconnectSocket, endSession, setPhaseNow]);

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
    navigate('/intelligence/hearing-watch');
  }, [captureActive, disconnectSocket, endSession, navigate]);

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

  return (
    <div
      className="lw-root redesign"
      style={{ padding: '22px 32px 80px', background: 'var(--bg-canvas)', minHeight: '100%' }}
    >
      <div className="lw-room-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Button
            icon={<ArrowLeftOutlined />}
            size="small"
            onClick={() => void goBack()}
            style={{ marginBottom: 8 }}
          >
            Back
          </Button>
          <p className="pg-eyebrow" style={{ marginBottom: 6 }}>
            {[session.data?.sourceType, session.data?.status].filter(Boolean).join(' · ') ||
              'Live session'}
          </p>
          <h1 className="pg-title" style={{ fontSize: 22, lineHeight: '28px' }}>
            <AudioOutlined /> {session.data?.title ?? 'Live Hearing Room'}
          </h1>
        </div>
        <span className={captureActive ? 'lw-room-live' : 'lw-room-live off'}>
          <span className="pdot" />
          {phase === 'capturing' ? 'Transcribing' : phase.replace('_', ' ')}
        </span>
      </div>

      {/* Only signals the client actually observes. The mockup also showed audio
          health and a transcript-latency figure; neither is measured anywhere. */}
      <div className="lw-health">
        <div className="lw-health-cell">
          <div className="lw-health-k">Source</div>
          <div className="lw-health-v">
            {phase === 'idle' || phase === 'ended' ? 'Disconnected' : 'Connected'}
          </div>
        </div>
        <div className="lw-health-cell">
          <div className="lw-health-k">Capture</div>
          <div className="lw-health-v">{captureActive ? 'This tab' : 'Not capturing'}</div>
        </div>
        <div className="lw-health-cell">
          <div className="lw-health-k">Uploaded</div>
          <div className="lw-health-v">{(bytesSent / 1024 / 1024).toFixed(2)} MB</div>
        </div>
        <div className="lw-health-cell">
          <div className="lw-health-k">Last final</div>
          <div className="lw-health-v">
            {lastTranscriptAt
              ? `${Math.max(0, Math.round((Date.now() - lastTranscriptAt) / 1000))}s ago`
              : 'None yet'}
          </div>
        </div>
        {session.data?.watchlistMatchCount != null && (
          <div className="lw-health-cell">
            <div className="lw-health-k">Watchlist hits</div>
            <div className="lw-health-v">{session.data.watchlistMatchCount}</div>
          </div>
        )}
      </div>

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

      <div className="lw-room-grid">
        <div className="lw-room-col">
      {(embeddableUrl || referenceUrl) && (
        <div className="lw-panel">
          <div className="lw-panel-head">
            <h3>Hearing source</h3>
            <span className="grow" style={{ flex: 1 }} />
            {session.data?.audioSource && (
              <span className="lw-panel-meta">{session.data.audioSource}</span>
            )}
          </div>
          <div className="lw-panel-body">
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
          </div>
        </div>
      )}

      <div className="lw-panel">
        <div className="lw-panel-head">
          <h3>Capture</h3>
          <span className="grow" style={{ flex: 1 }} />
          {captureActive && (
            <span className="lw-pill ok">
              <span className="pdot" />
              Transcribing
            </span>
          )}
        </div>
        <div className="lw-panel-body">
          <div className="lw-panel-meta" style={{ marginBottom: 8 }}>
            {captureActive ? `This tab · ${RECORDER_MIME.replace(';codecs=', ' · ')}` : 'Not capturing'}
          </div>
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
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            Choose the browser tab playing the hearing and enable Share tab audio. Chrome or Edge is
            required.
          </Text>
          {statusText && (
            <div style={{ marginTop: 8 }}>
              <Badge status="processing" text={statusText} />
            </div>
          )}
          {/* The mockup shows a dropped-frame count next to the byte total;
              MediaRecorder gives us bytes but nothing tracks dropped frames. */}
          <div className="lw-panel-meta" style={{ marginTop: 8 }}>
            {(bytesSent / 1024 / 1024).toFixed(2)} MB uploaded
          </div>
        </div>
      </div>

        </div>

        <div className="lw-room-col">
          <div className="lw-panel">
            <div className="lw-panel-head">
              <h3>Live transcript</h3>
              <span className="lw-panel-meta">
                {segments.length} finals{interim ? ' · 1 interim' : ''}
              </span>
            </div>
            {transcript.isLoading && segments.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24 }}>
                <Spin />
              </div>
            ) : segments.length === 0 && !interim ? (
              <div className="lw-empty">
                {statusText ??
                  'No transcript yet. Connect, play the hearing, and start transcription.'}
              </div>
            ) : (
              <div style={{ padding: '0 0 4px' }}>
                <TranscriptList segments={segments} interim={interim} />
              </div>
            )}
            <div className="lw-panel-foot">
              {transcript.hasNextPage ? (
                <button
                  type="button"
                  className="btn"
                  disabled={transcript.isFetchingNextPage}
                  onClick={() => void transcript.fetchNextPage()}
                >
                  Load earlier
                </button>
              ) : (
                <span className="lw-panel-meta">Start of transcript</span>
              )}
              <span className="grow" style={{ flex: 1 }} />
              <span className="lw-panel-meta">
                {segments.length} finals{segments.length > 200 ? ' · virtualized' : ''}
              </span>
            </div>
          </div>
        </div>

        <div className="lw-room-col intel">
          <div className="lw-panel">
            <div className="lw-panel-head">
              <h3>Live intelligence</h3>
              <span className="lw-panel-meta">
                {cards.length} {cards.length === 1 ? 'moment' : 'moments'}
              </span>
            </div>
            {/* The mockup has MOMENTS / ACTIONS / ENTITIES tabs. Only moments
                exist: there is no live action-rule engine and no entity
                extraction on the hearing path, so a tab strip here would be two
                tabs that can never fill. */}
            {cards.length === 0 ? (
              <div className="lw-empty">Relevant moments will appear here.</div>
            ) : (
              <div style={{ maxHeight: 620, overflowY: 'auto' }}>
                {cards.map((c) => (
                  <div
                    className={c.cardType === 'watchlist_match' ? 'lw-icard match' : 'lw-icard'}
                    key={c.id}
                  >
                    <div className="lw-icard-top">
                      <span className="lw-icard-kind">
                        <span className="pdot" />
                        {c.cardType.replace(/_/g, ' ')}
                      </span>
                      <span className="grow" style={{ flex: 1 }} />
                      {c.startMs != null && (
                        <span className="lw-icard-at">{fmtClock(c.startMs)}</span>
                      )}
                    </div>
                    <div className="lw-icard-title">{c.title}</div>
                    {c.body && <div className="lw-icard-body">{c.body}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {recapOpen && (
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
 * L6 — Save Recap. Generates the post-hearing brief, previews it, and files it to
 * a client's Documents (which auto-indexes into that client's Meri knowledge)
 * through the dedicated hearing-recap endpoint, carrying the sessionId so the
 * server can prove tenant ownership and private-session access.
 */
function SaveRecapModal({
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

  useEffect(() => {
    gen.mutate(sessionId, {
      onSuccess: (value) => (value ? setBrief(value) : setFailed(true)),
      onError: () => setFailed(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
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
      {!brief && !failed ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
          <div style={{ marginTop: 12 }}>Meri is writing the recap…</div>
        </div>
      ) : failed ? (
        <Alert
          type="warning"
          showIcon
          message="No recap available yet"
          description="This session has no transcribed content to summarize."
        />
      ) : (
        <div>
          <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--muted, #8a8a96)' }}>
            Save to client
          </div>
          <Select
            style={{ minWidth: 300 }}
            placeholder="Choose a client"
            value={clientId || undefined}
            options={clients.map((c) => ({ value: c.id, label: c.name }))}
            onChange={setClientId}
            showSearch
            optionFilterProp="label"
          />
          <Divider style={{ margin: '12px 0' }} />
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
