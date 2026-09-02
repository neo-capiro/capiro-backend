/**
 * Hill Day Library — /workspace/documents.
 *
 * Markup mirrors the prototype's LIBRARY section: title + actions, "Start a
 * workflow" template grid, the Template Studio banner, and the "Recent
 * documents" table. Blueprints and document rows come from the workspace
 * engine's Hill Day API (api.ts); the table lists Hill Day packets alongside
 * the firm's other workspace documents.
 */
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useHillDayApi } from './api.js';
import { HdIcon, HdPill, HdPrimary, HdSecondary } from './ui.js';
import { blueprintIcon, relativeTime, statusPill } from './types.js';

const RECENT_LIMIT = 8;

export function HillDayLibrary() {
  const navigate = useNavigate();
  const api = useHillDayApi();
  const templatesQuery = useQuery({
    queryKey: ['hd', 'blueprints'],
    queryFn: () => api.listBlueprints(),
    staleTime: 60_000,
  });
  const docsQuery = useQuery({
    queryKey: ['hd', 'documents', RECENT_LIMIT],
    queryFn: () => api.listDocuments({ limit: RECENT_LIMIT }),
    staleTime: 15_000,
  });

  const templates = templatesQuery.data ?? [];
  const docs = docsQuery.data?.items ?? [];

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

      <div className="hd-library__section-head">
        <h2 className="hd-library__h2">Start a workflow</h2>
        <span className="hd-eyebrow">
          {templatesQuery.isPending
            ? 'Loading templates…'
            : templatesQuery.isError
              ? 'Templates unavailable'
              : `${templates.length} templates published`}
        </span>
      </div>

      <div className="hd-template-grid">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`hd-template-card${t.isNew ? ' hd-template-card--new' : ''}`}
            onClick={() => navigate(t.implemented ? '/workspace/documents/new' : '/workspace/new')}
            title={t.implemented ? undefined : 'Not implemented yet — opens the existing workspace flow'}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span className={`hd-template-card__icon${t.isNew ? '' : ' hd-template-card__icon--plain'}`}>
                <HdIcon name={blueprintIcon(t.icon)} size={20} />
              </span>
              {t.isNew ? (
                <span className="hd-badge-new">New</span>
              ) : (
                <span style={{ flex: '0 0 auto' }} />
              )}
            </div>
            <span style={{ display: 'block' }}>
              <span className="hd-template-card__name">{t.name}</span>
              <span className="hd-template-card__desc">{t.description}</span>
            </span>
            <span className="hd-template-card__meta">
              {t.scope === 'firm' ? `${t.meta}` : t.meta}
            </span>
          </button>
        ))}
        {templatesQuery.isError && (
          <div className="hd-studio-banner" role="status">
            <HdIcon name="AlertTriangle" size={20} />
            <span style={{ flex: 1, minWidth: 0 }}>
              The blueprint catalog could not be loaded from the workspace engine. Retry in a moment.
            </span>
          </div>
        )}
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
              : `${docs.length} most recent${docsQuery.data?.nextCursor ? ' · more in the library' : ''}`}
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
        {!docsQuery.isPending && !docsQuery.isError && docs.length === 0 && (
          <div className="hd-doc-table__row" style={{ cursor: 'default' }}>
            <span className="hd-doc-table__doc-cell">
              <span className="hd-doc-table__icon">
                <HdIcon name="File04" size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="hd-doc-table__name">No documents yet</span>
                <span className="hd-doc-table__type">Start with a Hill Day Schedule above.</span>
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
      </div>
    </div>
  );
}
