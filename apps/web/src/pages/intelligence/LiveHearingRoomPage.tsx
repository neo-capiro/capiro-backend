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
import { useConfirmConsent } from '../../lib/hearing-watch-api.js';

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

  const [connected, setConnected] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [interim, setInterim] = useState<string>('');
  const [cards, setCards] = useState<Card_[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const connect = useCallback(async () => {
    const token = await getToken({ template: 'capiro' });
    if (!token) {
      setError('Not authenticated');
      return;
    }
    const ws = new WebSocket(wsUrl(id, token));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setError('WebSocket connection error');
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'interim') setInterim(msg.segment?.text ?? '');
        else if (msg.type === 'final') {
          setInterim('');
          if (msg.segment) setSegments((s) => [...s, msg.segment]);
        } else if (msg.type === 'card' && msg.card) setCards((c) => [msg.card, ...c]);
        else if (msg.type === 'error') setError(msg.message ?? 'stream error');
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
    ws.send(JSON.stringify({ type: 'ingest', audioUrl: audioUrl.trim() }));
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
        <Card title="Transcript" size="small" style={{ minHeight: 420 }}>
          {segments.length === 0 && !interim ? (
            <Empty description="No transcript yet. Connect to begin." />
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
