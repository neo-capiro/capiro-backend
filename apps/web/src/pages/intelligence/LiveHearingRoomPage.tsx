import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import {
  App as AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Tag,
  Typography,
} from 'antd';
import { ArrowLeftOutlined, AudioOutlined } from '@ant-design/icons';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import { useConfirmConsent, useHearingSession } from '../../lib/hearing-watch-api.js';

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

function wsUrl(sessionId: string, token: string): string {
  // Gateway listens at /intel-api/live and reads sessionId + token from the query
  // string (WS can't set Authorization). ALB routes /intel-api/* and upgrades WS.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/intel-api/live?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

export function LiveHearingRoomPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const { id = '' } = useParams();
  const { getToken } = useAuth();
  const { message } = AntApp.useApp();
  const confirmConsent = useConfirmConsent();

  const session = useHearingSession(id);
  const [connected, setConnected] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState<string>('');
  const [cards, setCards] = useState<Card_[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Human-readable progress from the server's `status` frames (connecting,
  // ingesting, transcribing, reconnecting, ended). Without surfacing these the
  // room looked identical whether ingestion was working, still starting, or had
  // failed — the "nothing happens" report.
  const [statusText, setStatusText] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioUrlRef = useRef('');
  const ingestSentRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Keep a ref of the current URL so the WS message handler (created once per
  // connect) always sends the latest value.
  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  // Pre-fill the ingestion URL from the session's stored stream URL (set at
  // "New Hearing"), unless the user has already typed one.
  useEffect(() => {
    const u = session.data?.sourceUrl;
    if (u && !audioUrl) setAudioUrl(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data?.sourceUrl]);

  const connect = useCallback(async () => {
    const token = await getToken({ template: 'capiro' });
    if (!token) {
      setError('Not authenticated');
      return;
    }
    ingestSentRef.current = false;
    const ws = new WebSocket(wsUrl(id, token));
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setStatusText('Connected — starting transcription…');
    };
    ws.onclose = () => {
      setConnected(false);
      setStatusText(null);
    };
    ws.onerror = () => setError('WebSocket connection error');

    // Map the server's free-form `status` frames to a readable line. The
    // 'connected' case also auto-starts ingestion when a URL is present.
    const handleStatus = (s: string) => {
      if (s === 'connected') {
        setStatusText('Connected — starting transcription…');
        // Auto-start ingestion when a stream URL is present (from the session or
        // the field), so the user doesn't have to paste + click. Small delay: the
        // server registers its message handler just after sending 'connected'.
        if (audioUrlRef.current.trim() && !ingestSentRef.current) {
          ingestSentRef.current = true;
          setStatusText('Starting ingestion…');
          setTimeout(() => {
            const w = wsRef.current;
            if (w && w.readyState === WebSocket.OPEN) {
              w.send(JSON.stringify({ type: 'ingest', audioUrl: audioUrlRef.current.trim() }));
            }
          }, 1200);
        }
      } else if (s === 'ingesting') setStatusText('Ingesting the stream…');
      else if (s === 'transcribing') setStatusText('Listening for audio…');
      else if (s.startsWith('reconnecting')) setStatusText('Reconnecting to transcription…');
      else if (s === 'max_duration_reached')
        setStatusText('Session reached the maximum duration and was stopped.');
      else if (s.startsWith('ingestion_ended')) {
        const reason = s.slice('ingestion_ended:'.length).trim();
        setStatusText(reason ? `Stream ended: ${reason}` : 'Stream ended.');
      } else if (s) setStatusText(s);
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
  }, [getToken, id]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  const startIngest = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Connect first, then start ingestion.');
      return;
    }
    if (!audioUrl.trim()) {
      setError('Enter a hearing audio/stream URL.');
      return;
    }
    // Acknowledge the click immediately — the server's first status frame can be
    // a second or two out, and previously nothing changed on screen until then.
    setError(null);
    setStatusText('Starting ingestion…');
    ws.send(JSON.stringify({ type: 'ingest', audioUrl: audioUrl.trim() }));
    ingestSentRef.current = true;
  }, [audioUrl]);

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
      <div style={{ padding: 24 }}>
        <Empty description="Hearing Watch is not enabled for this workspace." />
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
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
              setConnected(false);
              setStatusText(null);
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

      <Space.Compact style={{ display: 'flex', marginBottom: 12, maxWidth: 720 }}>
        <Input
          placeholder="Hearing audio/stream URL (HLS .m3u8, MP3/AAC, or any ffmpeg-openable URL)"
          value={audioUrl}
          onChange={(e) => setAudioUrl(e.target.value)}
          onPressEnter={startIngest}
        />
        <Button type="primary" onClick={startIngest} disabled={!connected}>
          Start ingestion
        </Button>
      </Space.Compact>

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
    </div>
  );
}

export default LiveHearingRoomPage;
