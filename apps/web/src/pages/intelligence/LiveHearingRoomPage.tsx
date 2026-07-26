import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
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
import {
  briefToMarkdown,
  isMediaUrl,
  useConfirmConsent,
  useGenerateBrief,
  useHearingSession,
  useSaveRecap,
  type HearingBrief,
  mintWsTicket,
} from '../../lib/hearing-watch-api.js';

const { Title, Text, Paragraph } = Typography;

interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
}
interface Card_ {
  id: string;
  cardType: string;
  title: string;
  body?: string;
  startMs?: number;
}

/** youtube.com/watch?v=, youtube.com/live/, youtube.com/embed/, or youtu.be/
 *  short links — anything else returns null (not embeddable via this path).
 *  Parses the URL properly rather than pattern-matching the raw string: a
 *  watch URL shared from a playlist commonly has `list=` before `v=`
 *  (`?list=PL...&v=ID`), which a "watch?v=" prefix match would miss. */
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{6,}$/;

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
 *  everywhere else (same library-free-until-needed approach as the rest of
 *  this app). Unmuted, no autoplay: this IS the audio source for
 *  transcription now (there is no server-side ingestion), so the analyst
 *  presses play, then shares THIS TAB's audio via "Start transcription"
 *  below — autoplay-with-sound is browser-blocked without a user gesture
 *  anyway, and the native play button doubles as that gesture.
 *
 *  A browser's own fetch of this URL is CORS-gated even though a raw server
 *  pull isn't — government/committee CDNs commonly lack permissive CORS for
 *  playback. Surface that as a clear message rather than a silently-black
 *  video box. */
function HlsVideoPlayer({ src }: { src: string }) {
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
    return () => {
      hls?.destroy();
    };
  }, [src]);

  if (unavailable) {
    return (
      <div
        style={{
          padding: '32px 16px',
          textAlign: 'center',
          background: '#000',
          borderRadius: 8,
          color: 'rgba(255,255,255,0.65)',
          fontSize: 12,
        }}
      >
        Video preview unavailable for this stream — open the source link below instead.
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      onError={() => setUnavailable(true)}
      style={{ width: '100%', maxHeight: 320, background: '#000', borderRadius: 8, display: 'block' }}
    />
  );
}

function wsUrl(sessionId: string, ticket: string): string {
  // Gateway listens at /intel-api/live. A WebSocket cannot set an Authorization
  // header, so the browser presents a SINGLE-USE, 60-second ticket minted over
  // authenticated HTTPS (POST /intel-api/hearings/:id/ws-ticket) instead of the
  // Clerk JWT. Query strings end up in ALB access logs, proxies and browser
  // history — a ticket that dies on first use is safe there; a session token
  // valid for the whole socket lifetime was not.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/intel-api/live?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`;
}

export function LiveHearingRoomPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const { id = '' } = useParams();
  const { message } = AntApp.useApp();
  const confirmConsent = useConfirmConsent();

  const session = useHearingSession(id);
  const api = useApi();
  // Clients (id→name) to resolve the recap's target client + label the picker.
  const clientsQuery = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Array<{ id: string; name: string }>>('/api/clients')).data,
    staleTime: 60_000,
  });
  // Post-session (L6): once the session has ended (server status or a local Stop),
  // surface "Save recap" → files a client Document + indexes into Meri's knowledge.
  const [stopped, setStopped] = useState(false);
  const [recapOpen, setRecapOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState<string>('');
  const [cards, setCards] = useState<Card_[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Human-readable progress from the server's `status` frames (connecting,
  // transcribing, reconnecting, ended). Without surfacing these the room
  // looked identical whether transcription was working, still starting, or
  // had failed — the "nothing happens" report.
  const [statusText, setStatusText] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // A non-media sourceUrl is a reference (event page / C-SPAN search / YouTube
  // watch page) carried over from hearing creation — the source to embed or
  // open in a tab so the analyst can share its audio.
  const referenceUrl =
    session.data?.sourceUrl && !isMediaUrl(session.data.sourceUrl)
      ? session.data.sourceUrl
      : undefined;
  // A directly-embeddable media URL (HLS/MP4/audio) — played right here via
  // HlsVideoPlayer instead of needing a separate tab. There is no server-side
  // ingestion of this anymore: it's just the audio source for "Start
  // transcription" below, same as the YouTube-embed and open-in-tab cases.
  const embeddableUrl =
    session.data?.sourceUrl && isMediaUrl(session.data.sourceUrl)
      ? session.data.sourceUrl
      : undefined;
  const youtubeVideoId = referenceUrl ? extractYouTubeVideoId(referenceUrl) : null;

  const connect = useCallback(async () => {
    let ticket: string;
    try {
      ticket = (await mintWsTicket(api, id)).ticket;
    } catch {
      setError('Not authenticated');
      return;
    }
    const ws = new WebSocket(wsUrl(id, ticket));
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setStatusText('Connected — starting transcription…');
    };
    ws.onclose = () => {
      setConnected(false);
      setStatusText(null);
      // A drop for any reason (max-duration cutoff, network blip, auth expiry)
      // must tear down browser capture too — otherwise a running MediaRecorder
      // keeps sending chunks (silently dropped since wsRef is now closed) and
      // the browser's "sharing this tab" indicator stays on. Without this, a
      // stale recorder from a dead connection would also start bleeding into
      // whatever WS a subsequent reconnect creates.
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      displayStreamRef.current?.getTracks().forEach((t) => t.stop());
      displayStreamRef.current = null;
      setCapturing(false);
    };
    ws.onerror = () => setError('WebSocket connection error');

    // Map the server's free-form `status` frames to a readable line.
    const handleStatus = (s: string) => {
      if (s === 'connected') setStatusText('Connected — starting transcription…');
      else if (s === 'transcribing') setStatusText('Listening for audio…');
      else if (s.startsWith('reconnecting')) setStatusText('Reconnecting to transcription…');
      else if (s === 'max_duration_reached')
        setStatusText('Session reached the maximum duration and was stopped.');
      else if (s) setStatusText(s);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'interim') setInterim(msg.segment?.text ?? '');
        else if (msg.type === 'final') {
          setInterim('');
          if (msg.segment) setSegments((s) => [...s, msg.segment]);
        } else if (msg.type === 'card' && msg.card) setCards((c) => [msg.card, ...c]);
        else if (msg.type === 'error') {
          // A hard failure (e.g. ffmpeg couldn't open the stream). Show it and
          // clear the transient status so the room doesn't look stuck "starting".
          setError(msg.message ?? 'stream error');
          setStatusText(null);
        } else if (msg.type === 'status') {
          handleStatus(String(msg.status ?? ''));
        }
      } catch {
        /* ignore malformed frame */
      }
    };
  }, [api, id]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      mediaRecorderRef.current?.stop();
      displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /** Stop an in-progress browser-audio capture (recorder + shared-tab tracks). */
  const stopBrowserCapture = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    setCapturing(false);
  }, []);

  /**
   * Chamber-agnostic capture path: the analyst opens/plays the hearing (the
   * embed above, or a separate tab for anything that can't be embedded),
   * picks that tab here with "Share tab audio" checked, and MediaRecorder
   * streams opus chunks over the WS's default Deepgram connection. This
   * captures audio already being rendered on the analyst's own machine; it
   * never touches the source platform's servers, and there is no server-side
   * stream ingestion — this is the only transcription path now.
   */
  const startBrowserCapture = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Connect first, then capture browser audio.');
      return;
    }
    if (!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      setError('This browser cannot record opus audio — try Chrome or Edge.');
      return;
    }
    try {
      // video:true is required by the browser to offer a "Tab" source with a
      // "Share tab audio" checkbox; the video track is discarded immediately.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      // Re-check live state: the browser's picker can sit open for a while,
      // and a disconnect may have happened while we waited on the user.
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        display.getTracks().forEach((t) => t.stop());
        setError('Connection state changed while waiting for the capture picker — try again.');
        return;
      }
      const audioTracks = display.getAudioTracks();
      if (audioTracks.length === 0) {
        display.getTracks().forEach((t) => t.stop());
        setError(
          'No audio was shared — when picking the tab/window, check "Share tab audio" (or "Share system audio").',
        );
        return;
      }
      display.getVideoTracks().forEach((t) => t.stop());
      displayStreamRef.current = display;
      const recorder = new MediaRecorder(new MediaStream(audioTracks), {
        mimeType: 'audio/webm;codecs=opus',
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        void e.data.arrayBuffer().then((buf) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(buf);
        });
      };
      // The browser's own "Stop sharing" control ends the track directly.
      audioTracks[0]?.addEventListener('ended', stopBrowserCapture);
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setCapturing(true);
      setError(null);
      setStatusText("Capturing this browser's audio…");
    } catch (err) {
      setError(`Could not start browser capture: ${(err as Error).message}`);
    }
  }, [stopBrowserCapture]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, interim]);

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
      <div
        className="lw-root redesign"
        style={{ padding: '22px 32px 80px', background: 'var(--bg-canvas)', minHeight: '100%' }}
      >
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
      <Space style={{ marginBottom: 12 }}>
        <Link to="/intelligence/hearing-watch">
          <Button icon={<ArrowLeftOutlined />} size="small">
            Back
          </Button>
        </Link>
        <Title level={4} style={{ margin: 0 }}>
          <AudioOutlined /> Live Hearing Room
        </Title>
        <Badge status={connected ? 'processing' : 'default'} text={connected ? 'Live' : 'Disconnected'} />
      </Space>

      {error && (
        <Alert type="error" showIcon closable message={error} style={{ marginBottom: 12 }} onClose={() => setError(null)} />
      )}

      <Space style={{ marginBottom: 12 }}>
        {!connected ? (
          <Button type="primary" onClick={connect}>
            Connect & start transcription
          </Button>
        ) : (
          <Button
            danger
            onClick={() => {
              wsRef.current?.close();
              stopBrowserCapture();
              setConnected(false);
              setStatusText(null);
              setStopped(true);
            }}
          >
            Stop
          </Button>
        )}
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
      </Space>

      {(stopped || session.data?.status === 'ended') && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Text type="secondary">Session ended — act on it:</Text>
          <Button type="primary" icon={<SaveOutlined />} onClick={() => setRecapOpen(true)}>
            Save recap
          </Button>
        </Space>
      )}

      {(embeddableUrl || referenceUrl) && (
        <Card size="small" title="Hearing video" style={{ marginBottom: 12, maxWidth: 720 }}>
          {embeddableUrl ? (
            <>
              <HlsVideoPlayer src={embeddableUrl} />
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                Press play above, connect (if you haven&apos;t already), then click{' '}
                <Text strong>&quot;Start transcription&quot;</Text> below and choose{' '}
                <Text strong>&quot;This tab&quot;</Text> when sharing — the video is right here, no
                need to switch tabs.
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
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    border: 0,
                    borderRadius: 8,
                  }}
                />
              </div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                Press play above, connect (if you haven&apos;t already), then click{' '}
                <Text strong>&quot;Start transcription&quot;</Text> below and choose{' '}
                <Text strong>&quot;This tab&quot;</Text> when sharing — the video is right here, no
                need to switch tabs.
              </Text>
            </>
          ) : (
            <>
              <Text type="secondary">This source can&apos;t be embedded here.</Text>{' '}
              <Button type="link" href={referenceUrl} target="_blank" rel="noreferrer" style={{ padding: 0 }}>
                Open hearing source in a new tab ↗
              </Button>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                Then come back, connect (if you haven&apos;t already), and click{' '}
                <Text strong>&quot;Start transcription&quot;</Text> below — pick that tab and check
                &quot;Share tab audio&quot;.
              </Text>
            </>
          )}
        </Card>
      )}

      <Space direction="vertical" size={2} style={{ marginBottom: 12 }}>
        <Space>
          {!referenceUrl && !embeddableUrl && (
            <Text type="secondary">Play the hearing in another tab, then:</Text>
          )}
          {!capturing ? (
            <Tooltip title={!connected ? 'Connect first.' : undefined}>
              <span>
                <Button type="primary" onClick={startBrowserCapture} disabled={!connected}>
                  Start transcription
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button danger onClick={stopBrowserCapture}>
              Stop transcription
            </Button>
          )}
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Share the tab playing the hearing (this one, or another) and check &quot;Share tab
          audio&quot;. Chrome/Edge only.
        </Text>
      </Space>

      {statusText && !error && (
        <div style={{ marginBottom: 12 }}>
          <Badge status="processing" text={statusText} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
        <Card title="Transcript" size="small" style={{ minHeight: 420 }}>
          {segments.length === 0 && !interim ? (
            <Empty
              description={
                error
                  ? 'Stream could not be transcribed — see the error above.'
                  : statusText ?? 'No transcript yet. Connect to begin.'
              }
            />
          ) : (
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
              {segments.map((s, i) => (
                <Paragraph key={i} style={{ marginBottom: 8 }}>
                  {s.speakerLabel && <Text strong>{s.speakerLabel}: </Text>}
                  <Text>{s.text}</Text>{' '}
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    [{Math.floor(s.startMs / 1000)}s]
                  </Text>
                </Paragraph>
              ))}
              {interim && (
                <Paragraph style={{ marginBottom: 8, opacity: 0.6 }}>
                  <Text italic>{interim}</Text>
                </Paragraph>
              )}
              <div ref={transcriptEndRef} />
            </div>
          )}
        </Card>

        <Card title="Intelligence cards" size="small" style={{ minHeight: 420 }}>
          {cards.length === 0 ? (
            <Empty description="Relevant moments will appear here." />
          ) : (
            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
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
 * a client's Documents (which auto-indexes into that client's Meri knowledge).
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
      onSuccess: (b) => (b ? setBrief(b) : setFailed(true)),
      onError: () => setFailed(true),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const clientName = clients.find((c) => c.id === clientId)?.name ?? '';
  const onSave = () => {
    if (!brief || !clientId) return;
    save.mutate(
      { clientId, clientName, title: `Hearing recap — ${sessionTitle}`, markdown: briefToMarkdown(brief) },
      {
        onSuccess: () => {
          message.success(`Recap saved to ${clientName}'s Documents and added to Meri's knowledge`);
          onClose();
        },
        onError: (e: unknown) => {
          const detail = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
            ?.message;
          message.error(
            `Could not save recap: ${
              Array.isArray(detail) ? detail.join('; ') : detail ?? (e as Error).message
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
          description="This session has no transcribed content to summarize. Connect and transcribe the hearing first."
        />
      ) : (
        <div>
          <div style={{ marginBottom: 4, fontSize: 12, color: 'var(--muted, #8a8a96)' }}>Save to client</div>
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
            Saving files this into the client&rsquo;s Documents and adds it to Meri&rsquo;s knowledge.
          </Text>
        </div>
      )}
    </Modal>
  );
}

export default LiveHearingRoomPage;
