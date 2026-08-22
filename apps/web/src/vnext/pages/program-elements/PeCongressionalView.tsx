/**
 * Program Elements vNext — Congressional surface (native port of
 * src/pages/program-element/v2/PeV2Congressional.tsx).
 * Stage-aggregate cards (Authorization / Appropriations) + the cross-line
 * position matrix, computed from monitored lines' detail reads. Tracks are
 * never combined; divergence is only ever reported within one track.
 *
 * Phase 4 polish: the matrix is a real `CapiroTable`, the aggregate cards are
 * vNext card chrome and the per-stage completeness marks are `CapiroBadge`s.
 * Endpoints, query keys, the aggregate math and every copy string are unchanged.
 */
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import {
  getMarkupMonitor,
  getProgramElementDetail,
} from '../../../pages/program-element/api.js';
import { buildFundingSeries } from '../../../pages/program-element/funding-model.js';
import {
  APPR_LADDER,
  AUTH_LADDER,
  money,
  sgn,
  spct,
  stageSub,
  V2_STAGE_LABEL,
  type V2StageId,
} from '../../../pages/program-element/v2/pe-v2-model.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { EvMark, PeSkeletonBlock, Segmented } from './pe-primitives.js';
import { familyById, serviceToApiParam, useDefenseBudgetContext } from './defense-budget-context.js';

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

export function PeCongressionalView() {
  const api = useApi();
  const navigate = useNavigate();
  const ctx = useDefenseBudgetContext();
  const family = familyById(ctx.family);
  const [track, setTrack] = useState<Track>('both');

  // The matrix spans the divergence-watch set (markup monitor) — monitored lines
  // with live marks, matching the mockup's "MONITORED LINES · FY" caption.
  // `service` is a real, supported query param; the markup-monitor endpoint
  // has no family/line-type facet, so the family context-bar dimension is not
  // applied here — the cards below reflect exactly what this endpoint covers.
  const monitor = useQuery({
    queryKey: ['pe-v2-congressional-monitor', serviceToApiParam(ctx.service)],
    queryFn: () => getMarkupMonitor(api, { service: serviceToApiParam(ctx.service) }),
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

  return (
    <div data-screen-label="Congressional" className="pe-ws-view">
      <div className="pe-v2-page-head">
        <div className="pe-ws-head__text">
          <div className="pe-v2-page-title">Congressional</div>
          <div className="pe-v2-page-sub">
            Compare House, Senate, conference and enacted positions across monitored defense programs.
          </div>
        </div>
        <div className="pe-ws-head__actions">
          <span className="pe-ws-eyebrow">Table track</span>
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
        <div className="pe-ws-body">
          <section className="pe-v2-card">
            <div className="pe-ws-pad">
              <PeSkeletonBlock rows={8} />
            </div>
          </section>
        </div>
      ) : (
        <div className="pe-ws-body">
          {family.id !== 'All' ? (
            <p className="pe-ws-note">
              THE {family.label.toUpperCase()} FAMILY FILTER DOES NOT SCOPE THIS VIEW YET — MARKUP MONITOR HAS NO
              FAMILY FACET. SERVICE FILTERING IS APPLIED.
            </p>
          ) : null}
          <div className="pe-ws-trackgrid">
            {(
              [
                ['AUTHORIZATION', 'NDAA · what may be spent', authAgg],
                ['APPROPRIATIONS', 'Defense Approps · what is actually funded', apprAgg],
              ] as const
            ).map(([name, sub, ag]) => (
              <section key={name} className="pe-v2-card pe-v2-card-inktop">
                <div className="pe-v2-card-head">
                  <span className="pe-ws-eyebrow pe-ws-eyebrow--ink">{name}</span>
                  <span className="pe-ws-card-sub">{sub}</span>
                </div>
                <div className="pe-ws-stagerow">
                  {ag.map((a, i) => (
                    <div
                      key={a.stage}
                      title={stageSub(a.stage)}
                      className={`pe-ws-stagecell${i === ag.length - 1 ? ' is-terminal' : ''}`}
                    >
                      <div className="pe-ws-cap pe-ws-cap--strong">{V2_STAGE_LABEL[a.stage]}</div>
                      {a.filed > 0 ? (
                        <div className="pe-ws-stagecell__value">{money(a.sum)}</div>
                      ) : (
                        <div className="pe-ws-stagecell__absent">NOT FILED</div>
                      )}
                      <div className="pe-ws-cap">
                        {a.filed} OF {a.total} FILED
                      </div>
                      <div className="pe-ws-stagecell__mark">
                        <EvMark
                          state={a.filed === a.total && a.total > 0 ? 'VERIFIED' : a.filed === 0 ? 'ABSENT' : 'PARTIAL'}
                          label={a.filed === a.total && a.total > 0 ? 'COMPLETE' : a.filed === 0 ? 'NOT FILED' : 'PARTIAL'}
                          quiet
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <p className="pe-ws-note">
            TRACKS ARE NEVER COMBINED · A SENATE AUTHORIZATION FIGURE IS NOT AN APPROPRIATION
          </p>

          <section className="pe-v2-card pe-ws-tablecard">
            <div className="pe-v2-card-head">
              <div className="pe-v2-card-title">Cross-line positions</div>
              <span className="pe-ws-cap">{rows.length} MONITORED LINES</span>
              <span className="pe-ws-spacer" />
              <span className="pe-ws-cap">SELECT A ROW FOR THE LINE</span>
            </div>
            <CapiroTableWrap className="pe-ws-tablescroll">
              <CapiroTable className="pe-ws-table">
                <CapiroTableHead>
                  <tr>
                    <CapiroTableHeaderCell className="pe-ws-col-id">Program</CapiroTableHeaderCell>
                    {cols.map((c) => (
                      <CapiroTableHeaderCell key={c} className="pe-ws-num">
                        {V2_STAGE_LABEL[c]}
                      </CapiroTableHeaderCell>
                    ))}
                    <CapiroTableHeaderCell>Material change</CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.map((r) => {
                    const latest = [...r.series].reverse().find((y) => y.current.value != null);
                    const delta = latest?.deltaVsRequest ?? null;
                    const pct =
                      delta != null && latest?.request
                        ? (delta / Math.abs(latest.request)) * 100
                        : null;
                    const open = () => navigate(`/program-elements/${encodeURIComponent(r.code)}`);
                    return (
                      <tr key={r.code} className="pe-ws-row pe-ws-row--link" onClick={open}>
                        <CapiroTableCell className="pe-ws-col-id">
                          <button
                            type="button"
                            className="pe-ws-idbtn"
                            onClick={(event) => {
                              event.stopPropagation();
                              open();
                            }}
                          >
                            <span className="pe-ws-code">{r.code}</span>
                            <span className="pe-ws-title">{r.title}</span>
                          </button>
                        </CapiroTableCell>
                        {cols.map((c) => {
                          const cell = cellFor(r.series, c);
                          const isCur =
                            latest != null &&
                            latest.current.value != null &&
                            latest.current.value === cell.value &&
                            cell.value != null;
                          return cell.value != null ? (
                            <CapiroTableCell
                              key={c}
                              className={`pe-ws-num pe-ws-stageval${isCur ? ' is-current' : ''}`}
                            >
                              <span>{money(cell.value)}</span>
                            </CapiroTableCell>
                          ) : (
                            <CapiroTableCell key={c} className="pe-ws-num pe-ws-cap">
                              {cell.word}
                            </CapiroTableCell>
                          );
                        })}
                        <CapiroTableCell>
                          <span
                            className={`pe-ws-delta${
                              delta == null ? ' is-flat' : delta > 0 ? ' is-up' : delta < 0 ? ' is-down' : ' is-flat'
                            }`}
                          >
                            {delta == null ? 'NO POSITION' : delta === 0 ? 'NO MATERIAL CHANGE' : `${sgn(delta)} · ${spct(pct)}`}
                          </span>
                        </CapiroTableCell>
                      </tr>
                    );
                  })}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
            <div className="pe-v2-table-foot">
              AUTHORIZATION AND APPROPRIATIONS ARE SEPARATE AUTHORITIES · DIVERGENCE IS NEVER COMBINED ACROSS TRACKS
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
