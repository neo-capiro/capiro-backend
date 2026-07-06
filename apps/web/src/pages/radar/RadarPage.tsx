import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Modal, Segmented, Select, Spin, Typography } from 'antd';
import {
  AimOutlined,
  AudioOutlined,
  BellOutlined,
  EyeOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
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

const INTRO_SEEN_KEY = 'legiwatch-intro-seen-v1';

/** Plain-language first-run orientation — the four-step LegiWatch loop (L5). */
function LegiWatchIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps: Array<{ n: number; title: string; body: string }> = [
    {
      n: 1,
      title: 'Configure',
      body: 'Tell LegiWatch what a client cares about — issue areas and watchlist tags. This one list drives everything else.',
    },
    {
      n: 2,
      title: 'Bills',
      body: 'Meri recommends legislation to track against that watchlist; tracked bills sit on a board that mirrors their live status.',
    },
    {
      n: 3,
      title: 'Hearings',
      body: 'Watch a hearing and LegiWatch transcribes it and flags the moments that hit the watchlist.',
    },
    {
      n: 4,
      title: 'Feed',
      body: 'Everything that changed — bill moves and hearing moments — lands in one stream. Act from there: draft a memo, start outreach, or add it to the weekly report.',
    },
  ];
  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Got it"
      cancelButtonProps={{ style: { display: 'none' } }}
      title="How LegiWatch works"
      width={560}
      destroyOnHidden
    >
      <Paragraph type="secondary" style={{ marginTop: 0 }}>
        LegiWatch unifies bill tracking and hearing intelligence around one per-client watchlist —
        four steps, one loop.
      </Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {steps.map((s) => (
          <div key={s.n} style={{ display: 'flex', gap: 12 }}>
            <div
              style={{
                flexShrink: 0,
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: 'var(--accent, #6b4fbb)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              {s.n}
            </div>
            <div>
              <div style={{ fontWeight: 600 }}>{s.title}</div>
              <div style={{ color: 'var(--text-2, #55555f)', fontSize: 13 }}>{s.body}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

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

  // LegiWatch v2 (L5): one-time, plain-language orientation on first run, plus a
  // permanent "How it works" control. Seen-state is per-user-per-device
  // (localStorage) — an intro doesn't warrant a server round-trip.
  const [showIntro, setShowIntro] = useState(false);
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(INTRO_SEEN_KEY)) setShowIntro(true);
    } catch {
      /* private mode / no storage — just don't auto-open */
    }
  }, []);
  const dismissIntro = () => {
    try {
      window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowIntro(false);
  };

  const clientPicker = (
    <Select
      allowClear
      showSearch
      aria-label="LegiWatch client"
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
          <AimOutlined /> LegiWatch
        </Title>
        <span style={{ flex: 1 }} />
        {clientPicker}
        <Button icon={<QuestionCircleOutlined />} onClick={() => setShowIntro(true)}>
          How it works
        </Button>
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
          { label: 'Configure', value: 'watchlist', icon: <EyeOutlined /> },
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
            <RadarGlobalFeedTab
              clientNameById={clientNameById}
              onScopeClient={(id) => setParam('client', id)}
            />
          </div>
        ))}

      {tab === 'bills' &&
        (selectedClient ? (
          <FirstRunGate
            loading={!coldStartReady}
            cold={isColdStart}
            clientName={selectedClient.name}
            onSetup={() => setParam('tab', 'watchlist')}
          >
            <TrackerSurface
              key={selectedClient.id}
              clientId={selectedClient.id}
              clientName={selectedClient.name}
              variant="bills"
              onOpenConfigure={() => setParam('tab', 'watchlist')}
            />
          </FirstRunGate>
        ) : trackerReady && trackerV2 ? (
          // L2b all-clients altitude: the tenant-wide board roll-up (every
          // client's tracked bills, client-labelled). Recommendations stay
          // per-client (they score against one client's watchlist), so the
          // roll-up is board-only; pick a client for recs + tracking.
          <div className="trk">
            <RadarGlobalBillsTab onScopeClient={(id) => setParam('client', id)} />
          </div>
        ) : (
          <ClientGate
            client={selectedClient}
            clientsLoading={clients.isLoading}
            picker={clientPicker}
            what="its bill board and recommendations"
          >
            {() => null}
          </ClientGate>
        ))}

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

      <LegiWatchIntro open={showIntro} onClose={dismissIntro} />
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
function RadarGlobalFeedTab({
  clientNameById,
  onScopeClient,
}: {
  clientNameById: Map<string, string>;
  /** LegiWatch v2 (L1): scope the whole feature to a client (from a feed card's label). */
  onScopeClient: (clientId: string) => void;
}) {
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
        onScopeClient={onScopeClient}
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

/** One tenant-board card (per-client tracked bill) from `_all/tracker/board`. */
type TenantBoardCard = {
  billId: string;
  displayNum: string;
  title: string | null;
  passageProbability: number;
  unread: boolean;
  matchedTags: string[];
  changeChip: { label: string; changeType: string | null } | null;
  hearingCount?: number;
  clientId: string;
  clientName: string | null;
};
type TenantBoard = { columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }> };

/**
 * L2b — the ALL-CLIENTS Bills board roll-up (U4 / Gherkin "All-clients board").
 * Read-only: every client's tracked bills in the same stage columns, each card
 * labelled with its client; opening a card shows the shared bill side-drawer
 * (scoped to that card's client), and the client label scopes the whole feature.
 * Recommendations are per-client (they score against one client's watchlist), so
 * they're intentionally absent here — pick a client for recs + track/untrack.
 */
function RadarGlobalBillsTab({ onScopeClient }: { onScopeClient: (clientId: string) => void }) {
  const api = useApi();
  const [drawer, setDrawer] = useState<{ billId: string; clientId: string; clientName: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'hifit' | 'hiprob'>('all');
  const board = useQuery<TenantBoard>({
    queryKey: ['radar-tenant-board'],
    queryFn: async () => (await api.get<TenantBoard>(intelTrackerPaths.board('_all'))).data,
    staleTime: 30_000,
  });

  if (board.isPending) return <PanelLoading />;
  if (board.isError) return <Empty description="Could not load the all-clients board." />;

  const columns = board.data?.columns ?? [];
  const total = columns.reduce((n, c) => n + c.cards.length, 0);
  if (total === 0) {
    return <Empty description="No tracked bills across your clients yet — pick a client to start tracking." />;
  }
  const pass = (c: TenantBoardCard) =>
    filter === 'hifit' ? c.matchedTags.length > 0 : filter === 'hiprob' ? c.passageProbability >= 70 : true;
  const probColor = (p: number) =>
    p >= 70 ? 'var(--good, #2f7a57)' : p >= 40 ? 'var(--notable, #d98324)' : 'var(--muted, #8a8a96)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Every client&rsquo;s tracked bills, by legislative stage.
        </Text>
        <span style={{ flex: 1 }} />
        <Select
          size="small"
          value={filter}
          style={{ minWidth: 190 }}
          onChange={(v) => setFilter(v as 'all' | 'hifit' | 'hiprob')}
          options={[
            { value: 'all', label: 'All tracked bills' },
            { value: 'hifit', label: 'Priority-tag bills' },
            { value: 'hiprob', label: 'High probability (≥70%)' },
          ]}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns.length}, minmax(220px, 1fr))`,
          gap: 12,
          overflowX: 'auto',
        }}
      >
        {columns.map((col) => {
          const cards = col.cards.filter(pass);
          return (
            <div key={col.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                <span>{col.label}</span>
                <span style={{ color: 'var(--muted, #8a8a96)' }}>{cards.length}</span>
              </div>
              {cards.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--muted, #8a8a96)', padding: '6px 0' }}>Nothing here</div>
              ) : (
                cards.map((c) => (
                  <div
                    key={c.clientId + c.billId}
                    onClick={() =>
                      setDrawer({ billId: c.billId, clientId: c.clientId, clientName: c.clientName ?? 'Client' })
                    }
                    style={{
                      border: '1px solid var(--border, #e4e4ea)',
                      borderRadius: 8,
                      background: 'var(--surface, #fff)',
                      padding: '10px 12px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{c.displayNum}</span>
                      {c.unread && (
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent, #6b4fbb)' }} />
                      )}
                      <span style={{ flex: 1 }} />
                      {c.changeChip && (
                        <span
                          style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--notable, #d98324)' }}
                          title={c.changeChip.label}
                        />
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, lineHeight: 1.3 }}>{c.title ?? c.displayNum}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div
                        style={{
                          flex: 1,
                          height: 4,
                          background: 'var(--surface-2, #f0f0f4)',
                          borderRadius: 2,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{ width: `${c.passageProbability}%`, height: '100%', background: probColor(c.passageProbability) }}
                        />
                      </div>
                      <span style={{ fontSize: 10.5, color: 'var(--muted, #8a8a96)' }}>{c.passageProbability}%</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onScopeClient(c.clientId);
                        }}
                        title="View only this client"
                        style={{
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontSize: 11,
                          fontWeight: 600,
                          color: 'var(--accent, #6b4fbb)',
                        }}
                      >
                        {c.clientName ?? 'Client'}
                      </button>
                      {!!c.hearingCount && c.hearingCount > 0 && (
                        <span style={{ fontSize: 10.5, color: 'var(--info, #4a7bd6)' }}>
                          in {c.hearingCount} hearing{c.hearingCount > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
      <BillDrawer
        open={drawer !== null}
        billId={drawer?.billId ?? null}
        clientId={drawer?.clientId ?? ''}
        clientName={drawer?.clientName ?? ''}
        isTracked
        onTrack={() => undefined}
        onClose={() => setDrawer(null)}
      />
    </div>
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
