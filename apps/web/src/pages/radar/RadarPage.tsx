import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Segmented, Select, Spin, Typography } from 'antd';
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
import { BillDrawer } from './BillDrawer.js';
import { HearingWatchPanel } from '../intelligence/HearingWatchPage.js';
import {
  trackerKeys,
  trackerPaths,
  type BoardResponse,
  type WatchlistPayload,
} from '../clients/tracker/tracker-api.js';
import {
  intelTrackerPaths,
  adaptBoard,
  adaptWatchlist,
  type IntelBoard,
  type IntelWatchlist,
} from '../clients/tracker/intel-tracker-api.js';
import type { Client } from '../clients/clientTypes.js';

const { Title, Paragraph, Text } = Typography;

type RadarTab = 'feed' | 'bills' | 'hearings' | 'watchlist';
const RADAR_TABS: readonly RadarTab[] = ['feed', 'bills', 'hearings', 'watchlist'];

/**
 * Radar (P4 shell) — one destination unifying the Bill Tracker and Hearing
 * Watch surfaces. Four tabs: Feed (default) · Bills · Hearings · Watchlist.
 *
 * Bills/Watchlist are per-client and reuse the client-profile Tracker components
 * — same queries and react-query keys, so Radar and the profile tab stay in sync.
 * The Feed has TWO altitudes (P11): with a client selected it's that client's
 * feed; with NO client selected it's the TENANT-WIDE cross-client roll-up (each
 * card labels its client). Hearings is the global hearing schedule/session list
 * and needs no client.
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
  // clientId → name, for labelling the bill drawer opened from the global feed
  // (the feed API resolves names server-side, but the drawer needs one by id).
  const clientNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clients.data ?? []) m.set(c.id, c.name);
    return m;
  }, [clients.data]);

  const { enabled: trackerV2, ready: trackerReady } = useIntelFeature('tracker_v2');
  const { enabled: hearingWatch, ready: hearingReady } = useIntelFeature('hearing_watch');

  // ── First-run cold-start (P6) ──────────────────────────────────────────────
  // A client is "cold" when it has NO watchlist configured: 0 issue areas AND 0
  // topics/terms. Feed and Bills lead with a single-CTA guided empty state that
  // routes to the Watchlist tab (where Import-from-profile is prominent). Uses
  // the SAME watchlist query + cache key as the tracker surfaces, so once the
  // user configures on the Watchlist tab, Feed/Bills unlock without a refetch.
  const coldStartQuery = useQuery<WatchlistPayload>({
    queryKey: selectedClient ? trackerKeys.watchlist(selectedClient.id) : ['radar-coldstart', 'none'],
    queryFn: async () =>
      trackerV2
        ? adaptWatchlist(
            (await api.get<IntelWatchlist>(intelTrackerPaths.watchlist(selectedClient!.id))).data,
          )
        : (await api.get<WatchlistPayload>(trackerPaths.watchlist(selectedClient!.id))).data,
    enabled: Boolean(selectedClient) && trackerReady,
    staleTime: 30_000,
  });
  const coldStartReady = coldStartQuery.isSuccess;
  const isColdStart =
    coldStartReady &&
    (coldStartQuery.data?.issueAreas.length ?? 0) === 0 &&
    (coldStartQuery.data?.tags.length ?? 0) === 0;

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

      {tab === 'feed' &&
        (!trackerReady ? (
          <PanelLoading />
        ) : !trackerV2 ? (
          <Empty description="The unified alert feed is not enabled for this workspace yet." />
        ) : selectedClient ? (
          <FirstRunGate
            loading={!coldStartReady}
            cold={isColdStart}
            clientName={selectedClient.name}
            onSetup={() => setParam('tab', 'watchlist')}
          >
            <div className="trk">
              {/* key: full remount per client — the Radar picker swaps clientId
                  in place and these panels hold per-client interactive state
                  (P4 review: cross-client autosave/select leaks). */}
              <RadarFeedTab
                key={selectedClient.id}
                clientId={selectedClient.id}
                clientName={selectedClient.name}
              />
            </div>
          </FirstRunGate>
        ) : (
          // P11 global altitude: no client selected → the tenant-wide roll-up
          // (instead of the ClientGate picker prompt Bills/Watchlist still use).
          <div className="trk">
            <RadarGlobalFeedTab clientNameById={clientNameById} />
          </div>
        ))}

      {tab === 'bills' && (
        <ClientGate
          client={selectedClient}
          clientsLoading={clients.isLoading}
          picker={clientPicker}
          what="its bill board and recommendations"
        >
          {(client) => (
            <FirstRunGate
              loading={!coldStartReady}
              cold={isColdStart}
              clientName={client.name}
              onSetup={() => setParam('tab', 'watchlist')}
            >
              <TrackerSurface
                key={client.id}
                clientId={client.id}
                clientName={client.name}
                variant="bills"
                onOpenConfigure={() => setParam('tab', 'watchlist')}
              />
            </FirstRunGate>
          )}
        </ClientGate>
      )}

      {tab === 'hearings' &&
        (!hearingReady ? (
          <PanelLoading />
        ) : hearingWatch ? (
          <div style={{ maxWidth: 1180 }}>
            {/* The hearing term-watchlist CRUD that used to live here was absorbed
                into the unified Watchlist tab (TrackerConfigPanel, P5). This is
                purely the hearing schedule/session surface now. */}
            <HearingWatchPanel />
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
            <div className="trk">
              {/* First-run nudge: once the client is configured (no longer cold),
                  point the user onward to the recommendations on the Bills tab.
                  Import-from-profile itself is prominent inside the config panel. */}
              {coldStartReady && !isColdStart && (
                <div className="radar-nudge">
                  <span>
                    Targeting set for <b>{client.name}</b>. Review the bills Capiro recommends next.
                  </span>
                  <Button size="small" type="primary" onClick={() => setParam('tab', 'bills')}>
                    Go to Bills → Recommendations
                  </Button>
                </div>
              )}
              <TrackerSurface
                key={client.id}
                clientId={client.id}
                clientName={client.name}
                variant="watchlist"
              />
            </div>
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
 * Radar Feed tab (tracker_v2-only). The unified alert feed + the bill side-drawer
 * (P7/P9): `open_bill` alert actions open the bill in place (spec D9 — never
 * routes to Data Explorer). The drawer's "Track for <client>" (P9.1) reuses the
 * standard track endpoint; the board query (shared react-query key with the Bills
 * tab) tells the drawer whether the bill is already tracked.
 */
function RadarFeedTab({ clientId, clientName }: { clientId: string; clientName: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  const [drawerBillId, setDrawerBillId] = useState<string | null>(null);

  // Shares trackerKeys.board(clientId) with the Bills tab / profile tab, so the
  // board is one cached fetch across Radar and stays in sync after a track.
  const boardQuery = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptBoard((await api.get<IntelBoard>(intelTrackerPaths.board(clientId))).data)
        : (await api.get<BoardResponse>(trackerPaths.board(clientId))).data,
    enabled: flagsReady,
  });
  const boardNums = useMemo(
    () => new Set((boardQuery.data?.columns ?? []).flatMap((c) => c.bills.map((b) => b.billId))),
    [boardQuery.data],
  );

  const trackMutation = useMutation({
    mutationFn: async (billId: string) =>
      trackerV2
        ? (await api.post(intelTrackerPaths.track(clientId), { billId, source: 'manual_search' })).data
        : (await api.post(trackerPaths.track(clientId), { billId, source: 'manual_search' })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
      void qc.invalidateQueries({ queryKey: trackerKeys.summary(clientId) });
      // Feed and Bills tabs share the recommendations cache; without this the
      // just-tracked bill lingers in Bills→Recs for ~staleTime (P7/P9 review).
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
      message.success(`Tracking for ${clientName}`);
    },
    onError: () => message.error('Could not track bill'),
  });

  return (
    <>
      <TrackerFeedPanel
        clientId={clientId}
        clientName={clientName}
        onOpenBill={(billId) => setDrawerBillId(billId)}
      />
      <BillDrawer
        open={drawerBillId !== null}
        billId={drawerBillId}
        clientId={clientId}
        clientName={clientName}
        isTracked={drawerBillId ? boardNums.has(drawerBillId) : false}
        onTrack={(billId) => trackMutation.mutate(billId)}
        onClose={() => setDrawerBillId(null)}
      />
    </>
  );
}

/**
 * Radar Feed tab at GLOBAL altitude (P11) — the TENANT-WIDE cross-client roll-up
 * shown when no client is selected. Reuses TrackerFeedPanel in `global` mode (each
 * card labels its client). Opening a bill from an alert opens the SAME in-place
 * side-drawer as the per-client tab (spec D9, never routes to Data Explorer),
 * scoped to that alert's client — the board query + track mutation are lazily
 * bound to the drawer's client so tracking still works cross-client.
 */
function RadarGlobalFeedTab({ clientNameById }: { clientNameById: Map<string, string> }) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  const [drawer, setDrawer] = useState<{ billId: string; clientId: string } | null>(null);
  const drawerClientId = drawer?.clientId ?? null;

  // The drawer's client board (shared react-query key with that client's Bills/
  // Feed tabs) — fetched only while a drawer is open, so the global feed itself
  // stays a single tenant-wide request.
  const boardQuery = useQuery<BoardResponse>({
    queryKey: drawerClientId ? trackerKeys.board(drawerClientId) : ['radar-global-board', 'none'],
    queryFn: async () =>
      trackerV2
        ? adaptBoard((await api.get<IntelBoard>(intelTrackerPaths.board(drawerClientId!))).data)
        : (await api.get<BoardResponse>(trackerPaths.board(drawerClientId!))).data,
    enabled: flagsReady && !!drawerClientId,
  });
  const boardNums = useMemo(
    () => new Set((boardQuery.data?.columns ?? []).flatMap((c) => c.bills.map((b) => b.billId))),
    [boardQuery.data],
  );

  const trackMutation = useMutation({
    mutationFn: async ({ billId, cId }: { billId: string; cId: string }) =>
      trackerV2
        ? (await api.post(intelTrackerPaths.track(cId), { billId, source: 'manual_search' })).data
        : (await api.post(trackerPaths.track(cId), { billId, source: 'manual_search' })).data,
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: trackerKeys.board(vars.cId) });
      void qc.invalidateQueries({ queryKey: trackerKeys.summary(vars.cId) });
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(vars.cId) });
      message.success(`Tracking for ${clientNameById.get(vars.cId) ?? 'client'}`);
    },
    onError: () => message.error('Could not track bill'),
  });

  return (
    <>
      <TrackerFeedPanel
        global
        onOpenBill={(billId, cId) => setDrawer({ billId, clientId: cId })}
      />
      <BillDrawer
        open={drawer !== null}
        billId={drawer?.billId ?? null}
        clientId={drawerClientId ?? ''}
        clientName={drawerClientId ? clientNameById.get(drawerClientId) ?? 'Client' : ''}
        isTracked={drawer ? boardNums.has(drawer.billId) : false}
        onTrack={(billId) => drawerClientId && trackMutation.mutate({ billId, cId: drawerClientId })}
        onClose={() => setDrawer(null)}
      />
    </>
  );
}

/**
 * First-run guided empty state (P6). When the selected client has no watchlist
 * configured, Feed/Bills lead with a single CTA that routes to the Watchlist tab
 * (where Import-from-profile is prominent) instead of an empty board/feed. Once
 * ≥1 issue area/tag is saved the client is no longer cold and the real panel
 * renders. While the cold-start check is still loading, show a spinner so the
 * guided state never flashes over a configured client.
 */
function FirstRunGate({
  loading,
  cold,
  clientName,
  onSetup,
  children,
}: {
  loading: boolean;
  cold: boolean;
  clientName: string;
  onSetup: () => void;
  children: ReactNode;
}) {
  if (loading) return <PanelLoading />;
  if (!cold) return <>{children}</>;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '56px 24px',
        textAlign: 'center',
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            Capiro doesn&apos;t know what <b>{clientName}</b> cares about yet.
            <br />
            <Text type="secondary">
              Set up issue areas and watchlist tags to unlock recommendations, the tracked-bill
              board, and the alert feed.
            </Text>
          </span>
        }
      />
      <Button type="primary" size="large" onClick={onSetup}>
        Set up what {clientName} cares about →
      </Button>
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
