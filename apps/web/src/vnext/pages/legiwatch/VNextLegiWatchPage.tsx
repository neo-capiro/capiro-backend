import { useMemo, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import type { UpcomingHearing } from '../../../lib/hearing-watch-api.js';
import { RadarPage } from '../../../pages/radar/RadarPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';
import {
  SOURCE_LABEL,
  feedQueryString,
  intelFeedKeys,
  intelFeedPaths,
  type FeedItem,
  type FeedResponse,
  type FeedSourceType,
} from '../../../pages/clients/tracker/intel-feed-api.js';
import './legiwatch.css';

type VNextLegiWatchTab =
  | 'overview'
  | 'feed'
  | 'bills'
  | 'hearings'
  | 'watchlist'
  | 'digest'
  | 'analytics';

const LEGACY_TABS = new Set<VNextLegiWatchTab>(['feed', 'bills', 'hearings', 'watchlist']);
const VALID_TABS = new Set<VNextLegiWatchTab>([
  'overview',
  'feed',
  'bills',
  'hearings',
  'watchlist',
  'digest',
  'analytics',
]);

const TAB_COPY: Record<VNextLegiWatchTab, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: 'Policy action center',
    title: 'LegiWatch',
    description: 'A decision-first view of legislative, regulatory, hearing, and budget movement across the portfolio.',
  },
  feed: {
    eyebrow: 'Alert worklist',
    title: 'Feed',
    description: 'Prioritized policy and funding movement, with the client impact and next action kept in view.',
  },
  bills: {
    eyebrow: 'Legislative portfolio',
    title: 'Bills',
    description: 'Track the federal and state measures that matter, their posture, movement, ownership, and client exposure.',
  },
  hearings: {
    eyebrow: 'Hearing watch',
    title: 'Hearings',
    description: 'Move from committee schedules to live transcription, watchlist hits, and durable hearing intelligence.',
  },
  watchlist: {
    eyebrow: 'Signal configuration',
    title: 'Watchlists',
    description: 'Define the issue areas, terms, bills, people, agencies, and programs LegiWatch should monitor for each client.',
  },
  digest: {
    eyebrow: 'Portfolio briefing',
    title: 'Digest',
    description: 'A compact briefing of the highest-priority movement in the current LegiWatch feed.',
  },
  analytics: {
    eyebrow: 'Coverage and movement',
    title: 'Analytics',
    description: 'See where alert volume, severity, and source movement are concentrating across the current scope.',
  },
};

/**
 * os.capiro.ai LegiWatch surface.
 *
 * Figma source set: 869:2502–869:4938 plus responsive frames 888:2593,
 * 889:2593 and 890:2593. The Overview/Digest/Analytics read the same production
 * intel-api feed that powers the canonical Feed. Existing Feed/Bills/Hearings/
 * Watchlist business logic is mounted as a presentation adapter, so triage,
 * memo/outreach actions, Bill 360, hearing sessions and watchlist mutations are
 * unchanged.
 */
export function VNextLegiWatchPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') as VNextLegiWatchTab | null;
  const tab = rawTab && VALID_TABS.has(rawTab) ? rawTab : 'overview';
  const clientId = searchParams.get('client');
  const tracker = useIntelFeature('tracker_v2');
  const hearingFeature = useIntelFeature('hearing_watch');

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
  const selectedClient = visibleClients.find((client) => client.id === clientId) ?? null;

  const feed = useQuery<FeedResponse>({
    queryKey: clientId
      ? intelFeedKeys.feed(clientId, 'all', 'score')
      : intelFeedKeys.tenantFeed('all', 'score'),
    queryFn: async () => {
      const path = clientId ? intelFeedPaths.feed(clientId) : intelFeedPaths.tenantFeed();
      return (await api.get<FeedResponse>(`${path}?${feedQueryString('all', 'score')}`)).data;
    },
    enabled: tracker.ready && tracker.enabled,
    staleTime: 30_000,
    retry: false,
  });

  const upcoming = useQuery<UpcomingHearing[]>({
    queryKey: ['intel', 'upcoming-hearings'],
    queryFn: async () => (await api.get<UpcomingHearing[]>('/intel-api/upcoming-hearings')).data,
    enabled: hearingFeature.ready && hearingFeature.enabled,
    retry: false,
    staleTime: 300_000,
  });

  const counts = useMemo(() => buildCounts(feed.data, upcoming.data), [feed.data, upcoming.data]);
  const scopeLabel = selectedClient?.name ?? 'All clients';
  const copy = TAB_COPY[tab];

  const setTab = (nextTab: VNextLegiWatchTab) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('tab', nextTab);
      if (nextTab !== 'feed') next.delete('alert');
      return next;
    }, { replace: true });
  };

  const setClient = (nextClientId: string) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextClientId) next.set('client', nextClientId);
      else next.delete('client');
      next.delete('alert');
      return next;
    }, { replace: true });
  };

  const openAlert = (item: FeedItem) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('tab', 'feed');
      next.set('alert', item.id);
      if (item.clientId) next.set('client', item.clientId);
      return next;
    }, { replace: true });
  };

  const tabs: Array<{ id: VNextLegiWatchTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'feed', label: 'Feed', count: counts.alerts },
    { id: 'bills', label: 'Bills', count: counts.bills },
    { id: 'hearings', label: 'Hearings', count: counts.hearings },
    { id: 'watchlist', label: 'Watchlists' },
    { id: 'digest', label: 'Digest' },
    { id: 'analytics', label: 'Analytics' },
  ];

  return (
    <div className="vnext-legiwatch" data-figma-page="868:2502">
      <header className="vnext-legiwatch__header">
        <div className="vnext-legiwatch__heading">
          <div className="vnext-legiwatch__eyebrow">{copy.eyebrow} · {scopeLabel}</div>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <div className="vnext-legiwatch__header-actions">
          {tab !== 'hearings' ? (
            <select
              aria-label="LegiWatch client scope"
              className="vnext-legiwatch__scope"
              value={selectedClient?.id ?? ''}
              onChange={(event) => setClient(event.target.value)}
            >
              <option value="">All clients</option>
              {visibleClients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
            </select>
          ) : null}
          <button className="vnext-legiwatch-button" type="button" disabled title="Saved views require the saved-view service before this control can be activated.">
            Saved Views
          </button>
          <button className="vnext-legiwatch-button is-primary" type="button" onClick={() => setTab('watchlist')}>
            Create Watch
          </button>
          <span className={`vnext-legiwatch-health${feed.isError ? ' is-error' : feed.isFetching ? ' is-refreshing' : ''}`}>
            <span aria-hidden="true" />
            {tracker.ready && !tracker.enabled
              ? 'Feed not enabled'
              : feed.isError
                ? 'Source status unavailable'
                : feed.isFetching
                  ? 'Refreshing sources'
                  : 'Live portfolio data'}
          </span>
        </div>
      </header>

      <nav className="vnext-legiwatch-tabs" aria-label="LegiWatch sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? 'is-active' : ''}
            onClick={() => setTab(item.id)}
            aria-current={tab === item.id ? 'page' : undefined}
          >
            {/* No glyph: 869:2502's tab rail is label + count only. */}
            <span>{item.label}</span>
            {item.count != null && item.count > 0 ? <span className="vnext-legiwatch-tabs__count">{item.count > 999 ? '999+' : item.count}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <LegiWatchOverview
          feed={feed.data}
          feedLoading={feed.isLoading}
          trackerEnabled={tracker.enabled}
          hearings={upcoming.data ?? []}
          counts={counts}
          onOpenAlert={openAlert}
        />
      ) : tab === 'digest' ? (
        <LegiWatchDigest feed={feed.data} loading={feed.isLoading} trackerEnabled={tracker.enabled} onOpenAlert={openAlert} />
      ) : tab === 'analytics' ? (
        <LegiWatchAnalytics feed={feed.data} loading={feed.isLoading} trackerEnabled={tracker.enabled} />
      ) : LEGACY_TABS.has(tab) ? (
        <div className={`vnext-legiwatch__legacy legacy-${tab}`} data-figma-node={legacyFigmaNode(tab)}>
          <RadarPage />
        </div>
      ) : null}
    </div>
  );
}

function LegiWatchOverview({
  feed,
  feedLoading,
  trackerEnabled,
  hearings,
  counts,
  onOpenAlert,
}: {
  feed?: FeedResponse;
  feedLoading: boolean;
  trackerEnabled: boolean;
  hearings: UpcomingHearing[];
  counts: LegiWatchCounts;
  onOpenAlert: (item: FeedItem) => void;
}) {
  const decisionItems = (feed?.items ?? []).slice(0, 4);
  const exposure = clientExposure(feed?.items ?? []);
  const windows = [...hearings]
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt))
    .slice(0, 4);

  return (
    <main className="vnext-legiwatch-overview" data-figma-node="869:2502">
      <section className="vnext-legiwatch-pulse">
        <div className="vnext-legiwatch-pulse__copy">
          <div className="vnext-legiwatch-pulse__eyebrow">Operational pulse</div>
          <strong>{counts.critical ? `${counts.critical} critical movement${counts.critical === 1 ? '' : 's'} need attention` : 'Portfolio monitoring is active'}</strong>
          <span>Current totals returned by LegiWatch for this scope.</span>
        </div>
        <PulseMetric label="Alerts" value={counts.alerts} />
        <PulseMetric label="Critical" value={counts.critical} tone="danger" />
        <PulseMetric label="Bill movement" value={counts.bills} />
        <PulseMetric label="Upcoming hearings" value={counts.hearings} />
      </section>

      <section className="vnext-legiwatch-decision-queue">
        <PanelHeader label="Decision queue" meta={`${decisionItems.length} highest-priority items`} />
        {!trackerEnabled ? (
          <PanelEmpty title="Feed not enabled" detail="The tenant-wide alert feed is gated off for this tenant." />
        ) : feedLoading ? (
          <PanelEmpty title="Loading decision queue…" detail="Reading the current LegiWatch priority feed." />
        ) : decisionItems.length === 0 ? (
          <PanelEmpty title="No active alerts" detail="New policy, hearing, regulatory, and funding movement will appear here." />
        ) : (
          <div className="vnext-legiwatch-decision-list">
            {decisionItems.map((item) => (
              <button key={item.id} className={`vnext-legiwatch-decision severity-${item.severity}`} type="button" onClick={() => onOpenAlert(item)}>
                <div className="vnext-legiwatch-decision__meta">
                  <span>{item.clientName ?? 'Client'}</span>
                  <span>{SOURCE_LABEL[item.sourceType]}</span>
                  {item.urgency ? <span>{item.urgency}</span> : null}
                </div>
                <strong>{item.title}</strong>
                <p>{item.whyItMatters || 'Client relevance is still being resolved.'}</p>
                <div className="vnext-legiwatch-decision__foot">
                  <span>{item.recommendedAction || item.recommendedActions?.[0]?.label || 'Review alert'}</span>
                  <span aria-hidden="true">›</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="vnext-legiwatch-exposure">
        <PanelHeader label="Client exposure" meta="Current priority window" />
        {exposure.length === 0 ? (
          <PanelEmpty title="No client exposure yet" detail="Client concentration appears as feed items arrive." />
        ) : (
          <div className="vnext-legiwatch-exposure__list">
            {exposure.slice(0, 5).map((client) => (
              <div className="vnext-legiwatch-exposure__row" key={client.clientId}>
                <div className="vnext-legiwatch-exposure__top">
                  <strong>{client.name}</strong>
                  <span>{client.count} alert{client.count === 1 ? '' : 's'}{client.critical ? ` · ${client.critical} critical` : ''}</span>
                </div>
                <div className="vnext-legiwatch-exposure__track"><span style={{ width: `${client.share}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="vnext-legiwatch-windows">
        <PanelHeader label="Today and next windows" meta="Hearing Watch" />
        {windows.length === 0 ? (
          <PanelEmpty title="No upcoming hearings" detail="The current Hearing Watch window has no scheduled items." />
        ) : (
          <div className="vnext-legiwatch-window-list">
            {windows.map((hearing) => (
              <div className="vnext-legiwatch-window" key={hearing.id}>
                <div className="vnext-legiwatch-window__date">{formatHearingDate(hearing.scheduledAt)}</div>
                <div className="vnext-legiwatch-window__copy">
                  <strong>{hearing.title}</strong>
                  <span>{[hearing.committee, hearing.time, hearing.chamber].filter(Boolean).join(' · ')}</span>
                </div>
                {hearing.watchlistMatchCount ? <span className="vnext-legiwatch-window__matches">{hearing.watchlistMatchCount} matches</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function LegiWatchDigest({
  feed,
  loading,
  trackerEnabled,
  onOpenAlert,
}: {
  feed?: FeedResponse;
  loading: boolean;
  trackerEnabled: boolean;
  onOpenAlert: (item: FeedItem) => void;
}) {
  const groups = useMemo(() => groupFeedByClient((feed?.items ?? []).slice(0, 12)), [feed?.items]);
  return (
    <main className="vnext-legiwatch-single" data-figma-node="869:4126">
      <div className="vnext-legiwatch-section-intro">
        <div>
          <span className="vnext-legiwatch-section-intro__eyebrow">Current briefing</span>
          <h2>What changed and who needs to know</h2>
        </div>
        <span>Built from the same live alert feed — no separate generated copy.</span>
      </div>
      {!trackerEnabled ? (
        <PanelEmpty title="Feed not enabled" detail="Digest becomes available with the LegiWatch tenant feed." />
      ) : loading ? (
        <PanelEmpty title="Building the current digest…" detail="Reading the priority feed." />
      ) : groups.length === 0 ? (
        <PanelEmpty title="Nothing to brief yet" detail="The digest fills as alerts enter the feed." />
      ) : (
        <div className="vnext-legiwatch-digest-grid">
          {groups.map((group) => (
            <section className="vnext-legiwatch-digest-card" key={group.clientId}>
              <header><span>{group.clientName}</span><strong>{group.items.length}</strong></header>
              {group.items.map((item) => (
                <button type="button" key={item.id} onClick={() => onOpenAlert(item)}>
                  <span className={`vnext-legiwatch-dot severity-${item.severity}`} />
                  <span><strong>{item.title}</strong><small>{SOURCE_LABEL[item.sourceType]} · {item.urgency || 'Review when ready'}</small></span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function LegiWatchAnalytics({ feed, loading, trackerEnabled }: { feed?: FeedResponse; loading: boolean; trackerEnabled: boolean }) {
  const sourceRows = useMemo(() => {
    const rows = Object.entries(feed?.counts ?? {})
      .map(([source, count]) => ({ source: source as FeedSourceType, count: count ?? 0 }))
      .filter((row) => row.count > 0)
      .sort((left, right) => right.count - left.count);
    const max = Math.max(...rows.map((row) => row.count), 1);
    return rows.map((row) => ({ ...row, share: Math.round((row.count / max) * 100) }));
  }, [feed?.counts]);
  const severity = feed?.severityCounts ?? {};
  const severityRows = [
    { label: 'Critical', value: severity.critical ?? 0, tone: 'danger' },
    { label: 'Notable', value: severity.notable ?? 0, tone: 'warning' },
    { label: 'Informational', value: severity.info ?? 0, tone: 'info' },
  ];
  const maxSeverity = Math.max(...severityRows.map((row) => row.value), 1);

  return (
    <main className="vnext-legiwatch-single" data-figma-node="869:4329">
      <div className="vnext-legiwatch-section-intro">
        <div>
          <span className="vnext-legiwatch-section-intro__eyebrow">Current feed distribution</span>
          <h2>Where movement is concentrating</h2>
        </div>
        <span>Counts are read directly from the current intel-api feed response.</span>
      </div>
      {!trackerEnabled ? (
        <PanelEmpty title="Feed not enabled" detail="Analytics becomes available with the LegiWatch tenant feed." />
      ) : loading ? (
        <PanelEmpty title="Loading analytics…" detail="Reading source and severity totals." />
      ) : (
        <div className="vnext-legiwatch-analytics-grid">
          <section className="vnext-legiwatch-analytics-card">
            <PanelHeader label="Movement by source" meta="Current scope" />
            <div className="vnext-legiwatch-analytics-rows">
              {sourceRows.map((row) => (
                <AnalyticsRow key={row.source} label={SOURCE_LABEL[row.source]} value={row.count} share={row.share} />
              ))}
              {sourceRows.length === 0 ? <PanelEmpty title="No source movement" detail="No feed counts are available yet." /> : null}
            </div>
          </section>
          <section className="vnext-legiwatch-analytics-card">
            <PanelHeader label="Severity distribution" meta="Current scope" />
            <div className="vnext-legiwatch-analytics-rows">
              {severityRows.map((row) => (
                <AnalyticsRow key={row.label} label={row.label} value={row.value} share={Math.round((row.value / maxSeverity) * 100)} tone={row.tone} />
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function AnalyticsRow({ label, value, share, tone = 'accent' }: { label: string; value: number; share: number; tone?: string }) {
  return (
    <div className={`vnext-legiwatch-analytics-row tone-${tone}`}>
      <div><strong>{label}</strong><span>{value}</span></div>
      <div className="vnext-legiwatch-analytics-track"><span style={{ width: `${share}%` }} /></div>
    </div>
  );
}

function PulseMetric({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className={`vnext-legiwatch-pulse__metric${tone ? ` tone-${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelHeader({ label, meta }: { label: string; meta?: string }) {
  return (
    <header className="vnext-legiwatch-panel-head">
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </header>
  );
}

function PanelEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="vnext-legiwatch-panel-empty">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

interface LegiWatchCounts {
  alerts: number;
  critical: number;
  bills: number;
  hearings: number;
}

export function buildCounts(feed?: FeedResponse, hearings?: UpcomingHearing[]): LegiWatchCounts {
  const severityTotal = Object.values(feed?.severityCounts ?? {}).reduce((sum, count) => sum + (count ?? 0), 0);
  const sourceTotal = Object.values(feed?.counts ?? {}).reduce((sum, count) => sum + (count ?? 0), 0);
  return {
    alerts: severityTotal || sourceTotal || feed?.items.length || 0,
    critical: feed?.severityCounts?.critical ?? 0,
    bills: (feed?.counts?.bill ?? 0) + (feed?.counts?.state_bill ?? 0),
    hearings: hearings?.length ?? 0,
  };
}

function clientExposure(items: FeedItem[]) {
  const map = new Map<string, { clientId: string; name: string; count: number; critical: number }>();
  for (const item of items) {
    const current = map.get(item.clientId) ?? {
      clientId: item.clientId,
      name: item.clientName ?? 'Client',
      count: 0,
      critical: 0,
    };
    current.count += 1;
    if (item.severity === 'critical') current.critical += 1;
    map.set(item.clientId, current);
  }
  const rows = [...map.values()].sort((left, right) => right.count - left.count || right.critical - left.critical);
  const max = Math.max(...rows.map((row) => row.count), 1);
  return rows.map((row) => ({ ...row, share: Math.round((row.count / max) * 100) }));
}

function groupFeedByClient(items: FeedItem[]) {
  const map = new Map<string, { clientId: string; clientName: string; items: FeedItem[] }>();
  for (const item of items) {
    const current = map.get(item.clientId) ?? {
      clientId: item.clientId,
      clientName: item.clientName ?? 'Client',
      items: [],
    };
    current.items.push(item);
    map.set(item.clientId, current);
  }
  return [...map.values()];
}

function formatHearingDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '');
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function legacyFigmaNode(tab: VNextLegiWatchTab): string {
  if (tab === 'feed') return '869:2705';
  if (tab === 'bills') return '869:3111';
  if (tab === 'hearings') return '869:3517';
  if (tab === 'watchlist') return '869:3923';
  return '869:2502';
}
