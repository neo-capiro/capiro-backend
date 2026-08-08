/**
 * Program Elements v2 — Explore surface.
 *
 * Dense analyst grid per "Capiro Program Elements v2 (standalone).html" +
 * refinement notes §01/§07: column-group header, pinned checkbox + identity,
 * BudgetDeltaRail, 72×18 sparkline, quiet-vs-loud evidence, expandable row,
 * sticky selection bar. Data: existing program-elements list + summary APIs.
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from 'antd';
import { useApi } from '../../../lib/use-api.js';
import {
  getProgramElementsList,
  getProgramElementSummary,
} from '../api.js';
import type { ProgramElementListItem } from '../types.js';
import { serviceLabel, useWatchToggle } from '../pe-shared.js';
import {
  money,
  spct,
  sgn,
  railGeometry,
  recommendedAction,
  sparkGeometry,
  stageLabelShort,
  toLineRow,
  type V2LineRow,
} from './pe-v2-model.js';
import { EvMark, FilterControl, Segmented } from './pe-v2-primitives.js';

const PAGE_SIZE = 50;
const GRID_COLS =
  '54px minmax(240px,1fr) 84px 92px 104px 104px 92px 136px 76px 128px 62px 148px 30px';

type Density = 'standard' | 'compact';

interface ExploreFilters {
  comp: string; // service
  type: string; // line type
  move: string; // movement
  mon: string; // monitored
}

const SERVICE_OPTIONS = ['ANY', 'Army', 'Navy', 'Air Force', 'Space Force', 'Defense-Wide'];
const TYPE_OPTIONS = ['ANY', 'RDT&E', 'Procurement', 'O&M'];
const MOVE_OPTIONS = ['ANY', 'Material change', 'No material change'];
const MON_OPTIONS = ['ANY', 'Monitored only'];

const SERVICE_TO_API: Record<string, string> = {
  Army: 'ARMY',
  Navy: 'NAVY',
  'Air Force': 'AF',
  'Space Force': 'SF',
  'Defense-Wide': 'DW',
};
const TYPE_TO_API: Record<string, string> = {
  'RDT&E': 'RDTE_PE',
  Procurement: 'PROCUREMENT_BLIN',
  'O&M': 'OM_BLI',
};

function rowMovement(row: V2LineRow): 'material' | 'none' {
  return row.delta != null && row.delta !== 0 ? 'material' : 'none';
}

export function PeV2Explore() {
  const api = useApi();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<ExploreFilters>({
    comp: 'ANY',
    type: 'ANY',
    move: 'ANY',
    mon: 'ANY',
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const [density, setDensity] = useState<Density>('standard');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const watch = useWatchToggle();

  const summary = useQuery({
    queryKey: ['pe-v2-summary'],
    queryFn: () => getProgramElementSummary(api, {}),
    staleTime: 60_000,
  });

  const listParams = {
    q: q.trim() || undefined,
    service: filters.comp !== 'ANY' ? SERVICE_TO_API[filters.comp] : undefined,
    line_type: filters.type !== 'ANY' ? TYPE_TO_API[filters.type] : undefined,
    watched: filters.mon === 'Monitored only' ? ('true' as const) : undefined,
    page,
    limit: PAGE_SIZE,
  };
  const list = useQuery({
    queryKey: ['pe-v2-explore', listParams],
    queryFn: () => getProgramElementsList(api, listParams),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const items: ProgramElementListItem[] = list.data?.data ?? [];
    let mapped = items.map(toLineRow);
    if (filters.move === 'Material change') mapped = mapped.filter((r) => rowMovement(r) === 'material');
    if (filters.move === 'No material change') mapped = mapped.filter((r) => rowMovement(r) === 'none');
    return mapped;
  }, [list.data, filters.move]);

  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeSecondary = [filters.comp, filters.type, filters.mon].filter((v) => v !== 'ANY').length;
  const anyFilter = q.trim() !== '' || activeSecondary > 0 || filters.move !== 'ANY';

  const resetFilters = () => {
    setQ('');
    setFilters({ comp: 'ANY', type: 'ANY', move: 'ANY', mon: 'ANY' });
    setPage(1);
  };

  const toggleAll = () => {
    setSelected((sel) => (sel.length === rows.length && rows.length > 0 ? [] : rows.map((r) => r.code)));
  };
  const toggleRow = (code: string) => {
    setSelected((sel) => (sel.includes(code) ? sel.filter((c) => c !== code) : [...sel, code]));
  };

  const exportRows = (codes: string[] | null) => {
    const source = codes ? rows.filter((r) => codes.includes(r.code)) : rows;
    const csv = [
      ['Program Element', 'Title', 'Service', 'Type', 'Request ($M)', 'Current ($M)', 'Stage', 'Delta ($M)', 'Delta (%)'],
      ...source.map((r) => [
        r.code,
        r.title,
        r.service,
        r.lineType,
        r.request,
        r.current,
        r.currentStage,
        r.delta,
        r.pct == null ? null : Number(r.pct.toFixed(2)),
      ]),
    ]
      .map((r) => r.map((c) => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = codes ? 'program-elements-selection.csv' : 'program-elements-explore.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const pad = density === 'compact' ? '7px 24px 7px 0' : '11px 24px 12px 0';
  const watchedCount = summary.data?.watched;

  return (
    <div data-screen-label="Explore">
      {/* Header — quiet meta right of title (refinement §01 Explore header) */}
      <div
        style={{
          background: '#fff',
          padding: '20px 24px 16px',
          display: 'flex',
          alignItems: 'flex-end',
          gap: 28,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.016em', lineHeight: 1.2 }}>
            Program Elements
          </div>
          <div
            style={{
              fontSize: 13.5,
              lineHeight: 1.5,
              color: 'var(--pev2-secondary)',
              marginTop: 4,
              maxWidth: 610,
            }}
          >
            Follow defense funding from request through Congress and enacted outcomes.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 15, flex: 'none', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="pe-v2-quiet-link ink"
            onClick={() => navigate('/program-elements?tab=portfolio')}
          >
            Monitoring · {watchedCount ?? '—'}
          </button>
          <span style={{ width: 1, height: 15, background: 'var(--pev2-border)' }} />
          <button type="button" className="pe-v2-quiet-link" onClick={() => exportRows(null)}>
            Export
          </button>
        </div>
      </div>

      {/* Toolbar — search + primary filters + MORE FILTERS + density (refinement §01) */}
      <div
        style={{
          background: '#fff',
          borderBottom: '1px solid var(--pev2-border-strong)',
          padding: '0 24px 13px',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'stretch',
              border: '1px solid var(--pev2-control)',
              background: '#fff',
              flex: '1 1 300px',
              minWidth: 300,
              maxWidth: 470,
            }}
          >
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 9px',
                color: 'var(--pev2-quiet)',
                flex: 'none',
                fontSize: 13,
              }}
              aria-hidden
            >
              ⌕
            </span>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search code or title"
              aria-label="Search code or title"
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                padding: '7px 6px 7px 0',
                fontSize: 13.5,
                color: '#121722',
                background: 'transparent',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </span>
          <FilterControl
            label="Movement"
            value={filters.move}
            options={MOVE_OPTIONS}
            onChange={(v) => {
              setFilters((f) => ({ ...f, move: v }));
              setPage(1);
            }}
          />
          <button
            type="button"
            className={`pe-v2-filter-btn${activeSecondary || moreOpen ? ' active' : ''}`}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
          >
            {moreOpen ? 'FEWER FILTERS' : 'MORE FILTERS'}
            {activeSecondary ? ` · ${activeSecondary}` : ''}
          </button>
          <div style={{ flex: 1, minWidth: 6 }} />
          <Segmented
            ariaLabel="Row density"
            options={[
              { value: 'standard', label: 'STANDARD' },
              { value: 'compact', label: 'COMPACT' },
            ]}
            value={density}
            onChange={setDensity}
          />
          {anyFilter ? (
            <button type="button" className="pe-v2-quiet-link" style={{ color: 'var(--pev2-rust-text)' }} onClick={resetFilters}>
              Reset filters
            </button>
          ) : null}
        </div>
        {moreOpen ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              borderTop: '1px solid var(--pev2-hairline-faint)',
              paddingTop: 9,
            }}
          >
            <FilterControl
              label="Component"
              value={filters.comp}
              options={SERVICE_OPTIONS}
              onChange={(v) => {
                setFilters((f) => ({ ...f, comp: v }));
                setPage(1);
              }}
            />
            <FilterControl
              label="Line type"
              value={filters.type}
              options={TYPE_OPTIONS}
              onChange={(v) => {
                setFilters((f) => ({ ...f, type: v }));
                setPage(1);
              }}
            />
            <FilterControl
              label="Monitored"
              value={filters.mon}
              options={MON_OPTIONS}
              onChange={(v) => {
                setFilters((f) => ({ ...f, mon: v }));
                setPage(1);
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Grid */}
      <div style={{ background: '#fff' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 1400 }}>
            {/* Group header + column header (sticky container) */}
            <div className="pe-v2-grid-head">
              <div className="pe-v2-grid" style={{ padding: '8px 24px 5px 0' }}>
                <div
                  className="pe-v2-eyebrow-quiet"
                  style={{ gridColumn: 'span 2', paddingLeft: 24, position: 'sticky', left: 0, background: 'var(--pev2-raised)' }}
                >
                  Identity
                </div>
                <div className="pe-v2-eyebrow-quiet" style={{ gridColumn: 'span 2' }}>
                  Classification
                </div>
                <div className="pe-v2-eyebrow-quiet" style={{ gridColumn: 'span 3' }}>
                  FY2027 position
                </div>
                <div className="pe-v2-eyebrow-quiet" style={{ gridColumn: 'span 2' }}>
                  Movement vs request
                </div>
                <div className="pe-v2-eyebrow-quiet">Evidence</div>
                <div className="pe-v2-eyebrow-quiet" style={{ gridColumn: 'span 3' }}>
                  Client impact &amp; action
                </div>
              </div>
              <div
                className="pe-v2-grid"
                style={{
                  padding: '0 24px 8px',
                  fontFamily: 'var(--pev2-mono)',
                  fontSize: 11,
                  letterSpacing: '0.07em',
                  color: 'var(--pev2-secondary)',
                }}
              >
                <button
                  type="button"
                  aria-label="Select all rows"
                  onClick={toggleAll}
                  style={{
                    cursor: 'pointer',
                    paddingLeft: 24,
                    position: 'sticky',
                    left: 0,
                    background: 'var(--pev2-raised)',
                    fontSize: 12,
                    color: 'var(--pev2-ink)',
                    textAlign: 'left',
                  }}
                >
                  {selected.length === rows.length && rows.length > 0 ? '■' : '□'}
                </button>
                <div
                  style={{
                    color: 'var(--pev2-ink)',
                    fontWeight: 600,
                    position: 'sticky',
                    left: 54,
                    background: 'var(--pev2-raised)',
                  }}
                >
                  Program / budget line
                </div>
                <div>Component</div>
                <div>Type</div>
                <div style={{ textAlign: 'right' }}>Request</div>
                <div style={{ textAlign: 'right' }}>Current</div>
                <div>Stage</div>
                <div>Δ request</div>
                <div>FY trend</div>
                <div>State</div>
                <div style={{ textAlign: 'right' }}>Clients</div>
                <div>Recommended</div>
                <div />
              </div>
            </div>

            {list.isLoading ? (
              <div style={{ padding: 24 }}>
                <Skeleton active paragraph={{ rows: 8 }} />
              </div>
            ) : rows.length === 0 ? (
              <div
                style={{
                  padding: '52px 24px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <div className="pe-v2-eyebrow">No rows — the query is valid and returned nothing</div>
                <div style={{ fontSize: 14, color: 'var(--pev2-body)', textAlign: 'center', maxWidth: 420 }}>
                  No budget line in the active snapshot matches every filter. The narrowest filter is the one to
                  remove first.
                </div>
                <button type="button" className="pe-v2-btn pe-v2-btn-sm" style={{ marginTop: 2 }} onClick={resetFilters}>
                  Reset filters
                </button>
              </div>
            ) : (
              rows.map((r) => {
                const sel = selected.includes(r.code);
                const exp = expanded === r.code;
                const rail = railGeometry(r.pct);
                const spark = sparkGeometry(r.spark);
                const hasClients = false; // per-line client rows load on expand
                return (
                  <div key={r.code}>
                    <div
                      className={`pe-v2-grid pe-v2-row${sel ? ' sel' : ''}${exp ? ' exp' : ''}`}
                      style={{ padding: pad }}
                    >
                      <button
                        type="button"
                        className="pe-v2-cell-check"
                        aria-label={`Select ${r.code}`}
                        aria-pressed={sel}
                        onClick={() => toggleRow(r.code)}
                        style={{ paddingTop: 3 }}
                      >
                        {sel ? '■' : '□'}
                      </button>
                      <button
                        type="button"
                        className="pe-v2-cell-id"
                        onClick={() => navigate(`/program-elements/${encodeURIComponent(r.code)}`)}
                      >
                        <div
                          className="pe-v2-mono"
                          style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-quiet)', textAlign: 'left' }}
                        >
                          {r.code}
                        </div>
                        <div
                          style={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: 'var(--pev2-ink)',
                            marginTop: 2,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            textAlign: 'left',
                          }}
                        >
                          {r.title}
                        </div>
                      </button>
                      <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-secondary)', paddingTop: 4 }}>
                        {r.service ? serviceLabel(r.service).toUpperCase() : '—'}
                      </div>
                      <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-secondary)', paddingTop: 4 }}>
                        {(r.lineType ?? '—').toString().toUpperCase().replace('RDTE_PE', 'RDT&E').replace('PROCUREMENT_BLIN', 'PROC').replace('OM_BLI', 'O&M')}
                      </div>
                      <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--pev2-tertiary)', paddingTop: 4 }}>
                        {money(r.request)}
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate(`/program-elements/${encodeURIComponent(r.code)}?tab=funding`)}
                        style={{
                          textAlign: 'right',
                          fontSize: 14,
                          fontWeight: 700,
                          paddingTop: 3,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--pev2-border)',
                          textUnderlineOffset: 3,
                          color: r.current == null ? 'var(--pev2-warning)' : 'var(--pev2-ink)',
                          display: 'block',
                          width: '100%',
                        }}
                      >
                        {money(r.current)}
                      </button>
                      <div className="pe-v2-mono" style={{ fontSize: 11, letterSpacing: '0.05em', color: 'var(--pev2-ink)', paddingTop: 4 }}>
                        {stageLabelShort(r.currentStage)}
                      </div>
                      <div style={{ paddingTop: 2 }}>
                        <div className="pe-v2-rail">
                          <div className="pe-v2-rail-base" />
                          {rail.kind !== 'none' ? <div style={rail.style as React.CSSProperties} /> : null}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
                          <div
                            className="pe-v2-mono"
                            style={{
                              fontSize: 11.5,
                              fontWeight: 600,
                              whiteSpace: 'nowrap',
                              color:
                                r.delta != null && r.delta > 0
                                  ? 'var(--pev2-success)'
                                  : r.delta != null && r.delta < 0
                                    ? 'var(--pev2-ink)'
                                    : r.pct == null
                                      ? 'var(--pev2-warning)'
                                      : 'var(--pev2-quiet)',
                            }}
                          >
                            {r.pct == null ? 'NO PAIR' : r.pct === 0 ? 'NO CHANGE' : spct(r.pct)}
                          </div>
                          <div className="pe-v2-mono" style={{ fontSize: 10.5, color: 'var(--pev2-quiet)', whiteSpace: 'nowrap' }}>
                            {r.delta == null ? '' : r.delta === 0 ? 'VS REQUEST' : sgn(r.delta)}
                          </div>
                        </div>
                      </div>
                      <div style={{ paddingTop: 5 }}>
                        {spark ? (
                          <svg viewBox="0 0 72 18" width={72} height={18} style={{ display: 'block' }} aria-hidden>
                            <polyline points={spark.points} fill="none" stroke="#B6BFCC" strokeWidth={1} />
                            <rect x={spark.endX} y={spark.endY} width={3} height={3} fill="#131A24" />
                          </svg>
                        ) : (
                          <span className="pe-v2-mono" style={{ fontSize: 10.5, color: 'var(--pev2-quiet)' }}>
                            —
                          </span>
                        )}
                        <div className="pe-v2-spark-cap">{r.spark.length >= 2 ? `${r.spark.length} FY` : 'ONE YEAR'}</div>
                      </div>
                      <div style={{ paddingTop: 3 }}>
                        <EvMark
                          state={r.signalType ? 'PARTIAL' : 'VERIFIED'}
                          label={r.signalType ? '■ SIGNAL' : '■ VERIFIED'}
                          quiet={!r.signalType}
                        />
                        <div className="pe-v2-spark-cap">{r.billCount != null ? `${r.billCount} BILLS` : ''}</div>
                      </div>
                      <div style={{ textAlign: 'right', paddingTop: 3 }}>
                        <ExpandClients code={r.code} />
                      </div>
                      <button
                        type="button"
                        onClick={() => navigate(`/program-elements/${encodeURIComponent(r.code)}?tab=legislative`)}
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: 'var(--pev2-ink-2)',
                          paddingTop: 4,
                          cursor: 'pointer',
                          lineHeight: 1.3,
                          textAlign: 'left',
                        }}
                      >
                        {recommendedAction(r)}
                      </button>
                      <button
                        type="button"
                        aria-label={exp ? `Collapse ${r.code}` : `Expand ${r.code}`}
                        aria-expanded={exp}
                        onClick={() => setExpanded(exp ? null : r.code)}
                        className="pe-v2-mono"
                        style={{
                          textAlign: 'right',
                          fontSize: 11,
                          color: 'var(--pev2-quiet)',
                          cursor: 'pointer',
                          paddingTop: 4,
                        }}
                      >
                        {exp ? '⌃' : '⌄'}
                      </button>
                    </div>
                    {exp ? <ExpandRegion row={r} onClose={() => setExpanded(null)} /> : null}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pe-v2-table-foot">
          <span>
            {rows.length} OF {total.toLocaleString()} BUDGET LINES · FY{summary.data?.latestRequestFy ?? '—'}
          </span>
          <span style={{ flex: 1, minWidth: 8 }} />
          <span style={{ color: 'var(--pev2-quiet)' }}>PAGE {page} OF {pageCount}</span>
          <span style={{ width: 1, height: 14, background: 'var(--pev2-border)' }} />
          <button
            type="button"
            className="pe-v2-quiet-link"
            disabled={page <= 1}
            style={page <= 1 ? { color: 'var(--pev2-quiet)', cursor: 'not-allowed' } : { color: 'var(--pev2-ink)' }}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Prev
          </button>
          <button
            type="button"
            className="pe-v2-quiet-link"
            disabled={page >= pageCount}
            style={page >= pageCount ? { color: 'var(--pev2-quiet)', cursor: 'not-allowed' } : { color: 'var(--pev2-ink)' }}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            Next →
          </button>
        </div>
      </div>

      {/* Selection bar */}
      {selected.length > 0 ? (
        <div className="pe-v2-selbar" role="region" aria-label="Selection">
          <span className="pe-v2-eyebrow" style={{ color: '#AAB5C4' }}>
            Selected
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
            {selected.length} budget line{selected.length === 1 ? '' : 's'}
          </span>
          <span style={{ width: 1, height: 18, background: '#2F3C50' }} />
          <span
            style={{
              fontSize: 12.5,
              color: '#AAB5C4',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {selected.slice(0, 4).join(' · ')}
            {selected.length > 4 ? ` · +${selected.length - 4}` : ''}
          </span>
          <span style={{ flex: 1, minWidth: 8 }} />
          <button
            type="button"
            className="pe-v2-selbar-btn"
            disabled={selected.length < 2}
            onClick={() =>
              navigate(`/program-elements?view=compare&codes=${selected.slice(0, 4).join(',')}`)
            }
          >
            Compare
          </button>
          <button
            type="button"
            className="pe-v2-selbar-btn"
            disabled={watch.isPending}
            onClick={() => {
              for (const code of selected) watch.mutate({ peCode: code, watching: true });
            }}
          >
            Monitor
          </button>
          <button type="button" className="pe-v2-selbar-btn" onClick={() => exportRows(selected)}>
            Export
          </button>
          <button
            type="button"
            className="pe-v2-selbar-btn primary"
            onClick={() => { if (selected[0]) navigate(`/actions?peCode=${encodeURIComponent(selected[0])}`); }}
          >
            Create action
          </button>
          <button
            type="button"
            className="pe-v2-quiet-link"
            style={{ color: '#AAB5C4' }}
            onClick={() => setSelected([])}
          >
            Clear ⎋
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Clients cell — per-line client count from the relevance API (lazy per visible row). */
function ExpandClients({ code }: { code: string }) {
  const api = useApi();
  const q = useQuery({
    queryKey: ['pe-v2-row-clients', code],
    queryFn: async () => {
      const { getRelevantClientsForPe } = await import('../../clients/relevance-api.js');
      return getRelevantClientsForPe(api, code);
    },
    staleTime: 5 * 60_000,
  });
  const n = q.data?.length ?? 0;
  return (
    <>
      <div
        style={{
          fontSize: 13.5,
          fontWeight: n ? 700 : 400,
          color: n ? 'var(--pev2-ink)' : 'var(--pev2-quiet)',
        }}
      >
        {q.isLoading ? '…' : n || '—'}
      </div>
      <div className="pe-v2-spark-cap">{n ? 'AFFECTED' : 'NONE'}</div>
    </>
  );
}

/** Expanded row region — WHAT CHANGED / STRONGEST EVIDENCE / CLIENT EXPOSURE / RECOMMENDED ACTION. */
function ExpandRegion({ row, onClose }: { row: V2LineRow; onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ['pe-v2-row-detail', row.code],
    queryFn: async () => {
      const { getProgramElementDetail, getProgramElementDeltas } = await import('../api.js');
      const [d, deltas] = await Promise.all([
        getProgramElementDetail(api, row.code),
        getProgramElementDeltas(api, row.code, { limit: 3 }).catch(() => null),
      ]);
      return { d, deltas };
    },
    staleTime: 5 * 60_000,
  });
  const clients = useQuery({
    queryKey: ['pe-v2-row-clients', row.code],
    queryFn: async () => {
      const { getRelevantClientsForPe } = await import('../../clients/relevance-api.js');
      return getRelevantClientsForPe(api, row.code);
    },
    staleTime: 5 * 60_000,
  });

  const latestDelta = detail.data?.deltas?.data?.[0];
  const clientRows = clients.data ?? [];

  return (
    <div className="pe-v2-expand">
      <div style={{ flex: '1 1 0', minWidth: 300 }}>
        <div className="pe-v2-eyebrow-quiet">What changed</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.55, color: '#121722', marginTop: 7 }}>
          {detail.isLoading ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : latestDelta?.explanation ? (
            latestDelta.explanation
          ) : (
            'No material change in the active snapshot.'
          )}
        </div>
      </div>
      <div style={{ flex: '1 1 0', minWidth: 230 }}>
        <div className="pe-v2-eyebrow-quiet">Strongest evidence</div>
        <div className="pe-v2-mono" style={{ fontSize: 12.5, color: 'var(--pev2-ink)', marginTop: 7 }}>
          {detail.data?.d.sourceCount ?? row.billCount ?? 0} SOURCES · {detail.data?.d.billCount ?? row.billCount ?? 0} BILLS
        </div>
        <button
          type="button"
          onClick={() => navigate(`/program-elements/${encodeURIComponent(row.code)}?tab=sources`)}
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--pev2-ink-2)',
            marginTop: 7,
            cursor: 'pointer',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          Open source inspector →
        </button>
      </div>
      <div style={{ flex: 'none', minWidth: 200 }}>
        <div className="pe-v2-eyebrow-quiet">Client exposure</div>
        <div style={{ fontSize: 13, color: '#121722', marginTop: 7, lineHeight: 1.5 }}>
          {clients.isLoading
            ? '…'
            : clientRows.length
              ? clientRows.map((c) => c.clientName).join(', ')
              : 'No client in this tenant is linked to this line.'}
        </div>
      </div>
      <div style={{ flex: 'none', minWidth: 190 }}>
        <div className="pe-v2-eyebrow-quiet">Recommended action</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#121722', marginTop: 7, lineHeight: 1.4 }}>
          {recommendedAction(row)}
        </div>
        <button
          type="button"
          className="pe-v2-btn pe-v2-btn-sm"
          style={{ marginTop: 9 }}
          onClick={() => navigate(`/actions?peCode=${encodeURIComponent(row.code)}`)}
        >
          Create action
        </button>
      </div>
      <button type="button" aria-label="Close" onClick={onClose} style={{ display: 'none' }} />
    </div>
  );
}
