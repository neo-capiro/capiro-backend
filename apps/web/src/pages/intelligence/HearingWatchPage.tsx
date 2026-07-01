import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Empty, List, Segmented, Spin, Tag, Typography } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../lib/intel-feature-flags.js';

const { Title, Text, Paragraph } = Typography;

interface LiveHearingSession {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  startedAt?: string | null;
  clientId?: string | null;
}

interface Watchlist {
  id: string;
  name: string;
  clientId: string;
  active: boolean;
  terms: Array<{ id: string; termType: string; value: string }>;
}

/**
 * Hearing Watch — the Intelligence subtab. Lists live/finished hearing sessions
 * and the client watchlists driving relevance. Gated to tenants with the
 * `hearing_watch` flag; the nav item is hidden otherwise, and this page also
 * guards directly so a deep-link 404s gracefully for non-enabled tenants.
 *
 * Data comes from intel-api (`/intel-api/hearings`, `/intel-api/watchlists`).
 * Until intel-api is routed through the ALB those calls fail; the page shows an
 * empty state rather than erroring.
 */
export function HearingWatchPage() {
  const api = useApi();
  const enabled = useIntelFeatureEnabled('hearing_watch');
  const [view, setView] = useState<'sessions' | 'watchlists'>('sessions');

  const sessions = useQuery<LiveHearingSession[]>({
    queryKey: ['intel', 'hearings'],
    queryFn: async () => {
      try {
        return (await api.get<LiveHearingSession[]>('/intel-api/hearings')).data;
      } catch {
        return [];
      }
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const watchlists = useQuery<Watchlist[]>({
    queryKey: ['intel', 'watchlists'],
    queryFn: async () => {
      try {
        return (await api.get<Watchlist[]>('/intel-api/watchlists')).data;
      } catch {
        return [];
      }
    },
    enabled,
    retry: false,
    staleTime: 30_000,
  });

  const statusColor = useMemo(
    () =>
      ({ live: 'red', scheduled: 'blue', paused: 'orange', ended: 'green', failed: 'default' }) as Record<
        string,
        string
      >,
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
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <Title level={3} style={{ marginBottom: 4 }}>
        Hearing Watch
      </Title>
      <Paragraph type="secondary" style={{ marginTop: 0 }}>
        Client-ready intelligence from public hearings — live transcription, relevant moments,
        and post-hearing briefs.
      </Paragraph>

      <Segmented
        value={view}
        onChange={(v) => setView(v as 'sessions' | 'watchlists')}
        options={[
          { label: 'Hearings', value: 'sessions' },
          { label: 'Watchlists', value: 'watchlists' },
        ]}
        style={{ marginBottom: 16 }}
      />

      {view === 'sessions' ? (
        <Card title="Hearing sessions" size="small">
          {sessions.isLoading ? (
            <Spin />
          ) : sessions.data && sessions.data.length > 0 ? (
            <List
              dataSource={sessions.data}
              renderItem={(s) => (
                <List.Item
                  actions={[<Tag key="status" color={statusColor[s.status] ?? 'default'}>{s.status}</Tag>]}
                >
                  <List.Item.Meta
                    title={s.title}
                    description={
                      <Text type="secondary">
                        {s.sourceType}
                        {s.startedAt ? ` · ${new Date(s.startedAt).toLocaleString()}` : ''}
                      </Text>
                    }
                  />
                </List.Item>
              )}
            />
          ) : (
            <Empty description="No hearing sessions yet. Start one from a hearing to capture live intelligence." />
          )}
        </Card>
      ) : (
        <Card title="Client watchlists" size="small">
          {watchlists.isLoading ? (
            <Spin />
          ) : watchlists.data && watchlists.data.length > 0 ? (
            <List
              dataSource={watchlists.data}
              renderItem={(wl) => (
                <List.Item actions={[wl.active ? <Tag key="a" color="green">active</Tag> : <Tag key="a">paused</Tag>]}>
                  <List.Item.Meta
                    title={wl.name}
                    description={
                      <span>
                        {wl.terms.slice(0, 8).map((t) => (
                          <Tag key={t.id}>{t.value}</Tag>
                        ))}
                        {wl.terms.length > 8 ? <Text type="secondary">+{wl.terms.length - 8} more</Text> : null}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          ) : (
            <Empty description="No watchlists yet. Add client terms (bills, agencies, topics, risk phrases) to drive relevance." />
          )}
        </Card>
      )}
    </div>
  );
}

export default HearingWatchPage;
