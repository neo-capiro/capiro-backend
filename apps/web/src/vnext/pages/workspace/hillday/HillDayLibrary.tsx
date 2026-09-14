/**
 * Hill Day Library — /workspace/documents.
 *
 * Title + actions, the Template Studio banner, and the "Recent documents"
 * table. No template picker here — that's the wizard's own step 1
 * (/workspace/documents/new), which reads the same blueprint catalog and
 * already handles both the implemented and not-yet-implemented cases;
 * showing the same grid on both pages just made "New document" a two-click
 * detour through an identical choice. Document rows come from the workspace
 * engine's Hill Day API (api.ts) and list Hill Day packets alongside the
 * firm's other workspace documents.
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
    queryFn: ({ pageParam }) => api.listDocuments({ limit: RECENT_LIMIT, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 15_000,
  });

  const docs = docsQuery.data?.pages.flatMap((page) => page.items) ?? [];

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
            Client-ready documents drafted from platform evidence and finished by you. Every
            template pulls from the Directory, Portfolio and Intelligence layers.
          </p>
        </div>
        <div className="hd-library__actions">
          <HdSecondary onClick={() => navigate('/workspace/studio')}>
            <HdIcon name="LayoutAlt01" size={18} />
            Template Studio
          </HdSecondary>
          <HdPrimary onClick={() => navigate('/workspace/documents/new')}>
            <HdIcon name="Plus" size={18} />
            New document
          </HdPrimary>
        </div>
      </div>

      <div className="hd-studio-banner">
        <HdIcon name="LayoutAlt01" size={20} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--hd-gray-900)' }}>Template Studio.</span>{' '}
          Blueprints own what a document says; document themes own what it looks like. Firm-scope
          blueprints publish to every user.
        </span>
        <button
          type="button"
          className="hd-studio-banner__open"
          onClick={() => navigate('/workspace/studio')}
        >
          Open Studio
          <HdIcon name="ArrowRight" size={16} />
        </button>
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
