/**
 * Hill Day Library — /workspace/documents.
 *
 * Markup mirrors the prototype's LIBRARY section (hill-day.markup.html lines
 * 83–167): title + actions, "Start a workflow" template grid, the Template
 * Studio banner, and the "Recent documents" table. Blueprints and document
 * rows hydrate from hillday/api.ts.
 */
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { hillDayApi } from './api.js';
import { HdIcon, HdPill, HdPrimary, HdSecondary } from './ui.js';
import type { HillDayIcon } from './ui.js';
import type { PillTone } from './types.js';

export function HillDayLibrary() {
  const navigate = useNavigate();
  const templatesQuery = useQuery({
    queryKey: ['hd', 'blueprints'],
    queryFn: () => hillDayApi.listBlueprints(),
    staleTime: 60_000,
  });
  const docsQuery = useQuery({
    queryKey: ['hd', 'documents'],
    queryFn: () => hillDayApi.listDocuments(),
    staleTime: 30_000,
  });

  const templates = templatesQuery.data ?? [];
  const docs = docsQuery.data ?? [];

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
        <span className="hd-eyebrow">7 templates published</span>
      </div>

      <div className="hd-template-grid">
        {templates.map((t) => (
          <button
            key={t.name}
            type="button"
            className={`hd-template-card${t.isNew ? ' hd-template-card--new' : ''}`}
            onClick={() => navigate(t.isNew ? '/workspace/documents/new' : '/workspace/documents')}
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
                <HdIcon name={t.icon as HillDayIcon} size={20} />
              </span>
              {t.isNew ? (
                <span className="hd-badge-new">New</span>
              ) : (
                <span style={{ flex: '0 0 auto' }} />
              )}
            </div>
            <span style={{ display: 'block' }}>
              <span className="hd-template-card__name">{t.name}</span>
              <span className="hd-template-card__desc">{t.desc}</span>
            </span>
            <span className="hd-template-card__meta">{t.meta}</span>
          </button>
        ))}
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
        <span className="hd-eyebrow">7 of 42</span>
      </div>

      <div className="hd-doc-table">
        <div className="hd-doc-table__head">
          <span>Document</span>
          <span>Client</span>
          <span>Status</span>
          <span>Updated</span>
          <span />
        </div>
        {docs.map((d) => (
          <button
            key={d.name}
            type="button"
            className="hd-doc-table__row"
            onClick={() =>
              navigate(d.isHill ? '/workspace/documents/hillday-demo' : '/workspace/documents')
            }
          >
            <span className="hd-doc-table__doc-cell">
              <span className="hd-doc-table__icon">
                <HdIcon name={d.icon as HillDayIcon} size={16} />
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="hd-doc-table__name">{d.name}</span>
                <span className="hd-doc-table__type">{d.type}</span>
              </span>
            </span>
            <span className="hd-doc-table__client">{d.client}</span>
            <span style={{ display: 'flex', justifySelf: 'start' }}>
              <HdPill tone={d.tone as PillTone}>{d.label}</HdPill>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span className="hd-doc-table__updated">{d.updated}</span>
            </span>
            <span
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}
            >
              <span className="hd-doc-table__owner">{d.owner}</span>
            </span>
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}
