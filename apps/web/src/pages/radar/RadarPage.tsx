import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Empty, Segmented, Select, Spin, Typography } from 'antd';
import {
  AimOutlined,
  AudioOutlined,
  BellOutlined,
  EyeOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { useIntelFeature } from '../../lib/intel-feature-flags.js';
import { TrackerSurface } from '../clients/tracker/TrackerTab.js';
import { TrackerFeedPanel } from '../clients/tracker/TrackerFeedPanel.js';
import { HearingWatchPanel } from '../intelligence/HearingWatchPage.js';
import type { Client } from '../clients/clientTypes.js';

const { Title, Paragraph, Text } = Typography;

type RadarTab = 'feed' | 'bills' | 'hearings' | 'watchlist';
const RADAR_TABS: readonly RadarTab[] = ['feed', 'bills', 'hearings', 'watchlist'];

/**
 * Radar (P4 shell) — one destination unifying the Bill Tracker and Hearing
 * Watch surfaces. Four tabs: Feed (default) · Bills · Hearings · Watchlist.
 *
 * Feed/Bills/Watchlist are per-client in v1 (the global roll-up is a later
 * phase) and reuse the client-profile Tracker components — same queries and
 * react-query keys, so Radar and the profile tab stay in sync. Hearings is the
 * global hearing schedule/session list and needs no client.
 *
 * URL state: /radar?tab=feed|bills|hearings|watchlist&client=<id>.
 * Gating matches the underlying surfaces: `tracker_v2` gates the Feed,
 * `hearing_watch` gates Hearings; Bills/Watchlist work for every tenant via
 * the tracker's own legacy/intel dual-path.
 */
export function RadarPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const tab: RadarTab = (RADAR_TABS as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as RadarTab)
    : 'feed';
  const clientParam = searchParams.get('client');

  const setParam = (key: 'tab' | 'client', value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  // Same key + fetch as AppShell/Portfolio so the client list is shared cache.
  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const visibleClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((client) => client.status !== 'archived')
        .sort((left, right) => left.name.localeCompare(right.name)),
    [clients.data],
  );
  const selectedClient = visibleClients.find((client) => client.id === clientParam) ?? null;

  const { enabled: trackerV2, ready: trackerReady } = useIntelFeature('tracker_v2');
  const { enabled: hearingWatch, ready: hearingReady } = useIntelFeature('hearing_watch');

  const clientPicker = (
    <Select
      allowClear
      showSearch
      aria-label="Radar client"
      placeholder={clients.isLoading ? 'Loading clients…' : 'Select a client'}
      loading={clients.isLoading}
      style={{ minWidth: 240 }}
      value={selectedClient?.id}
      options={visibleClients.map((client) => ({ value: client.id, label: client.name }))}
      optionFilterProp="label"
      onChange={(value) => setParam('client', value ?? null)}
    />
  );

  return (
    <div
      className="redesign"
      style={{
        padding: '24px 32px',
        overflow: 'auto',
        height: '100%',
        background: 'var(--bg-canvas)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0 }}>
          <AimOutlined /> Radar
        </Title>
        <span style={{ flex: 1 }} />
        {clientPicker}
      </div>
      <Paragraph type="secondary" style={{ margin: '4px 0 16px' }}>
        Bills and hearings that matter to your clients — the unified alert feed, the tracked-bill
        board, the hearing schedule, and watchlist targeting in one place.
      </Paragraph>

      <Segmented
        value={tab}
        onChange={(v) => setParam('tab', v as RadarTab)}
        options={[
          { label: 'Feed', value: 'feed', icon: <BellOutlined /> },
          { label: 'Bills', value: 'bills', icon: <FileTextOutlined /> },
          { label: 'Hearings', value: 'hearings', icon: <AudioOutlined /> },
          { label: 'Watchlist', value: 'watchlist', icon: <EyeOutlined /> },
        ]}
        style={{ marginBottom: 16 }}
      />

      {tab === 'feed' && (
        <ClientGate
          client={selectedClient}
          clientsLoading={clients.isLoading}
          picker={clientPicker}
          what="its alert feed"
        >
          {(client) =>
            !trackerReady ? (
              <PanelLoading />
            ) : trackerV2 ? (
              <div className="trk">
                {/* key: full remount per client — unlike the profile flow (which
                    unmounts between clients), the Radar picker swaps clientId in
                    place, and these panels hold per-client interactive state
                    (P4 review: cross-client autosave/select leaks). */}
                <TrackerFeedPanel key={client.id} clientId={client.id} clientName={client.name} />
              </div>
            ) : (
              <Empty description="The unified alert feed is not enabled for this workspace yet." />
            )
          }
        </ClientGate>
      )}

      {tab === 'bills' && (
        <ClientGate
          client={selectedClient}
          clientsLoading={clients.isLoading}
          picker={clientPicker}
          what="its bill board and recommendations"
        >
          {(client) => (
            <TrackerSurface
              key={client.id}
              clientId={client.id}
              clientName={client.name}
              variant="bills"
              onOpenConfigure={() => setParam('tab', 'watchlist')}
            />
          )}
        </ClientGate>
      )}

      {tab === 'hearings' &&
        (!hearingReady ? (
          <PanelLoading />
        ) : hearingWatch ? (
          <div style={{ maxWidth: 1180 }}>
            {/* includeWatchlists: this is the ONLY reachable hearing term-watchlist
                CRUD until the unified editor (P5) absorbs it — the standalone
                Hearing Watch route now redirects here (P4 review finding). */}
            <HearingWatchPanel includeWatchlists />
          </div>
        ) : (
          <Empty description="Hearing Watch is not enabled for this workspace." />
        ))}

      {tab === 'watchlist' && (
        <ClientGate
          client={selectedClient}
          clientsLoading={clients.isLoading}
          picker={clientPicker}
          what="its watchlist targeting and alerts"
        >
          {(client) => (
            <TrackerSurface key={client.id} clientId={client.id} clientName={client.name} variant="watchlist" />
          )}
        </ClientGate>
      )}
    </div>
  );
}

function PanelLoading() {
  return (
    <div style={{ padding: '64px 0', textAlign: 'center' }}>
      <Spin />
    </div>
  );
}

/**
 * Feed/Bills/Watchlist are inherently per-client in v1 — when no client is
 * selected, show a clean picker prompt instead of the panel.
 */
function ClientGate({
  client,
  clientsLoading,
  picker,
  what,
  children,
}: {
  client: Client | null;
  clientsLoading: boolean;
  picker: ReactNode;
  what: string;
  children: (client: Client) => ReactNode;
}) {
  if (client) return <>{children(client)}</>;
  if (clientsLoading) return <PanelLoading />;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '48px 0',
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            Select a client to view {what}.
            <br />
            <Text type="secondary">Feed, Bills, and Watchlist are scoped to one client.</Text>
          </span>
        }
      />
      {picker}
    </div>
  );
}

export default RadarPage;
