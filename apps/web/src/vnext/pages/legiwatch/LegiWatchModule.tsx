/**
 * LegiWatch vNext module (LEGIWATCH-HANDOFF §7.1).
 *
 * Route: /legiwatch?tab=hearings|feed|bills|digest|analytics  (+ removed tabs
 * redirect to hearings). Tabs are URL-addressable; browser back/forward
 * restores tab, scope, filters and drawer state (§11.1).
 *
 * The module reuses the canonical shell (AppShellUui provides top bar, rail
 * with the Intelligence sub-nav expanded, mobile bottom nav). Inside <main>
 * LegiWatch adds three chrome rows: Intelligence sub-nav + source health, the
 * page header, and the tab strip. The live hearing room (§7.8) suppresses all
 * three — it is a separate route that replaces the module chrome.
 *
 * Non-negotiables honoured throughout (§1): no new backend; a screen that
 * needs data no endpoint provides STOPS and renders its §9 state (logged in
 * GAPS.md); missing data never renders as zero; tracked/work state is
 * server-authoritative; no external send path exists anywhere.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { LEGIWATCH_TABS, LEGIWATCH_PRIMARY_TABS, REMOVED_TABS, type LegiWatchTab } from './lib/types.js';
import { useLwFeed, useLwFeedItems, defaultBucketCount } from './lib/api.js';
import { LwPill, LwButton } from './lib/primitives.js';
import { HearingsTab } from './hearings/HearingsTab.js';
import { CommitteesTab } from './committees/CommitteesTab.js';
import { FeedTab } from './feed/FeedTab.js';
import { BillsTab } from './bills/BillsTab.js';
import { DigestTab } from './digest/DigestTab.js';
import { AnalyticsTab } from './analytics/AnalyticsTab.js';
import { WatchlistGatePanel } from './coldstart/WatchlistGatePanel.js';
import { LegiWatchSettingsTab } from './settings/LegiWatchSettingsTab.js';
import { SavedViewsOverlay } from './overlays/SavedViewsOverlay.js';
import { CreateWatchOverlay } from './overlays/CreateWatchOverlay.js';
import { SystemStatesOverlay } from './overlays/SystemStatesOverlay.js';
import { LegiWatchSearchOverlay } from './overlays/LegiWatchSearchOverlay.js';
import { ExportCalendarOverlay } from './overlays/ExportCalendarOverlay.js';
import './legiwatch.css';

type Overlay = 'views' | 'watch' | 'states' | 'search' | 'export' | null;

const TAB_HEAD: Record<LegiWatchTab, { eyebrow: string; title: string; description: string }> = {
  hearings: {
    eyebrow: 'Hearing watch',
    title: 'Hearings',
    description:
      'Move from committee schedules to live transcription, watchlist hits, and durable hearing intelligence.',
  },
  committees: {
    eyebrow: 'Committee directory',
    title: 'Committees',
    description: 'Every current committee and subcommittee, with its roster, its published record and your client exposure.',
  },
  feed: {
    eyebrow: 'Alert worklist',
    title: 'Feed',
    description:
      'Prioritized policy and funding movement, with the client impact and next action kept in view.',
  },
  bills: {
    eyebrow: 'Legislative portfolio',
    title: 'Bills',
    description:
      'Track the federal and state measures that matter, their posture, movement, ownership, and client exposure.',
  },
  digest: {
    eyebrow: 'Portfolio briefing',
    title: 'Digest',
    description:
      'A compact briefing of the highest-priority movement in the current LegiWatch feed.',
  },
  analytics: {
    eyebrow: 'Coverage and movement',
    title: 'Analytics',
    description:
      'See where alert volume, severity, and source movement are concentrating across the current scope.',
  },
  settings: {
    eyebrow: 'Preferences',
    title: 'Settings',
    description:
      'Personal LegiWatch display preferences — how hearings are shown, never the canonical data itself.',
  },
};

/** Intelligence sub-nav (§7.1 row 1) — static destinations; the source-health
 *  string is live data. There is no source-health endpoint (GAPS LW-G5), so
 *  the health chip renders its honest unavailable/refreshed state from the
 *  feed query, never a fabricated "5 sources healthy". */
function IntelligenceSubNav({
  feedState,
  onOpenStates,
}: {
  feedState: { isFetching: boolean; isError: boolean; dataUpdatedAt: number };
  onOpenStates: () => void;
}) {
  const items: Array<{ id: string; label: string; path: string }> = [
    { id: 'explorer', label: 'Data Explorer', path: '/explorer' },
    { id: 'legiwatch', label: 'LegiWatch', path: '/legiwatch' },
    { id: 'pe', label: 'Defense Budget', path: '/program-elements' },
    { id: 'fo', label: 'Funding Opportunities', path: '/intelligence/opportunities' },
    { id: 'nexus', label: 'District Nexus', path: '/intelligence/district-nexus' },
  ];
  const health = feedState.isError
    ? 'Source status unavailable'
    : feedState.isFetching
      ? 'Refreshing sources…'
      : feedState.dataUpdatedAt
        ? `Refreshed ${Math.max(0, Math.round((Date.now() - feedState.dataUpdatedAt) / 60000))} min ago`
        : 'Source status unavailable';
  return (
    <nav className="lw-subnav" aria-label="Intelligence">
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.path}
          className={`lw-subnav__item${item.id === 'legiwatch' ? ' is-active' : ''}`}
          aria-current={item.id === 'legiwatch' ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
      <button
        type="button"
        className="lw-subnav__health"
        style={{ background: 'none', border: 0, cursor: 'pointer' }}
        onClick={onOpenStates}
        title="System states reference"
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: feedState.isError ? 'var(--lw-error-dot)' : 'var(--lw-succ-dot)',
            display: 'inline-block',
          }}
        />
        {health}
      </button>
    </nav>
  );
}

export function LegiWatchModule() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overlay, setOverlay] = useState<Overlay>(null);

  // §7.2/§7.9 — removed tabs redirect to hearings; unknown tabs land on hearings.
  const rawTab = searchParams.get('tab');
  const tab: LegiWatchTab = useMemo(() => {
    if (!rawTab || REMOVED_TABS.has(rawTab)) return 'hearings';
    return (LEGIWATCH_TABS as readonly string[]).includes(rawTab) ? (rawTab as LegiWatchTab) : 'hearings';
  }, [rawTab]);

  const scope = searchParams.get('client') ?? '';
  // PR C §14 — browse mode: stay inside /legiwatch with watchlist-dependent
  // surfaces limited inline. URL-persisted (survives refresh, back/forward,
  // deep links) and explicitly cleared the moment a watchlist exists.
  const browse = searchParams.get('browse') === '1';
  const tracker = useIntelFeature('tracker_v2');

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });
  const visibleClients = useMemo(
    () =>
      (clients.data ?? [])
        .filter((c) => c.status !== 'archived')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients.data],
  );
  const selectedClient = visibleClients.find((c) => c.id === scope) ?? null;

  // The module-level feed drives the tab badge counts (§8.6: counts come from
  // the same query that fills the Feed tab). Active queue = server's default.
  //
  // LW-QA-020: this was `moduleItems.length` — the number of rows in the FIRST
  // page of a hard 25-row query the module never pages — so it saturated at 25
  // on any tenant with more active alerts. `defaultBucketCount(workStateCounts)`
  // is the server's exact count over the whole filtered set, and is byte-for-
  // byte the expression the Feed tab's own "Active queue" row uses against the
  // identical cache entry, so badge and queue cannot disagree. null while the
  // first page is in flight, or if the server omits the counts.
  const moduleFeed = useLwFeed(scope, 'all', 'date', undefined);
  const { workStateCounts } = useLwFeedItems(moduleFeed);
  const activeCount = defaultBucketCount(workStateCounts);

  // Cold start detection (§7.12): a scoped client whose watchlist read returns
  // the server's "never configured" shape (suggestedIssueAreas present, no
  // topics). The watchlist read is the canonical relevance source (§6.5).
  const watchlist = useQuery<{ topics?: unknown[]; suggestedIssueAreas?: string[] } | null>({
    queryKey: ['lw-vnext', 'watchlist-peek', scope],
    queryFn: async () => {
      if (!scope) return null;
      try {
        return (
          await api.get<{ topics?: unknown[]; suggestedIssueAreas?: string[] }>(
            `/intel-api/tracker/watchlists/${encodeURIComponent(scope)}`,
          )
        ).data;
      } catch {
        return null;
      }
    },
    enabled: Boolean(scope) && tracker.ready && tracker.enabled,
    retry: false,
    staleTime: 60_000,
  });
  const watchlistMissing =
    Boolean(scope) &&
    tracker.ready &&
    tracker.enabled &&
    watchlist.data != null &&
    (watchlist.data.topics == null || watchlist.data.topics.length === 0);
  // PR C §13: the watchlist gate no longer replaces the WHOLE module. It only
  // limits the watchlist-dependent surfaces (feed/digest/analytics — the tabs
  // whose content is client-relevance-ranked). Hearings, Bills, Committees,
  // Settings, archive/search stay public for every client; a no-watchlist
  // client gets inline setup guidance on the dependent tabs instead.
  const watchlistLimitedTab = tab === 'feed' || tab === 'digest' || tab === 'analytics';
  const coldStart = watchlistMissing && watchlistLimitedTab && !browse;

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null || value === '') next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: false },
    );
  };

  const setTab = (next: LegiWatchTab) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', next);
        if (next !== 'feed') p.delete('alert');
        return p;
      },
      { replace: false },
    );
  };

  const head = TAB_HEAD[tab];
  const scopeLabel = selectedClient?.name ?? 'All clients';

  // Counts for the tab strip (§8.6) — Hearings count comes from the hearings
  // query inside the Hearings tab; Feed/Bills from their own queries. Here we
  // surface the Feed active count; the others are read in their tabs and shown
  // via the same derived-not-literal rule.
  // LW-QA-020: an unavailable count omits the key entirely, so the render guard
  // below shows NO badge rather than a fabricated 0.
  const tabCount: Partial<Record<LegiWatchTab, number>> =
    activeCount != null ? { feed: activeCount } : {};

  return (
    <div className="lw" data-module="legiwatch">
      <IntelligenceSubNav
        feedState={{
          isFetching: moduleFeed.isFetching,
          isError: moduleFeed.isError,
          dataUpdatedAt: moduleFeed.dataUpdatedAt,
        }}
        onOpenStates={() => setOverlay('states')}
      />

      <header className="lw-pagehead">
        <div>
          <div className="lw-eyebrow">{head.eyebrow} · {scopeLabel}</div>
          <h1 className="lw-h1">{head.title}</h1>
          <p className="lw-desc">{head.description}</p>
        </div>
        <div className="lw-pagehead__actions">
          <select
            aria-label="LegiWatch client scope"
            className="lw-btn"
            style={{ height: 42, appearance: 'none', paddingRight: 28 }}
            value={selectedClient?.id ?? ''}
            onChange={(e) => setParam('client', e.target.value || null)}
          >
            <option value="">All clients</option>
            {visibleClients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {/* PR C §16: a scoped client the directory no longer lists is an
              ARCHIVED/DELETED reference. The scope keeps working (historical
              data stays reachable) but the selector must not silently pretend
              the client is active. */}
          {scope && !selectedClient ? (
            <LwPill tone="warning">ARCHIVED CLIENT SCOPE</LwPill>
          ) : null}
          <LwButton size="42" onClick={() => setOverlay('search')} aria-label="Search LegiWatch" title="Search LegiWatch">
            Search LegiWatch
          </LwButton>
          <LwButton size="42" onClick={() => setOverlay('views')}>Saved views</LwButton>
          <LwButton size="42" variant="primary" onClick={() => setOverlay('watch')}>Create watch</LwButton>
          <LwButton size="42" onClick={() => setOverlay('export')} aria-label="Export calendar" title="Export calendar">
            Export calendar
          </LwButton>
          <button
            type="button"
            className="lw-btn lw-btn--42 lw-btn--icon"
            aria-label="LegiWatch settings"
            title="LegiWatch settings"
            onClick={() => setTab('settings')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <LwPill tone={moduleFeed.isError ? 'error' : 'brand'}>
            {moduleFeed.isError
              ? 'SOURCE ISSUE'
              : activeCount != null
                ? `LIVE · ${activeCount} ACTIVE`
                : 'LIVE'}
          </LwPill>
        </div>
      </header>

      <div className="lw-tabs" role="tablist" aria-label="LegiWatch sections">
        {LEGIWATCH_PRIMARY_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`lw-tab${tab === t ? ' is-active' : ''}`}
            onClick={() => setTab(t)}
          >
            <span>{TAB_HEAD[t].title}</span>
            {tabCount[t] != null && tabCount[t]! > 0 ? (
              <span className="lw-tab__count">{tabCount[t]! > 999 ? '999+' : tabCount[t]}</span>
            ) : null}
          </button>
        ))}
      </div>

      {coldStart ? (
        // §13: scoped + no approved watchlist + a watchlist-dependent tab.
        // Inline guidance — the module (tabs, client selector, public surfaces)
        // stays mounted; the dependent tab's body is what's replaced.
        <WatchlistGatePanel
          clientName={selectedClient?.name ?? ''}
          onConfigure={() => navigate(`/radar?tab=watchlist&client=${encodeURIComponent(scope)}`)}
          onExplore={() => {
            // §14: browse mode stays INSIDE /legiwatch — URL-persisted so it
            // survives refresh, back/forward, and deep links. Never exits to CRM.
            setParam('browse', '1');
          }}
        />
      ) : watchlistMissing && browse && watchlistLimitedTab ? (
        // §14 browse mode on a dependent tab: the tab renders its real data path
        // (tenant-wide or all-clients) with an honest, dismissible notice.
        <>
          <div className="lw-card" style={{ padding: '10px 18px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }} aria-label="Browse mode notice">
            <LwPill tone="warning" size="22">BROWSE MODE</LwPill>
            <span style={{ fontSize: 13, color: 'var(--lw-body)' }}>
              Public LegiWatch data remains available. Client-specific alerts and relevance require a monitoring model.
            </span>
            <LwButton size="36" onClick={() => navigate(`/radar?tab=watchlist&client=${encodeURIComponent(scope)}`)}>
              Set up the watchlist
            </LwButton>
          </div>
          {tab === 'feed' ? <FeedTab scope={scope} clients={visibleClients} />
          : tab === 'digest' ? <DigestTab scope={scope} />
          : <AnalyticsTab scope={scope} />}
        </>
      ) : tab === 'hearings' ? (
        <HearingsTab scope={scope} />
      ) : tab === 'committees' ? (
        <CommitteesTab />
      ) : tab === 'feed' ? (
        <FeedTab scope={scope} clients={visibleClients} />
      ) : tab === 'bills' ? (
        <BillsTab scope={scope} clients={visibleClients} />
      ) : tab === 'digest' ? (
        <DigestTab scope={scope} />
      ) : tab === 'analytics' ? (
        <AnalyticsTab scope={scope} />
      ) : tab === 'settings' ? (
        <LegiWatchSettingsTab />
      ) : null}

      {overlay === 'views' ? (
        <SavedViewsOverlay onClose={() => setOverlay(null)} />
      ) : overlay === 'watch' ? (
        <CreateWatchOverlay
          onClose={() => setOverlay(null)}
          defaultClientId={scope || undefined}
          onConfigure={() => {
            setOverlay(null);
            navigate(scope ? `/radar?tab=watchlist&client=${encodeURIComponent(scope)}` : '/radar?tab=watchlist');
          }}
        />
      ) : overlay === 'states' ? (
        <SystemStatesOverlay onClose={() => setOverlay(null)} />
      ) : overlay === 'search' ? (
        <LegiWatchSearchOverlay
          onClose={() => setOverlay(null)}
          onOpenHearing={(id) => {
            setOverlay(null);
            navigate(`/legiwatch/hearings/${encodeURIComponent(id)}`);
          }}
          onOpenCommittee={(systemCode) => {
            setOverlay(null);
            navigate(`/legiwatch/committees/${encodeURIComponent(systemCode)}`);
          }}
        />
      ) : overlay === 'export' ? (
        <ExportCalendarOverlay scope={scope} onClose={() => setOverlay(null)} />
      ) : null}
    </div>
  );
}
