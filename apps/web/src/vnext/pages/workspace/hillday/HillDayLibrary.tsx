/**
 * Hill Day Library — /workspace/documents.
 *
 * Title + "New document", and the "Recent documents" table. Workspace is
 * Hill Day–only: Template Studio and the firm's other workspace documents are
 * hidden, so rows are Hill Day packets only (`kind: 'hillday'`, filtered by
 * the API and again here). No template picker here — that's the wizard's own
 * step 1 (/workspace/documents/new). Document rows come from the workspace
 * engine's Hill Day API (api.ts).
 */
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useHillDayApi } from './api.js';
import { HdIcon, HdPill, HdPrimary, HdSecondary } from './ui.js';
import { relativeTime, statusPill } from './types.js';

const RECENT_LIMIT = 8;

export function HillDayLibrary() {
  const navigate = useNavigate();
  const api = useHillDayApi();
  const scope = useApiScope();
  const docsQuery = useInfiniteQuery({
    queryKey: ['hd', 'documents', scope, RECENT_LIMIT],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listDocuments({ kind: 'hillday', limit: RECENT_LIMIT, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 15_000,
  });

  // The client-side filter also covers a workspace API that predates `kind`.
  const docs = (docsQuery.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (d) => d.kind === 'hillday',
  );

  return (
    <div className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
      <div className="hd-library">
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h1 className="hd-library__title">Documents</h1>
          <p className="hd-library__lede">
            Client-ready Hill Day schedules drafted from platform evidence and finished by you,
            pulling from the Directory, Portfolio and Intelligence layers.
          </p>
        </div>
        <div className="hd-library__actions">
          <HdPrimary onClick={() => navigate('/workspace/documents/new')}>
            <HdIcon name="Plus" size={18} />
            New document
          </HdPrimary>
        </div>
      </div>

      <div className="hd-library__section-head" style={{ marginTop: 44 }}>
        <h2 className="hd-library__h2">Recent documents</h2>
        <span className="hd-eyebrow">
          {docsQuery.isPending
            ? 'Loading…'
            : docsQuery.isError
              ? 'Documents unavailable'
              : `${docs.length} documents${docsQuery.hasNextPage ? ' · older documents available' : ''}`}
        </span>
      </div>

      <div className="hd-doc-table">
        <div className="hd-doc-table__head">
          <span>Document</span>
          <span>Client</span>
          <span>Status</span>
          <span>Updated</span>
          <span />
        </div>
        {docs.map((d) => {
          const pill = statusPill(d);
          return (
            <button
              key={`${d.kind}-${d.id}`}
              type="button"
              className="hd-doc-table__row"
              onClick={() => navigate(d.route)}
            >
              <span className="hd-doc-table__doc-cell">
                <span className="hd-doc-table__icon">
                  <HdIcon name={d.kind === 'hillday' ? 'CalendarCheck01' : 'File04'} size={16} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="hd-doc-table__name">{d.name}</span>
                  <span className="hd-doc-table__type">{d.blueprint}</span>
                </span>
              </span>
              <span className="hd-doc-table__client">{d.client ?? '—'}</span>
              <span style={{ display: 'flex', justifySelf: 'start' }}>
                <HdPill tone={pill.tone}>{pill.label}</HdPill>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span className="hd-doc-table__updated">{relativeTime(d.updatedAt)}</span>
              </span>
              <span
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}
              >
                <span className="hd-doc-table__owner" title={d.owner.name}>
                  {d.owner.initials}
                </span>
              </span>
            </button>
          );
        })}
        {!docsQuery.isPending && !docsQuery.isError && !docsQuery.hasNextPage && docs.length === 0 && (
          <div className="hd-doc-table__row" style={{ cursor: 'default' }}>
            <span className="hd-doc-table__doc-cell">
              <span className="hd-doc-table__icon">
                <HdIcon name="File04" size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="hd-doc-table__name">No documents yet</span>
                <span className="hd-doc-table__type">Start with "New document" above.</span>
              </span>
            </span>
            <span className="hd-doc-table__client">—</span>
            <span />
            <span />
            <span />
          </div>
        )}
        {docsQuery.isError && (
          <div className="hd-doc-table__row" style={{ cursor: 'default' }}>
            <span className="hd-doc-table__doc-cell">
              <span className="hd-doc-table__icon">
                <HdIcon name="AlertTriangle" size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="hd-doc-table__name">Documents unavailable</span>
                <span className="hd-doc-table__type">The workspace engine did not answer. Retry in a moment.</span>
              </span>
            </span>
            <span className="hd-doc-table__client">—</span>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      <div className="hd-library__actions" style={{ marginTop: 20 }}>
        {docsQuery.hasNextPage && (
          <HdSecondary disabled={docsQuery.isFetchingNextPage} onClick={() => void docsQuery.fetchNextPage()}>
            {docsQuery.isFetchingNextPage ? 'Loading older documents…' : 'Load older documents'}
          </HdSecondary>
        )}
        {docsQuery.isError && (
          <HdSecondary onClick={() => void docsQuery.refetch()}>Retry documents</HdSecondary>
        )}
      </div>
      </div>
    </div>
  );
}
