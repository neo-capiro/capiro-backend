import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { EVIDENCE_BASE, type Row } from './evidence-api.js';
import { useState } from 'react';
import { hasTestSessionTitle } from '../lib/hearing-presentation.js';

export function BriefingHistory({
  client,
  folder,
  configurationId,
  onReview,
}: {
  client: string;
  folder: string;
  configurationId?: string;
  onReview: (edition: Row) => void;
}) {
  const api = useApi(),
    scope = useApiScope();
  const query = useInfiniteQuery({
    queryKey: ['briefing-history', scope, client, folder, configurationId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ clientId: client, folderId: folder, limit: '20' });
      if (pageParam) params.set('cursor', pageParam);
      return (
        await api.get<Row>(
          `${EVIDENCE_BASE}/briefings/${configurationId ? `configurations/${encodeURIComponent(configurationId)}/occurrences` : 'drafts'}?${params}`,
        )
      ).data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const [includeTestEditions, setIncludeTestEditions] = useState(false);
  const visibleRows = rows.filter((row: Row) => includeTestEditions || !hasTestSessionTitle(row.draft?.title ?? row.title ?? ''));
  return (
    <section aria-label={configurationId ? 'Scheduled edition history' : 'Prepared editions'}>
      <h4>{configurationId ? 'Scheduled edition history' : 'Prepared editions'}</h4>
      <p>
        Open your editable draft or review its current output. Preparation does not send an edition.
      </p>
      <label className="lw-evidence-check"><input type="checkbox" checked={includeTestEditions} onChange={(event) => setIncludeTestEditions(event.target.checked)} /> Include editions named QA/test</label>
      {!includeTestEditions && rows.length > visibleRows.length ? <p role="status">{rows.length - visibleRows.length} editions named QA/test hidden in the loaded history.</p> : null}
      {query.isPending && <p role="status">Loading editions…</p>}
      {query.isError && (
        <p role="alert">
          Edition history could not be loaded.{' '}
          <button onClick={() => void query.refetch()}>Retry history</button>
        </p>
      )}
      {query.data?.pages.some((page) => page.draftLookupState === 'unavailable') && (
        <p role="status">
          Workspace draft links are temporarily unavailable.{' '}
          <button onClick={() => void query.refetch()}>Retry draft links</button>
        </p>
      )}
      <div className="lw-evidence-table">
        <table>
          <thead>
            <tr>
              <th>Edition</th>
              <th>Prepared / scheduled</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row: Row) => (
              <tr key={row.id}>
                <td>
                  {row.draft?.title ?? row.title ?? 'Scheduled edition'}
                  {row.definitionVersion != null && (
                    <small>Configuration version {row.definitionVersion}</small>
                  )}
                </td>
                <td>
                  {new Date(row.createdAt).toLocaleString()}
                  {row.occurrenceKey && <details><summary>Schedule details</summary><small>{row.occurrenceKey}</small></details>}
                </td>
                <td>
                  {row.state}
                  <small>{row.reason}</small>
                  {row.selectionId && !row.draft && (
                    <small>Draft unavailable or access changed</small>
                  )}
                </td>
                <td>
                  {row.draft && (
                    <div className="lw-evidence-actions">
                      <Link to={`/workspace/${encodeURIComponent(row.draft.draftId)}`}>
                        Open draft
                      </Link>
                      <CapiroButton size="compact" onClick={() => onReview(row)}>
                        Review edition
                      </CapiroButton>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!query.isPending && !query.isError && !rows.length && !query.hasNextPage && (
        <p>No editions are available in this scope yet.</p>
      )}
      {query.hasNextPage && (
        <CapiroButton
          size="compact"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older editions'}
        </CapiroButton>
      )}
    </section>
  );
}
