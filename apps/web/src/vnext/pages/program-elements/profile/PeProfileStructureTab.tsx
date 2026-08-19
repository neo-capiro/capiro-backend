/**
 * Program Elements vNext profile — Program structure tab.
 * Native port of PeV2StructureTab: kind-appropriate identity tables (R-2A
 * projects, P-40 procurement lines, relationships, linked acquisition
 * programs). Date granularity and roles are preserved exactly as published —
 * never interpreted.
 */
import { useState } from 'react';
import { CapiroSkeleton } from '../../../components/feedback/index.js';
import type { ProgramElementProfileFinalVm } from '../../../../pages/program-element/useProgramElementProfileFinalCore.js';
import { money } from '../../../../pages/program-element/v2/pe-v2-model.js';
import { EvMark, PfCard } from './pe-profile-primitives.js';

function StructureTable({
  title,
  note,
  head,
  rows,
  empty,
  minWidth,
}: {
  title: string;
  note?: string;
  head: Array<{ label: string; align?: 'r' }>;
  rows: Array<Array<React.ReactNode>>;
  empty?: string;
  minWidth?: number;
}) {
  const grid = `minmax(200px,1fr) ${head.slice(1).map(() => 'auto').join(' ')}`;
  return (
    <PfCard
      title={title}
      headPadding="12px 18px 11px"
      right={note ? <div className="pe-pf-eyebrow-quiet">{note}</div> : undefined}
    >
      <div className="pe-pf-scroll-x">
        <div style={minWidth ? { minWidth } : undefined}>
          <div
            className="pe-pf-gridhead"
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              columnGap: 14,
              padding: '9px 18px',
            }}
          >
            {head.map((h) => (
              <div key={h.label} style={h.align === 'r' ? { textAlign: 'right' } : undefined}>
                {h.label}
              </div>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="pe-pf-empty" style={{ padding: 18 }}>
              {empty ?? 'Nothing is published at this level in the active snapshot.'}
            </div>
          ) : (
            rows.map((cells, i) => (
              <div
                key={i}
                className="pe-pf-listrow"
                style={{
                  display: 'grid',
                  gridTemplateColumns: grid,
                  columnGap: 14,
                  padding: '10px 18px',
                  alignItems: 'center',
                  background: 'var(--pepf-surface)',
                }}
              >
                {cells.map((c, j) => (
                  <div key={j} style={head[j]?.align === 'r' ? { textAlign: 'right' } : undefined}>
                    {c}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </PfCard>
  );
}

export function PeProfileStructureTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
  const {
    detail,
    projectsQuery,
    procurementQuery,
    relatedQuery,
    programsQuery,
    relationshipsQuery,
  } = vm;
  const [linksOpen, setLinksOpen] = useState(false);

  const projects = projectsQuery.data ?? [];
  const procurement = procurementQuery.data ?? null;
  const related = relatedQuery.data?.related ?? [];
  const relationships = relationshipsQuery.data ?? [];
  const programs = programsQuery.data;

  const kind = detail?.appropriationType?.toUpperCase().startsWith('RDT')
    ? 'rdte'
    : detail?.appropriationType?.toUpperCase() === 'PROC'
      ? 'proc'
      : detail?.appropriationType?.toUpperCase() === 'OM'
        ? 'om'
        : 'line';

  const title =
    kind === 'rdte'
      ? 'RDT&E program structure'
      : kind === 'proc'
        ? 'Procurement structure'
        : kind === 'om'
          ? 'O&M structure'
          : 'Budget-line structure';
  const note =
    kind === 'rdte'
      ? 'Projects exactly as published in the R-2A exhibit.'
      : kind === 'proc'
        ? 'Native procurement identity: P-40 cost elements and secondary distribution.'
        : kind === 'om'
          ? 'Native O&M identity: subactivity detail.'
          : 'Published identity and verified relationships for this budget line.';

  const loading =
    projectsQuery.isLoading || procurementQuery.isLoading || relatedQuery.isLoading || relationshipsQuery.isLoading;

  return (
    <div style={{ padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--pepf-ink)' }}>{title}</div>
        <div style={{ fontSize: 13.5, color: 'var(--pepf-secondary)' }}>{note}</div>
      </div>

      {loading ? (
        <div className="pe-pf-card" style={{ padding: 18, display: 'grid', gap: 10 }}>
          <CapiroSkeleton height={16} width="40%" />
          <CapiroSkeleton height={14} />
          <CapiroSkeleton height={14} />
          <CapiroSkeleton height={14} width="72%" />
        </div>
      ) : (
        <>
          {kind === 'rdte' ? (
            <StructureTable
              title="Projects"
              note={`R-2A · ${detail?.peCode ?? ''}`}
              head={[{ label: 'PROJECT' }, { label: 'TITLE' }, { label: 'FY' }, { label: 'SOURCE' }]}
              rows={projects.map((p) => [
                <span key="c" className="pe-pf-mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--pepf-ink)' }}>
                  {p.projectCode}
                </span>,
                <span key="t" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pepf-ink)' }}>
                  {p.title}
                </span>,
                <span key="f" className="pe-pf-mono" style={{ fontSize: 11.5, color: 'var(--pepf-body)' }}>
                  {p.fy != null ? `FY${p.fy}` : '—'}
                </span>,
                p.sourceUrl ? (
                  <a
                    key="s"
                    href={p.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="pe-pf-mono"
                    style={{ fontSize: 11, color: 'var(--pepf-heading)', textDecoration: 'underline', textUnderlineOffset: 3 }}
                  >
                    {p.pageNumber != null ? `p. ${p.pageNumber}` : 'SOURCE'}
                  </a>
                ) : (
                  <span key="s" className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-quiet)' }}>
                    —
                  </span>
                ),
              ])}
              minWidth={760}
            />
          ) : null}

          {kind === 'proc' && procurement ? (
            <StructureTable
              title="P-40 detail"
              note="QUANTITY BY RECIPIENT"
              head={[{ label: 'RECIPIENT' }, { label: 'FY', align: 'r' }, { label: 'QTY', align: 'r' }, { label: 'COST', align: 'r' }]}
              rows={procurement.recipients.flatMap((r) =>
                r.fyRows.map((fy) => [
                  <span key="r" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pepf-ink)' }}>
                    {r.recipient}
                  </span>,
                  <span key="f" className="pe-pf-mono" style={{ fontSize: 11.5, color: 'var(--pepf-body)' }}>
                    FY{fy.fy}
                  </span>,
                  <span key="q" className="pe-pf-mono" style={{ fontSize: 11.5, color: 'var(--pepf-ink)' }}>
                    {fy.quantity ?? '—'}
                  </span>,
                  <span key="c" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pepf-ink)', fontVariantNumeric: 'tabular-nums' }}>
                    {fy.dollars != null ? money(fy.dollars) : '—'}
                  </span>,
                ]),
              )}
              minWidth={720}
            />
          ) : null}

          {/* Linked acquisition programs */}
          {(programs?.acceptedMatches ?? []).length > 0 ? (
            <StructureTable
              title="Linked acquisition programs"
              note="VERIFIED RELATIONSHIPS ONLY"
              head={[{ label: 'PROGRAM' }, { label: 'CONFIDENCE' }, { label: 'EVIDENCE' }]}
              rows={(programs?.acceptedMatches ?? []).map((m) => [
                <span key="p" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--pepf-ink)' }}>
                  {m.program?.canonicalName ?? m.programId}
                </span>,
                <span key="s" className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-body)' }}>
                  {m.confidenceBand.toUpperCase()}
                </span>,
                <EvMark key="e" state="VERIFIED" label="■ VERIFIED" quiet />,
              ])}
              minWidth={640}
            />
          ) : null}

          {/* Relationships (disclosure) */}
          {relationships.length > 0 || related.length > 0 ? (
            <div className="pe-pf-card">
              <button
                type="button"
                onClick={() => setLinksOpen((o) => !o)}
                aria-expanded={linksOpen}
                style={{
                  padding: '12px 18px 11px',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  cursor: 'pointer',
                  flexWrap: 'wrap',
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 0,
                  borderRadius: 0,
                  color: 'inherit',
                }}
              >
                <span className="pe-pf-card-title">Relationships</span>
                <span className="pe-pf-eyebrow-quiet">
                  {relationships.length + related.length} LINK{relationships.length + related.length === 1 ? '' : 'S'}
                </span>
                <span style={{ flex: 1, minWidth: 8 }} />
                <span className="pe-pf-mono" style={{ fontSize: 11, color: 'var(--pepf-secondary)' }}>
                  {linksOpen ? '−' : '+'}
                </span>
              </button>
              {linksOpen ? (
                <div className="pe-pf-scroll-x" style={{ borderTop: '1px solid var(--pepf-border)' }}>
                  <div style={{ minWidth: 640 }}>
                    {relationships.map((r) => (
                      <div
                        key={r.id}
                        className="pe-pf-listrow"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0,1fr) 260px 150px',
                          columnGap: 14,
                          padding: '11px 18px',
                          alignItems: 'center',
                        }}
                      >
                        <span
                          className="pe-pf-mono"
                          style={{
                            fontSize: 12,
                            color: 'var(--pepf-ink)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {r.line.peCode} — {r.line.title}
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--pepf-body)' }}>
                          {r.relType.replaceAll('_', ' ')}
                        </span>
                        <span>
                          <EvMark
                            state={r.status === 'accepted' ? 'VERIFIED' : 'PENDING'}
                            label={r.status === 'accepted' ? '■ VERIFIED' : '⊘ CANDIDATE'}
                            quiet={r.status === 'accepted'}
                          />
                        </span>
                      </div>
                    ))}
                    {related.map((r) => (
                      <div
                        key={r.peCode}
                        className="pe-pf-listrow"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0,1fr) 260px 150px',
                          columnGap: 14,
                          padding: '11px 18px',
                          alignItems: 'center',
                        }}
                      >
                        <span
                          className="pe-pf-mono"
                          style={{
                            fontSize: 12,
                            color: 'var(--pepf-ink)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {r.peCode} — {r.title}
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--pepf-body)' }}>
                          Mission similarity {r.similarity.toFixed(2)} (suggestion)
                        </span>
                        <span>
                          <EvMark state="PENDING" label="⊘ SUGGESTED" quiet />
                        </span>
                      </div>
                    ))}
                    <div
                      className="pe-pf-mono"
                      style={{ padding: '12px 18px', fontSize: 11, letterSpacing: '0.06em', color: 'var(--pepf-secondary)', lineHeight: 1.6 }}
                    >
                      A RELATIONSHIP GRAPH IS OFFERED ONLY WHERE EVERY LINK IN THE SET IS VERIFIED. CANDIDATE LINKS
                      STAY IN THIS LIST.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
