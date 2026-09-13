import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { HearingRecordContextLinks } from './HearingRecordContextLinks.js';
import {
  STATE_CALENDAR_FEATURE,
  useIntelFeatureEnabled,
} from '../../../../lib/intel-feature-flags.js';
import { normalizeCalendarPage } from '../lib/canonical-hearings.js';
import {
  formatHearingDay,
  formatHearingTime,
  momentOfCanonicalEvent,
  easternDayOf,
} from '../lib/hearing-datetime.js';

/** One bounded request for the visible bill page. A truncated response never
 * becomes a claim that an unseen bill has no scheduled appearance. */
export function useBillAgendaPage(billIds: string[], enabled: boolean) {
  const api = useApi(),
    actor = useApiScope();
  const from = easternDayOf(new Date().toISOString())!;
  return useQuery({
    queryKey: ['lw-bill-agenda-page', actor, billIds, from],
    enabled: enabled && billIds.length > 0,
    retry: false,
    queryFn: async () =>
      normalizeCalendarPage(
        (
          await api.post('/api/legiwatch/live-hearings/calendar/query', {
            jurisdiction: 'ALL',
            billIds,
            from,
            pageSize: 200,
          })
        ).data,
      ),
  });
}
export function BillAgenda({
  billId,
  clientId,
  folderId,
}: {
  billId: string;
  clientId?: string | null;
  folderId?: string | null;
}) {
  const location = useLocation();
  const [routeParams, setRouteParams] = useSearchParams();
  const range = routeParams.get('agendaRange') === 'past' ? 'past' : 'upcoming';
  const today = easternDayOf(new Date().toISOString())!;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  const api = useApi(),
    actor = useApiScope(),
    enabled = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE);
  const events = useQuery({
    queryKey: ['lw-bill-agenda', actor, billId, enabled, range, today],
    enabled,
    retry: false,
    queryFn: async () =>
      normalizeCalendarPage(
        (
          await api.post('/api/legiwatch/live-hearings/calendar/query', {
            jurisdiction: 'ALL',
            billIds: [billId],
            ...(range === 'past' ? { to: yesterday } : { from: today }),
            pageSize: 200,
          })
        ).data,
      ),
  });
  if (!enabled) return null;
  const params = new URLSearchParams();
  if (clientId) params.set('client', clientId);
  if (folderId) params.set('folder', folderId);
  return (
    <section aria-label="Published agenda appearances">
      <h3 className="lw-sect__title">Published agenda appearances</h3>
      <HearingRecordContextLinks billId={billId} clientId={clientId} folderId={folderId} />
      <div
        role="group"
        aria-label="Agenda date range"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}
      >
        {(['upcoming', 'past'] as const).map((value) => (
          <button
            key={value}
            className={`lw-btn${range === value ? ' lw-btn--primary' : ''}`}
            aria-pressed={range === value}
            onClick={() => {
              const next = new URLSearchParams(routeParams);
              next.set('agendaRange', value);
              if (location.pathname.startsWith('/bills/')) next.set('section', 'hearings');
              setRouteParams(next, { replace: true });
            }}
          >
            {value === 'past' ? 'Past dates' : 'Today and upcoming'}
          </button>
        ))}
      </div>
      {range === 'past' ? (
        <p>Past scheduled dates do not establish that a proceeding occurred.</p>
      ) : null}
      {events.isPending ? (
        <p role="status">Checking published agendas…</p>
      ) : events.isError ? (
        <p role="alert">
          Agenda appearances could not be checked.{' '}
          <button onClick={() => void events.refetch()}>Retry</button>
        </p>
      ) : events.data?.items.length ? (
        <ul>
          {events.data.items.map((event) => (
            <li key={event.id} style={{ marginBottom: 12 }}>
              <Link
                to={`/legiwatch/hearings/${encodeURIComponent(event.id)}${params.size ? `?${params}` : ''}`}
                state={{
                  legiwatchReturnTo: location.pathname + location.search,
                  legiwatchScrollY: window.scrollY,
                }}
              >
                {event.title}
              </Link>
              <p className="lw-card__meta">
                {formatHearingDay(momentOfCanonicalEvent(event))} ·{' '}
                {formatHearingTime(momentOfCanonicalEvent(event))} · {event.eventStatus}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No {range === 'past' ? 'past' : 'upcoming'} appearances are linked to this bill in the
          checked calendar sources.
        </p>
      )}
      {events.data && events.data.total > events.data.items.length ? (
        <p>
          {events.data.items.length} of {events.data.total} appearances shown.
        </p>
      ) : null}
    </section>
  );
}
