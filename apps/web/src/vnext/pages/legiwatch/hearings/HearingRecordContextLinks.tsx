import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
export function HearingRecordContextLinks({
  billId,
  clientId,
  folderId,
}: {
  billId: string;
  clientId?: string | null;
  folderId?: string | null;
}) {
  const api = useApi(),
    scope = useApiScope(),
    enabled = useIntelFeatureEnabled('legiwatch_published_records_v1'),
    params = new URLSearchParams({ billId });
  if (clientId) params.set('clientId', clientId);
  if (folderId) params.set('folderId', folderId);
  const q = useQuery({
    queryKey: ['hearing-record-bill-context', scope, billId, clientId, folderId],
    enabled,
    retry: false,
    queryFn: async () =>
      (
        await api.get<{
          events: Array<{ id: string; title: string }>;
          briefs: Array<{ id: string; eventId: string; title: string; version: number }>;
          complete: boolean;
        }>('/intel-api/legiwatch/reports/record-bill-context?' + params)
      ).data,
  });
  if (!enabled) return null;
  const link = (event: string, brief?: string) => {
    const p = new URLSearchParams({ bill: billId });
    if (clientId) p.set('client', clientId);
    if (folderId) p.set('folder', folderId);
    if (brief) p.set('brief', brief);
    return '/legiwatch/hearings/' + encodeURIComponent(event) + '?' + p + '#published-records';
  };
  return (
    <section aria-label="Hearing records and reviewed briefs">
      <h3>Hearing records and reviewed briefs</h3>
      {q.isError ? (
        <p role="alert">Linked records could not be checked with current access.</p>
      ) : q.isPending ? (
        <p role="status">Checking linked records…</p>
      ) : (
        <>
          <ul>
            {q.data?.events.map((e) => (
              <li key={e.id}>
                <Link to={link(e.id)}>{e.title} · Published records</Link>
              </li>
            ))}
            {q.data?.briefs.map((b) => (
              <li key={b.id}>
                <Link to={link(b.eventId, b.id)}>
                  {b.title} · Reviewed v{b.version}
                </Link>
              </li>
            ))}
          </ul>
          {!q.data?.events.length ? (
            <p>
              No event links in the checked scope. This does not establish that no hearing occurred.
            </p>
          ) : null}
          {!q.data?.complete ? (
            <p>Additional records may remain outside this bounded view.</p>
          ) : null}
        </>
      )}
    </section>
  );
}
