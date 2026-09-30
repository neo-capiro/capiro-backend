import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Hls from 'hls.js';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApi } from '../../lib/use-api.js';
import { useHearingWakeLock } from '../../lib/use-hearing-wake-lock.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import { useApiScope } from '../../lib/use-api-scope.js';
import { useCapiroToast } from '../../vnext/components/feedback/toast.js';
import {
  HearingRecordingTransport,
  type AudioSaved,
} from '../../lib/hearing-recording-transport.js';
import { HearingRecordingPanel } from './HearingRecordingPanel.js';
import { PublicHearingAudioPanel } from './PublicHearingAudioPanel.js';
import { HearingPublicationsPanel as PublicationsCore } from './HearingPublicationsPanelCore.js';
import { HearingPublishedRecordsPanel as PublishedRecordsCore } from './HearingPublishedRecordsPanelCore.js';
import {
  briefToMarkdown,
  isMediaUrl,
  mediaKindOf,
  mintWsTicket,
  useConfirmConsent,
  useCurrentHearingRecap,
  useGenerateBrief,
  useHearingSession,
  useHearingTranscript,
  useResolveStream,
  useSaveRecap,
  type HearingBrief,
  type HearingTranscriptItem,
  type ResolveStreamResult,
} from '../../lib/hearing-watch-api.js';
import { HearingRecapPreview } from './HearingRecapPreview.js';
import {
  useAttendance,
  useRequestAttendance,
  w1Error,
} from '../../vnext/pages/legiwatch/lib/wave1-api.js';
import {
  useHearingIntelligence,
  usePublicHearingTranscript,
} from '../radar/live-hearings/live-hearings-api.js';
import type { PublicTranscriptSegment } from '../radar/live-hearings/live-hearings.types.js';

const RECORDER_MIME = 'audio/webm;codecs=opus';
const CAPTURE_READY_TIMEOUT_MS = 15_000;
const SERVER_END_TIMEOUT_MS = 30_000;
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;

export type Phase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'requesting_share'
  | 'preparing'
  | 'capturing'
  | 'stopping'
  | 'ended';

export interface LiveSegment extends HearingTranscriptItem {}
export interface Card_ {
  id: string;
  cardType: string;
  title: string;
  body?: string;
  startMs?: number;
  /** The finding's cited transcript segment id, when the source carries one.
   *  This is the authoritative jump target at shared interval boundaries. */
  segmentId?: string;
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
  /** True while extraction is still producing public findings (loading,
   *  PROCESSING, or pending public jobs) — never claimed when DEGRADED only. */
  intelligenceProcessing?: boolean;
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
  /** The official source URL to open (resolved player page when available,
   *  else the saved sourceUrl). Never the raw Congress listing when a resolved
   *  official source exists. */
  openSourceUrl?: string | null;
  connect: () => void;
  disconnect: () => void;
  startCapture: () => void;
  endSession: () => void;
  goBack: () => void;
  confirmConsent: () => void;
  confirmingConsent: boolean;
  saveRecap: () => void;
  /** Canonical hearing detail path, when this room is linked to a hearing. */
  detailPath?: string | null;
  /** Server-attendance panel for rooms tied to a canonical hearing. */
  serverAttendance?: {
    available: boolean;
    /** This workspace has durable server demand for the proceeding. */
    scheduled: boolean;
    callerScheduled?: boolean;
    /** Capture lifecycle from the server's own state — never inferred from the
     *  durable demand flag (which stays true after complete/failed). */
    lifecycle?: 'scheduled' | 'capturing' | 'processing' | 'complete' | 'failed';
    stateLabel?: string;
    message?: string;
    pending: boolean;
    error?: string | null;
    confirm?: string | null;
    onSchedule: () => void;
  };
  /** Official-source resolution when the saved source is a listing page. */
  sourceResolution?: {
    status: 'idle' | 'resolving' | 'resolved' | 'unresolvable' | 'error';
    note?: string;
    referenceUrl?: string;
    candidates?: Array<{ title: string; pageUrl: string }>;
    onRetry: () => void;
    onSelectCandidate: (pageUrl: string) => void;
  };
}

import type * as Antd from 'antd';
import type { ComponentType } from 'react';
export interface HearingRoomUi {
  Alert: typeof Antd.Alert;
  Badge: typeof Antd.Badge;
  Button: typeof Antd.Button;
  Card: typeof Antd.Card;
  Divider: typeof Antd.Divider;
  Empty: typeof Antd.Empty;
  Modal: typeof Antd.Modal;
  Select: typeof Antd.Select;
  Space: typeof Antd.Space;
  Spin: typeof Antd.Spin;
  Tag: typeof Antd.Tag;
  Tooltip: typeof Antd.Tooltip;
  Typography: typeof Antd.Typography;
  ArrowLeftOutlined: ComponentType;
  AudioOutlined: ComponentType;
  ReloadOutlined: ComponentType;
  SaveOutlined: ComponentType;
  useNotifications: () => {
    message: { success: (text: string) => unknown; error: (text: string) => unknown };
  };
  HearingPublicationsPanel: typeof PublicationsCore;
  HearingPublishedRecordsPanel: typeof PublishedRecordsCore;
}
export function createHearingRoomComponents(ui: HearingRoomUi) {
  const {
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
    ArrowLeftOutlined,
    AudioOutlined,
    ReloadOutlined,
    SaveOutlined,
    useNotifications,
    HearingPublicationsPanel,
    HearingPublishedRecordsPanel,
  } = ui;
  const { Title, Text, Paragraph } = Typography;
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
  function TranscriptList({
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

  function LiveHearingRoomPage({
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
    const { message } = useNotifications();
    const api = useApi();
    const confirmConsent = useConfirmConsent();
    const session = useHearingSession(id);
    const transcript = useHearingTranscript(id);
    const isPublicReview = Boolean(session.data?.publicCaptureId && session.data?.hearingId);
    const publicTranscript = usePublicHearingTranscript(
      isPublicReview ? (session.data?.hearingId ?? '') : '',
    );
    // Saved public reviews read canonical PUBLIC intelligence (the same paged,
    // reconciled hook HearingDetailRoute uses); the private tenant summary below
    // stays the source for browser-capture sessions.
    const publicIntelRaw = useHearingIntelligence(
      isPublicReview ? (session.data?.hearingId ?? '') : '',
    );
    // Capture identity guard: the transcript rail already proved the returned
    // capture matches this session's canonical capture. Until it does (or if a
    // newer capture replaced it), that event's intelligence is NOT this saved
    // capture's — render nothing rather than another capture's findings.
    const publicIntelCaptureVerified = Boolean(
      isPublicReview &&
      session.data?.publicCaptureId &&
      publicTranscript.data &&
      publicTranscript.data.captureId === session.data.publicCaptureId,
    );
    const publicIntel = useMemo(
      () => (publicIntelCaptureVerified ? publicIntelRaw : { ...publicIntelRaw, data: undefined }),
      [publicIntelCaptureVerified, publicIntelRaw],
    );
    const publicSegments = useMemo(() => {
      const canonical = session.data?.publicCaptureId;
      const capture = publicTranscript.data?.captureId;
      // The hook already reconciles capture changes; if the returned capture
      // still doesn't match the session's canonical capture, the public rail
      // is inconsistent — render nothing rather than another capture's text.
      if (!isPublicReview || !publicTranscript.data || !canonical || capture !== canonical)
        return [] as HearingTranscriptItem[];
      return publicTranscript.data.pages
        .flatMap((p) => p.items)
        .filter((s: PublicTranscriptSegment) => s.isFinal)
        .map((s): HearingTranscriptItem => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          speakerLabel: s.speakerLabel,
          resolvedSpeakerName: s.speakerName,
          confidence: s.confidence,
        }));
    }, [isPublicReview, publicTranscript.data, session.data?.publicCaptureId]);
    const transcriptLoading = isPublicReview
      ? publicTranscript.isLoading && publicSegments.length === 0
      : transcript.isLoading;
    const transcriptError = isPublicReview ? publicTranscript.isError : transcript.isError;
    // Clients (id→name) to resolve the recap's target client + label the picker.
    const clientsQuery = useQuery<Array<{ id: string; name: string }>>({
      queryKey: ['clients', apiScope],
      queryFn: async () =>
        (await api.get<Array<{ id: string; name: string }>>('/api/clients')).data,
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
    /** Shared by the transcript list and the publications panel: both must drive
     *  the SAME mounted player, with a monotonic revision so a repeated position
     *  still re-seeks. */
    const playEvidenceAt = useCallback(
      (ms: number) =>
        setEvidenceTime((current) => ({ ms, revision: (current?.revision ?? 0) + 1 })),
      [],
    );
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
      () =>
        isPublicReview ? publicSegments : (transcript.data?.pages.flatMap((p) => p.items) ?? []),
      [isPublicReview, publicSegments, transcript.data],
    );
    const segments = useMemo(
      () => mergeSegments(persistedSegments, liveSegments),
      [persistedSegments, liveSegments],
    );

    const sourceUrl = session.data?.sourceUrl ?? undefined;
    const referenceUrl = sourceUrl && !isMediaUrl(sourceUrl) ? sourceUrl : undefined;
    const embeddableUrl = sourceUrl && isMediaUrl(sourceUrl) ? sourceUrl : undefined;
    const youtubeVideoId = referenceUrl ? extractYouTubeVideoId(referenceUrl) : null;

    // ── Server attendance (independent of this browser room) ────────────────
    const canonicalHearingId = session.data?.hearingId ?? undefined;
    const attendance = useAttendance(canonicalHearingId ?? '');
    const requestAttendance = useRequestAttendance(canonicalHearingId ?? '');
    const [serverConfirm, setServerConfirm] = useState<string | null>(null);
    const [serverError, setServerError] = useState<string | null>(null);
    const attendanceData = attendance.data;
    const automaticAvailable =
      attendanceData?.automaticAvailable ??
      (attendanceData?.availableModes ?? []).includes('automatic') ??
      false;
    const serverScheduled = Boolean(
      attendanceData &&
      (attendanceData.scheduled ||
        ['SCHEDULED', 'CAPTURING', 'PROCESSING'].includes(attendanceData.state)),
    );
    // The lifecycle label comes from the server's own capture STATE, not from the
    // durable demand flag — scheduled_by_user stays true after COMPLETE/FAILED,
    // so inferring "capturing/scheduled" from it misrepresents the lifecycle.
    const serverLifecycle =
      attendanceData?.state === 'CAPTURING'
        ? 'capturing'
        : attendanceData?.state === 'PROCESSING'
          ? 'processing'
          : attendanceData?.state === 'COMPLETE'
            ? 'complete'
            : attendanceData?.state === 'FAILED'
              ? 'failed'
              : 'scheduled';
    const onScheduleServer = useCallback(() => {
      if (!canonicalHearingId || requestAttendance.isPending) return;
      setServerError(null);
      setServerConfirm(null);
      requestAttendance.mutate(
        { mode: 'automatic' },
        {
          onSuccess: () =>
            setServerConfirm(
              'Server attendance scheduled. Capiro captures the official stream on the server — this browser room and its private capture are unaffected and stay available.',
            ),
          onError: (err) => setServerError(w1Error(err)),
        },
      );
    }, [canonicalHearingId, requestAttendance]);

    // ── Official-source resolution for listing-page sources ─────────────────
    // A saved sourceUrl that is a plain event LISTING page (Congress.gov, a
    // committee notice) carries no playable media. Restore the official player:
    // run the same stream resolver the add-hearing flow uses so reopening this
    // room surfaces a playable source instead of a dead link. The resolver never
    // ingests server-side; it returns the official media/page for the browser.
    const resolveStream = useResolveStream();
    const [resolution, setResolution] = useState<{
      status: 'idle' | 'resolving' | 'resolved' | 'unresolvable' | 'error';
      note?: string;
      referenceUrl?: string;
      candidates?: Array<{ title: string; pageUrl: string }>;
    }>({ status: 'idle' });
    const needsResolution = Boolean(
      !isPublicReview && referenceUrl && !youtubeVideoId && canonicalHearingId,
    );
    // Guard re-entrancy by the exact (session, source) identity — the mutation
    // object is unstable across renders, so it must not drive the effect.
    const resolveKeyRef = useRef<string | null>(null);
    const attemptResolve = useCallback(
      (pageUrl?: string) => {
        if (!canonicalHearingId) return;
        const key = `${id}:${pageUrl ?? referenceUrl ?? ''}`;
        resolveKeyRef.current = key;
        setResolution({ status: 'resolving' });
        resolveStream.mutate(
          { pageUrl: pageUrl ?? referenceUrl, hearingId: canonicalHearingId },
          {
            onSuccess: (r: ResolveStreamResult) => {
              // Drop a stale response that arrived after the source changed.
              if (resolveKeyRef.current !== key) return;
              const empty = r.status === 'candidates' && !(r.candidates && r.candidates.length);
              if (r.status === 'resolved' && r.media && !r.media.ipBound) {
                setResolution({ status: 'resolved', note: r.note, referenceUrl: r.media.url });
              } else if (r.status === 'resolved' && r.media?.ipBound) {
                setResolution({
                  status: 'unresolvable',
                  note:
                    r.note ??
                    'The official source is short-lived and cannot be saved. Open it and share that tab’s audio.',
                  referenceUrl: r.reference,
                });
              } else if (r.status === 'candidates' && !empty) {
                setResolution({
                  status: 'unresolvable',
                  note: 'Pick the matching official video below.',
                  candidates: r.candidates?.map((c) => ({ title: c.title, pageUrl: c.pageUrl })),
                  referenceUrl: r.reference,
                });
              } else {
                setResolution({
                  status: 'unresolvable',
                  note:
                    r.note ??
                    'Could not resolve an official playable source for this hearing. Open the official page and share that tab’s audio.',
                  referenceUrl: r.reference ?? pageUrl ?? referenceUrl,
                });
              }
            },
            onError: (e: unknown) => {
              if (resolveKeyRef.current !== key) return;
              setResolution({
                status: 'error',
                note: (e as Error).message,
                referenceUrl: pageUrl ?? referenceUrl,
              });
            },
          },
        );
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [id, canonicalHearingId, referenceUrl],
    );
    // Reset resolution whenever the session or saved source changes.
    useEffect(() => {
      resolveKeyRef.current = null;
      setResolution({ status: 'idle' });
    }, [id, referenceUrl]);
    // Auto-resolve once per (session, source) when the saved source is a listing page.
    useEffect(() => {
      if (!needsResolution || !referenceUrl) return;
      const key = `${id}:${referenceUrl}`;
      if (resolveKeyRef.current === key) return;
      attemptResolve(referenceUrl);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, needsResolution, referenceUrl]);
    // The URL the room opens/embeds. Prefer a resolved official source (media or
    // the resolver's official reference — e.g. a committee page that embeds the
    // YouTube player); fall back to the saved sourceUrl. Never show the original
    // Congress listing alongside a second obscure link.
    const resolvedMediaUrl =
      resolution.status === 'resolved' &&
      resolution.referenceUrl &&
      isMediaUrl(resolution.referenceUrl)
        ? resolution.referenceUrl
        : undefined;
    const resolvedPageUrl =
      resolution.referenceUrl && !isMediaUrl(resolution.referenceUrl)
        ? resolution.referenceUrl
        : undefined;
    const effectiveEmbeddableUrl = embeddableUrl ?? resolvedMediaUrl;
    // A resolved official PAGE (committee/player page) becomes the reference the
    // room opens — it may itself be a known YouTube player page.
    const effectiveReferenceUrl = resolvedPageUrl ?? referenceUrl;
    const effectiveYoutubeId = effectiveReferenceUrl
      ? extractYouTubeVideoId(effectiveReferenceUrl)
      : null;

    const sessionEnded =
      phase === 'ended' || session.data?.status === 'ended' || session.data?.status === 'failed';
    const captureActive = ['requesting_share', 'preparing', 'capturing', 'stopping'].includes(
      phase,
    );
    const wakeLock = useHearingWakeLock(captureActive);
    const summary = useQuery<{ cards?: Card_[] }>({
      queryKey: ['intel', 'hearing', id, 'summary', apiScope],
      queryFn: async () =>
        (
          await api.get<{ cards?: Card_[] }>(
            `/intel-api/hearings/${encodeURIComponent(id)}/summary`,
          )
        ).data,
      // Tenant summary is private to browser-capture sessions; public reviews
      // have canonical insights instead of tenant cards.
      enabled: enabled && Boolean(id) && !isPublicReview,
      retry: false,
      refetchInterval: captureActive || session.data?.status === 'live' ? 15_000 : false,
      refetchIntervalInBackground: true,
    });
    const cards = useMemo(() => {
      if (isPublicReview) {
        // Genuine canonical fields only: real id/type/title/summary plus the
        // evidence's own startMs. Findings without a timestamp stay (the views
        // already omit the jump control when startMs is undefined) — never
        // dropped, never given a guessed position.
        return (publicIntel.data ?? [])
          .map((item): Card_ => ({
            id: item.id,
            cardType: item.insightType,
            title: item.title,
            body: item.summary,
            startMs: item.startMs,
            segmentId: item.segmentId,
          }))
          .sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
      }
      const merged = new Map<string, Card_>();
      for (const card of [...(summary.data?.cards ?? []), ...liveCards]) {
        const key = card.id || `${card.cardType}:${card.startMs}:${card.title}`;
        merged.set(key, { ...card, id: key });
      }
      return [...merged.values()].sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
    }, [isPublicReview, publicIntel.data, summary.data, liveCards]);
    const refreshPersisted = useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: ['intel', 'hearing', id] });
    }, [queryClient, id]);

    // Reopened sessions and a refreshed first page may expose additional history.
    // Drain it automatically so a four-hour room never stops at 500 segments.
    // The public review path already drains internally via usePublicHearingTranscript.
    useEffect(() => {
      if (
        !isPublicReview &&
        transcript.hasNextPage &&
        !transcript.isFetchingNextPage &&
        !transcript.isError
      ) {
        void transcript.fetchNextPage();
      }
    }, [
      isPublicReview,
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
    }, [
      cleanupCaptureTracks,
      disconnectSocket,
      setPhaseNow,
      stopRecorderAndFlush,
      refreshPersisted,
    ]);

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
      // reference-only, in which case the analyst opened it in another tab. A
      // resolved official media URL upgrades a listing page to a this-tab source.
      const capturesThisTab = Boolean(effectiveEmbeddableUrl || effectiveYoutubeId);
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
        if (
          phaseAfterPicker !== 'requesting_share' ||
          wsRef.current?.readyState !== WebSocket.OPEN
        ) {
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
        const recorder = new MediaRecorder(new MediaStream(audioTracks), {
          mimeType: RECORDER_MIME,
        });
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
      effectiveEmbeddableUrl,
      effectiveYoutubeId,
      endSession,
      session.data?.recordingPolicy,
      setPhaseNow,
    ]);

    useEffect(() => {
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (
          !['requesting_share', 'preparing', 'capturing', 'stopping'].includes(phaseRef.current)
        ) {
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
      navigate(
        presentation === 'vnext' ? '/legiwatch?tab=hearings' : '/intelligence/hearing-watch',
      );
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

    // One playback surface per room, shared by both presentations. Public review
    // sessions play the canonical server capture through the SAME public player
    // the hearing detail page uses — never the tenant-private browser recorder.
    // The key carries the canonical capture id so a source/capture reassignment
    // remounts the player instead of replaying the previous capture's state.
    const recordingPanelNode = isPublicReview ? (
      <PublicHearingAudioPanel
        key={`public-audio:${apiScope}:${session.data?.hearingId ?? ''}:${session.data?.publicCaptureId ?? ''}`}
        hearingId={session.data?.hearingId ?? ''}
        seek={
          evidenceTime ? { positionMs: evidenceTime.ms, request: evidenceTime.revision } : undefined
        }
      />
    ) : recordingEnabled || session.data?.recordingPolicy === 'audio_and_transcript' ? (
      <HearingRecordingPanel
        key={`recording:${apiScope}:${id}`}
        sessionId={id}
        live={captureActive}
        canEnable={!captureActive && !session.data?.startedAt}
        evidenceTime={evidenceTime}
        onProgress={onRecordingProgress}
      />
    ) : null;

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
          playEvidence={playEvidenceAt}
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
              if (isPublicReview) void publicIntelRaw.refetch();
              refreshPersisted();
            },
            phase,
            captureActive,
            sessionEnded,
            segments,
            interim,
            cards,
            transcriptLoading,
            transcriptError,
            transcriptionDelayed,
            intelligenceError: isPublicReview ? publicIntel.isError : summary.isError,
            intelligenceProcessing:
              isPublicReview &&
              (publicIntel.isLoading ||
                publicIntel.data?.status === 'PROCESSING' ||
                (publicIntel.data?.jobs?.public?.pending ?? 0) > 0),
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
            recordingPanel: recordingPanelNode,
            publicationsPanel,
            playEvidence: playEvidenceAt,
            sourcePlayer: effectiveEmbeddableUrl ? (
              <MediaPlayer src={effectiveEmbeddableUrl} />
            ) : effectiveYoutubeId ? (
              <iframe
                src={`https://www.youtube.com/embed/${effectiveYoutubeId}`}
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
            detailPath: session.data?.hearingId
              ? `/legiwatch/hearings/${encodeURIComponent(session.data.hearingId)}`
              : null,
            openSourceUrl:
              effectiveEmbeddableUrl ?? effectiveReferenceUrl ?? session.data?.sourceUrl ?? null,
            serverAttendance: session.data?.hearingId
              ? {
                  // This tenant may add its own server demand even while a
                  // canonical capture is active (backend joins the shared
                  // recorder) — only the caller's own existing schedule hides it.
                  available: automaticAvailable && !attendanceData?.scheduled,
                  scheduled: serverScheduled,
                  callerScheduled: Boolean(attendanceData?.scheduled),
                  lifecycle: serverLifecycle,
                  stateLabel: attendanceData?.state,
                  message: attendanceData?.message,
                  pending: requestAttendance.isPending,
                  error: serverError,
                  confirm: serverConfirm,
                  onSchedule: onScheduleServer,
                }
              : undefined,
            sourceResolution:
              needsResolution && resolution.status !== 'idle'
                ? {
                    status: resolution.status,
                    note: resolution.note,
                    referenceUrl: resolution.referenceUrl,
                    candidates: resolution.candidates,
                    onRetry: () => attemptResolve(),
                    onSelectCandidate: (pageUrl: string) => attemptResolve(pageUrl),
                  }
                : undefined,
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
              Choose the browser tab playing the hearing and enable Share tab audio. Chrome or Edge
              is required.
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

        {recordingPanelNode}
        {publicationsPanel}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
            gap: 16,
          }}
        >
          <Card title="Transcript" size="small" style={{ minHeight: 420 }}>
            {transcriptError && (
              <Alert type="warning" message="Saved transcript could not be refreshed." />
            )}
            {transcriptLoading && segments.length === 0 ? (
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
                  isPublicReview || session.data?.recordingPolicy === 'audio_and_transcript'
                    ? playEvidenceAt
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
            {(isPublicReview ? publicIntel.isError : summary.isError) && (
              <Alert type="warning" message="Saved intelligence could not be refreshed." />
            )}
            {cards.length === 0 ? (
              <Empty
                description={
                  isPublicReview &&
                  (publicIntel.isLoading ||
                    publicIntel.data?.status === 'PROCESSING' ||
                    (publicIntel.data?.jobs?.public?.pending ?? 0) > 0)
                    ? 'Public intelligence is still being extracted from the canonical transcript.'
                    : 'Relevant moments will appear here.'
                }
              />
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
    const { message } = useNotifications();
    const gen = useGenerateBrief();
    const save = useSaveRecap();
    // vNext mounts NO antd App provider, so useNotifications().message is `{}` there;
    // calling message.success would throw and prevent the dialog from closing.
    // Use the native vNext toast when antd message is absent; antd where present.
    const capiroToast = useCapiroToast();
    const notify = useMemo(() => {
      const antdUsable =
        message && typeof (message as { success?: unknown }).success === 'function';
      return {
        success: (text: string) => (antdUsable ? message.success(text) : capiroToast.success(text)),
        error: (text: string) => (antdUsable ? message.error(text) : capiroToast.error(text)),
      };
    }, [message, capiroToast]);
    const [brief, setBrief] = useState<HearingBrief | null>(null);
    // Why there is no preview: nothing transcribed yet (null from the API) vs
    // Meri's synthesis being unavailable / failing (request error). They are
    // different problems with different next steps, so they are not merged.
    const [failure, setFailure] = useState<'none' | 'no-transcript' | 'generation'>('none');
    // A reused/kept-existing outcome surfaces inline (honest) instead of a green
    // success — the vNext toast has no warning variant and a "saved" toast would lie.
    const [keptExisting, setKeptExisting] = useState(false);
    const [clientId, setClientId] = useState(defaultClientId ?? '');
    // The recap this client already filed for THIS session, if any — drives the
    // explicit "Update existing recap" affordance (the save endpoint otherwise
    // silently reuses the old document).
    const existingRecap = useCurrentHearingRecap(clientId, sessionId);

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
        setFailure('none');
        setKeptExisting(false);
        mutateRef.current(
          { sessionId, clientId: forClientId },
          {
            onSuccess: (value) => {
              if (requestRef.current !== requestId) return;
              if (value) {
                setBrief(value);
                setFailure('none');
              } else {
                // API returned null: no transcribed content to summarize.
                setFailure('no-transcript');
              }
            },
            onError: () => {
              if (requestRef.current !== requestId) return;
              setFailure('generation');
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
        setFailure('none');
        return;
      }
      generate(clientId);
    }, [sessionId, clientId, generate]);

    const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
    const generating = Boolean(clientId) && !brief && failure === 'none';
    const synthesized = brief?.synthesisSource === 'orchestrator';
    const clientContext = brief?.clientContext;
    const matchedBand =
      clientContext?.relevanceBand &&
      ['HIGH', 'MEDIUM', 'LOW'].includes(clientContext.relevanceBand)
        ? clientContext.relevanceBand
        : null;
    // Replacement is exact-id only. Until we KNOW whether this client already has
    // a recap for THIS session, Save stays gated: saving blind could either
    // silently reuse a stale document (no replaceAttachmentId) or 404 on a
    // guessed id. Loading OR lookup-error both keep it gated.
    const recapLookupBusy = Boolean(clientId) && (existingRecap.isLoading || existingRecap.isError);
    const currentRecap = existingRecap.data ?? null;
    const onSave = () => {
      // Never file a deterministic (Meri-unavailable) assembly as if it were a
      // synthesized recap — the Save control is hidden in that case, this is the
      // belt-and-suspenders guard. And never save while the current-recap lookup
      // is unresolved (would risk a silent stale-reuse).
      if (!brief || !clientId || brief.synthesisSource !== 'orchestrator' || recapLookupBusy)
        return;
      // Prefer the model's concise report title for the filed document; fall back
      // to the session title. (The full formal title is kept inside the document
      // as provenance, not duplicated as the file name.)
      const docTitle = brief.summaryTitle?.trim() || `Hearing recap — ${sessionTitle}`;
      save.mutate(
        {
          sessionId,
          clientId,
          title: docTitle,
          markdown: briefToMarkdown(brief),
          // Explicitly name the exact current recap to replace it; omitting it
          // makes the server silently reuse the old document.
          ...(currentRecap ? { replaceAttachmentId: currentRecap.id } : {}),
        },
        {
          onSuccess: (result) => {
            // Trust the server's own account of what it did, not our expectation.
            // `reused` means the existing document was KEPT (nothing new written).
            // That is NOT a success — surface it inline (honest) and stay open so
            // the analyst can choose Update; a green "saved" toast would lie.
            if (result?.reused) {
              setKeptExisting(true);
              return;
            }
            notify.success(
              currentRecap
                ? `Recap updated — saved to ${clientName}'s Documents and available to Meri`
                : `Recap saved to ${clientName}'s Documents and available to Meri`,
            );
            onClose();
          },
          onError: (e: unknown) => {
            const detail = (e as { response?: { data?: { message?: string | string[] } } })
              ?.response?.data?.message;
            const text = Array.isArray(detail)
              ? detail.join('; ')
              : (detail ?? (e as Error).message);
            // The current recap changed between lookup and save (concurrent edit):
            // surface it plainly rather than a bare 404.
            const changed = /current hearing recap not found/i.test(String(text));
            notify.error(
              changed
                ? 'The existing recap changed while you were reviewing. Reopen Save Recap to see the current version.'
                : `Could not save recap: ${text}`,
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
          // No Save affordance for a deterministic (Meri-unavailable) assembly:
          // it is not a synthesized recap and must not be filed as one.
          ...(synthesized
            ? [
                <Button
                  key="save"
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={save.isPending}
                  disabled={!brief || !clientId || recapLookupBusy}
                  onClick={onSave}
                >
                  {currentRecap ? 'Update existing recap' : 'Save to Client Profile'}
                </Button>,
              ]
            : []),
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
        {clientId && existingRecap.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message="Could not check for an existing recap"
            description="Saving is paused until we know whether this client already has a recap for this session — otherwise we could overwrite or keep the wrong document."
            action={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => existingRecap.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : null}
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
        ) : failure === 'no-transcript' ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="No transcript yet"
              description="This session has no transcribed content to summarize. Capture or import the hearing transcript, then generate the recap."
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => generate(clientId)}>
              Try again
            </Button>
          </Space>
        ) : failure === 'generation' ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="Recap generation failed"
              description="Meri's synthesis was unavailable or returned something unusable. Nothing was assembled from the transcript as a substitute. You can retry."
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => generate(clientId)}>
              Try again
            </Button>
          </Space>
        ) : (
          <div>
            {keptExisting && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message="The existing recap for this session was kept"
                description="No new document was written. Use Update existing recap to replace it with this version, or Cancel to leave it as is."
              />
            )}
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
                message="Transcript-based recap — Meri synthesis unavailable"
                description="Assembled from the transcript, not analysed. It cannot be saved as a synthesized recap — regenerate to retry Meri."
              />
            )}
            <HearingRecapPreview markdown={briefToMarkdown(brief!)} />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              {currentRecap
                ? `Updating replaces ${clientName || 'this client'}'s existing recap for this session — saved to the client's Documents and available to Meri.`
                : `Saved to ${clientName || 'this client'}'s Documents and available to Meri.`}
            </Text>
          </div>
        )}
      </Modal>
    );
  }

  return { LiveHearingRoomPage, TranscriptList, SaveRecapModal };
}
