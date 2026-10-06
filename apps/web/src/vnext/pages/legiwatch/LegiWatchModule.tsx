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
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, Crosshair, Search } from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  LEGIWATCH_TABS,
  LEGIWATCH_PRIMARY_TABS,
  LEGIWATCH_SECONDARY_TABS,
  LEGIWATCH_HIDDEN_TABS,
  REMOVED_TABS,
  TAB_ALIASES,
  type LegiWatchTab,
} from './lib/types.js';
import { useLwFeed, useLwFeedItems, defaultBucketCount } from './lib/api.js';
import { LwPill, LwButton } from './lib/primitives.js';
import { isWatchlistSetup, watchlistSetupPath } from './lib/watchlist-navigation.js';
import { hasTestSessionTitle } from './lib/hearing-presentation.js';
import { HearingsTab } from './hearings/HearingsTab.js';
import { CommitteesTab } from './committees/CommitteesTab.js';
import { FeedTab } from './feed/FeedTab.js';
import { BillsTab } from './bills/BillsTab.js';
import { EvidenceTab } from './editorial/EvidenceTab.js';
import { ResearchTab } from './research/ResearchTab.js';
import { DigestTab } from './digest/DigestTab.js';
import { AnalyticsTab } from './analytics/AnalyticsTab.js';
import { WatchlistGatePanel } from './coldstart/WatchlistGatePanel.js';
import { LegiWatchSettingsTab } from './settings/LegiWatchSettingsTab.js';
import { LegiWatchSearchOverlay } from './overlays/LegiWatchSearchOverlay.js';
import './legiwatch.css';

type Overlay = 'search' | null;

const TAB_HEAD: Record<LegiWatchTab, { eyebrow: string; title: string; description: string }> = {
  news: {
    eyebrow: 'Monitored coverage',
    title: 'News',
    description: 'Source-linked news, personnel changes and monitored expressions.',
  },
  budget: {
    eyebrow: 'Florida appropriations',
    title: 'Florida Budget',
    description: 'Fiscal documents, project identities and supported stage comparisons.',
  },
  research: {
    eyebrow: 'Legislative research',
    title: 'Research',
    description: 'Explore exact bill versions, statutes, rule notices and published dates.',
  },
  hearings: {
    eyebrow: 'Legislative intelligence',
    title: 'Hearings',
    description:
      'Official proceedings, published agendas, preparation and saved hearing work for your clients.',
  },
  committees: {
    eyebrow: 'Committee directory',
    title: 'Committees',
    description:
      'Every current committee and subcommittee, with its roster, its published record and your client exposure.',
  },
  feed: {
    eyebrow: 'Alert worklist',
    title: 'Updates',
    description:
      'Prioritized policy and funding movement, with the client impact and next action kept in view.',
  },
  bills: {
    eyebrow: 'Legislative portfolio',
    title: 'Watchlists',
    description:
      'Track the federal and state measures that matter, their posture, movement, ownership, and client exposure.',
  },
  digest: {
    eyebrow: 'Portfolio briefing',
    title: 'Reports',
    description:
      'Create and manage bill reports, client briefings, and intelligence briefs.',
  },
  analytics: {
    eyebrow: 'Coverage and movement',
    title: 'Trends / Analytics',
    description:
      'See where alert volume, severity, and source movement are concentrating across the current scope.',
  },
  settings: {
    eyebrow: 'Preferences',
    title: 'Settings',
    description:
      'Manage agenda alerts, report settings, monitoring and display preferences.',
  },
};

export function LegiWatchModule() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [lensOpen, setLensOpen] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [includeTestClients, setIncludeTestClients] = useState(false);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay('search');
      }
    };
    window.addEventListener('keydown', openSearch);
    return () => window.removeEventListener('keydown', openSearch);
  }, []);

  // §7.2/§7.9 — removed tabs redirect to hearings; unknown tabs land on hearings.
  // Settings dispatches legacy watchlist links to canonical client targeting.
  const rawTab = searchParams.get('tab');
  const tab: LegiWatchTab = useMemo(() => {
    if (rawTab && Object.prototype.hasOwnProperty.call(TAB_ALIASES, rawTab))
      return TAB_ALIASES[rawTab] ?? 'hearings';
    if (!rawTab) return 'feed';
    if (REMOVED_TABS.has(rawTab)) return 'hearings';
    return (LEGIWATCH_TABS as readonly string[]).includes(rawTab)
      ? (rawTab as LegiWatchTab)
      : 'hearings';
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
  const watchlist = useQuery<{
    topics?: unknown[];
    issueAreas?: string[];
    suggestedIssueAreas?: string[];
  } | null>({
    queryKey: ['lw-vnext', 'watchlist-peek', scope],
    queryFn: async () => {
      if (!scope) return null;
      try {
        return (
          await api.get<{
            topics?: unknown[];
            issueAreas?: string[];
            suggestedIssueAreas?: string[];
          }>(`/intel-api/tracker/watchlists/${encodeURIComponent(scope)}`)
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
    (watchlist.data.topics == null || watchlist.data.topics.length === 0) &&
    (watchlist.data.issueAreas == null || watchlist.data.issueAreas.length === 0);
  // PR C §13: the watchlist gate no longer replaces the WHOLE module. It only
  // limits the watchlist-dependent surfaces (feed/digest/analytics — the tabs
  // whose content is client-relevance-ranked). Hearings, Bills, Committees,
  // Settings, archive/search stay public for every client; a no-watchlist
  // client gets inline setup guidance on the dependent tabs instead.
  const watchlistLimitedTab = tab === 'feed' || tab === 'digest' || tab === 'analytics';
  // Report library/history/frozen runs/contacts are persisted documents, not
  // monitoring output, so when DigestTab's own effective mode resolves to the
  // reports workspace (digestMode ?? reportView) the scope gate stays out of
  // the way; the legacy morning-brief mode keeps its watchlist dependency.
  const digestMode = searchParams.get('digestMode');
  const reportDeepLink =
    tab === 'digest' &&
    (digestMode ?? (searchParams.get('reportView') ? 'bill_report' : 'legacy')) === 'bill_report';
  const coldStart = watchlistMissing && watchlistLimitedTab && !browse && !reportDeepLink;

  const setParam = (key: string, value: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null || value === '') next.delete(key);
        else next.set(key, value);
        if (key === 'client' && prev.get('client') !== next.get('client')) {
          // A folder belongs to its client. Evidence and research validate
          // that pair before returning private context.
          next.delete('folder');
          next.delete('researchCursor');
          next.delete('offset');
          for (const name of Array.from(next.keys())) {
            if (/^(news|budget).*Offset$/.test(name)) next.delete(name);
          }
        }
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
        // Search terms belong to their own view. Keep client/folder scope and
        // namespaced view filters, but never carry legacy search pagination
        // from News into Budget, Research, or another primary destination.
        if (next !== tab) {
          p.delete('q');
          p.delete('offset');
        }
        if (p.get('sub') === 'watchlist') p.delete('sub');
        if (next !== 'feed') p.delete('alert');
        return p;
      },
      { replace: false },
    );
  };

  const head = isWatchlistSetup(searchParams)
    ? { eyebrow: 'Client monitoring', title: 'Watchlist & alerts', description: 'Manage client topics, terms, jurisdictions and alert preferences.' }
    : TAB_HEAD[tab];
  const scopeLabel = selectedClient?.name ?? 'All clients';

  // Counts for the tab strip (§8.6) — Hearings count comes from the hearings
  // query inside the Hearings tab; Feed/Bills from their own queries. Here we
  // surface the Feed active count; the others are read in their tabs and shown
  // via the same derived-not-literal rule.
  // LW-QA-020: an unavailable count omits the key entirely, so the render guard
  // below shows NO badge rather than a fabricated 0.
  const tabCount: Partial<Record<LegiWatchTab, number>> =
    activeCount != null ? { feed: activeCount } : {};
  // A hidden tab reached by deep link joins the strip as its own active tab so
  // the navigation never claims a different section is open.
  const primaryTabs: readonly LegiWatchTab[] = LEGIWATCH_HIDDEN_TABS.includes(tab)
    ? [...LEGIWATCH_PRIMARY_TABS, tab]
    : LEGIWATCH_PRIMARY_TABS;
  const primaryTab: LegiWatchTab | null =
    LEGIWATCH_SECONDARY_TABS.includes(tab) ? null : tab;

  return (
    <div className="lw" data-module="legiwatch">
      <header className="lw-pagehead">
        <div>
          <div className="lw-eyebrow">{head.eyebrow}</div>
          <h1 className="lw-h1">{head.title}</h1>
          <p className="lw-desc">{head.description}</p>
        </div>
        <div className="lw-pagehead__actions">
          {/* Client lens (§7.1) — the one shaded control in the header set:
              brand-tinted bg/ring because it scopes the whole page's private
              client analysis. Eyebrow + value stacked per the v2 prototype. */}
          <button
            type="button"
            className="lw-lens"
            onClick={() => setLensOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={lensOpen}
          >
            <Crosshair size={16} color="#294E68" aria-hidden="true" />
            <span className="lw-lens__stack">
              <span className="lw-lens__eyebrow">Client</span>
              <span className="lw-lens__value">{scopeLabel}</span>
            </span>
            <ChevronDown size={15} color="#294E68" aria-hidden="true" />
          </button>
          {lensOpen ? (
            <div className="lw-lens__menu" role="listbox" aria-label="Client">
              <div className="lw-lens__menuhead">Client</div>
              <input className="lw-client-search" type="search" aria-label="Find a client" placeholder="Find a client" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} />
              <label className="lw-client-test-filter"><input type="checkbox" checked={includeTestClients} onChange={(event) => setIncludeTestClients(event.target.checked)} /> Include names marked QA/test</label>
              <button
                type="button"
                role="option"
                aria-selected={!selectedClient}
                className={`lw-lens__opt${!selectedClient ? ' is-active' : ''}`}
                onClick={() => {
                  setParam('client', null);
                  setLensOpen(false);
                }}
              >
                <span className="lw-lens__optname">All clients</span>
              </button>
              {visibleClients.filter((c) => (includeTestClients || c.id === scope || !hasTestSessionTitle(c.name)) && c.name.toLowerCase().includes(clientSearch.toLowerCase())).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selectedClient?.id === c.id}
                  className={`lw-lens__opt${selectedClient?.id === c.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setParam('client', c.id);
                    setLensOpen(false);
                  }}
                >
                  <span className="lw-lens__optname">{c.name}</span>
                </button>
              ))}
              <div className="lw-lens__note">
                The lens changes your private client analysis. It never changes the public record.
              </div>
            </div>
          ) : null}
          {/* PR C §16: a scoped client the directory no longer lists is an
              ARCHIVED/DELETED reference. The scope keeps working (historical
              data stays reachable) but the selector must not silently pretend
              the client is active. */}
          {scope && !selectedClient ? <LwPill tone="warning">ARCHIVED CLIENT SCOPE</LwPill> : null}
          <LwButton
            size="42"
            className="lw-header-action lw-header-action--search"
            onClick={() => setOverlay('search')}
            ariaLabel="Search LegiWatch"
            title="Search all LegiWatch"
          >
            <Search size={16} aria-hidden="true" />
            <span>Search all LegiWatch</span>
          </LwButton>
          <LwButton size="42" className="lw-header-shortcut" onClick={() => navigate(watchlistSetupPath(scope))} ariaLabel="Open watchlist and alerts">
            <Bell size={16} aria-hidden="true" />
            <span>Watchlist &amp; alerts</span>
          </LwButton>
          <button
            type="button"
            className="lw-iconbtn lw-header-action--settings"
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
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51 1Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <div className="lw-mobile-nav" aria-label="Mobile LegiWatch navigation">
        <label className="lw-mobile-nav__field">
          <span>Section</span>
          <select
            aria-label="LegiWatch section"
            value={primaryTab ?? ''}
            onChange={(event) => {
              if (event.target.value) setTab(event.target.value as LegiWatchTab);
            }}
          >
            <option value="" disabled hidden>
              —
            </option>
            {primaryTabs.map((t) => (
              <option key={t} value={t}>
                {TAB_HEAD[t].title}
              </option>
            ))}
            <option value="settings">Settings</option>
          </select>
        </label>
        <label className="lw-mobile-nav__field">
          <span>More</span>
          <select
            aria-label="More LegiWatch sections"
            value={LEGIWATCH_SECONDARY_TABS.includes(tab) ? tab : ''}
            onChange={(event) => {
              if (event.target.value) setTab(event.target.value as LegiWatchTab);
            }}
          >
            <option value="">More</option>
            {LEGIWATCH_SECONDARY_TABS.map((t) => (
              <option key={t} value={t}>
                {TAB_HEAD[t].title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <nav className="lw-tabs" aria-label="LegiWatch sections">
        <div className="lw-tabs__primary" role="tablist" aria-label="Primary sections">
          {primaryTabs.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={primaryTab === t} className={`lw-tab${primaryTab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
              <span>{TAB_HEAD[t].title}</span>
              {tabCount[t] != null && tabCount[t]! > 0 ? <span className="lw-tab__count">{tabCount[t]! > 999 ? '999+' : tabCount[t]}</span> : null}
            </button>
          ))}
        </div>
        <div className="lw-tabs__secondary" aria-label="More LegiWatch sections">
          {LEGIWATCH_SECONDARY_TABS.map((t) => (
            <button key={t} type="button" className={`lw-tab lw-tab--secondary${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
              {TAB_HEAD[t].title}
            </button>
          ))}
        </div>
      </nav>

      {coldStart ? (
        // §13: scoped + no approved watchlist + a watchlist-dependent tab.
        // Inline guidance — the module (tabs, client selector, public surfaces)
        // stays mounted; the dependent tab's body is what's replaced.
        <WatchlistGatePanel
          clientName={selectedClient?.name ?? ''}
          onConfigure={() => navigate(watchlistSetupPath(scope))}
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
          <div
            className="lw-card"
            style={{
              padding: '10px 18px',
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
            aria-label="Browse mode notice"
          >
            <LwPill tone="warning" size="22">
              BROWSE MODE
            </LwPill>
            <span style={{ fontSize: 13, color: 'var(--lw-body)' }}>
              Public LegiWatch data remains available. Client-specific alerts and relevance require
              a monitoring model.
            </span>
            <LwButton size="36" onClick={() => navigate(watchlistSetupPath(scope))}>
              Set up the watchlist
            </LwButton>
          </div>
          {tab === 'feed' ? (
            <FeedTab scope={scope} clients={visibleClients} />
          ) : tab === 'digest' ? (
            <DigestTab scope={scope} />
          ) : (
            <AnalyticsTab scope={scope} />
          )}
        </>
      ) : tab === 'hearings' ? (
        <HearingsTab scope={scope} />
      ) : tab === 'committees' ? (
        <CommitteesTab />
      ) : tab === 'feed' ? (
        <FeedTab scope={scope} clients={visibleClients} />
      ) : tab === 'bills' ? (
        <BillsTab scope={scope} clients={visibleClients} />
      ) : tab === 'news' || tab === 'budget' ? (
        <EvidenceTab lane={tab} />
      ) : tab === 'research' ? (
        <ResearchTab />
      ) : tab === 'digest' ? (
        <DigestTab scope={scope} />
      ) : tab === 'analytics' ? (
        <AnalyticsTab scope={scope} />
      ) : tab === 'settings' ? (
        <LegiWatchSettingsTab />
      ) : null}

      {overlay === 'search' ? (
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
      ) : null}
    </div>
  );
}
