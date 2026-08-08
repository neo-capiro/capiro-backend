/**
 * Program Elements v2 — Source inspector drawer.
 * 498px right-aligned transient layer per refinement notes §07 SOURCE INSPECTOR:
 * CANONICAL / VERIFICATION / SOURCE / EVIDENCE blocks, TECHNICAL PROVENANCE
 * collapsed, footer Report issue + Create action. Content derives from the
 * line's real stage values + source list — never invented.
 */
import { useEffect, useState } from 'react';
import type { ProgramElementProfileFinalVm } from '../useProgramElementProfileFinal.js';
import { money, sgn } from './pe-v2-model.js';
import { EvMark } from './pe-v2-primitives.js';

export interface InspectorTarget {
  track: 'Authorization' | 'Appropriations' | 'Budget line';
  stage: string; // v2 stage label, e.g. 'HAC-D'
}

const STAGE_TO_FIELD: Record<string, string> = {
  REQUEST: 'request',
  HASC: 'hascMark',
  SASC: 'sascMark',
  'NDAA CONF.': 'ndaaConference',
  'HAC-D': 'hacDMark',
  'SAC-D': 'sacDMark',
  'APPROPS CONF.': 'conference',
  ENACTED: 'enacted',
};

export function PeV2SourceInspector({
  vm,
  target,
  onClose,
}: {
  vm: ProgramElementProfileFinalVm;
  target: InspectorTarget | null;
  onClose: () => void;
}) {
  const [provOpen, setProvOpen] = useState(false);
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  useEffect(() => {
    setProvOpen(false);
  }, [target?.stage, target?.track]);

  if (!target || !vm.detail) return null;

  const { detail, latest, request, sourcesQuery } = vm;
  const field = STAGE_TO_FIELD[target.stage] ?? null;
  const value = field && latest ? ((latest as unknown as Record<string, number | null>)[field] ?? null) : null;
  const delta = value != null && request != null && target.stage !== 'REQUEST' ? value - request : null;

  const sources = (sourcesQuery.data ?? []).slice(0, 6);
  const conflict = (detail.openReconciliationConflictCount ?? 0) > 0;

  return (
    <>
      <div className="pe-v2-drawer-scrim" onClick={onClose} aria-hidden />
      <aside className="pe-v2-drawer" role="dialog" aria-modal="true" aria-label={`${target.stage} stage evidence`}>
        <div style={{ flex: 'none', borderBottom: '1px solid var(--pev2-border)', padding: '16px 22px 15px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="pe-v2-eyebrow" style={{ letterSpacing: '0.09em' }}>
                {target.track.toUpperCase()} · STAGE EVIDENCE
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', marginTop: 6, lineHeight: 1.2 }}>
                {target.stage}
                {value != null ? ` · ${money(value)}` : ' · NOT FILED'}
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--pev2-body)', marginTop: 4 }}>
                {value != null
                  ? target.track === 'Authorization'
                    ? 'Official authorization position'
                    : 'Official appropriations position'
                  : 'No position asserted'}
              </div>
            </div>
            <button type="button" className="pe-v2-filter-btn" onClick={onClose} aria-label="Close inspector">
              CLOSE ⎋
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12, flexWrap: 'wrap' }}>
            <EvMark
              state={conflict ? 'CONFLICT' : value != null ? 'VERIFIED' : 'ABSENT'}
              label={conflict ? '⚠ CONFLICT' : value != null ? '■ VERIFIED' : '⊘ NOT FILED'}
              quiet={!conflict && value != null}
            />
            <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)' }}>
              {delta == null ? 'NO DELTA AVAILABLE' : delta === 0 ? 'NO CHANGE FROM REQUEST' : `${sgn(delta)} VS REQUEST`}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div className="pe-v2-drawer-block">
            <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.1em' }}>
              Canonical
            </div>
            <div className="pe-v2-drawer-pairs">
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>BUDGET LINE</span>
              <span style={{ fontSize: 13.5, color: 'var(--pev2-ink)' }}>
                {detail.peCode} · {detail.title}
              </span>
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>TRACK</span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pev2-ink)' }}>{target.track}</span>
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>FISCAL YEAR</span>
              <span className="pe-v2-mono" style={{ fontSize: 12.5, color: 'var(--pev2-ink)' }}>
                FY{latest?.fy ?? '—'}
              </span>
            </div>
          </div>

          <div className="pe-v2-drawer-block">
            <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.1em' }}>
              Verification
            </div>
            <div className="pe-v2-drawer-pairs">
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>STATUS</span>
              <span
                className="pe-v2-mono"
                style={{ fontSize: 12.5, fontWeight: 600, color: conflict ? 'var(--pev2-warning)' : 'var(--pev2-ink)' }}
              >
                {conflict ? 'BLOCKED' : value != null ? 'PASSED' : 'NOT APPLICABLE'}
              </span>
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>SOURCES ON LINE</span>
              <span className="pe-v2-mono" style={{ fontSize: 12.5, color: 'var(--pev2-ink)' }}>
                {detail.sourceCount ?? 0}
              </span>
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>LAST SYNCED</span>
              <span className="pe-v2-mono" style={{ fontSize: 12.5, color: 'var(--pev2-ink)' }}>
                {new Date(detail.lastSyncedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          </div>

          <div className="pe-v2-drawer-block">
            <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.1em' }}>
              {value != null || sources.length ? 'Source' : 'Why there is no figure'}
            </div>
            {value == null && !sources.length ? (
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: '#121722', marginTop: 9 }}>
                The {target.stage} position does not exist in the active snapshot. This is not a zero and not a
                confirmation of the request.
              </div>
            ) : sources.length === 0 ? (
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: '#121722', marginTop: 9 }}>
                {sourcesQuery.isLoading
                  ? 'Loading sources…'
                  : 'No page-level sources are attached to this line yet.'}
              </div>
            ) : (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {sources.map((s) => (
                  <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span className="pe-v2-mono" style={{ fontSize: 12, color: 'var(--pev2-ink)', flex: 1, minWidth: 180 }}>
                      {s.sourceDocument?.title ?? s.docType}
                      {s.pageNumber != null ? ` · p. ${s.pageNumber}` : ''}
                    </span>
                    <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.05em' }}>
                      {s.docType}
                      {s.fy != null ? ` · FY${s.fy}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ padding: '15px 22px 22px' }}>
            <button
              type="button"
              onClick={() => setProvOpen((o) => !o)}
              aria-expanded={provOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                cursor: 'pointer',
                border: '1px solid var(--pev2-border)',
                padding: '10px 12px',
                background: 'var(--pev2-raised)',
                width: '100%',
              }}
            >
              <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.09em', color: 'var(--pev2-body)', flex: 1, textAlign: 'left' }}>
                TECHNICAL PROVENANCE
              </span>
              <span className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-secondary)' }}>
                {provOpen ? '−' : '+'}
              </span>
            </button>
            {provOpen ? (
              <div style={{ border: '1px solid var(--pev2-border)', borderTop: 0, padding: '13px 14px 15px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '128px minmax(0,1fr)', gap: '8px 14px', alignItems: 'baseline' }}>
                  <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>PE CODE</span>
                  <span className="pe-v2-mono" style={{ fontSize: 12, color: 'var(--pev2-ink)', wordBreak: 'break-all' }}>
                    {detail.peCode}
                  </span>
                  <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>FIRST SEEN</span>
                  <span className="pe-v2-mono" style={{ fontSize: 12, color: 'var(--pev2-ink)' }}>
                    {detail.firstSeenFy != null ? `FY${detail.firstSeenFy}` : '—'}
                  </span>
                  <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>LAST SYNCED</span>
                  <span className="pe-v2-mono" style={{ fontSize: 12, color: 'var(--pev2-ink)', wordBreak: 'break-all' }}>
                    {detail.lastSyncedAt}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={{
            flex: 'none',
            borderTop: '1px solid var(--pev2-border)',
            padding: '12px 22px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            className="pe-v2-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.06em',
              color: 'var(--pev2-secondary)',
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {detail.peCode} · FY{latest?.fy ?? '—'}
          </span>
          <button type="button" className="pe-v2-btn pe-v2-btn-sm" onClick={() => vm.setDataIssueOpen(true)}>
            Report issue
          </button>
          <button
            type="button"
            className="pe-v2-btn pe-v2-btn-primary pe-v2-btn-sm"
            onClick={() => vm.navigate(`/actions?peCode=${encodeURIComponent(detail.peCode)}`)}
          >
            Create action
          </button>
        </div>
      </aside>
    </>
  );
}
