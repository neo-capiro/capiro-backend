import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Empty, Select, Spin } from 'antd';
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
import { PassageBar } from '../clients/tracker/tracker-components.js';
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
import './legiwatch.css';

type RadarTab = 'feed' | 'bills' | 'hearings' | 'watchlist';
const RADAR_TABS: readonly RadarTab[] = ['feed', 'bills', 'hearings', 'watchlist'];

const INTRO_SEEN_KEY = 'legiwatch-intro-seen-v1';

/** Client initials for the calm client chip (.chip.client .cdot). */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] ?? '')
      .join('')
      .toUpperCase() || '•'
  );
}

/** Plain-language first-run orientation — the four-step LegiWatch loop (L5).
 *  Calm re-skin: the prototype's navy-hero `.intro` card (rendered inside the
 *  `.lw-root` scope so the scoped classes apply). */
function LegiWatchIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const steps: Array<{ icon: ReactNode; title: string; body: string }> = [
    {
      icon: <EyeOutlined />,
      title: 'You set a watchlist for each client',
      body: 'Pick the client’s issue areas and add terms, bills, people, or agencies to watch. Nothing works until this is set.',
    },
    {
      icon: <FileTextOutlined />,
      title: 'LegiWatch finds matching policy and funding developments',
      body: 'It scores federal and state legislation, regulations, and Program Element funding changes against the client’s priorities. You choose which bills to track on the board.',
    },
    {
      icon: <AudioOutlined />,
      title: 'It transcribes the hearings you pick',
      body: 'Choose a hearing and LegiWatch transcribes it and marks the moments that hit the watchlist.',
    },
    {
      icon: <BellOutlined />,
      title: 'Everything that changed shows up in the Feed',
      body: 'Bill moves, hearing moments, regulations, and funding changes land in one list. From there you can save a recap, draft a memo, or start outreach.',
    },
  ];
  return (
    <div className="intro-veil" onClick={onClose} role="dialog" aria-modal="true">
      <div className="intro" onClick={(e) => e.stopPropagation()}>
        <div className="intro-hero">
          <div className="k">Intelligence · LegiWatch</div>
          <h2>What LegiWatch does</h2>
          <p>
            It tracks legislation, hearings, regulations, and defense-budget changes for each client
            and shows you what changed. Here’s the flow, start to finish.
          </p>
        </div>
        <div className="intro-body">
          <div className="loop">
            {steps.map((s) => (
              <div className="loop-step" key={s.title}>
                <span className="ln">{s.icon}</span>
                <div className="lt">
                  <b>{s.title}</b>
                  <p>{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="intro-foot">
          <span className="mini muted">Reopen this anytime from “How it works.”</span>
          <span className="grow" />
          <button className="btn btn-accent" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
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
  /**
   * Gate D g-7: `&alert=<id>` — the deep link Gate A's email wanted and deferred
   * because nothing read it. The Feed scrolls to that card, expands it, and then
   * CLEARS the param, so a refresh does not re-scroll and re-expand.
   */
  const alertParam = searchParams.get('alert');

  const setParam = (key: 'tab' | 'client' | 'alert', value: string | null) => {
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
    queryKey: selectedClient
      ? trackerKeys.watchlist(selectedClient.id)
      : ['radar-coldstart', 'none'],
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

  /**
   * P2-03 (Gate D g-6): the header client picker used to render on EVERY tab,
   * including two places it does nothing useful.
   *
   * 1. Hearings is NOT client-filtered — HearingWatchPanel takes no clientId, so
   *    the picker there is a control that changes nothing.
   * 2. On a tab that REQUIRES a client, ClientGate renders its own picker inside
   *    the empty state. With the header picker also visible that is two pickers
   *    for one decision; the gate's is the one with the explanation next to it.
   */
  const HEARINGS_IS_CLIENT_FILTERED = false;
  // Mirrors the render conditions below exactly: Watchlist ALWAYS gates without
  // a client; Bills gates only when tracker_v2 is off (with it on, the
  // all-clients board roll-up renders instead and the header picker is the way
  // to scope down).
  const gateWillShow =
    !selectedClient && (tab === 'watchlist' || (tab === 'bills' && !(trackerReady && trackerV2)));
  const showHeaderPicker =
    (tab !== 'hearings' || HEARINGS_IS_CLIENT_FILTERED) && !gateWillShow;

  const TABS: Array<{ v: RadarTab; label: string; icon: ReactNode }> = [
    { v: 'feed', label: 'Feed', icon: <BellOutlined /> },
    { v: 'bills', label: 'Bills', icon: <FileTextOutlined /> },
    { v: 'hearings', label: 'Hearings', icon: <AudioOutlined /> },
    { v: 'watchlist', label: 'Configure', icon: <EyeOutlined /> },
  ];

  return (
    <div
      className="lw-root redesign"
      style={{
        padding: '22px 32px 80px',
        overflow: 'auto',
        height: '100%',
        background: 'var(--bg-canvas)',
      }}
    >
      <div className="pg-head">
        <div className="pg-top">
          <h1 className="pg-title">
            <AimOutlined /> LegiWatch
          </h1>
          <span className="grow" />
          {showHeaderPicker && clientPicker}
          <button className="btn btn-ghost" onClick={() => setShowIntro(true)}>
            <QuestionCircleOutlined /> How it works
          </button>
        </div>
        <p className="pg-desc">
          Bills and hearings that matter to your clients — the unified alert feed, the tracked-bill
          board, the hearing schedule, and watchlist targeting in one place.
        </p>
      </div>

      <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.v}
            role="tab"
            aria-selected={tab === t.v}
            className={tab === t.v ? 'active' : ''}
            onClick={() => setParam('tab', t.v)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

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
                focusAlertId={alertParam}
                onFocused={() => setParam('alert', null)}
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
              focusAlertId={alertParam}
              onFocused={() => setParam('alert', null)}
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
function RadarFeedTab({
  clientId,
  clientName,
  focusAlertId,
  onFocused,
}: {
  clientId: string;
  clientName: string;
  /** g-7: `&alert=<id>` from an alert email — scroll to and expand that card. */
  focusAlertId?: string | null;
  onFocused?: () => void;
}) {
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
        ? (await api.post(intelTrackerPaths.track(clientId), { billId, source: 'manual_search' }))
            .data
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
        focusAlertId={focusAlertId}
        onFocused={onFocused}
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
  focusAlertId,
  onFocused,
}: {
  clientNameById: Map<string, string>;
  /** LegiWatch v2 (L1): scope the whole feature to a client (from a feed card's label). */
  onScopeClient: (clientId: string) => void;
  /** g-7: `&alert=<id>` from an alert email. */
  focusAlertId?: string | null;
  onFocused?: () => void;
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
        focusAlertId={focusAlertId}
        onFocused={onFocused}
      />
      <BillDrawer
        open={drawer !== null}
        billId={drawer?.billId ?? null}
        clientId={drawerClientId ?? ''}
        clientName={drawerClientId ? (clientNameById.get(drawerClientId) ?? 'Client') : ''}
        isTracked={drawer ? boardNums.has(drawer.billId) : false}
        onTrack={(billId) =>
          drawerClientId && trackMutation.mutate({ billId, cId: drawerClientId })
        }
        onClose={() => setDrawer(null)}
      />
    </>
  );
}

/** One tenant-board card (per-client tracked bill) from `_all/tracker/board`. */
export type TenantBoardCard = {
  billId: string;
  displayNum: string;
  title: string | null;
  passageProbability: number;
  unread: boolean;
  matchedTags: string[];
  matchedHighPriorityTopics?: string[];
  changeChip: {
    label: string;
    changeType: string | null;
    severity?: string | null;
    tone?: string | null;
  } | null;
  hearingCount?: number;
  clientId: string;
  clientName: string | null;
};
type TenantBoard = {
  columns: Array<{ id: string; label: string; cards: TenantBoardCard[] }>;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  withheld?: number;
};

export type TenantBoardFilter = 'all' | 'hifit' | 'hiprob';

/** Keep the global board's labels aligned with the server-owned scoring facts. */
export function tenantBoardCardMatchesFilter(
  card: TenantBoardCard,
  filter: TenantBoardFilter,
): boolean {
  if (filter === 'hifit') return (card.matchedHighPriorityTopics?.length ?? 0) > 0;
  if (filter === 'hiprob') {
    const pct = card.passageProbability > 1 ? card.passageProbability : card.passageProbability * 100;
    return pct >= 70;
  }
  return true;
}

/** Server tone wins; severity is only a compatibility fallback for cached cards. */
export function tenantBoardChangeTone(card: TenantBoardCard): 'critical' | 'notable' | 'info' | 'success' {
  const tone = card.changeChip?.tone;
  if (tone === 'critical' || tone === 'notable' || tone === 'info' || tone === 'success') return tone;
  if (card.changeChip?.severity === 'critical') return 'critical';
  if (card.changeChip?.severity === 'info') return 'info';
  return 'notable';
}

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
  const [drawer, setDrawer] = useState<{
    billId: string;
    clientId: string;
    clientName: string;
  } | null>(null);
  const [filter, setFilter] = useState<TenantBoardFilter>('all');
  const board = useInfiniteQuery<TenantBoard>({
    queryKey: ['radar-tenant-board'],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<TenantBoard>(
          intelTrackerPaths.board('_all', typeof pageParam === 'string' ? pageParam : undefined),
        )
      ).data,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    staleTime: 30_000,
  });

  // The tenant board is keyset-paginated at the API. The old surface consumed
  // only page 1 (200 rows by default) and silently presented it as the complete
  // all-client portfolio. Merge pages by stage and de-duplicate on the true card
  // identity (client + bill), preserving the server's page/stage order.
  const columns = useMemo(() => {
    const byStage = new Map<string, TenantBoard['columns'][number]>();
    for (const page of board.data?.pages ?? []) {
      for (const column of page.columns) {
        const existing = byStage.get(column.id);
        if (!existing) {
          byStage.set(column.id, { ...column, cards: [...column.cards] });
          continue;
        }
        const seen = new Set(existing.cards.map((card) => `${card.clientId}:${card.billId}`));
        for (const card of column.cards) {
          const key = `${card.clientId}:${card.billId}`;
          if (!seen.has(key)) {
            existing.cards.push(card);
            seen.add(key);
          }
        }
      }
    }
    return [...byStage.values()];
  }, [board.data]);
  const loadedTotal = columns.reduce((n, c) => n + c.cards.length, 0);
  const availableTotal = board.data?.pages[0]?.total ?? loadedTotal;

  if (board.isPending) return <PanelLoading />;
  if (board.isError)
    return (
      <div className="guide plain">
        <h4>Couldn’t load the all-clients board</h4>
        <p>Try again in a moment.</p>
      </div>
    );

  if (loadedTotal === 0) {
    return (
      <div className="guide">
        <div className="gico">
          <FileTextOutlined />
        </div>
        <h4>Your board is empty across all clients</h4>
        <p>
          The board fills in as you track bills. Pick a client to see its recommendations and start
          tracking.
        </p>
      </div>
    );
  }
  const pass = (card: TenantBoardCard) => tenantBoardCardMatchesFilter(card, filter);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="ctx-strip" style={{ margin: 0 }}>
        <span className="lead">Every client’s tracked bills, by legislative stage.</span>
        <span className="grow" />
        <Select
          size="small"
          value={filter}
          style={{ minWidth: 190 }}
          onChange={(v) => setFilter(v as TenantBoardFilter)}
          options={[
            { value: 'all', label: 'All tracked bills' },
            { value: 'hifit', label: 'Priority-tag bills' },
            // §4.8 (Gate D c-8): the estimate is stage-based, not a calibrated
            // forecast — the label says so now. Computation unchanged.
            { value: 'hiprob', label: 'High passage likelihood (≥70%)' },
          ]}
        />
      </div>
      <div className="board">
        {columns.map((col) => {
          const cards = col.cards.filter(pass);
          return (
            <div key={col.id} className="bcol" data-stage={col.id}>
              <div className="bcol-head">
                <span className="sq" />
                <span className="ttl">{col.label}</span>
                <span className="ct num">{cards.length}</span>
              </div>
              {cards.length === 0 ? (
                <div className="bcol-empty">Nothing here</div>
              ) : (
                cards.map((c) => (
                  <div
                    key={c.clientId + c.billId}
                    className="bcard"
                    onClick={() =>
                      setDrawer({
                        billId: c.billId,
                        clientId: c.clientId,
                        clientName: c.clientName ?? 'Client',
                      })
                    }
                  >
                    <div className="b-top">
                      <span className="b-num">{c.displayNum}</span>
                      {c.unread && <span className="b-unread" title="Unseen change" />}
                      <span className="grow" />
                      {c.changeChip && (
                        <span
                          className={`dot ${tenantBoardChangeTone(c)}`}
                          style={{ width: 7, height: 7 }}
                          title={c.changeChip.label}
                        />
                      )}
                    </div>
                    <div className="b-title">{c.title ?? c.displayNum}</div>
                    <PassageBar prob={c.passageProbability} />
                    <div className="b-foot">
                      <button
                        className="chip client"
                        onClick={(e) => {
                          e.stopPropagation();
                          onScopeClient(c.clientId);
                        }}
                        title="View only this client"
                      >
                        <span className="cdot">{initials(c.clientName ?? 'Client')}</span>
                        {c.clientName ?? 'Client'}
                      </button>
                      {!!c.hearingCount && c.hearingCount > 0 && (
                        <span
                          className="chip"
                          style={{
                            border: 'none',
                            background: 'var(--info-soft)',
                            color: 'var(--info)',
                            fontWeight: 600,
                            fontSize: 10.5,
                          }}
                        >
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
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10 }}>
        <span className="muted mini">
          Showing {loadedTotal.toLocaleString()} of {availableTotal.toLocaleString()} tracked bills
        </span>
        {board.hasNextPage ? (
          <Button
            size="small"
            loading={board.isFetchingNextPage}
            disabled={board.isFetchingNextPage}
            onClick={() => void board.fetchNextPage()}
          >
            Load more tracked bills
          </Button>
        ) : null}
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
    <div className="guide" style={{ margin: '8px auto' }}>
      <div className="gico">
        <EyeOutlined />
      </div>
      <h4>Capiro doesn’t know what {clientName} cares about yet</h4>
      <p>
        Set up issue areas and watchlist tags to unlock recommendations, the tracked-bill board, and
        the alert feed.
      </p>
      <div className="row">
        <button className="btn btn-accent" onClick={onSetup}>
          Set up what {clientName} cares about →
        </button>
      </div>
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
    <div className="guide" style={{ margin: '8px auto' }}>
      <div className="gico">
        <EyeOutlined />
      </div>
      <h4>Choose a client</h4>
      <p>Select a client to view {what}. Feed, Bills, and Configure are scoped to one client.</p>
      <div className="row">{picker}</div>
    </div>
  );
}

export default RadarPage;
