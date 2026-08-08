/**
 * Program Elements v2 — Funding & lifecycle tab.
 * Two horizontal stage ladders (auth + approps), movement-vs-request waterfall
 * panels, fiscal-year sparkline with position-table disclosure, snapshot change
 * ledger, funding narrative. All values from the canonical funding series.
 */
import { useMemo, useState } from 'react';
import type { ProgramElementProfileFinalVm } from '../useProgramElementProfileFinal.js';
import type { FundingPoint } from '../funding-model.js';
import {
  APPR_LADDER,
  AUTH_LADDER,
  currentStageId,
  historySeries,
  ladderCells,
  money,
  sgn,
  spct,
  type V2StageCell,
} from './pe-v2-model.js';
import { EvMark } from './pe-v2-primitives.js';
import { PeV2SourceInspector, type InspectorTarget } from './PeV2SourceInspector.js';

function LadderTrack({
  title,
  note,
  cells,
  currentId,
  onOpen,
}: {
  title: string;
  note: string;
  cells: V2StageCell[];
  currentId: string | null;
  onOpen: (stage: string) => void;
}) {
  return (
    <div style={{ padding: '15px 20px 17px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span className="pe-v2-eyebrow" style={{ letterSpacing: '0.13em', fontWeight: 600, color: 'var(--pev2-ink)' }}>
          {title}
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--pev2-secondary)' }}>{note}</span>
        <span style={{ flex: 1, minWidth: 8 }} />
        <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
          {cells.filter((c) => c.value != null).length} OF {cells.length} STAGES FILED
        </span>
      </div>
      <ol className="pe-v2-ladder" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {cells.map((c) => (
          <li key={c.stage} style={{ flex: '1 1 0', minWidth: 156, display: 'flex' }}>
            <button
              type="button"
              className={`pe-v2-ladder-node${c.stage === currentId ? ' current' : ''}`}
              aria-current={c.stage === currentId ? 'step' : undefined}
              onClick={() => onOpen(c.label)}
              style={{ flex: 1, textAlign: 'left' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  className="pe-v2-mono"
                  style={{ fontSize: 11, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--pev2-ink)', whiteSpace: 'nowrap' }}
                >
                  {c.label}
                </span>
                {c.stage === currentId ? <span className="pe-v2-current-badge">CURRENT</span> : null}
              </span>
              {c.value != null ? (
                <span
                  className="pe-v2-ladder-val"
                  style={{ display: 'block', color: c.stage === currentId ? 'var(--pev2-ink)' : 'var(--pev2-ink-2)' }}
                >
                  {money(c.value)}
                </span>
              ) : (
                <span className="pe-v2-ladder-val absent" style={{ display: 'block' }}>
                  {c.stateWord}
                </span>
              )}
              <span
                className="pe-v2-ladder-delta"
                style={{
                  display: 'block',
                  color:
                    c.delta == null
                      ? 'var(--pev2-quiet)'
                      : c.delta > 0
                        ? 'var(--pev2-success)'
                        : c.delta < 0
                          ? 'var(--pev2-ink)'
                          : 'var(--pev2-quiet)',
                }}
              >
                {c.stage === 'request'
                  ? 'Request baseline'
                  : c.delta == null
                    ? ''
                    : c.delta === 0
                      ? 'No change vs request'
                      : `${sgn(c.delta)} vs request`}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 9 }}>
                <EvMark state={c.ev} label={c.value != null ? '■ VERIFIED' : `⊘ ${c.stateWord}`} quiet />
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Waterfall({
  title,
  claim,
  cells,
  baseline,
  note,
}: {
  title: string;
  claim: string;
  cells: V2StageCell[];
  baseline: number | null;
  note: string;
}) {
  const rows = cells.filter((c) => c.stage !== 'request');
  const max = Math.max(...rows.map((r) => Math.abs(r.delta ?? 0)), 1);
  return (
    <div className="pe-v2-card">
      <div className="pe-v2-card-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: '#121722' }}>{title}</div>
        <div style={{ fontSize: 12.5, color: 'var(--pev2-secondary)' }}>{claim}</div>
      </div>
      {rows.map((r) => {
        const d = r.delta;
        const w = d ? Math.max(5, Math.round((Math.abs(d) / max) * 92)) : 0;
        return (
          <div key={r.stage} className="pe-v2-wfall-row">
            <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--pev2-ink)', whiteSpace: 'nowrap', paddingTop: 1 }}>
              {r.label}
            </div>
            <div className="pe-v2-wfall-track">
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--pev2-control)' }} />
              {d == null ? (
                r.value == null ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: 'calc(50% - 8px)',
                      top: 4,
                      width: 16,
                      height: 6,
                      border: '1px dashed var(--pev2-border-strong)',
                    }}
                  />
                ) : null
              ) : d === 0 ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 'calc(50% - 3px)',
                    top: 4,
                    width: 6,
                    height: 6,
                    background: 'var(--pev2-border-strong)',
                  }}
                />
              ) : (
                <div
                  style={{
                    position: 'absolute',
                    ...(d < 0 ? { right: '50%' } : { left: '50%' }),
                    top: 4,
                    height: 6,
                    width: w,
                    background: d < 0 ? '#131A24' : '#2F6B4F',
                  }}
                />
              )}
            </div>
            <div
              style={
                r.value != null
                  ? { textAlign: 'right', fontSize: 13, fontWeight: 600, color: 'var(--pev2-ink)', fontVariantNumeric: 'tabular-nums' }
                  : { textAlign: 'right', fontFamily: 'var(--pev2-mono)', fontSize: 10.5, letterSpacing: '0.05em', color: 'var(--pev2-quiet)' }
              }
            >
              {r.value != null ? money(r.value) : r.stateWord}
            </div>
            <div
              className="pe-v2-mono"
              style={{
                fontSize: 11,
                fontWeight: 600,
                textAlign: 'right',
                whiteSpace: 'nowrap',
                color: d == null ? 'var(--pev2-quiet)' : d > 0 ? 'var(--pev2-success)' : d < 0 ? 'var(--pev2-ink)' : 'var(--pev2-quiet)',
              }}
            >
              {d == null ? '' : d === 0 ? 'NO CHANGE' : sgn(d)}
            </div>
          </div>
        );
      })}
      <div
        style={{
          padding: '9px 18px 11px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          borderTop: '1px solid var(--pev2-border)',
        }}
      >
        <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>Baseline</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--pev2-ink)' }}>
          {baseline != null ? `${money(baseline)} request` : 'No request filed'}
        </span>
        <span style={{ flex: 1 }} />
        <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>{note}</span>
      </div>
    </div>
  );
}

export function PeV2FundingTab({ vm }: { vm: ProgramElementProfileFinalVm }) {
  const { detail, funding, latest, deltasQuery, narrativeQuery } = vm;
  const [histOpen, setHistOpen] = useState(false);
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);

  const latestFp: FundingPoint | undefined = latest;
  const authCells = useMemo(() => (latestFp ? ladderCells(latestFp, 'auth') : []), [latestFp]);
  const apprCells = useMemo(() => (latestFp ? ladderCells(latestFp, 'appr') : []), [latestFp]);
  const curId = currentStageId(latestFp);
  const hist = useMemo(() => historySeries(detail!, funding), [detail, funding]);

  const spark = useMemo(() => {
    if (hist.length < 2) return null;
    const vals = hist.map((h) => h.value);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const span = mx - mn || 1;
    const pts = hist.map((h, i) => ({
      x: hist.length === 1 ? 50 : i * (100 / (hist.length - 1)),
      y: 20 + (1 - (h.value - mn) / span) * 44,
      kind: h.kind,
      fy: h.fy,
      val: h.value,
    }));
    const line = pts.map((p) => `${p.x.toFixed(1)},${((p.y / 74) * 40).toFixed(1)}`).join(' ');
    return { pts, line };
  }, [hist]);

  const deltas = deltasQuery.data?.data ?? [];
  const narrative = narrativeQuery.data;

  return (
    <div style={{ padding: '22px 24px 32px', display: 'flex', flexDirection: 'column', gap: 34 }}>
      {/* Funding lifecycle */}
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.012em', color: 'var(--pev2-ink)' }}>
            FY{latest?.fy ?? ''} funding lifecycle
          </div>
          <div style={{ flex: 1, minWidth: 8 }} />
          <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
            CLICK ANY STAGE FOR ITS SOURCE
          </div>
        </div>
        <div className="pe-v2-card" style={{ marginTop: 12 }}>
          <LadderTrack
            title="AUTHORIZATION"
            note="NDAA · the ceiling on what may be spent"
            cells={authCells}
            currentId={curId && ['request', 'hasc', 'sasc', 'ndaaConf'].includes(curId) ? curId : null}
            onOpen={(stage) => setInspector({ track: 'Authorization', stage })}
          />
          <div style={{ height: 1, background: 'var(--pev2-hairline)', margin: '0 20px' }} />
          <LadderTrack
            title="APPROPRIATIONS"
            note="Defense Appropriations · what is actually funded"
            cells={apprCells}
            currentId={curId && ['request', 'hacd', 'sacd', 'conf', 'enacted'].includes(curId) ? curId : null}
            onOpen={(stage) => setInspector({ track: 'Appropriations', stage })}
          />
        </div>
        <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-quiet)', marginTop: 9 }}>
          PARALLEL AUTHORITIES · A STAGE VALUE IS A POSITION, NOT A CUMULATIVE STEP · VALUES ARE NEVER SUMMED ACROSS TRACKS
        </div>
      </section>

      {/* Movement against the request */}
      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.012em', color: 'var(--pev2-ink)' }}>
            Movement against the FY{latest?.fy ?? ''} request
          </div>
          <div style={{ flex: 1, minWidth: 8 }} />
          <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.07em' }}>
            EACH STAGE MEASURED AGAINST THE REQUEST BASELINE
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(400px,1fr))',
            gap: 20,
            marginTop: 12,
            alignItems: 'start',
          }}
        >
          <Waterfall
            title="Authorization positions vs the request"
            claim="Each chamber's authorization is an alternative position on the same line — not a step in a sequence."
            cells={authCells}
            baseline={latestFp?.request ?? null}
            note="NDAA TRACK"
          />
          <Waterfall
            title="Appropriations positions vs the request"
            claim="Each subcommittee mark is an alternative position. Only enactment is final."
            cells={apprCells}
            baseline={latestFp?.request ?? null}
            note="DEFENSE APPROPS TRACK"
          />
        </div>
      </section>

      {/* History + snapshot */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))', gap: 20, alignItems: 'start' }}>
        <div className="pe-v2-card">
          <div className="pe-v2-card-head">
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#121722' }}>Fiscal-year history</div>
            <div style={{ flex: 1, minWidth: 8 }} />
            <div
              className="pe-v2-mono"
              style={{ display: 'flex', alignItems: 'center', gap: 13, fontSize: 10.5, letterSpacing: '0.05em', color: 'var(--pev2-quiet)', flexWrap: 'wrap' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, background: '#131A24', display: 'block' }} /> ENACTED
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, background: '#96A1B4', display: 'block' }} /> REQUEST
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, border: '1.5px solid #131A24', display: 'block' }} /> CURRENT
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 7, height: 7, border: '1px dashed #8792A3', display: 'block' }} /> FYDP
              </span>
            </div>
          </div>
          <div style={{ padding: '20px 18px 12px' }}>
            {spark ? (
              <>
                <div className="pe-v2-fyspark" role="img" aria-label="Fiscal year history sparkline">
                  <svg
                    viewBox="0 0 100 40"
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                  >
                    <polyline points={spark.line} fill="none" stroke="#C3CBD7" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
                  </svg>
                  {spark.pts.map((p) => (
                    <div key={p.fy} className="pe-v2-fyspark-pt" style={{ left: `${p.x}%`, top: p.y - 20 }}>
                      <div
                        className="pe-v2-mono"
                        style={{
                          fontSize: 10.5,
                          letterSpacing: '0.02em',
                          whiteSpace: 'nowrap',
                          order: -1,
                          color: p.kind === 'current' ? 'var(--pev2-ink)' : 'var(--pev2-quiet)',
                          fontWeight: p.kind === 'current' ? 600 : 400,
                        }}
                      >
                        {money(p.val)}
                      </div>
                      <div
                        style={{
                          width: 9,
                          height: 9,
                          ...(p.kind === 'enacted'
                            ? { background: '#131A24' }
                            : p.kind === 'request'
                              ? { background: '#96A1B4' }
                              : p.kind === 'current'
                                ? { border: '1.5px solid #131A24', background: '#fff' }
                                : { border: '1px dashed #8792A3' }),
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', borderTop: '1px solid var(--pev2-hairline)', paddingTop: 7 }}>
                  {spark.pts.map((p) => (
                    <div
                      key={p.fy}
                      className="pe-v2-mono"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10.5,
                        letterSpacing: '0.04em',
                        color: 'var(--pev2-quiet)',
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.fy.split(' ')[0]}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="pe-v2-empty">One or zero fiscal years on record — no trend to draw.</div>
            )}
          </div>
          <div style={{ padding: '0 18px 6px' }}>
            <button
              type="button"
              onClick={() => setHistOpen((o) => !o)}
              aria-expanded={histOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                cursor: 'pointer',
                padding: '9px 0',
                borderTop: '1px solid var(--pev2-hairline)',
                width: '100%',
              }}
            >
              <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--pev2-body)', flex: 1, textAlign: 'left' }}>
                POSITION TABLE
              </span>
              <span className="pe-v2-mono" style={{ fontSize: 11, color: 'var(--pev2-quiet)' }}>{histOpen ? '−' : '+'}</span>
            </button>
            {histOpen ? (
              <div style={{ paddingBottom: 10 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '78px minmax(0,1fr) 104px 118px',
                    columnGap: 12,
                    padding: '6px 0',
                    fontFamily: 'var(--pev2-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.08em',
                    color: 'var(--pev2-quiet)',
                    borderBottom: '1px solid var(--pev2-hairline-faint)',
                  }}
                >
                  <div>FY</div>
                  <div>Position</div>
                  <div style={{ textAlign: 'right' }}>Amount</div>
                  <div>Evidence</div>
                </div>
                {hist.map((h) => (
                  <div
                    key={h.fy}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '78px minmax(0,1fr) 104px 118px',
                      columnGap: 12,
                      padding: '7px 0',
                      borderBottom: '1px solid var(--pev2-hairline-faint)',
                      alignItems: 'center',
                    }}
                  >
                    <div className="pe-v2-mono" style={{ fontSize: 11.5, color: 'var(--pev2-ink)' }}>
                      {h.fy.split(' ')[0]}
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--pev2-body)' }}>
                      {h.kind === 'enacted'
                        ? 'Enacted appropriation'
                        : h.kind === 'request'
                          ? "President's Budget request"
                          : h.kind === 'current'
                            ? 'Current position'
                            : 'FYDP position'}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: 'var(--pev2-ink)' }}>{money(h.value)}</div>
                    <div>
                      <EvMark state={h.kind === 'fydp' ? 'ABSENT' : 'VERIFIED'} label={h.kind === 'fydp' ? '◇ OUTLOOK' : '■ VERIFIED'} quiet />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* Snapshot change ledger */}
        <div className="pe-v2-card">
          <div className="pe-v2-card-head">
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#121722' }}>What changed in this snapshot</div>
            <div style={{ flex: 1 }} />
            <span className="pe-v2-eyebrow-quiet">{deltas.length ? `${deltas.length} CHANGE${deltas.length === 1 ? '' : 'S'}` : ''}</span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 104px 114px 142px',
              columnGap: 12,
              padding: '8px 18px',
              borderBottom: '1px solid var(--pev2-hairline-faint)',
              fontFamily: 'var(--pev2-mono)',
              fontSize: 10.5,
              letterSpacing: '0.08em',
              color: 'var(--pev2-quiet)',
            }}
          >
            <div>Field</div>
            <div style={{ textAlign: 'right' }}>From</div>
            <div style={{ textAlign: 'right' }}>To</div>
            <div>Classification</div>
          </div>
          {deltas.length === 0 ? (
            <div className="pe-v2-empty" style={{ padding: '11px 18px' }}>
              No typed deltas recorded for this line in the active snapshot.
            </div>
          ) : (
            deltas.slice(0, 8).map((d) => (
              <div
                key={d.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0,1fr) 104px 114px 142px',
                  columnGap: 12,
                  padding: '9px 18px',
                  borderBottom: '1px solid var(--pev2-hairline-faint)',
                  alignItems: 'center',
                }}
              >
                <div style={{ fontSize: 13, color: 'var(--pev2-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.deltaType.replaceAll('_', ' ')}
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--pev2-mono)', fontSize: 11.5, color: 'var(--pev2-quiet)' }}>
                  {d.amountFrom != null ? money(Number(d.amountFrom)) : '—'}
                </div>
                <div style={{ textAlign: 'right', fontFamily: 'var(--pev2-mono)', fontSize: 11.5, fontWeight: 600, color: 'var(--pev2-ink)' }}>
                  {d.amountTo != null ? money(Number(d.amountTo)) : '—'}
                </div>
                <div>
                  <span className={`pe-v2-cls ${d.deltaType.includes('cut') || d.deltaType.includes('add') ? 'official' : ''}`}>
                    {d.deltaType.replaceAll('_', ' ').toUpperCase()}
                  </span>
                </div>
              </div>
            ))
          )}
          <div
            className="pe-v2-mono"
            style={{ padding: '11px 18px', fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--pev2-quiet)', lineHeight: 1.6 }}
          >
            A CORRECTION IS A CAPIRO DATA FIX · AN OFFICIAL CHANGE IS A CONGRESSIONAL ACT
          </div>
        </div>
      </section>

      {/* Funding narrative */}
      <section style={{ borderTop: '1px solid var(--pev2-border)', paddingTop: 18 }}>
        <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.1em' }}>
          Funding narrative
        </div>
        <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--pev2-body)', marginTop: 9, maxWidth: 900 }}>
          {typeof narrative === 'string'
            ? narrative
            : (narrative as { summary?: string } | null)?.summary ??
              detail?.fundingSummary ??
              'No funding narrative has been generated for this line in the active snapshot.'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 13, flexWrap: 'wrap' }}>
          <span className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-ink)' }}>
            ◆ CAPIRO ANALYSIS
          </span>
          <span style={{ width: 1, height: 13, background: 'var(--pev2-border)' }} />
          <span className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>
            DERIVED FROM VERIFIED STAGE VALUES ONLY
          </span>
        </div>
      </section>

      <PeV2SourceInspector vm={vm} target={inspector} onClose={() => setInspector(null)} />
    </div>
  );
}
