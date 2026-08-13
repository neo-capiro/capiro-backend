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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import { LEGIWATCH_TABS, REMOVED_TABS, type LegiWatchTab } from './lib/types.js';
import { useLwFeed, useLwFeedItems } from './lib/api.js';
import { LwPill, LwButton } from './lib/primitives.js';
import { HearingsTab } from './hearings/HearingsTab.js';
import { FeedTab } from './feed/FeedTab.js';
import { BillsTab } from './bills/BillsTab.js';
import { DigestTab } from './digest/DigestTab.js';
import { AnalyticsTab } from './analytics/AnalyticsTab.js';
import { ColdStart } from './coldstart/ColdStart.js';
import { SavedViewsOverlay } from './overlays/SavedViewsOverlay.js';
import { CreateWatchOverlay } from './overlays/CreateWatchOverlay.js';
import { SystemStatesOverlay } from './overlays/SystemStatesOverlay.js';
import { HowItWorksOverlay } from './overlays/HowItWorksOverlay.js';
import './legiwatch.css';

type Overlay = 'views' | 'watch' | 'states' | 'how' | null;

const TAB_HEAD: Record<LegiWatchTab, { eyebrow: string; title: string; description: string }> = {
  hearings: {
    eyebrow: 'Hearing watch',
    title: 'Hearings',
    description:
      'Move from committee schedules to live transcription, watchlist hits, and durable hearing intelligence.',
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
    { id: 'pe', label: 'Program Elements', path: '/program-elements' },
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
        <a
          key={item.id}
          href={item.path}
          className={`lw-subnav__item${item.id === 'legiwatch' ? ' is-active' : ''}`}
          aria-current={item.id === 'legiwatch' ? 'page' : undefined}
        >
          {item.label}
        </a>
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
  const moduleFeed = useLwFeed(scope, 'all', 'date', undefined);
  const { items: moduleItems } = useLwFeedItems(moduleFeed);
  const activeCount = moduleItems.length; // default bucket excludes dismissed/snoozed server-side

  // Cold start (§7.12): a client with no approved targeting replaces the module
  // body. Detection: a scoped client whose watchlist read returns the server's
  // "never configured" shape (suggestedIssueAreas present, no topics). The
  // watchlist read is the canonical relevance source (§6.5).
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
  const coldStart =
    Boolean(scope) &&
    tracker.ready &&
    tracker.enabled &&
    watchlist.data != null &&
    (watchlist.data.topics == null || watchlist.data.topics.length === 0);

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
  const tabCount: Partial<Record<LegiWatchTab, number>> = { feed: activeCount };

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
          <LwButton size="42" onClick={() => setOverlay('views')}>Saved views</LwButton>
          <LwButton size="42" variant="primary" onClick={() => setOverlay('watch')}>Create watch</LwButton>
          <LwButton size="42" onClick={() => setOverlay('how')}>How it works</LwButton>
          <LwPill tone={moduleFeed.isError ? 'error' : 'brand'}>
            {moduleFeed.isError ? 'SOURCE ISSUE' : `LIVE · ${activeCount} ACTIVE`}
          </LwPill>
        </div>
      </header>

      <div className="lw-tabs" role="tablist" aria-label="LegiWatch sections">
        {LEGIWATCH_TABS.map((t) => (
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
        <ColdStart clientId={scope} onConfigure={() => navigate('/clients?clientId=' + scope)} />
      ) : tab === 'hearings' ? (
        <HearingsTab scope={scope} />
      ) : tab === 'feed' ? (
        <FeedTab scope={scope} clients={visibleClients} />
      ) : tab === 'bills' ? (
        <BillsTab scope={scope} clients={visibleClients} />
      ) : tab === 'digest' ? (
        <DigestTab scope={scope} />
      ) : tab === 'analytics' ? (
        <AnalyticsTab scope={scope} />
      ) : null}

      {overlay === 'views' ? (
        <SavedViewsOverlay onClose={() => setOverlay(null)} />
      ) : overlay === 'watch' ? (
        <CreateWatchOverlay
          onClose={() => setOverlay(null)}
          onConfigure={() => {
            setOverlay(null);
            navigate(scope ? `/clients?clientId=${scope}` : '/clients');
          }}
        />
      ) : overlay === 'states' ? (
        <SystemStatesOverlay onClose={() => setOverlay(null)} />
      ) : overlay === 'how' ? (
        <HowItWorksOverlay onClose={() => setOverlay(null)} />
      ) : null}
    </div>
  );
}
