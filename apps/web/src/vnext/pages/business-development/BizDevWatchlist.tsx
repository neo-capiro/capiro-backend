/**
 * Business Development v5 — top-level Watchlist view.
 *
 * Lists the firm's prospects from the EXISTING
 * Phase 1 list endpoint, then performs a BOUNDED client-side fan-out of the
 * EXISTING Phase 5 per-prospect watch/alert GETs (getBizDevProspectWatch,
 * getBizDevProspectAlerts) over the currently loaded prospects only. It never
 * calls a provider or invents scenario/digest/delivery controls. Alert actions
 * use the existing Phase 5 endpoints. Opening a prospect routes to the same
 * drawer where the watch controls and evidence live.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { openVNextMeriWorkspaceWindow } from '../../../components/chat/meri-window.js';
import {
  applyBizDevRoute,
} from './bizdev-routing.js';
import {
  bizdevKeys,
  bizdevErrorMessage,
  getBizDevProspectAlerts,
  getBizDevProspectWatch,
  listBizDevProspects,
  markBizDevAlertRead,
  dismissBizDevAlert,
  updateBizDevWatch,
  bizdevWatchKeys,
  BIZDEV_SOURCE_HEALTH_LABELS,
  type BizDevMemberOption,
  type BizDevProspect,
  type BizDevProspectAlert,
  type BizDevWatchSourceHealth,
  type BizDevUpdateWatchInput,
} from './bizdev-api.js';

/** Hard cap on prospect fan-out per page. Each watch may also load alerts. */
export const BIZDEV_WATCHLIST_FANOUT_LIMIT = 12;

type WatchPayload = {
  prospect: BizDevProspect;
  watch: Awaited<ReturnType<typeof getBizDevProspectWatch>> | null;
  alerts: BizDevProspectAlert[];
  error: string | null;
};

function fanoutKey(tenantId: string) {
  return bizdevKeys.lists(tenantId, { watchlistFanout: true });
}

/** Bounded fan-out over the currently loaded prospects (no new endpoint). */
function useWatchlistFanout(
  tenantId: string,
  prospects: BizDevProspect[],
  enabled: boolean,
) {
  const api = useApi();
  return useQuery({
    queryKey: [...fanoutKey(tenantId), prospects.map((p) => p.id).join(',')],
    queryFn: async (): Promise<WatchPayload[]> => {
      const watchedIds = prospects
        .filter((p) => p.status === 'active')
        .slice(0, BIZDEV_WATCHLIST_FANOUT_LIMIT);
      return Promise.all(
        watchedIds.map(async (prospect) => {
          try {
            const watch = await getBizDevProspectWatch(api, prospect.id);
            if (!watch.watch) return { prospect, watch, alerts: [], error: null };
            // Alerts only for prospects that actually have a watch; bounded
            // by the existing endpoint's limit parameter.
            const alerts = await getBizDevProspectAlerts(api, prospect.id, 10);
            return {
              prospect,
              watch,
              alerts: (alerts.items ?? []).filter((a) => !a.dismissedAt),
              error: null,
            };
          } catch (error) {
            // One prospect failing must never break the whole view.
            return {
              prospect,
              watch: null,
              alerts: [],
              error: bizdevErrorMessage(error),
            };
          }
        }),
      );
    },
    // Never fan out when the watch feature flag is off.
    enabled: enabled && prospects.length > 0,
    staleTime: 30_000,
  });
}

function memberName(m: BizDevMemberOption | undefined): string {
  if (!m) return '';
  return [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email || '';
}

function WatchStatusPill({ status }: { status: string }) {
  const label = status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Ended';
  return <span className={`capiro-bizdev__pill capiro-bizdev__pill--${status}`}>{label}</span>;
}

const SOURCE_NAMES: Record<string, string> = {
  federal_award: 'USAspending contracts',
  federal_assistance_award: 'USAspending assistance',
  sam_opportunity: 'SAM opportunities',
  tango_resource: 'Tango records',
  lda_filing: 'LDA filings',
  usaspending_contract: 'USAspending contracts',
};

function sourceName(source: string): string {
  return SOURCE_NAMES[source.toLowerCase()] ?? source;
}

function checkedDate(value: string | null): string {
  if (!value) return 'Not supplied';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not supplied' : date.toLocaleString();
}

export const BIZDEV_WATCH_MERI_PROMPT =
  'Explain what changed for the active prospect using its authorized watch alerts and evidence. ' +
  'Distinguish event, publication, and first-observed dates. Cite the precise sources, ' +
  'separate verified changes from inferred implications, and describe missing or stale coverage. ' +
  'Do not draft or send outreach.';

function WatchlistProspectCard({
  tenantId,
  payload,
  members,
  onOpen,
}: {
  tenantId: string;
  payload: WatchPayload;
  members: BizDevMemberOption[];
  onOpen: (id: string) => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const actionPending = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { prospect, watch, error } = payload;
  const w = watch?.watch ?? null;
  const sources = watch?.sources ?? [];
  const memberById = new Map(members.map((m) => [m.id, m]));
  const owner = w?.ownerUserId ? memberById.get(w.ownerUserId) : undefined;
  const muted = Boolean(w?.mutedUntil && new Date(w.mutedUntil).getTime() > Date.now());
  const update = useMutation({
    mutationFn: (input: BizDevUpdateWatchInput) => updateBizDevWatch(api, prospect.id, input),
    onSuccess: async (result) => {
      setActionError(null);
      queryClient.setQueryData(bizdevWatchKeys.watch(tenantId, prospect.id), result);
      queryClient.setQueriesData<WatchPayload[]>({ queryKey: fanoutKey(tenantId) }, (current) =>
        current?.map((row) => row.prospect.id === prospect.id ? { ...row, watch: result } : row),
      );
      await queryClient.invalidateQueries({ queryKey: fanoutKey(tenantId) });
      void queryClient.invalidateQueries({ queryKey: bizdevKeys.history(tenantId, prospect.id) });
    },
    onError: (failure) => setActionError(bizdevErrorMessage(failure)),
    onSettled: () => { actionPending.current = false; },
  });
  const changeWatch = (input: BizDevUpdateWatchInput) => {
    if (actionPending.current) return;
    actionPending.current = true;
    update.mutate(input);
  };
  return (
    <li className="capiro-bizdev__card capiro-bizdev__watch-prospect">
      <div className="capiro-bizdev__card-head">
        <button
          type="button"
          className="capiro-bizdev__name-btn"
          onClick={() => onOpen(prospect.id)}
        >
          {prospect.displayName}
        </button>
        {w ? <WatchStatusPill status={w.status} /> : null}
        {muted ? <span className="capiro-bizdev__pill">Muted</span> : null}
        {payload.alerts.some((a) => !a.readAt) ? (
          <span className="capiro-bizdev__pill capiro-bizdev__pill--alert">
            {payload.alerts.filter((a) => !a.readAt).length} new
          </span>
        ) : null}
      </div>
      <p className="capiro-bizdev__meta">
        {error
          ? 'Watch status is temporarily unavailable for this prospect.'
          : `${w ? (owner ? `Watched by ${memberName(owner)}` : 'Watch configured') : 'No watch yet for this prospect.'} · ${
              watch?.lastCompletedCheckAt
                ? `Last completed check ${checkedDate(watch.lastCompletedCheckAt)}`
                : 'no completed check yet'
            }`}
      </p>
      {error ? (
        <p role="status" className="capiro-bizdev__meta">
          Watch status could not be loaded right now: {error}
        </p>
      ) : null}
      {sources.length > 0 ? (
        <ul className="capiro-bizdev__source-health" aria-label={`Source health for ${prospect.displayName}`}>
          {sources.map((source) => (
            <li key={source.source}>
              <span className="capiro-bizdev__history-kind">{sourceName(source.source)}</span>
              <span>
                {BIZDEV_SOURCE_HEALTH_LABELS[source.health as BizDevWatchSourceHealth] ??
                  `Health: ${source.health}`}
                {source.lastCheckedAt
                  ? ` · Last check ${checkedDate(source.lastCheckedAt)}`
                  : ''}
                {source.detail ? (
                  <details className="capiro-bizdev__watch-source-detail">
                    <summary>Check details</summary>
                    <p>{source.detail}</p>
                  </details>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="capiro-bizdev__actions">
        {w ? (
          <CapiroButton
            size="compact"
            variant="quiet"
            disabled={update.isPending}
            onClick={() => changeWatch({ status: w.status === 'active' ? 'paused' : 'active' })}
          >
            {w.status === 'active' ? 'Pause' : w.status === 'paused' ? 'Resume' : 'Restart'}
          </CapiroButton>
        ) : null}
        {w?.status === 'active' ? (
          <CapiroButton
            size="compact"
            variant="quiet"
            disabled={update.isPending}
            onClick={() => changeWatch({ mutedUntil: muted ? null : new Date(Date.now() + 7 * 864e5).toISOString() })}
          >
            {muted ? 'Unmute' : 'Mute for 7 days'}
          </CapiroButton>
        ) : null}
        <CapiroButton size="compact" onClick={() => onOpen(prospect.id)}>
          Open prospect
        </CapiroButton>
      </div>
      {actionError ? <p role="alert" className="capiro-bizdev__statusnote capiro-bizdev__statusnote--warn">Watch update failed: {actionError}</p> : null}
    </li>
  );
}

export function BizDevWatchlist({
  tenantId,
  members,
  watchAlertsEnabled,
  meriProspectToolsEnabled = false,
}: {
  tenantId: string;
  members: BizDevMemberOption[];
  watchAlertsEnabled: boolean;
  meriProspectToolsEnabled?: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [category, setCategory] = useState('all');
  const [watchPage, setWatchPage] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);
  const pendingAlertRef = useRef<string | null>(null);

  // The EXISTING list endpoint with status=all so watched-but-dismissed or
  // any visible prospects can appear; the fan-out filters to active ones.
  const list = useQuery({
    queryKey: bizdevKeys.lists(tenantId, { status: 'all' }),
    queryFn: () => listBizDevProspects(api, { status: 'all' }),
  });

  const prospects = list.data?.prospects ?? [];
  const activeProspects = prospects.filter((prospect) => prospect.status === 'active');
  const pageCount = Math.max(1, Math.ceil(activeProspects.length / BIZDEV_WATCHLIST_FANOUT_LIMIT));
  const pageIndex = Math.min(watchPage, pageCount - 1);
  const pageProspects = activeProspects.slice(
    pageIndex * BIZDEV_WATCHLIST_FANOUT_LIMIT,
    (pageIndex + 1) * BIZDEV_WATCHLIST_FANOUT_LIMIT,
  );
  const fanout = useWatchlistFanout(tenantId, pageProspects, watchAlertsEnabled);
  const payloads = fanout.data ?? [];
  const watchedPayloads = payloads.filter((p) => p.watch?.watch);
  // Keep failed rows visible. Otherwise a transient watch endpoint failure
  // would be misreported as the truthful-empty "No watched prospects" state.
  const visiblePayloads = payloads.filter((p) => p.watch?.watch || p.error != null);
  const totalUnread = watchedPayloads.reduce(
    (n, p) => n + p.alerts.filter((a) => !a.readAt).length,
    0,
  );
  const feed = watchedPayloads.flatMap((payload) =>
    payload.alerts.map((alert) => ({ alert, prospect: payload.prospect })),
  ).sort((a, b) => {
    const timestamp = (alert: BizDevProspectAlert) =>
      Date.parse(alert.firstObservedAt ?? alert.publishedAt ?? alert.eventAt ?? '') || 0;
    return timestamp(b.alert) - timestamp(a.alert);
  });
  const categories = [...new Set(feed.map(({ alert }) => alert.category).filter((value): value is string => Boolean(value)))].sort();
  const filteredFeed = category === 'all' ? feed : feed.filter(({ alert }) => alert.category === category);

  const finishAlertAction = () => {
    pendingAlertRef.current = null;
    setPendingAlertId(null);
  };
  const invalidateAlerts = (prospectId: string) => {
    void queryClient.invalidateQueries({ queryKey: fanoutKey(tenantId) });
    void queryClient.invalidateQueries({ queryKey: bizdevWatchKeys.alerts(tenantId, prospectId) });
  };
  const markRead = useMutation({
    mutationFn: ({ prospectId, alertId }: { prospectId: string; alertId: string }) =>
      markBizDevAlertRead(api, prospectId, alertId),
    onSuccess: (_result, { prospectId }) => {
      setActionError(null);
      finishAlertAction();
      invalidateAlerts(prospectId);
    },
    onError: (error) => {
      finishAlertAction();
      setActionError(bizdevErrorMessage(error));
    },
  });
  const dismiss = useMutation({
    mutationFn: ({ prospectId, alertId }: { prospectId: string; alertId: string }) =>
      dismissBizDevAlert(api, prospectId, alertId),
    onSuccess: (_result, { prospectId }) => {
      setActionError(null);
      finishAlertAction();
      invalidateAlerts(prospectId);
    },
    onError: (error) => {
      finishAlertAction();
      setActionError(bizdevErrorMessage(error));
    },
  });
  const runAlertAction = (prospectId: string, alertId: string, action: 'read' | 'dismiss') => {
    if (pendingAlertRef.current) return;
    pendingAlertRef.current = alertId;
    setPendingAlertId(alertId);
    if (action === 'read') markRead.mutate({ prospectId, alertId });
    else dismiss.mutate({ prospectId, alertId });
  };

  const openProspect = (id: string) =>
    setSearchParams(applyBizDevRoute(searchParams, { prospectId: id, status: 'all' }));

  return (
    <section className="capiro-bizdev__watchlist-page" aria-labelledby="bizdev-watchlist">
      <div className="capiro-bizdev__toolbar">
        <div className="capiro-bizdev__title-row">
          <h2 className="capiro-bizdev__section-title" id="bizdev-watchlist">
            Watchlist
          </h2>
          <span className="capiro-bizdev__count">
            {!watchAlertsEnabled
              ? 'Reporting disabled'
              : fanout.isPending && activeProspects.length > 0
              ? '…'
              : `${watchedPayloads.length} watched · ${totalUnread} unread alerts`}
          </span>
        </div>
      </div>
      <p className="capiro-bizdev__discover-note capiro-bizdev__meta">
        {watchAlertsEnabled
          ? 'Recent alerts from watched prospects, with their source health and last completed checks.'
          : 'Watch and alert reporting is not enabled for your firm yet; watch choices are saved but no checks run.'}
      </p>

      {list.isPending ? (
        <div className="capiro-bizdev__section-pad" aria-busy="true">
          <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" />
        </div>
      ) : list.isError ? (
        <div className="capiro-bizdev__section-pad">
          <CapiroErrorState
            title="The watchlist could not be loaded"
            description={bizdevErrorMessage(list.error)}
            onRetry={() => void list.refetch()}
            retryLabel="Retry"
          />
        </div>
      ) : !watchAlertsEnabled ? (
        <div className="capiro-bizdev__section-pad">
          <CapiroEmptyState
            variant="search-empty"
            title="Watch reporting is not enabled yet"
            description="Your watch choices are saved for later, but source checks and alerts are not running for your firm."
          />
        </div>
      ) : activeProspects.length === 0 ? (
        <div className="capiro-bizdev__section-pad">
          <CapiroEmptyState
            variant="first-use"
            title="No prospects to watch yet"
            description="Add prospects in the Pipeline view first; then activate a watch from each prospect."
          />
        </div>
      ) : fanout.isPending ? (
        <div className="capiro-bizdev__section-pad" aria-busy="true">
          <div className="capiro-portfolio__skeleton capiro-portfolio__skeleton--tall" />
        </div>
      ) : visiblePayloads.length === 0 ? (
        <div className="capiro-bizdev__section-pad">
          <CapiroEmptyState
            variant="search-empty"
            title="No watched prospects yet"
            description="Open a prospect in the Pipeline and activate a watch to see it here with its source health and alerts."
          />
        </div>
      ) : (
        <div className="capiro-bizdev__watchlist-layout">
          <section className="capiro-bizdev__watchlist-main" aria-labelledby="bizdev-watchlist-feed-title">
            <div className="capiro-bizdev__watchlist-section-head">
              <div>
                <h3 id="bizdev-watchlist-feed-title">Recent changes</h3>
                <p className="capiro-bizdev__meta">{feed.length} alerts from the loaded watched prospects</p>
              </div>
              {categories.length > 1 ? (
                <label className="capiro-bizdev__watchlist-filter">
                  Category
                  <select value={category} onChange={(event) => setCategory(event.target.value)}>
                    <option value="all">All categories</option>
                    {categories.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
            {actionError ? <p role="alert" className="capiro-bizdev__statusnote capiro-bizdev__statusnote--warn">Alert action failed: {actionError}</p> : null}
            {filteredFeed.length === 0 ? (
              <p className="capiro-bizdev__meta capiro-bizdev__watchlist-quiet">
                {feed.length === 0 ? 'No alerts from the loaded watches yet.' : 'No alerts in this category.'}
              </p>
            ) : (
              <ul className="capiro-bizdev__alert-feed" aria-label="Recent watch alerts">
                {filteredFeed.map(({ alert, prospect }) => (
                  <li key={`${prospect.id}:${alert.id}`} className="capiro-bizdev__alert-card">
                    <div className="capiro-bizdev__title-row">
                      <strong>{alert.title}</strong>
                      {alert.readAt ? <span className="capiro-bizdev__meta">Read</span> : <span className="capiro-bizdev__pill capiro-bizdev__pill--alert">New</span>}
                    </div>
                    <p className="capiro-bizdev__meta capiro-bizdev__watchlist-alert-meta">
                      {[prospect.displayName, alert.category ?? (alert.sourceFamily ? sourceName(alert.sourceFamily) : null),
                      ].filter(Boolean).join(' · ')}
                    </p>
                    {alert.summary ? <p className="capiro-bizdev__watchlist-alert-text">{alert.summary}</p> : null}
                    {alert.materiality ? <p className="capiro-bizdev__meta capiro-bizdev__watchlist-alert-meta">Materiality: {alert.materiality}</p> : null}
                    {alert.implication ? <p className="capiro-bizdev__meta capiro-bizdev__watchlist-alert-meta">Inference: {alert.implication}</p> : null}
                    <p className="capiro-bizdev__meta capiro-bizdev__watchlist-alert-dates">
                      <span>Event: {checkedDate(alert.eventAt)}</span>
                      {alert.effectiveAt ? <span>Effective: {checkedDate(alert.effectiveAt)}</span> : null}
                      <span>Published: {checkedDate(alert.publishedAt)}</span>
                      <span>First observed: {checkedDate(alert.firstObservedAt)}</span>
                    </p>
                    <div className="capiro-bizdev__actions capiro-bizdev__watchlist-alert-actions">
                      <CapiroButton size="compact" onClick={() => openProspect(prospect.id)}>Open prospect / evidence</CapiroButton>
                      {meriProspectToolsEnabled ? (
                        <CapiroButton variant="quiet" size="compact" onClick={() => openVNextMeriWorkspaceWindow(window, window.location.origin, { prospectId: prospect.id, prompt: BIZDEV_WATCH_MERI_PROMPT })}>
                          Ask Meri what changed
                        </CapiroButton>
                      ) : null}
                      {!alert.readAt ? <CapiroButton size="compact" disabled={pendingAlertId !== null} onClick={() => runAlertAction(prospect.id, alert.id, 'read')}>Mark read</CapiroButton> : null}
                      <CapiroButton size="compact" disabled={pendingAlertId !== null} onClick={() => runAlertAction(prospect.id, alert.id, 'dismiss')}>Dismiss</CapiroButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <aside className="capiro-bizdev__watchlist-side" aria-labelledby="bizdev-watchlist-prospects-title">
            <div className="capiro-bizdev__watchlist-section-head">
              <div>
                <h3 id="bizdev-watchlist-prospects-title">Watched prospects</h3>
                <p className="capiro-bizdev__meta">Status and source health</p>
              </div>
            </div>
            <ul className="capiro-bizdev__watchlist">
              {visiblePayloads.map((payload) => (
                <WatchlistProspectCard
                  key={payload.prospect.id}
                  tenantId={tenantId}
                  payload={payload}
                  members={members}
                  onOpen={openProspect}
                />
              ))}
            </ul>
          </aside>
        </div>
      )}
      {pageCount > 1 ? (
        <nav className="capiro-bizdev__watchlist-pagination" aria-label="Watchlist pages">
          <span className="capiro-bizdev__meta">
            {pageIndex === 0
              ? `Showing the first ${BIZDEV_WATCHLIST_FANOUT_LIMIT} active prospects.`
              : `Showing active prospects ${pageIndex * BIZDEV_WATCHLIST_FANOUT_LIMIT + 1}–${Math.min((pageIndex + 1) * BIZDEV_WATCHLIST_FANOUT_LIMIT, activeProspects.length)}.`}
            {' '}Page {pageIndex + 1} of {pageCount}. Counts and alerts reflect this page.
          </span>
          <CapiroButton size="compact" disabled={pageIndex === 0} onClick={() => { setWatchPage(pageIndex - 1); setCategory('all'); }}>Previous watches</CapiroButton>
          <CapiroButton size="compact" disabled={pageIndex + 1 === pageCount} onClick={() => { setWatchPage(pageIndex + 1); setCategory('all'); }}>Next watches</CapiroButton>
        </nav>
      ) : null}
    </section>
  );
}
