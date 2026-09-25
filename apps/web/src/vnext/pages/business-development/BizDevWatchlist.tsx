/**
 * Business Development v5 — top-level Watchlist view.
 *
 * A pure aggregation surface: it lists the firm's prospects from the EXISTING
 * Phase 1 list endpoint, then performs a BOUNDED client-side fan-out of the
 * EXISTING Phase 5 per-prospect watch/alert GETs (getBizDevProspectWatch,
 * getBizDevProspectAlerts) over the currently loaded prospects only. It never
 * calls a provider, never mutates, and invents no scenario/digest/delivery
 * controls — every control here maps to a real Phase 5 endpoint. Opening a
 * prospect routes to the exact same drawer where the real watch controls live.
 */
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState } from '../../components/feedback/index.js';
import { formatDateShort } from '../../lib/labels.js';
import {
  applyBizDevRoute,
} from './bizdev-routing.js';
import {
  bizdevKeys,
  bizdevErrorMessage,
  getBizDevProspectAlerts,
  getBizDevProspectWatch,
  listBizDevProspects,
  BIZDEV_SOURCE_HEALTH_LABELS,
  type BizDevMemberOption,
  type BizDevProspect,
  type BizDevProspectAlert,
  type BizDevWatchSourceHealth,
} from './bizdev-api.js';

/** Hard cap on fan-out requests: the first N active prospects only. */
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

function WatchlistProspectCard({
  payload,
  members,
  onOpen,
  alertCount,
}: {
  payload: WatchPayload;
  members: BizDevMemberOption[];
  onOpen: (id: string) => void;
  alertCount: number;
}) {
  const { prospect, watch, alerts, error } = payload;
  const w = watch?.watch ?? null;
  const sources = watch?.sources ?? [];
  const memberById = new Map(members.map((m) => [m.id, m]));
  const owner = w?.ownerUserId ? memberById.get(w.ownerUserId) : undefined;
  const muted = Boolean(w?.mutedUntil && new Date(w.mutedUntil).getTime() > Date.now());
  return (
    <li className="capiro-bizdev__card">
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
        {alertCount > 0 ? (
          <span className="capiro-bizdev__pill capiro-bizdev__pill--alert">{alertCount} new</span>
        ) : null}
      </div>
      <p className="capiro-bizdev__meta">
        {error
          ? 'Watch status is temporarily unavailable for this prospect.'
          : `${w ? (owner ? `Watched by ${memberName(owner)}` : 'Watch active') : 'No watch yet for this prospect.'} · ${
              watch?.lastCompletedCheckAt
                ? `Last completed check ${formatDateShort(watch.lastCompletedCheckAt) ?? watch.lastCompletedCheckAt}`
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
              <span className="capiro-bizdev__history-kind">{source.source}</span>
              <span>
                {BIZDEV_SOURCE_HEALTH_LABELS[source.health as BizDevWatchSourceHealth] ??
                  `Health: ${source.health}`}
                {source.lastCheckedAt
                  ? ` · Last check ${formatDateShort(source.lastCheckedAt) ?? source.lastCheckedAt}`
                  : ''}
                {source.detail ? ` · ${source.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {alerts.length > 0 ? (
        <ul className="capiro-bizdev__alert-feed" aria-label={`Alerts for ${prospect.displayName}`}>
          {alerts.map((alert) => (
            <li key={alert.id} className="capiro-bizdev__alert-card">
              <div className="capiro-bizdev__title-row">
                <strong>{alert.title}</strong>
                {alert.readAt ? <span className="capiro-bizdev__meta">Read</span> : null}
              </div>
              {alert.company || alert.category || alert.sourceFamily ? (
                <p className="capiro-bizdev__meta" style={{ margin: 0 }}>
                  {[alert.company, alert.category ?? alert.sourceFamily].filter(Boolean).join(' · ')}
                </p>
              ) : null}
              <p className="capiro-bizdev__meta" style={{ margin: 0 }}>
                Open the prospect to mark read or dismiss.
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="capiro-bizdev__actions">
        <CapiroButton size="compact" onClick={() => onOpen(prospect.id)}>
          Open prospect
        </CapiroButton>
      </div>
    </li>
  );
}

export function BizDevWatchlist({
  tenantId,
  members,
  watchAlertsEnabled,
}: {
  tenantId: string;
  members: BizDevMemberOption[];
  watchAlertsEnabled: boolean;
}) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  // The EXISTING list endpoint with status=all so watched-but-dismissed or
  // any visible prospects can appear; the fan-out filters to active ones.
  const list = useQuery({
    queryKey: bizdevKeys.lists(tenantId, { status: 'all' }),
    queryFn: () => listBizDevProspects(api, { status: 'all' }),
  });

  const prospects = list.data?.prospects ?? [];
  const fanout = useWatchlistFanout(tenantId, prospects, watchAlertsEnabled);
  const payloads = fanout.data ?? [];
  const watchedPayloads = payloads.filter((p) => p.watch?.watch);
  // Keep failed rows visible. Otherwise a transient watch endpoint failure
  // would be misreported as the truthful-empty "No watched prospects" state.
  const visiblePayloads = payloads.filter((p) => p.watch?.watch || p.error != null);
  const totalUnread = watchedPayloads.reduce(
    (n, p) => n + p.alerts.filter((a) => !a.readAt).length,
    0,
  );

  const openProspect = (id: string) =>
    setSearchParams(applyBizDevRoute(searchParams, { prospectId: id, status: 'all' }));

  return (
    <section className="capiro-bizdev__surface" aria-labelledby="bizdev-watchlist">
      <div className="capiro-bizdev__toolbar">
        <div className="capiro-bizdev__title-row">
          <h2 className="capiro-bizdev__section-title" id="bizdev-watchlist">
            Watchlist
          </h2>
          <span className="capiro-bizdev__count">
            {fanout.isPending
              ? '…'
              : `${watchedPayloads.length} watched · ${totalUnread} unread alerts`}
          </span>
        </div>
      </div>
      <p className="capiro-bizdev__discover-note capiro-bizdev__meta">
        {watchAlertsEnabled
          ? 'Watched prospects with their real source health, last completed check and current alerts. Read and dismiss actions live on each prospect.'
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
      ) : prospects.length === 0 ? (
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
        <ul className="capiro-bizdev__watchlist">
          {visiblePayloads.map((payload) => (
            <WatchlistProspectCard
              key={payload.prospect.id}
              payload={payload}
              members={members}
              onOpen={openProspect}
              alertCount={payload.alerts.filter((a) => !a.readAt).length}
            />
          ))}
        </ul>
      )}
      {prospects.filter((p) => p.status === 'active').length > BIZDEV_WATCHLIST_FANOUT_LIMIT ? (
        <p className="capiro-bizdev__footer-note capiro-bizdev__meta">
          Showing the first {BIZDEV_WATCHLIST_FANOUT_LIMIT} active prospects. Open a prospect to
          manage its watch directly.
        </p>
      ) : null}
    </section>
  );
}
