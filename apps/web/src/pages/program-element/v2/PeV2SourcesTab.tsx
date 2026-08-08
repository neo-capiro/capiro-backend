/**
 * Program Elements v2 — Sources & proof tab.
 * EvidenceCoverageMap (stage families of square nodes with verified ratios) +
 * source ledger (quiet PASSED, loud conflict) + data-quality card shown only
 * when there is something to resolve.
 */
import { useMemo } from 'react';
import { Skeleton } from 'antd';
import type { ProgramElementProfileFinalVm } from '../useProgramElementProfileFinal.js';
import type { V2StageId } from './pe-v2-model.js';
import { EvMark } from './pe-v2-primitives.js';
import { PeV2SourceInspector, type InspectorTarget } from './PeV2SourceInspector.js';
import { useState } from 'react';

const COVER_GROUPS: Array<{ name: string; cells: Array<{ stage: V2StageId; label: string }> }> = [
  {
    name: 'AUTHORIZATION',
    cells: [
      { stage: 'hasc', label: 'HASC' },
      { stage: 'sasc', label: 'SASC' },
      { stage: 'ndaaConf', label: 'NDAA CONF.' },
    ],
  },
  {
    name: 'APPROPRIATIONS',
    cells: [
      { stage: 'hacd', label: 'HAC-D' },
      { stage: 'sacd', label: 'SAC-D' },
      { stage: 'conf', label: 'APPROPS CONF.' },
      { stage: 'enacted', label: 'ENACTED' },
    ],
  },
];

export function PeV2SourcesTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
  const { detail, latest, sourcesQuery, deltasQuery, setDataIssueOpen } = vm;
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);

  const sources = sourcesQuery.data ?? [];
  const deltas = deltasQuery.data?.data ?? [];
  const conflictCount = detail?.openReconciliationConflictCount ?? 0;

  const coverage = useMemo(() => {
    const requestVerified = (detail?.sourceCount ?? 0) > 0;
    const groups = [
      {
        name: "PRESIDENT'S BUDGET",
        cells: [
          {
            stage: 'request' as V2StageId,
            label: 'R-DOCS',
            state: requestVerified ? ('VERIFIED' as const) : ('ABSENT' as const),
          },
        ],
      },
      ...COVER_GROUPS.map((g) => ({
        name: g.name,
        cells: g.cells.map((c) => {
          const FIELD_BY_STAGE: Partial<Record<V2StageId, string>> = {
            hasc: 'hascMark',
            sasc: 'sascMark',
            ndaaConf: 'ndaaConference',
            hacd: 'hacDMark',
            sacd: 'sacDMark',
            conf: 'conference',
            enacted: 'enacted',
          };
          const field = FIELD_BY_STAGE[c.stage];
          const value =
            latest != null && field
              ? ((latest as unknown as Record<string, number | null>)[field] ?? null)
              : c.stage === 'request'
                ? (latest?.request ?? null)
                : null;
          return {
            stage: c.stage,
            label: c.label,
            state: value != null ? ('VERIFIED' as const) : ('ABSENT' as const),
          };
        }),
      })),
    ];
    return groups;
  }, [detail, latest]);

  return (
    <div style={{ padding: '20px 24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Coverage map */}
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.012em', color: 'var(--pev2-ink)' }}>
            FY{latest?.fy ?? ''} evidence coverage
          </div>
          <div style={{ flex: 1, minWidth: 8 }} />
          <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
            MISSING IS NEVER ZERO · EVERY CELL STATES WHAT EXISTS
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(310px,1fr))', gap: 20, alignItems: 'start' }}>
          {coverage.map((g) => {
            const verified = g.cells.filter((c) => c.state === 'VERIFIED').length;
            const alert = conflictCount > 0;
            return (
              <div key={g.name} className="pe-v2-card">
                <div
                  style={{
                    padding: '12px 16px 11px',
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    borderBottom: '1px solid var(--pev2-hairline)',
                  }}
                >
                  <span className="pe-v2-eyebrow" style={{ letterSpacing: '0.12em', fontWeight: 600, color: 'var(--pev2-ink)' }}>
                    {g.name}
                  </span>
                  <span style={{ flex: 1, minWidth: 6 }} />
                  <span
                    className="pe-v2-mono"
                    style={{
                      fontSize: 11,
                      letterSpacing: '0.06em',
                      whiteSpace: 'nowrap',
                      color: alert && g.name === 'APPROPRIATIONS' ? 'var(--pev2-warning)' : verified === g.cells.length ? 'var(--pev2-ink)' : 'var(--pev2-quiet)',
                    }}
                  >
                    {verified} / {g.cells.length} VERIFIED
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', padding: '4px 16px 14px' }}>
                  {g.cells.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className="pe-v2-cov-node"
                      onClick={() =>
                        setInspector({
                          track: g.name === 'AUTHORIZATION' ? 'Authorization' : g.name === "PRESIDENT'S BUDGET" ? 'Budget line' : 'Appropriations',
                          stage: c.label === 'R-DOCS' ? 'REQUEST' : c.label,
                        })
                      }
                    >
                      <span
                        className={`pe-v2-ev-mark lg ${c.state === 'VERIFIED' ? 'verified' : 'absent'}`}
                        style={{ display: 'block' }}
                      />
                      <span
                        className="pe-v2-mono"
                        style={{
                          display: 'block',
                          fontSize: 11.5,
                          fontWeight: 600,
                          letterSpacing: '0.05em',
                          color: 'var(--pev2-ink)',
                          marginTop: 9,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {c.label}
                      </span>
                      <span
                        className="pe-v2-mono"
                        style={{
                          display: 'block',
                          fontSize: 10,
                          letterSpacing: '0.05em',
                          marginTop: 4,
                          whiteSpace: 'nowrap',
                          color: c.state === 'VERIFIED' ? 'var(--pev2-body)' : 'var(--pev2-quiet)',
                        }}
                      >
                        {c.state === 'VERIFIED' ? 'VERIFIED' : c.stage === 'enacted' ? 'NOT ENACTED' : 'NOT FILED'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Source ledger */}
      <div className="pe-v2-card">
        <div className="pe-v2-card-head">
          <div className="pe-v2-card-title">Source ledger</div>
          <div style={{ flex: 1, minWidth: 8 }} />
          <button
            type="button"
            className="pe-v2-quiet-link ink"
            onClick={() => {
              const csv = [
                ['Source', 'Exhibit', 'FY', 'Page', 'Doc type'],
                ...sources.map((s) => [
                  s.sourceDocument?.title ?? s.publisher ?? '',
                  s.exhibitType ?? '',
                  s.fy,
                  s.pageNumber,
                  s.docType,
                ]),
              ]
                .map((r) => r.map((c) => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))
                .join('\n');
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${detail?.peCode ?? 'pe'}-sources.csv`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Export
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1080 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(240px,1fr) 210px 78px 96px 128px 96px',
                columnGap: 12,
                padding: '9px 18px',
                borderBottom: '1px solid var(--pev2-border-strong)',
                background: 'var(--pev2-canvas)',
                fontFamily: 'var(--pev2-mono)',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--pev2-secondary)',
              }}
            >
              <div style={{ color: 'var(--pev2-ink)', fontWeight: 600 }}>Source</div>
              <div>Exhibit</div>
              <div>FY</div>
              <div>Page</div>
              <div>Verification</div>
              <div>Open</div>
            </div>
            {sourcesQuery.isLoading ? (
              <div style={{ padding: 18 }}>
                <Skeleton active paragraph={{ rows: 3 }} title={false} />
              </div>
            ) : sources.length === 0 ? (
              <div className="pe-v2-empty" style={{ padding: 18 }}>
                No page-level sources are attached to this line yet.
              </div>
            ) : (
              sources.map((s) => {
                const passed = s.confidence == null || s.confidence >= 0.5;
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(240px,1fr) 210px 78px 96px 128px 96px',
                      columnGap: 12,
                      padding: '10px 18px',
                      borderBottom: '1px solid var(--pev2-hairline)',
                      alignItems: 'center',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: 'var(--pev2-ink)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {s.sourceDocument?.title ?? s.publisher ?? s.docType}
                    </div>
                    <div
                      className="pe-v2-mono"
                      style={{ fontSize: 11.5, color: 'var(--pev2-body)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {s.exhibitType ?? s.docType}
                    </div>
                    <div className="pe-v2-mono" style={{ fontSize: 11.5, color: 'var(--pev2-body)' }}>
                      {s.fy != null ? `FY${s.fy}` : '—'}
                    </div>
                    <div className="pe-v2-mono" style={{ fontSize: 11.5, color: 'var(--pev2-body)' }}>
                      {s.pageNumber != null ? `p. ${s.pageNumber}` : '—'}
                    </div>
                    <div>
                      {passed ? (
                        <span className="pe-v2-mono" style={{ fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--pev2-quiet)' }}>
                          ✓ PASSED
                        </span>
                      ) : (
                        <span className="pe-v2-ev-chip conflict">⚠ REVIEW</span>
                      )}
                    </div>
                    <div>
                      {s.sourceUrl ? (
                        <a
                          href={s.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="pe-v2-mono"
                          style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-ink-2)', textDecoration: 'underline', textUnderlineOffset: 3 }}
                        >
                          OPEN →
                        </a>
                      ) : (
                        <span className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-quiet)' }}>
                          —
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Data quality — shown only when there is something to resolve */}
      {conflictCount > 0 ? (
        <div className="pe-v2-card pe-v2-card-rusttop">
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Data quality</div>
            <div style={{ flex: 1 }} />
            <span className="pe-v2-eyebrow-quiet">SHOWN ONLY WHEN THERE IS SOMETHING TO RESOLVE</span>
          </div>
          <div style={{ padding: '14px 18px', display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span className="pe-v2-ev-chip conflict" style={{ flex: 'none' }}>
              BLOCKING CONFLICT
            </span>
            <div style={{ flex: '1 1 0', minWidth: 280, fontSize: 13.5, lineHeight: 1.58, color: 'var(--pev2-body)' }}>
              {conflictCount} open reconciliation conflict{conflictCount === 1 ? '' : 's'} on this line. The current
              position is blocked until a reviewer resolves the disagreement.
            </div>
            <button type="button" className="pe-v2-btn pe-v2-btn-sm" style={{ flex: 'none' }} onClick={() => setDataIssueOpen(true)}>
              Open conflict
            </button>
          </div>
        </div>
      ) : null}

      {/* Snapshot deltas detail */}
      {deltas.length > 0 ? (
        <div className="pe-v2-card">
          <div className="pe-v2-card-head">
            <div className="pe-v2-card-title">Verification activity</div>
            <div style={{ flex: 1 }} />
            <span className="pe-v2-eyebrow-quiet">{deltas.length} RECORDS</span>
          </div>
          {deltas.slice(0, 6).map((d) => (
            <div key={d.id} style={{ padding: '10px 18px', borderBottom: '1px solid var(--pev2-hairline)', display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span className="pe-v2-mono" style={{ fontSize: 11.5, color: 'var(--pev2-ink)' }}>
                {d.deltaType.replaceAll('_', ' ').toUpperCase()} · FY{d.assertedFy}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--pev2-body)', flex: 1, minWidth: 200 }}>
                {d.explanation ?? ''}
              </span>
              <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.05em' }}>
                {new Date(d.computedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <PeV2SourceInspector vm={vm} target={inspector} onClose={() => setInspector(null)} />
    </div>
  );
}
