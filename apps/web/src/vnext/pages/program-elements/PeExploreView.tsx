/**
 * Program Elements vNext — Explore surface (native port of
 * src/pages/program-element/v2/PeV2Explore.tsx).
 *
 * Dense analyst catalog: column-group header, per-row selection, BudgetDeltaRail,
 * 72×18 sparkline, quiet-vs-loud evidence, expandable row, selection command bar.
 * Data: existing program-elements list + summary APIs — identical endpoints,
 * query keys, params, filter/sort semantics and copy as the canonical view.
 *
 * Phase 4 polish: the grid is a real `CapiroTable` (the same table family as
 * Settings → Intelligence Mappings and the Mark-up monitor) instead of a
 * hand-rolled `.pe-v2-grid` of divs, the filters are `CapiroSelect`s, the
 * actions are `CapiroButton`s and the evidence marks are `CapiroBadge`s. The
 * information architecture — which columns exist, in which order, under which
 * group heading — is unchanged.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import {
  getProgramElementsList,
  getProgramElementSummary,
} from '../../../pages/program-element/api.js';
import type { ProgramElementListItem } from '../../../pages/program-element/types.js';
import { serviceLabel } from '../../../pages/program-element/pe-shared-model.js';
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
} from '../../../pages/program-element/v2/pe-v2-model.js';
import { CapiroButton, CapiroIconButton } from '../../components/actions/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { CapiroDownloadIcon } from '../../components/icons/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { useWatchToggle } from './pe-watch-toggle.js';
import { EvMark, FilterControl, PeSkeletonBlock, Segmented } from './pe-primitives.js';
import { familyById, serviceToApiParam, useDefenseBudgetContext } from './defense-budget-context.js';
import { DefenseBudgetFamilyCoverageNote } from './defense-budget-coverage.js';

const PAGE_SIZE = 50;

/** Column count of the catalog table — the expanded row spans all of it. */
const COLUMN_COUNT = 13;

type Density = 'standard' | 'compact';

interface ExploreFilters {
  move: string; // movement — the one dimension the shared Defense Budget context bar doesn't own
}

const MOVE_OPTIONS = ['ANY', 'Material change', 'No material change'];

function rowMovement(row: V2LineRow): 'material' | 'none' {
  return row.delta != null && row.delta !== 0 ? 'material' : 'none';
}

/**
 * The delta rail keeps the canonical geometry (width is the shared model's
 * `railGeometry` math, unchanged) but paints on the token layer: the model
 * returns DS-v2 hex literals, which would be the only raw colors left on this
 * surface.
 */
function railStyle(rail: ReturnType<typeof railGeometry>, pct: number | null): CSSProperties {
  const base = { ...(rail.style ?? {}) } as CSSProperties;
  if (rail.kind === 'nopos') {
    return { ...base, border: '1px dashed var(--capiro-color-warning-rail)' };
  }
  return {
    ...base,
    background:
      pct != null && pct < 0
        ? 'var(--capiro-color-bg-dark)'
        : 'var(--capiro-color-success)',
  };
}

export function PeExploreView() {
  const api = useApi();
  const navigate = useNavigate();
  const ctx = useDefenseBudgetContext();
  const family = familyById(ctx.family);
  const [filters, setFilters] = useState<ExploreFilters>({ move: 'ANY' });
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

  // A family with no canonical line-level projection (MILPERS / WCF / Health
  // today) has nothing this query could honestly return — skip it and show
  // the coverage note instead of an empty catalog (task §9).
  const familyQueryable = family.id === 'All' || !!family.lineType;
  const listParams = {
    q: ctx.q.trim() || undefined,
    service: serviceToApiParam(ctx.service),
    line_type: family.lineType,
    watched: ctx.watchedOnly ? ('true' as const) : undefined,
    page,
    limit: PAGE_SIZE,
  };
  const list = useQuery({
    queryKey: ['pe-v2-explore', listParams],
    queryFn: () => getProgramElementsList(api, listParams),
    enabled: familyQueryable,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    if (!familyQueryable) return [];
    const items: ProgramElementListItem[] = list.data?.data ?? [];
    let mapped = items.map(toLineRow);
    if (filters.move === 'Material change') mapped = mapped.filter((r) => rowMovement(r) === 'material');
    if (filters.move === 'No material change') mapped = mapped.filter((r) => rowMovement(r) === 'none');
    return mapped;
  }, [familyQueryable, list.data, filters.move]);

  // Context-bar scope (q / family / service / watched) resets pagination, same
  // rule the local `move`/`mon` filters already followed.
  useEffect(() => {
    setPage(1);
  }, [ctx.q, ctx.family, ctx.service, ctx.watchedOnly]);

  const total = familyQueryable ? (list.data?.total ?? 0) : 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const anyFilter = filters.move !== 'ANY';

  const resetFilters = () => {
    setFilters({ move: 'ANY' });
    setPage(1);
  };

  const allSelected = selected.length === rows.length && rows.length > 0;
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

  const watchedCount = summary.data?.watched;

  return (
    <div data-screen-label="Explore" className="pe-ws-view">
      {/* Header — quiet meta right of title */}
      <div className="pe-v2-page-head">
        <div className="pe-ws-head__text">
          <div className="pe-v2-page-title">Defense Budget Explore</div>
          <div className="pe-v2-page-sub">
            Follow defense funding from request through Congress and enacted outcomes.
          </div>
        </div>
        <div className="pe-ws-head__actions">
          <CapiroButton
            size="compact"
            variant="quiet"
            onClick={() => navigate('/program-elements?tab=portfolio')}
          >
            Monitoring · {watchedCount ?? '—'}
          </CapiroButton>
          <CapiroButton
            size="compact"
            leadingIcon={<CapiroDownloadIcon />}
            onClick={() => exportRows(null)}
          >
            Export
          </CapiroButton>
        </div>
      </div>

      <div className="pe-ws-body">
        {family.id !== 'All' ? <DefenseBudgetFamilyCoverageNote familyId={family.id} fy={ctx.fy} /> : null}

        {/* Toolbar — movement chip + density (search/family/service/watched live in the shared context bar above) */}
        <section className="pe-v2-card" aria-label="Filters">
          <div className="pe-ws-toolbar__row">
            <FilterControl
              label="Movement"
              value={filters.move}
              options={MOVE_OPTIONS}
              onChange={(v) => {
                setFilters({ move: v });
                setPage(1);
              }}
            />
            <span className="pe-ws-spacer" />
            <span className="pe-ws-toolbar__tail">
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
                <CapiroButton size="compact" variant="quiet" className="pe-ws-btn-reset" onClick={resetFilters}>
                  Reset filters
                </CapiroButton>
              ) : null}
            </span>
          </div>
        </section>

        {/* Catalog */}
        <section className="pe-v2-card pe-ws-tablecard">
          {!familyQueryable ? null : list.isLoading ? (
            <div className="pe-ws-pad">
              <PeSkeletonBlock rows={8} />
            </div>
          ) : rows.length === 0 ? (
            <div className="pe-ws-pad pe-ws-pad--tall">
              <CapiroEmptyState
                title="No rows — the query is valid and returned nothing"
                description="No budget line in the active snapshot matches every filter. The narrowest filter is the one to remove first."
                action={
                  <CapiroButton size="compact" onClick={resetFilters}>
                    Reset filters
                  </CapiroButton>
                }
              />
            </div>
          ) : (
            <CapiroTableWrap className="pe-ws-tablescroll">
              <CapiroTable
                className={`pe-ws-table pe-ws-table--catalog${density === 'compact' ? ' pe-ws-table--compact' : ''}`}
              >
                <CapiroTableHead>
                  <tr className="pe-ws-table__grouprow">
                    <CapiroTableHeaderCell colSpan={2}>Identity</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell colSpan={2}>Classification</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell colSpan={3}>FY2027 position</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell colSpan={2}>Movement vs request</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell colSpan={3}>Client impact &amp; action</CapiroTableHeaderCell>
                  </tr>
                  <tr>
                    <CapiroTableHeaderCell className="pe-ws-col-check">
                      <input
                        type="checkbox"
                        className="pe-ws-check"
                        aria-label="Select all rows"
                        checked={allSelected}
                        onChange={toggleAll}
                      />
                    </CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-col-id">Program / budget line</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Component</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Type</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-num">Request</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-num">Current</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Stage</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Δ request</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>FY trend</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>State</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell className="pe-ws-num">Clients</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>Recommended</CapiroTableHeaderCell>
                    <CapiroTableHeaderCell>
                      <span className="pe-ws-sr">Expand row</span>
                    </CapiroTableHeaderCell>
                  </tr>
                </CapiroTableHead>
                <CapiroTableBody>
                  {rows.flatMap((r) => {
                    const sel = selected.includes(r.code);
                    const exp = expanded === r.code;
                    const rail = railGeometry(r.pct);
                    const spark = sparkGeometry(r.spark);
                    const line = (
                      <tr
                        key={r.code}
                        className={`pe-ws-row${sel ? ' is-selected' : ''}${exp ? ' is-expanded' : ''}`}
                      >
                        <CapiroTableCell className="pe-ws-col-check">
                          <input
                            type="checkbox"
                            className="pe-ws-check"
                            aria-label={`Select ${r.code}`}
                            checked={sel}
                            onChange={() => toggleRow(r.code)}
                          />
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-col-id">
                          <button
                            type="button"
                            className="pe-ws-idbtn"
                            onClick={() => navigate(`/program-elements/${encodeURIComponent(r.code)}`)}
                          >
                            <span className="pe-ws-code">{r.code}</span>
                            <span className="pe-ws-title">{r.title}</span>
                          </button>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta">
                          {r.service ? serviceLabel(r.service).toUpperCase() : '—'}
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta">
                          {(r.lineType ?? '—').toString().toUpperCase().replace('RDTE_PE', 'RDT&E').replace('PROCUREMENT_BLIN', 'PROC').replace('OM_BLI', 'O&M')}
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-num pe-ws-quiet">{money(r.request)}</CapiroTableCell>
                        <CapiroTableCell className="pe-ws-num">
                          <button
                            type="button"
                            className={`pe-ws-link pe-ws-current${r.current == null ? ' is-missing' : ''}`}
                            onClick={() =>
                              navigate(`/program-elements/${encodeURIComponent(r.code)}?tab=funding`)
                            }
                          >
                            {money(r.current)}
                          </button>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-meta pe-ws-meta--ink">
                          {stageLabelShort(r.currentStage)}
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <div className="pe-ws-rail">
                            <div className="pe-ws-rail__base" />
                            {rail.kind !== 'none' ? <div style={railStyle(rail, r.pct)} /> : null}
                          </div>
                          <div className="pe-ws-deltaline">
                            <span
                              className={`pe-ws-delta${
                                r.delta != null && r.delta > 0
                                  ? ' is-up'
                                  : r.delta != null && r.delta < 0
                                    ? ' is-down'
                                    : r.pct == null
                                      ? ' is-missing'
                                      : ' is-flat'
                              }`}
                            >
                              {r.pct == null ? 'NO PAIR' : r.pct === 0 ? 'NO CHANGE' : spct(r.pct)}
                            </span>
                            <span className="pe-ws-cap">
                              {r.delta == null ? '' : r.delta === 0 ? 'VS REQUEST' : sgn(r.delta)}
                            </span>
                          </div>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          {spark ? (
                            <svg viewBox="0 0 72 18" width={72} height={18} className="pe-ws-spark" aria-hidden>
                              <polyline points={spark.points} fill="none" stroke="var(--capiro-color-border-strong)" strokeWidth={1} />
                              <rect x={spark.endX} y={spark.endY} width={3} height={3} fill="var(--capiro-color-text-primary)" />
                            </svg>
                          ) : (
                            <span className="pe-ws-cap">—</span>
                          )}
                          <div className="pe-ws-cap">{r.spark.length >= 2 ? `${r.spark.length} FY` : 'ONE YEAR'}</div>
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <EvMark
                            state={r.signalType ? 'PARTIAL' : 'VERIFIED'}
                            label={r.signalType ? 'SIGNAL' : 'VERIFIED'}
                            quiet={!r.signalType}
                          />
                          <div className="pe-ws-cap">{r.billCount != null ? `${r.billCount} BILLS` : ''}</div>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-num">
                          <ExpandClients code={r.code} />
                        </CapiroTableCell>
                        <CapiroTableCell>
                          <button
                            type="button"
                            className="pe-ws-link pe-ws-reco"
                            onClick={() =>
                              navigate(`/program-elements/${encodeURIComponent(r.code)}?tab=legislative`)
                            }
                          >
                            {recommendedAction(r)}
                          </button>
                        </CapiroTableCell>
                        <CapiroTableCell className="pe-ws-col-toggle">
                          <CapiroIconButton
                            className="pe-ws-rowtoggle"
                            label={exp ? `Collapse ${r.code}` : `Expand ${r.code}`}
                            aria-expanded={exp}
                            icon={<span aria-hidden>{exp ? '⌃' : '⌄'}</span>}
                            onClick={() => setExpanded(exp ? null : r.code)}
                          />
                        </CapiroTableCell>
                      </tr>
                    );
                    return exp
                      ? [line, <ExpandRegion key={`${r.code}-exp`} row={r} onClose={() => setExpanded(null)} />]
                      : [line];
                  })}
                </CapiroTableBody>
              </CapiroTable>
            </CapiroTableWrap>
          )}

          {/* Footer — sibling of the scroll wrapper, so it never scrolls away */}
          <div className="pe-v2-table-foot">
            <span>
              {rows.length} OF {total.toLocaleString()} BUDGET LINES · FY{summary.data?.latestRequestFy ?? '—'}
            </span>
            <span className="pe-ws-spacer" />
            <span className="pe-ws-foot__page">PAGE {page} OF {pageCount}</span>
            <CapiroButton
              size="compact"
              variant="quiet"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </CapiroButton>
            <CapiroButton
              size="compact"
              variant="quiet"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next →
            </CapiroButton>
          </div>
        </section>
      </div>

      {/* Selection command bar */}
      {selected.length > 0 ? (
        <div className="pe-v2-selbar capiro-elevation-widget" role="region" aria-label="Selection">
          <span className="pe-ws-selbar__eyebrow">Selected</span>
          <span className="pe-ws-selbar__count">
            {selected.length} budget line{selected.length === 1 ? '' : 's'}
          </span>
          <span className="pe-ws-selbar__rule" aria-hidden />
          <span className="pe-ws-selbar__codes">
            {selected.slice(0, 4).join(' · ')}
            {selected.length > 4 ? ` · +${selected.length - 4}` : ''}
          </span>
          <span className="pe-ws-spacer" />
          <CapiroButton
            size="compact"
            disabled={selected.length < 2}
            onClick={() =>
              navigate(`/program-elements?view=compare&codes=${selected.slice(0, 4).join(',')}`)
            }
          >
            Compare
          </CapiroButton>
          <CapiroButton
            size="compact"
            disabled={watch.isPending}
            onClick={() => {
              for (const code of selected) watch.mutate({ peCode: code, watching: true });
            }}
          >
            Monitor
          </CapiroButton>
          <CapiroButton size="compact" onClick={() => exportRows(selected)}>
            Export
          </CapiroButton>
          <CapiroButton
            size="compact"
            variant="primary"
            onClick={() => { if (selected[0]) navigate(`/actions?peCode=${encodeURIComponent(selected[0])}`); }}
          >
            Create action
          </CapiroButton>
          <CapiroButton size="compact" variant="quiet" onClick={() => setSelected([])}>
            Clear ⎋
          </CapiroButton>
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
      const { getRelevantClientsForPe } = await import('../../../pages/clients/relevance-api.js');
      return getRelevantClientsForPe(api, code);
    },
    staleTime: 5 * 60_000,
  });
  const n = q.data?.length ?? 0;
  return (
    <>
      <div className={`pe-ws-clients${n ? ' is-affected' : ''}`}>{q.isLoading ? '…' : n || '—'}</div>
      <div className="pe-ws-cap">{n ? 'AFFECTED' : 'NONE'}</div>
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
      const { getProgramElementDetail, getProgramElementDeltas } = await import(
        '../../../pages/program-element/api.js'
      );
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
      const { getRelevantClientsForPe } = await import('../../../pages/clients/relevance-api.js');
      return getRelevantClientsForPe(api, row.code);
    },
    staleTime: 5 * 60_000,
  });

  const latestDelta = detail.data?.deltas?.data?.[0];
  const clientRows = clients.data ?? [];

  return (
    <tr className="pe-ws-expandrow">
      <CapiroTableCell colSpan={COLUMN_COUNT} className="pe-ws-expandcell">
        <div className="pe-ws-expand">
          <div className="pe-ws-expand__col pe-ws-expand__col--wide">
            <div className="pe-ws-eyebrow">What changed</div>
            <div className="pe-ws-expand__body">
              {detail.isLoading ? (
                <PeSkeletonBlock rows={2} />
              ) : latestDelta?.explanation ? (
                latestDelta.explanation
              ) : (
                'No material change in the active snapshot.'
              )}
            </div>
          </div>
          <div className="pe-ws-expand__col">
            <div className="pe-ws-eyebrow">Strongest evidence</div>
            <div className="pe-ws-expand__mono">
              {detail.data?.d.sourceCount ?? row.billCount ?? 0} SOURCES · {detail.data?.d.billCount ?? row.billCount ?? 0} BILLS
            </div>
            <button
              type="button"
              className="pe-ws-link"
              onClick={() => navigate(`/program-elements/${encodeURIComponent(row.code)}?tab=sources`)}
            >
              Open source inspector →
            </button>
          </div>
          <div className="pe-ws-expand__col">
            <div className="pe-ws-eyebrow">Client exposure</div>
            <div className="pe-ws-expand__body">
              {clients.isLoading
                ? '…'
                : clientRows.length
                  ? clientRows.map((c) => c.clientName).join(', ')
                  : 'No client in this tenant is linked to this line.'}
            </div>
          </div>
          <div className="pe-ws-expand__col">
            <div className="pe-ws-eyebrow">Recommended action</div>
            <div className="pe-ws-expand__strong">{recommendedAction(row)}</div>
            <CapiroButton
              size="compact"
              onClick={() => navigate(`/actions?peCode=${encodeURIComponent(row.code)}`)}
            >
              Create action
            </CapiroButton>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="pe-ws-sr-btn" />
        </div>
      </CapiroTableCell>
    </tr>
  );
}
