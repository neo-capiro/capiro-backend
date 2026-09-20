import { useQuery } from '@tanstack/react-query';

import { Link } from 'react-router-dom';

import { useApi } from '../../../../lib/use-api.js';

import { useApiScope } from '../../../../lib/use-api-scope.js';

import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';

type Deadline = {
  id: string;
  kind: string;
  date_only: string;
  raw_wording: string;
  notice_id: string;
};

/** Read-only calendar projection. These rows have no event, attendance or capture action. */

export function LegalDeadlineOverlay({
  from,
  to,
  clientId,
  folderId,
}: {
  from: string;
  to: string;
  clientId?: string;
  folderId?: string;
}) {
  const api = useApi(),
    identity = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_research_v1');

  const query = new URLSearchParams({ jurisdiction: 'FL', from, to });
  if (clientId) query.set('clientId', clientId);
  if (folderId) query.set('folderId', folderId);

  const dates = useQuery<{ rows: Deadline[] }>({
    queryKey: ['legal-deadline-overlay', identity, from, to, clientId, folderId],
    enabled,
    queryFn: () =>
      api
        .get<{ rows: Deadline[] }>('/intel-api/legiwatch/research/deadlines?' + query)
        .then((r) => r.data),
    retry: false,
  });

  if (!enabled) return null;

  return (
    <section
      className="lw-card"
      aria-label="Published legal dates"
      style={{ padding: 16, marginBottom: 12 }}
    >
      <details open={dates.isError}>
        <summary className="lw-card__title" style={{ cursor: 'pointer' }}>
          Published legal dates
          {dates.isPending
            ? ' · Loading…'
            : dates.isError
              ? ' · Unavailable'
              : ` · ${dates.data?.rows.length ?? 0}`}{' '}
          <span>View details</span>
        </summary>
        <p>
          Source-stated dates for retained Florida rule notices. Dates shown here have no assumed
          cutoff time.
        </p>
        {dates.isError ? (
          <p role="status">
            Legal dates could not be loaded. <button onClick={() => dates.refetch()}>Retry</button>
          </p>
        ) : dates.isPending ? (
          <p role="status">Loading published dates…</p>
        ) : dates.data?.rows.length ? (
          <ul>
            {dates.data.rows.map((d) => (
              <li key={d.id}>
                <time dateTime={d.date_only.slice(0, 10)}>{d.date_only.slice(0, 10)}</time> ·{' '}
                {d.kind.replaceAll('_', ' ')} ·{' '}
                <Link
                  to={
                    '/legiwatch?' +
                    new URLSearchParams({
                      tab: 'research',
                      researchView: 'deadlines',
                      noticeId: d.notice_id,
                      ...(folderId ? { folder: folderId } : {}),
                      ...(clientId ? { client: clientId } : {}),
                    })
                  }
                >
                  {d.notice_id}
                </Link>
                <p>{d.raw_wording}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No retained source dates fall in this range. This does not establish a complete absence
            of legal deadlines.
          </p>
        )}
      </details>
    </section>
  );
}
