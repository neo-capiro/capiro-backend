/**
 * Hill Day Editor — /workspace/documents/:id.
 *
 * Markup mirrors the prototype's EDITOR section: topbar (back, title, saved
 * state, Preview as client, Deliver), the as-generated provenance strip, and
 * the three-column grid — outline rail, paper canvas (cover block, fact grid,
 * day-at-a-glance table, per-meeting sections), quality + sources inspector.
 * The document model, quality checks and provenance all come from the
 * workspace engine (api.ts); the summary table and the sections render from
 * the same rows. Column collapses are driven by a live container measure.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { config } from '../../../../env.js';
import { useHillDayApi } from './api.js';
import type { DocumentSectionView, HillDayDocumentView } from './types.js';
import { HdIcon, HdPrimary, HdSecondary, type HillDayIcon } from './ui.js';

const SOURCE_ICONS: Record<string, HillDayIcon> = {
  directory: 'Users01',
  calendar: 'Calendar2',
  objectives: 'Briefcase01',
  correspondence: 'Mail01',
  prior: 'ClockRewind',
  notes: 'Edit01',
};

function errorMessage(err: unknown): string {
  const e = err as { response?: { data?: { message?: string | string[] } }; message?: string };
  const m = e.response?.data?.message;
  if (Array.isArray(m)) return m.join(' ');
  return m ?? e.message ?? 'Something went wrong';
}

function humanReason(reason: string | null): string {
  switch (reason) {
    case 'model_credential_missing':
      return 'no model credential is configured for this firm';
    case 'provider_unavailable':
      return 'the generation provider was unavailable';
    case 'provider_timeout':
      return 'the generation provider timed out';
    case 'provider_output_unparseable':
      return 'the model reply could not be read';
    case null:
      return 'this section has not been generated yet';
    default:
      return reason.replace(/_/g, ' ');
  }
}

const DOC_PATH = /^\/workspace\/documents\/([A-Za-z0-9-]+)\/?$/;

/**
 * The document id comes from the route dispatcher as a prop
 * (WorkspaceVNextRoutes matches the path itself), else from a router param,
 * else from the pathname — the vNext workspace router does not mount this
 * screen under a `:id` route, so `useParams()` alone is empty here.
 */
export function HillDayEditor({ documentId }: { documentId?: string } = {}) {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const docId = documentId ?? params.id ?? DOC_PATH.exec(location.pathname)?.[1] ?? '';
  const api = useHillDayApi();
  const queryClient = useQueryClient();

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1440);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [regen, setRegen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ sectionId: string; focus: string; background: string } | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [exporting, setExporting] = useState<'preview' | 'deliver' | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const docKey = ['hd', 'document', docId] as const;
  const docQuery = useQuery({
    queryKey: docKey,
    queryFn: () => api.getDocument(docId),
    enabled: Boolean(docId),
    refetchInterval: (query) => (query.state.data?.status === 'generating' ? 3000 : false),
  });
  const doc = docQuery.data ?? null;
  const qualityQuery = useQuery({
    queryKey: ['hd', 'quality', docId, doc?.updatedAt],
    queryFn: () => api.quality(docId),
    enabled: Boolean(doc),
    staleTime: 30_000,
  });

  // Live container measure: the rail and inspector are siblings of the measured column.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width || window.innerWidth);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const sections = doc?.sections ?? [];
  const activeSection = sectionId ?? sections[0]?.sectionId ?? null;

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: docKey });
    await queryClient.invalidateQueries({ queryKey: ['hd', 'quality', docId] });
  };

  const regenerate = async (id: string) => {
    setSectionId(id);
    setRegen(id);
    setError(null);
    try {
      await api.regenerate(docId, id);
      await invalidate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRegen(null);
    }
  };

  const saveSection = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patchDocument(docId, {
        section: { sectionId: editing.sectionId, focus: editing.focus, background: editing.background },
      });
      queryClient.setQueryData<HillDayDocumentView>(docKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['hd', 'quality', docId] });
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const saveName = async () => {
    if (nameDraft === null || !doc) return;
    const name = nameDraft.trim();
    setNameDraft(null);
    if (!name || name === doc.name) return;
    setSaving(true);
    try {
      const updated = await api.patchDocument(docId, { name });
      queryClient.setQueryData<HillDayDocumentView>(docKey, updated);
      await queryClient.invalidateQueries({ queryKey: ['hd', 'documents'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const exportPdf = async (mode: 'preview' | 'deliver') => {
    setExporting(mode);
    setError(null);
    try {
      const exp = await api.createExport(docId, 'letter');
      if (exp.status !== 'ready' || !exp.url) {
        setError(`PDF export failed${exp.error ? `: ${exp.error}` : ''}.`);
        return;
      }
      const url = `${config.apiBaseUrl}${exp.url}${mode === 'deliver' ? '&download=1' : ''}`;
      if (mode === 'deliver') {
        const updated = await api.patchDocument(docId, { status: 'delivered' });
        queryClient.setQueryData<HillDayDocumentView>(docKey, updated);
        await queryClient.invalidateQueries({ queryKey: ['hd', 'documents'] });
      }
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const gridClass =
    width < 779 ? ' hd-editor__grid--single' : width < 1179 ? ' hd-editor__grid--no-inspector' : '';
  const outlineHidden = width < 779;
  const inspectorHidden = width < 1179;

  if (docQuery.isError) {
    return (
      <div className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
        <div className="hd-editor">
          <div className="hd-editor__topbar">
            <button type="button" className="hd-icon-btn" onClick={() => navigate('/workspace/documents')} aria-label="Back to documents">
              <HdIcon name="FlipBackward" size={18} />
            </button>
            <span className="hd-editor__title-block">
              <span className="hd-editor__title">Document unavailable</span>
              <span className="hd-editor__meta">{errorMessage(docQuery.error)}</span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  const quality = qualityQuery.data ?? null;
  const qualityPct = quality ? Math.round(quality.score * 100) : doc?.provenance.quality != null ? Math.round(doc.provenance.quality * 100) : null;

  return (
    <div ref={rootRef} className="hd-root" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--hd-canvas)' }}>
    <div className="hd-editor">
      <div className="hd-editor__topbar">
        <button
          type="button"
          className="hd-icon-btn"
          onClick={() => navigate('/workspace/documents')}
          aria-label="Back to documents"
        >
          <HdIcon name="FlipBackward" size={18} />
        </button>
        <span className="hd-editor__title-block">
          {nameDraft === null ? (
            <button
              type="button"
              className="hd-editor__title"
              style={{ background: 'transparent', border: 0, padding: 0, textAlign: 'left', cursor: 'text', font: 'inherit', color: 'inherit' }}
              onClick={() => doc && setNameDraft(doc.name)}
              title="Rename"
            >
              {doc?.name ?? 'Loading…'}
            </button>
          ) : (
            <input
              className="hd-editor__title"
              aria-label="Document name"
              value={nameDraft}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveName();
                if (e.key === 'Escape') setNameDraft(null);
              }}
              style={{ font: 'inherit', color: 'inherit', border: 0, background: 'transparent', padding: 0, width: '100%' }}
            />
          )}
          <span className="hd-editor__meta">
            <span className="hd-editor__version">
              {doc?.blueprint.name ?? 'Hill Day Schedule'} · {doc?.cover.facts.find((f) => f.k === 'Revision')?.v ?? 'Version 1'}
              {doc?.status === 'delivered' ? ' · Delivered' : ''}
            </span>
            <span className="hd-editor__saved">
              <span className="hd-editor__saved-dot" />
              {saving ? 'Saving…' : doc?.status === 'generating' ? 'Generating…' : 'Saved'}
            </span>
          </span>
        </span>
        <HdSecondary style={{ height: 38 }} disabled={!doc || exporting !== null} onClick={() => void exportPdf('preview')}>
          <HdIcon name="Eye" size={16} />
          {exporting === 'preview' ? 'Rendering…' : 'Preview as client'}
        </HdSecondary>
        <HdPrimary style={{ height: 38 }} disabled={!doc || exporting !== null || doc.status === 'draft' || doc.status === 'generating'} onClick={() => void exportPdf('deliver')}>
          <HdIcon name="Send01" size={16} />
          {exporting === 'deliver' ? 'Rendering…' : 'Deliver'}
        </HdPrimary>
      </div>

      <div className="hd-editor__prov">
        <span className="hd-editor__prov-label">
          As generated · {doc?.meetingCount ?? 0} meetings · {doc?.provenance.totalSources ?? 0} sources
          {qualityPct !== null ? ` · Quality ${qualityPct}%` : ''}
          {doc?.provenance.failedUnits ? ` · ${doc.provenance.failedUnits} section${doc.provenance.failedUnits === 1 ? '' : 's'} unavailable` : ''}
        </span>
        <button type="button" className="hd-editor__prov-link" onClick={() => setShowContext((s) => !s)}>
          Context used
          <HdIcon name="ChevronRight" size={15} className={showContext ? 'hd-rotate-90' : undefined} />
        </button>
      </div>
      {showContext && doc && (
        <div className="hd-editor__prov" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>
          <span style={{ flex: '1 1 320px', minWidth: 0 }}>
            <span className="hd-eyebrow" style={{ display: 'block', marginBottom: 6 }}>Sources that fed the model</span>
            {doc.provenance.sourceCounts.map((s) => (
              <span key={s.id} className="hd-source-row">
                <HdIcon name={SOURCE_ICONS[s.id] ?? 'File04'} size={15} />
                <span className="hd-source-row__label">{s.label}</span>
                <span className="hd-source-row__count">{s.detail ?? s.count}</span>
              </span>
            ))}
          </span>
          <span style={{ flex: '1 1 320px', minWidth: 0 }}>
            <span className="hd-eyebrow" style={{ display: 'block', marginBottom: 6 }}>Manual corrections that govern</span>
            {doc.provenance.corrections.length ? (
              doc.provenance.corrections.map((c) => (
                <span key={c} className="hd-source-row">
                  <HdIcon name="UserCheck01" size={15} />
                  <span className="hd-source-row__label">{c}</span>
                </span>
              ))
            ) : (
              <span className="hd-source-row">
                <span className="hd-source-row__label">None — every office and attendee is as the Directory resolved it.</span>
              </span>
            )}
            <span className="hd-source-row">
              <span className="hd-source-row__label">
                {doc.provenance.generatedAt ? `Generated ${new Date(doc.provenance.generatedAt).toLocaleString()}` : 'Not generated yet'}
                {doc.provenance.model ? ` · ${doc.provenance.model}` : ''}
              </span>
            </span>
          </span>
        </div>
      )}
      {error && (
        <div className="hd-editor__prov" role="alert" style={{ color: 'var(--hd-amber-600)' }}>
          <HdIcon name="AlertTriangle" size={16} />
          <span className="hd-editor__prov-label">{error}</span>
        </div>
      )}

      <div className={`hd-editor__grid${gridClass}`}>
        <div className={`hd-editor__outline${outlineHidden ? ' hd-editor__outline--hidden' : ''}`}>
          <span className="hd-eyebrow" style={{ display: 'block', padding: '0 8px 10px' }}>
            Contents
          </span>
          <button
            type="button"
            className="hd-editor__outline-row"
            style={{ alignItems: 'center' }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            <HdIcon name="File04" size={16} />
            Cover and schedule
          </button>
          {sections.map((m) => (
            <button
              key={m.sectionId}
              type="button"
              className={`hd-editor__outline-row${m.sectionId === activeSection ? ' hd-editor__outline-row--on' : ''}`}
              onClick={() => {
                setSectionId(m.sectionId);
                document.getElementById(`hd-section-${m.sectionId}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              <span className="hd-editor__outline-num">{String(m.number).padStart(2, '0')}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="hd-editor__outline-member">{m.member}</span>
                <span className="hd-editor__outline-time">
                  {m.time}
                  {m.status === 'unavailable' ? ' · unavailable' : m.status === 'pending' ? ' · pending' : ''}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="hd-editor__canvas">
          <div className="hd-paper">
            <div className="hd-paper__cover">
              <div className="hd-paper__cover-rule">
                <span className="hd-paper__brand">
                  <span className="hd-paper__brand-mark">{doc?.client.mono ?? ''}</span>
                  <span className="hd-paper__brand-name">{doc?.client.name ?? ''}</span>
                </span>
                <span className="hd-paper__firm">{doc?.firm.name ?? ''}</span>
              </div>
              <h1 className="hd-paper__h1">{doc?.cover.title ?? 'Hill Day Schedule'}</h1>
              <p className="hd-paper__lede">{doc?.cover.dateline ?? (docQuery.isPending ? 'Loading…' : '')}</p>
              <div className="hd-paper__facts">
                {(doc?.cover.facts ?? []).map((c) => (
                  <span key={c.k} className="hd-paper__fact">
                    <span className="hd-paper__fact-k">{c.k}</span>
                    <span className="hd-paper__fact-v">{c.v}</span>
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 28 }}>
                <span className="hd-paper__glance-label">The day at a glance</span>
                <div className="hd-paper__table">
                  <div className="hd-paper__th">
                    <span>Time</span>
                    <span>Member</span>
                    <span>Office</span>
                    <span>Room</span>
                    <span>Min</span>
                    <span>Staff lead</span>
                  </div>
                  {(doc?.summary ?? []).map((r, i, all) => (
                    <div
                      key={r.sectionId}
                      className="hd-paper__tr"
                      style={{
                        borderBottom: i === all.length - 1 ? '1px solid transparent' : undefined,
                      }}
                    >
                      <span className="hd-paper__td-time">{r.time}</span>
                      <span className="hd-paper__td-member">{r.member}</span>
                      <span className="hd-paper__td">{r.office}</span>
                      <span className="hd-paper__td" style={{ whiteSpace: 'nowrap' }}>
                        {r.room}
                      </span>
                      <span className="hd-paper__td-mono">{r.minutes}</span>
                      <span className="hd-paper__td">{r.staffLead}</span>
                    </div>
                  ))}
                  {doc && doc.summary.length === 0 && (
                    <div className="hd-paper__tr">
                      <span className="hd-paper__td" style={{ gridColumn: '1 / -1' }}>No meetings selected.</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {sections.map((m) => (
              <SectionBlock
                key={m.sectionId}
                section={m}
                regenerating={regen === m.sectionId}
                editing={editing?.sectionId === m.sectionId ? editing : null}
                saving={saving}
                onRegenerate={() => void regenerate(m.sectionId)}
                onEdit={() => setEditing({ sectionId: m.sectionId, focus: m.focus ?? '', background: m.background ?? '' })}
                onChange={(patch) => setEditing((e) => (e && e.sectionId === m.sectionId ? { ...e, ...patch } : e))}
                onCancel={() => setEditing(null)}
                onSave={() => void saveSection()}
              />
            ))}
          </div>
        </div>

        <div className={`hd-editor__inspector${inspectorHidden ? ' hd-editor__inspector--hidden' : ''}`}>
          <span className="hd-eyebrow" style={{ display: 'block' }}>
            Quality
          </span>
          <div className="hd-checks">
            {(quality?.checks ?? []).map((c) => (
              <div key={c.id} className={`hd-check${c.state === 'warn' ? ' hd-check--warn' : ''}`}>
                <span className={`hd-check__icon--${c.state === 'pass' ? 'ok' : 'warn'}`}>
                  <HdIcon name={c.state === 'pass' ? 'CheckCircle' : 'AlertTriangle'} size={16} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="hd-check__label">{c.label}</span>
                  <span className="hd-check__detail">{c.detail}</span>
                </span>
              </div>
            ))}
            {qualityQuery.isPending && <span className="hd-check__detail">Checking…</span>}
            {qualityQuery.isError && <span className="hd-check__detail">Quality checks unavailable right now.</span>}
          </div>

          <span className="hd-eyebrow hd-editor__inspector-sep" style={{ display: 'block' }}>
            Sources used
          </span>
          <div className="hd-sources">
            {(doc?.provenance.sourceCounts ?? []).map((s) => (
              <span key={s.id} className="hd-source-row">
                <HdIcon name={SOURCE_ICONS[s.id] ?? 'File04'} size={15} />
                <span className="hd-source-row__label">{s.label}</span>
                <span className="hd-source-row__count">{s.detail ?? s.count}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}

function SectionBlock({
  section: m,
  regenerating,
  editing,
  saving,
  onRegenerate,
  onEdit,
  onChange,
  onCancel,
  onSave,
}: {
  section: DocumentSectionView;
  regenerating: boolean;
  editing: { sectionId: string; focus: string; background: string } | null;
  saving: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  onChange: (patch: Partial<{ focus: string; background: string }>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const flagged = m.flags.filter((f) => f.kind === 'unsupported_claim' || f.kind === 'needs_confirmation' || f.kind === 'partial_resolution');
  return (
    <div id={`hd-section-${m.sectionId}`} className="hd-section">
      <span className="hd-section__eyebrow-row">
        <span className="hd-section__eyebrow">
          Meeting {m.number} · {m.time} · {m.duration}
          {m.edited.focus || m.edited.background ? ' · edited' : ''}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          {!editing && m.status !== 'pending' && (
            <button type="button" className="hd-section__regen" onClick={onEdit}>
              <HdIcon name="Edit01" size={14} />
              Edit
            </button>
          )}
          <button type="button" className="hd-section__regen" onClick={onRegenerate} disabled={regenerating}>
            <HdIcon name={regenerating ? 'Loading01' : 'RefreshCw01'} size={14} className={regenerating ? 'hd-spin' : undefined} />
            {regenerating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </span>
      </span>
      <h2 className="hd-section__h2">{m.member}</h2>
      <p className="hd-section__subline">{m.subline}</p>
      <div className="hd-section__facts">
        {m.facts.map((f) => (
          <span key={f.k}>
            <span className="hd-section__fact-k">{f.k}</span>
            <span className="hd-section__fact-v">{f.v}</span>
          </span>
        ))}
      </div>

      {m.status === 'unavailable' && !editing && (
        <div className="hd-check hd-check--warn" style={{ marginTop: 14 }}>
          <span className="hd-check__icon--warn">
            <HdIcon name="AlertTriangle" size={16} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="hd-check__label">Section unavailable</span>
            <span className="hd-check__detail">
              {humanReason(m.reason)}. The facts above are intact from the calendar and the Directory. Regenerate to draft Focus and Background, or write them yourself with Edit.
            </span>
          </span>
        </div>
      )}
      {m.status === 'pending' && (
        <div className="hd-check" style={{ marginTop: 14 }}>
          <span className="hd-check__icon--ok">
            <HdIcon name="Clock" size={16} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="hd-check__label">Not generated yet</span>
            <span className="hd-check__detail">This meeting has not been drafted. Regenerate to draft it now.</span>
          </span>
        </div>
      )}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <label className="hd-section__h3" htmlFor={`hd-focus-${m.sectionId}`}>Focus</label>
          <textarea
            id={`hd-focus-${m.sectionId}`}
            className="hd-section__body"
            rows={6}
            value={editing.focus}
            onChange={(e) => onChange({ focus: e.target.value })}
            style={{ width: '100%', font: 'inherit', resize: 'vertical' }}
          />
          <label className="hd-section__h3 hd-section__h3--tight" htmlFor={`hd-background-${m.sectionId}`}>Background</label>
          <textarea
            id={`hd-background-${m.sectionId}`}
            className="hd-section__body"
            rows={7}
            value={editing.background}
            onChange={(e) => onChange({ background: e.target.value })}
            style={{ width: '100%', font: 'inherit', resize: 'vertical' }}
          />
          <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <HdSecondary onClick={onCancel} disabled={saving}>
              Cancel
            </HdSecondary>
            <HdPrimary onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save section'}
            </HdPrimary>
          </span>
        </div>
      ) : (
        m.status === 'done' && (
          <>
            <h3 className="hd-section__h3">Focus</h3>
            <p className="hd-section__body">{m.focus ?? 'Focus not available.'}</p>
            <h3 className="hd-section__h3 hd-section__h3--tight">Background</h3>
            <p className="hd-section__body">{m.background ?? 'Background not available.'}</p>
          </>
        )
      )}

      {flagged.length > 0 && !editing && (
        <div className="hd-checks" style={{ marginTop: 12 }}>
          {flagged.map((f, i) => (
            <div key={`${f.kind}-${i}`} className="hd-check hd-check--warn">
              <span className="hd-check__icon--warn">
                <HdIcon name="AlertCircle" size={16} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="hd-check__label">
                  {f.kind === 'unsupported_claim' ? 'Flagged for review' : f.kind === 'needs_confirmation' ? 'Confirm before delivery' : 'Partial resolution'}
                </span>
                <span className="hd-check__detail">{f.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
