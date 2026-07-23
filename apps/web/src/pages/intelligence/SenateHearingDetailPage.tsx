import { Link, useParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, Empty, Space, Spin, Typography } from 'antd';
import { ArrowLeftOutlined, AudioOutlined } from '@ant-design/icons';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';
import '../radar/legiwatch.css';
import {
  isSenateHearingOnAir,
  useSenateHearing,
  type SenateHearingStatus,
} from '../../lib/senate-hearings-api.js';

const { Title, Text, Paragraph } = Typography;

const STATUS_LABEL: Record<SenateHearingStatus, string> = {
  discovered: 'Discovered — not yet probed',
  pending: 'Scheduled — stream not live yet',
  live: 'Live — capture starting',
  capturing: 'Capturing live',
  ended: 'Capture ended',
  failed: 'Capture failed',
  skipped: 'Skipped (postponed/cancelled or no-show)',
};

function formatFull(v: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
}

/**
 * Read-only detail view for one auto-captured Senate proceeding — the
 * capture's metadata plus its full transcript. Unlike LiveHearingRoomPage
 * (the manual flow's room), there is no WebSocket here: this corpus has no
 * push channel, so the transcript is a plain poll (see useSenateHearing) that
 * stops once the capture reaches a terminal status.
 */
export function SenateHearingDetailPage() {
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const { id = '' } = useParams();
  const hearing = useSenateHearing(id);

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

  const data = hearing.data;

  return (
    <div
      className="lw-root redesign"
      style={{ padding: '22px 32px 80px', background: 'var(--bg-canvas)', minHeight: '100%' }}
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Link to="/legiwatch?tab=hearings">
          <Button icon={<ArrowLeftOutlined />} size="small">
            Back
          </Button>
        </Link>
        <Title level={4} style={{ margin: 0 }}>
          <AudioOutlined /> {data?.title ?? data?.hearingKey ?? 'Senate hearing'}
        </Title>
        {data ? (
          <Badge
            status={isSenateHearingOnAir(data.status) ? 'processing' : 'default'}
            text={STATUS_LABEL[data.status] ?? data.status}
          />
        ) : null}
      </Space>

      {hearing.isLoading ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Spin />
        </div>
      ) : !data ? (
        <Alert
          type="error"
          showIcon
          message="Hearing not found"
          description="This Senate hearing capture doesn't exist, or hasn't been discovered yet."
        />
      ) : (
        <>
          <div
            className="card"
            style={{ padding: '10px 14px', marginBottom: 12, display: 'flex', gap: 20, flexWrap: 'wrap' }}
          >
            <span className="mini muted">
              Committee: <b>{data.committeeName ?? '—'}</b>
            </span>
            <span className="mini muted">
              Type: <b>{data.hearingType ?? '—'}</b>
            </span>
            <span className="mini muted">
              Scheduled: <b>{formatFull(data.scheduledAt)}</b>
            </span>
            <span className="mini muted">
              Started: <b>{formatFull(data.startedAt)}</b>
            </span>
            <span className="mini muted">
              Ended: <b>{formatFull(data.endedAt)}</b>
            </span>
          </div>

          <Card title="Transcript" size="small">
            {data.segments.length === 0 ? (
              <Empty
                description={
                  data.status === 'failed'
                    ? 'Capture failed — no transcript was produced.'
                    : isSenateHearingOnAir(data.status)
                      ? 'Capturing — the transcript will appear here as it comes in.'
                      : 'No transcript for this proceeding.'
                }
              />
            ) : (
              <div style={{ maxHeight: 640, overflowY: 'auto' }}>
                {data.segments.map((s, i) => (
                  <Paragraph key={i} style={{ marginBottom: 8 }}>
                    {s.speakerLabel && <Text strong>{s.speakerLabel}: </Text>}
                    <Text>{s.text}</Text>{' '}
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      [{Math.floor(s.startMs / 1000)}s]
                    </Text>
                  </Paragraph>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default SenateHearingDetailPage;
