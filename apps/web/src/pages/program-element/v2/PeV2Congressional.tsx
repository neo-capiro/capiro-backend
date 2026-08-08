/**
 * Program Elements v2 — Congressional surface.
 * Stage-aggregate cards (Authorization / Appropriations) + the cross-line
 * position matrix, computed from monitored lines' detail reads. Tracks are
 * never combined; divergence is only ever reported within one track.
 */
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  getMarkupMonitor,
  getProgramElementDetail,
} from '../api.js';
import { buildFundingSeries } from '../funding-model.js';
import {
  APPR_LADDER,
  AUTH_LADDER,
  money,
  sgn,
  spct,
  stageSub,
  V2_STAGE_LABEL,
  type V2StageId,
} from './pe-v2-model.js';
import { EvMark, Segmented } from './pe-v2-primitives.js';

type Track = 'both' | 'auth' | 'appr';

function cellFor(
  years: ReturnType<typeof buildFundingSeries>,
  stage: V2StageId,
): { value: number | null; word: string | null } {
  // Use the latest FY that carries any value for the line.
  const latest = [...years].reverse().find((y) => y.current.value != null);
  if (!latest) return { value: null, word: 'NOT FILED' };
  const v =
    stage === 'request'
      ? latest.request
      : stage === 'hasc'
        ? latest.hascMark
        : stage === 'sasc'
          ? latest.sascMark
          : stage === 'ndaaConf'
            ? latest.ndaaConference
            : stage === 'hacd'
              ? latest.hacDMark
              : stage === 'sacd'
                ? latest.sacDMark
                : stage === 'conf'
                  ? latest.conference
                  : latest.enacted;
  if (v != null) return { value: v, word: null };
  return {
    value: null,
    word: stage === 'enacted' ? 'NOT ENACTED' : stage === 'conf' || stage === 'ndaaConf' ? 'NOT FILED' : 'NOT FILED',
  };
}

export function PeV2Congressional() {
  const api = useApi();
  const navigate = useNavigate();
  const [track, setTrack] = useState<Track>('both');

  // The matrix spans the divergence-watch set (markup monitor) — monitored lines
  // with live marks, matching the mockup's "MONITORED LINES · FY" caption.
  const monitor = useQuery({
    queryKey: ['pe-v2-congressional-monitor'],
    queryFn: () => getMarkupMonitor(api, {}),
    staleTime: 60_000,
  });
  const lines = useMemo(
    () => (monitor.data?.data ?? []).slice(0, 24),
    [monitor.data],
  );

  const details = useQueries({
    queries: lines.map((l) => ({
      queryKey: ['program-element-detail', l.peCode],
      queryFn: () => getProgramElementDetail(api, l.peCode),
      staleTime: 5 * 60_000,
    })),
  });

  const rows = useMemo(
    () =>
      lines.map((l, i) => {
        const detail = details[i]?.data;
        const series = detail ? buildFundingSeries(detail.years ?? []) : [];
        return { code: l.peCode, title: l.title, series, divergence: l.divergencePct };
      }),
    [lines, details],
  );

  const cols: V2StageId[] =
    track === 'auth'
      ? AUTH_LADDER
      : track === 'appr'
        ? APPR_LADDER
        : (['request', 'hasc', 'sasc', 'ndaaConf', 'hacd', 'sacd', 'conf', 'enacted'] as V2StageId[]);

  const agg = (stages: V2StageId[]) =>
    stages.map((s) => {
      let sum = 0;
      let filed = 0;
      for (const r of rows) {
        const c = cellFor(r.series, s);
        if (c.value != null) {
          sum += c.value;
          filed += 1;
        }
      }
      return { stage: s, sum, filed, total: rows.length };
    });

  const authAgg = agg(AUTH_LADDER);
  const apprAgg = agg(APPR_LADDER);

  const loading = monitor.isLoading || details.some((d) => d.isLoading);

  const gridCols = `minmax(226px,1fr) repeat(${cols.length},90px) 152px`;

  return (
    <div data-screen-label="Congressional">
      <div className="pe-v2-page-head">
        <div style={{ flex: 1, minWidth: 340 }}>
          <div className="pe-v2-page-title">Congressional</div>
          <div className="pe-v2-page-sub">
            Compare House, Senate, conference and enacted positions across monitored defense programs.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', marginTop: 6 }}>
          <span className="pe-v2-eyebrow">Table track</span>
          <Segmented
            ariaLabel="Track"
            options={[
              { value: 'both', label: 'BOTH' },
              { value: 'auth', label: 'AUTHORIZATION' },
              { value: 'appr', label: 'APPROPRIATIONS' },
            ]}
            value={track}
            onChange={setTrack}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 24 }}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      ) : (
        <>
          <div style={{ padding: '20px 24px 0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(430px,1fr))', gap: 20 }}>
              {(
                [
                  ['AUTHORIZATION', 'NDAA · what may be spent', authAgg],
                  ['APPROPRIATIONS', 'Defense Approps · what is actually funded', apprAgg],
                ] as const
              ).map(([name, sub, ag]) => (
                <div key={name} className="pe-v2-card pe-v2-card-inktop">
                  <div className="pe-v2-card-head">
                    <span className="pe-v2-eyebrow" style={{ color: 'var(--pev2-ink)', fontWeight: 600, letterSpacing: '0.12em' }}>
                      {name}
                    </span>
                    <span style={{ fontSize: 12.5, color: 'var(--pev2-secondary)' }}>{sub}</span>
                    <span style={{ flex: 1, minWidth: 8 }} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap' }}>
                    {ag.map((a, i) => (
                      <div
                        key={a.stage}
                        title={stageSub(a.stage)}
                        style={{
                          flex: '1 1 132px',
                          minWidth: 132,
                          padding: '13px 14px 15px',
                          borderLeft: i ? '1px solid var(--pev2-hairline)' : 'none',
                          background: i === ag.length - 1 ? 'var(--pev2-raised)' : '#fff',
                        }}
                      >
                        <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--pev2-secondary)' }}>
                          {V2_STAGE_LABEL[a.stage]}
                        </div>
                        {a.filed > 0 ? (
                          <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.02em', marginTop: 7, color: 'var(--pev2-ink)', whiteSpace: 'nowrap' }}>
                            {money(a.sum)}
                          </div>
                        ) : (
                          <div className="pe-v2-mono" style={{ fontSize: 12.5, letterSpacing: '0.05em', marginTop: 9, color: 'var(--pev2-quiet)' }}>
                            NOT FILED
                          </div>
                        )}
                        <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-secondary)', marginTop: 4 }}>
                          {a.filed} OF {a.total} FILED
                        </div>
                        <div style={{ marginTop: 9 }}>
                          <EvMark
                            state={a.filed === a.total && a.total > 0 ? 'VERIFIED' : a.filed === 0 ? 'ABSENT' : 'PARTIAL'}
                            label={a.filed === a.total && a.total > 0 ? '■ COMPLETE' : a.filed === 0 ? '⊘ NOT FILED' : '◧ PARTIAL'}
                            quiet
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--pev2-secondary)', marginTop: 10 }}>
              TRACKS ARE NEVER COMBINED · A SENATE AUTHORIZATION FIGURE IS NOT AN APPROPRIATION
            </div>
          </div>

          <div style={{ background: '#fff', borderTop: '1px solid var(--pev2-border-strong)', marginTop: 20 }}>
            <div
              style={{
                padding: '12px 24px',
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                borderBottom: '1px solid var(--pev2-border)',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: '#121722' }}>Cross-line positions</div>
              <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>
                {rows.length} MONITORED LINES
              </div>
              <div style={{ flex: 1, minWidth: 8 }} />
              <div className="pe-v2-eyebrow-quiet" style={{ letterSpacing: '0.06em' }}>
                SELECT A ROW FOR THE LINE
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 226 + cols.length * 90 + 152 + (cols.length + 2) * 12 + 48 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: gridCols,
                    columnGap: 12,
                    padding: '9px 24px',
                    borderBottom: '1px solid var(--pev2-border-strong)',
                    background: 'var(--pev2-canvas)',
                    fontFamily: 'var(--pev2-mono)',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    color: 'var(--pev2-secondary)',
                    position: 'sticky',
                    top: 0,
                    zIndex: 5,
                  }}
                >
                  <div style={{ color: 'var(--pev2-ink)', fontWeight: 600 }}>Program</div>
                  {cols.map((c) => (
                    <div key={c} style={{ textAlign: 'right' }}>
                      {V2_STAGE_LABEL[c]}
                    </div>
                  ))}
                  <div>Material change</div>
                </div>
                {rows.map((r) => {
                  const latest = [...r.series].reverse().find((y) => y.current.value != null);
                  const delta = latest?.deltaVsRequest ?? null;
                  const pct =
                    delta != null && latest?.request
                      ? (delta / Math.abs(latest.request)) * 100
                      : null;
                  return (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => navigate(`/program-elements/${encodeURIComponent(r.code)}`)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: gridCols,
                        columnGap: 12,
                        padding: '10px 24px',
                        borderBottom: '1px solid var(--pev2-hairline)',
                        alignItems: 'start',
                        cursor: 'pointer',
                        background: '#fff',
                        width: '100%',
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span className="pe-v2-mono" style={{ display: 'block', fontSize: 11.5, letterSpacing: '0.04em', color: 'var(--pev2-secondary)' }}>
                          {r.code}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: 'var(--pev2-ink)',
                            marginTop: 2,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {r.title}
                        </span>
                      </span>
                      {cols.map((c) => {
                        const cell = cellFor(r.series, c);
                        const isCur = latest != null && latest.current.value != null && latest.current.value === cell.value && cell.value != null;
                        return cell.value != null ? (
                          <span
                            key={c}
                            style={{
                              textAlign: 'right',
                              fontSize: 13,
                              fontVariantNumeric: 'tabular-nums',
                              paddingTop: 3,
                              color: 'var(--pev2-ink)',
                              fontWeight: isCur ? 700 : 600,
                              boxShadow: isCur ? 'inset 0 -2px 0 var(--pev2-ink)' : 'none',
                            }}
                          >
                            {money(cell.value)}
                          </span>
                        ) : (
                          <span
                            key={c}
                            className="pe-v2-mono"
                            style={{
                              textAlign: 'right',
                              fontSize: 10.5,
                              letterSpacing: '0.04em',
                              color: 'var(--pev2-quiet)',
                              paddingTop: 5,
                            }}
                          >
                            {cell.word}
                          </span>
                        );
                      })}
                      <span
                        className="pe-v2-mono"
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          paddingTop: 4,
                          color: delta == null ? 'var(--pev2-secondary)' : delta > 0 ? 'var(--pev2-success)' : delta < 0 ? 'var(--pev2-ink)' : 'var(--pev2-secondary)',
                        }}
                      >
                        {delta == null ? 'NO POSITION' : delta === 0 ? 'NO MATERIAL CHANGE' : `${sgn(delta)} · ${spct(pct)}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="pe-v2-table-foot">
              AUTHORIZATION AND APPROPRIATIONS ARE SEPARATE AUTHORITIES · DIVERGENCE IS NEVER COMBINED ACROSS TRACKS
            </div>
          </div>
        </>
      )}
    </div>
  );
}
