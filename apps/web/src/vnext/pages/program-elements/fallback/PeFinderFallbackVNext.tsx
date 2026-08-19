/**
 * PE finder — native vNext port of the canonical read surface served to
 * tenants OTHER than capiro-internal (old-UI purge Phase 3, PE-FALLBACK).
 *
 * Re-skin of `pages/program-element/ProgramElementFinderPage.tsx`: identical
 * endpoints, query keys, URL state, copy, empty/loading/error states — only
 * the presentation moved to vNext primitives + the token layer
 * (`pe-fallback.css`). The data layer is IMPORTED from the canonical modules
 * (`api.ts`, `pe-shared-model.ts`, `funding-model.ts`, `charts/*` — all
 * antd-free), so the two surfaces cannot drift.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useActionsList } from '../../../../pages/actions/actions-api.js';
import {
  getCapabilities,
  getMovement,
  getProgramElementDetail,
  getProgramElementSummary,
  getProgramElementsList,
} from '../../../../pages/program-element/api.js';
import type {
  MovementFeedItem,
  ProgramElementDetail,
  ProgramElementListItem,
  ProgramElementSummary,
} from '../../../../pages/program-element/types.js';
import {
  LINE_TYPES,
  serviceLabel,
} from '../../../../pages/program-element/pe-shared-model.js';
import { fmtMoneyM, serviceColor } from '../../../../pages/program-element/charts/index.js';
import { buildFundingSeries } from '../../../../pages/program-element/funding-model.js';
import { CapiroButton } from '../../../components/actions/index.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import {
  CapiroCheckIcon,
  CapiroDownloadIcon,
  CapiroSearchIcon,
} from '../../../components/icons/index.js';
import {
  PeFbChevronDownIcon,
  PeFbFlagIcon,
  PeFbInfoCircleIcon,
  PeFbSwapIcon,
  PeFbTrendDownIcon,
  PeFbTrendUpIcon,
} from './pe-fallback-icons.js';
import {
  ActionSignalChipVNext,
  PeFbEmpty,
  PeFbErrorState,
  PeFbSkeleton,
  SignalPillVNext,
  useWatchToggleVNext,
} from './pe-fallback-ui.js';
import { PeCapabilityFinderVNext } from './PeCapabilityFinderVNext.js';
import { PeAlertEmailControlVNext } from './PeAlertEmailControlVNext.js';
// The canonical finder's Actions tab mounts pages/actions/ActionBoardPage; the
// native vNext port of that exact board shipped with the admin-misc tranche —
// reused here rather than duplicated (same actions-api hooks, same copy).
import { VNextActionBoardPage } from '../../admin-misc/VNextActionBoardPage.js';
import './pe-fallback.css';

const PAGE_SIZE = 50;
const CLOSED_ACTION_STATUSES = new Set(['dismissed', 'archived']);
const LINE_TYPE_KEYS = ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI'] as const;
type PrimaryTab = 'explore' | 'movement' | 'actions';
type SearchMode = 'code' | 'capability';
type MovementMode = 'feed' | 'graph';

function readTab(value: string | null): PrimaryTab {
  return value === 'movement' || value === 'actions' ? value : 'explore';
}
function readCodes(value: string | null): string[] {
  return [...new Set((value ?? '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean))].slice(0, 4);
}
function rowDelta(row: ProgramElementListItem): number | null {
  if (
    row.latestCurrent != null &&
    row.latestRequest != null &&
    row.latestCurrentFy != null &&
    row.latestCurrentFy === row.latestRequestFy &&
    row.latestRequest !== 0
  ) {
    return ((row.latestCurrent - row.latestRequest) / Math.abs(row.latestRequest)) * 100;
  }
  return row.deltaPct ?? null;
}
function downloadCsv(name: string, rows: Array<Array<string | number | null | undefined>>) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function PeFinderFallbackVNext() {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<PrimaryTab>(() => readTab(searchParams.get('tab')));
  const [searchMode, setSearchMode] = useState<SearchMode>(() =>
    searchParams.get('mode') === 'capability' ? 'capability' : 'code',
  );
  const [movementMode, setMovementMode] = useState<MovementMode>(() =>
    searchParams.get('movement') === 'graph' ? 'graph' : 'feed',
  );
  const [term, setTerm] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [lineType, setLineType] = useState<string | null>(null);
  const [hasDataOnly, setHasDataOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [capabilitySlug, setCapabilitySlug] = useState<string | null>(null);
  const [capabilityQuery, setCapabilityQuery] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [selectedCodes, setSelectedCodes] = useState<string[]>(() => readCodes(searchParams.get('codes')));
  const q = term.trim();
  const compareCodes = readCodes(searchParams.get('codes'));
  const compareOpen = searchParams.get('view') === 'compare' && compareCodes.length >= 2;
  const watch = useWatchToggleVNext();
  const busyCode = watch.isPending ? watch.variables?.peCode ?? null : null;

  const summary = useQuery({
    queryKey: ['program-element-summary', hasDataOnly],
    queryFn: () => getProgramElementSummary(api, { has_data: hasDataOnly ? 'true' : undefined }),
    staleTime: 60_000,
  });
  const list = useQuery({
    queryKey: ['program-element-finder', 'approved-redesign', q, service, lineType, hasDataOnly, page],
    queryFn: () =>
      getProgramElementsList(api, {
        q: q || undefined,
        service: service || undefined,
        line_type: lineType || undefined,
        has_data: hasDataOnly ? 'true' : undefined,
        page,
        limit: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    enabled: !compareOpen && tab === 'explore' && searchMode === 'code',
  });
  const capabilities = useQuery({
    queryKey: ['budget-lines-capabilities'],
    queryFn: () => getCapabilities(api),
    staleTime: 300_000,
  });
  const actions = useActionsList({ page: 1, limit: 100 });
  const openActionCount = useMemo(
    () =>
      (actions.data?.data ?? []).filter((action) => !CLOSED_ACTION_STATUSES.has(action.status))
        .length,
    [actions.data],
  );
  const rows = list.data?.data ?? [];
  const total = list.data?.total ?? 0;
  const watchingCount = summary.data?.watched ?? 0;
  const serviceFacets = useMemo(
    () =>
      (summary.data?.byService ?? [])
        .filter((item): item is { service: string; count: number } => Boolean(item.service))
        .map((item) => ({
          code: item.service.toUpperCase(),
          label: serviceLabel(item.service),
          color: serviceColor(item.service),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [summary.data?.byService],
  );
  const commonCapabilities = (capabilities.data ?? []).slice(0, 5);

  const changeUrl = (change: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams);
    change(params);
    setSearchParams(params, { replace: true });
  };
  const selectTab = (next: PrimaryTab) => {
    setTab(next);
    setSelectedCodes([]);
    changeUrl((params) => {
      if (next === 'explore') params.delete('tab');
      else params.set('tab', next);
      params.delete('view');
      params.delete('codes');
    });
  };
  const selectMode = (next: SearchMode) => {
    setSearchMode(next);
    setTerm('');
    setCapabilitySlug(null);
    setCapabilityQuery(null);
    setSelectedCodes([]);
    changeUrl((params) => {
      if (next === 'code') params.delete('mode');
      else params.set('mode', next);
      params.delete('view');
      params.delete('codes');
    });
  };
  const selectMovement = (next: MovementMode) => {
    setMovementMode(next);
    changeUrl((params) => {
      if (next === 'feed') params.delete('movement');
      else params.set('movement', next);
    });
  };
  const openCapability = (slug: string) => {
    setCapabilitySlug(slug);
    setCapabilityQuery(null);
    const capability = (capabilities.data ?? []).find((item) => item.slug === slug);
    setTerm(capability?.name.split(' / ')[0] ?? '');
  };
  const submitCapability = () => {
    const needle = q.toLowerCase();
    if (!needle) return;
    const hit = (capabilities.data ?? []).find(
      (capability) =>
        capability.name.toLowerCase().includes(needle) ||
        capability.aliases.some((alias) => alias.toLowerCase().includes(needle)),
    );
    if (hit) openCapability(hit.slug);
    else {
      setCapabilitySlug(null);
      setCapabilityQuery(q);
    }
  };
  const toggleSelection = (code: string) => {
    setSelectedCodes((current) => {
      if (current.includes(code)) return current.filter((item) => item !== code);
      return current.length < 4 ? [...current, code] : current;
    });
  };
  const openCompare = () => {
    if (selectedCodes.length < 2) return;
    changeUrl((params) => {
      params.set('view', 'compare');
      params.set('codes', selectedCodes.join(','));
    });
  };
  const closeCompare = () =>
    changeUrl((params) => {
      params.delete('view');
      params.delete('codes');
    });
  const exportRows = (onlySelected: boolean) => {
    const selected = onlySelected ? rows.filter((row) => selectedCodes.includes(row.peCode)) : rows;
    downloadCsv('program-elements.csv', [
      ['Code', 'Title', 'Service', 'Current FY', 'Current', 'Request', 'Delta vs request', 'Signal'],
      ...selected.map((row) => [
        row.peCode,
        row.title,
        serviceLabel(row.service),
        row.latestCurrentFy,
        row.latestCurrent,
        row.latestRequest,
        rowDelta(row),
        row.actionSignalType ?? row.signalType,
      ]),
    ]);
    setExportOpen(false);
  };

  if (compareOpen) {
    return <CompareView codes={compareCodes} onBack={closeCompare} onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)} />;
  }

  return (
    <section className="pe-fb-root pe-fb-finder">
      <header className="pe-fb-page-head">
        <div className="pe-fb-page-copy">
          <h1>Program elements</h1>
          <p>
            Every RDT&amp;E program element, procurement BLIN and O&amp;M line, with the
            money that moved and what to do about it.
          </p>
        </div>
        <div className="pe-fb-page-actions">
          <div className="pe-fb-menu-wrap">
            <button className="pe-fb-btn" type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
              Monitoring tools <PeFbChevronDownIcon />
            </button>
            {toolsOpen ? (
              <div className="pe-fb-menu" role="menu">
                <MenuItem title="Signal feed" detail="Chronological budget activity across monitored lines" onClick={() => { setToolsOpen(false); selectTab('movement'); selectMovement('feed'); }} />
                <MenuItem title="Email alert settings" detail="Digest cadence and critical updates" onClick={() => { setToolsOpen(false); setAlertsOpen(true); }} />
                <MenuItem title="Contact review queue" detail="Acquisition personnel awaiting verification" onClick={() => navigate('/program-elements/contacts')} />
                <MenuItem title="Mark-up monitor" detail="Committee marks and House–Senate divergence" onClick={() => navigate('/program-elements/mark-up-monitor')} />
              </div>
            ) : null}
          </div>
          <div className="pe-fb-menu-wrap">
            <button className="pe-fb-btn" type="button" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}>
              <CapiroDownloadIcon /> Export <PeFbChevronDownIcon />
            </button>
            {exportOpen ? (
              <div className="pe-fb-menu" role="menu">
                <MenuItem title="Results CSV" detail="Export the visible catalog rows" onClick={() => exportRows(false)} />
                <MenuItem title="Selection CSV" detail="Export selected lines" disabled={!selectedCodes.length} onClick={() => exportRows(true)} />
                <MenuItem title="Source package" detail="Available from an individual line profile" disabled onClick={() => {}} />
                <MenuItem title="Results brief PDF" detail="PDF export is not supported by the current surface" disabled onClick={() => {}} />
              </div>
            ) : null}
          </div>
          <button className="pe-fb-btn primary" type="button" onClick={() => navigate('/clients?section=program-elements')}>
            Monitored · {watchingCount}
          </button>
        </div>
      </header>

      <nav className="pe-fb-tabs" aria-label="Program Element views">
        {(['explore', 'movement', 'actions'] as const).map((item) => (
          <button className={tab === item ? 'active' : ''} key={item} type="button" onClick={() => selectTab(item)}>
            {item === 'explore' ? 'Explore' : item === 'movement' ? 'Movement' : 'Actions'}
            {item === 'actions' && openActionCount > 0 ? <span className="pe-fb-count">{openActionCount}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'explore' ? (
        <>
          <div className="pe-fb-search">
            <div className="pe-fb-search-row">
              <div className="pe-fb-segment" aria-label="Search mode">
                <button className={searchMode === 'code' ? 'active' : ''} type="button" onClick={() => selectMode('code')}>Code or title</button>
                <button className={searchMode === 'capability' ? 'active' : ''} type="button" onClick={() => selectMode('capability')}>Capability</button>
              </div>
              <label className="pe-fb-search-input">
                <CapiroSearchIcon />
                <input
                  aria-label={searchMode === 'capability' ? 'Search by capability' : 'Search code or title'}
                  value={term}
                  placeholder={searchMode === 'capability' ? 'Describe a capability — e.g. counter-UAS, undersea sensing' : 'Search code or title — e.g. 0603270A, electronic warfare'}
                  onChange={(event) => { setTerm(event.target.value); setPage(1); if (searchMode === 'capability') { setCapabilitySlug(null); setCapabilityQuery(null); } }}
                  onKeyDown={(event) => { if (event.key === 'Enter' && searchMode === 'capability') { event.preventDefault(); submitCapability(); } }}
                />
              </label>
            </div>
            <div className="pe-fb-facets">
              <span className="pe-fb-facet-label">{searchMode === 'capability' ? 'Common capabilities' : 'Service'}</span>
              {searchMode === 'capability'
                ? commonCapabilities.map((capability) => (
                    <button className={`pe-fb-facet${capabilitySlug === capability.slug ? ' active' : ''}`} key={capability.slug} type="button" onClick={() => openCapability(capability.slug)}>
                      {capability.name.split(' / ')[0]}
                    </button>
                  ))
                : serviceFacets.map((facet) => (
                    <button className={`pe-fb-facet${service === facet.code ? ' active' : ''}`} key={facet.code} type="button" onClick={() => { setService(service === facet.code ? null : facet.code); setPage(1); }}>
                      <i className="pe-fb-dot" style={{ background: facet.color }} /> {facet.label}
                    </button>
                  ))}
              <button className={`pe-fb-facet${filtersOpen ? ' active' : ''}`} type="button" onClick={() => setFiltersOpen((open) => !open)}>More filters</button>
            </div>
            {filtersOpen ? (
              <div className="pe-fb-advanced">
                <span className="pe-fb-facet-label">Line type</span>
                <button className={`pe-fb-facet${!lineType ? ' active' : ''}`} type="button" onClick={() => { setLineType(null); setPage(1); }}>All</button>
                {LINE_TYPE_KEYS.map((key) => (
                  <button className={`pe-fb-facet${lineType === key ? ' active' : ''}`} key={key} type="button" onClick={() => { setLineType(lineType === key ? null : key); setPage(1); }}>
                    <i className="pe-fb-dot" style={{ background: LINE_TYPES[key]!.color }} /> {LINE_TYPES[key]!.short}
                  </button>
                ))}
                <label
                  className="pe-fb-switch-label"
                  title="Hide catalog records that do not yet have FY history, awards, or linked bills."
                >
                  <button
                    type="button"
                    role="switch"
                    aria-checked={hasDataOnly}
                    aria-label="Has data"
                    className={`pe-fb-switch${hasDataOnly ? ' on' : ''}`}
                    onClick={() => { setHasDataOnly(!hasDataOnly); setPage(1); }}
                  >
                    <i />
                  </button>
                  Has data
                </label>
              </div>
            ) : null}
          </div>

          <SummaryStrip
            value={summary.data}
            loading={summary.isLoading}
            actionCount={openActionCount}
            actionsLoading={actions.isLoading}
            onPortfolio={() => navigate('/clients?section=program-elements')}
            onMovement={() => selectTab('movement')}
            onActions={() => selectTab('actions')}
          />

          {searchMode === 'capability' ? (
            <PeCapabilityFinderVNext
              key={capabilityQuery ?? capabilitySlug ?? 'capability-default'}
              initialSlug={capabilitySlug}
              initialQuery={capabilityQuery}
              onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)}
            />
          ) : (
            <div className="pe-fb-card">
              <div className="pe-fb-card-head">
                <h3>Budget lines</h3>
                {!list.isError ? <small>{Math.min(rows.length, total)} of {total.toLocaleString()} shown</small> : null}
                <small className="push">Select up to 4 lines to compare</small>
              </div>
              {list.isError ? (
                <div style={{ padding: 16 }}>
                  <PeFbErrorState message="Unable to load budget lines" onRetry={() => void list.refetch()} />
                </div>
              ) : (
                <CatalogTable
                  rows={rows}
                  loading={list.isLoading}
                  selected={selectedCodes}
                  busyCode={busyCode}
                  onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)}
                  onSelect={toggleSelection}
                  onWatch={(row) => watch.mutate({ peCode: row.peCode, watching: !row.watched })}
                />
              )}
              {total > PAGE_SIZE ? (
                <div className="pe-fb-pagination">
                  <Pagination current={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
                </div>
              ) : null}
            </div>
          )}

          {selectedCodes.length ? (
            <div className="pe-fb-selection" aria-label="Selected Program Elements">
              <strong>{selectedCodes.length} selected</strong>
              <div className="pe-fb-selection-codes">{selectedCodes.map((code) => <span key={code}>{code}</span>)}</div>
              <small>{selectedCodes.length < 2 ? 'Select one more to compare' : selectedCodes.length >= 4 ? 'Maximum reached' : 'Up to 4'}</small>
              <button type="button" onClick={() => setSelectedCodes([])}>Clear</button>
              <button className="primary" type="button" disabled={selectedCodes.length < 2} onClick={openCompare}>Compare</button>
            </div>
          ) : null}
        </>
      ) : tab === 'movement' ? (
        <div>
          <div className="pe-fb-movement-toolbar">
            <div className="pe-fb-segment">
              <button className={movementMode === 'feed' ? 'active' : ''} type="button" onClick={() => selectMovement('feed')}>Signal feed</button>
              <button className={movementMode === 'graph' ? 'active' : ''} type="button" onClick={() => selectMovement('graph')}>Money graph</button>
            </div>
            <span>Current cycle · President&apos;s Budget → committee marks → enacted</span>
          </div>
          {movementMode === 'feed' ? <MovementFeed onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)} /> : <CycleMoneyGraph onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)} />}
        </div>
      ) : (
        <div className="pe-fb-actionhost"><VNextActionBoardPage /></div>
      )}

      <CapiroModal open={alertsOpen} title="Email alert settings" onClose={() => setAlertsOpen(false)}>
        <PeAlertEmailControlVNext />
      </CapiroModal>
    </section>
  );
}

function MenuItem({ title, detail, onClick, disabled }: { title: string; detail: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" role="menuitem" disabled={disabled} onClick={onClick}><span><strong>{title}</strong><small>{detail}</small></span></button>;
}

/**
 * Compact pagination (antd Pagination replacement). Same range copy
 * (`start-end of total`); page numbers collapse to Prev / Page x of y / Next.
 */
function Pagination({ current, pageSize, total, onChange }: {
  current: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (current - 1) * pageSize + 1;
  const end = Math.min(current * pageSize, total);
  return (
    <nav className="pe-fb-pager" aria-label="Pagination">
      <span className="pe-fb-pager-total">{start}-{end} of {total.toLocaleString()}</span>
      <CapiroButton size="compact" disabled={current <= 1} onClick={() => onChange(current - 1)}>
        Previous
      </CapiroButton>
      <span className="pe-fb-pager-page">Page {current} of {pages.toLocaleString()}</span>
      <CapiroButton size="compact" disabled={current >= pages} onClick={() => onChange(current + 1)}>
        Next
      </CapiroButton>
    </nav>
  );
}

function SummaryStrip({ value, loading, actionCount, actionsLoading, onPortfolio, onMovement, onActions }: {
  value?: ProgramElementSummary;
  loading: boolean;
  actionCount: number;
  actionsLoading: boolean;
  onPortfolio: () => void;
  onMovement: () => void;
  onActions: () => void;
}) {
  if (loading && !value) return <div className="pe-fb-kpis">{[0,1,2,3].map((item) => <div className="pe-fb-kpi" key={item}><PeFbSkeleton rows={2} /></div>)}</div>;
  const requestLabel = value?.latestRequestFy ? `FY${String(value.latestRequestFy).slice(-2)} request` : 'Latest request';
  return <div className="pe-fb-kpis">
    <button className="pe-fb-kpi" type="button" onClick={onPortfolio}><span className="pe-fb-kpi-label">Lines in catalog</span><span className="pe-fb-kpi-value">{(value?.tracked ?? 0).toLocaleString()}</span><span className="pe-fb-kpi-sub">{(value?.watched ?? 0).toLocaleString()} monitored in Portfolio</span><span className="pe-fb-kpi-hint">Open Portfolio →</span></button>
    <div className="pe-fb-kpi"><span className="pe-fb-kpi-label">{requestLabel}</span><span className="pe-fb-kpi-value">{value?.totalRequest == null ? '—' : fmtMoneyM(value.totalRequest, 0)}</span><span className="pe-fb-kpi-sub">across tracked lines</span></div>
    <button className="pe-fb-kpi" type="button" onClick={onMovement}><span className="pe-fb-kpi-label">Marked below request</span><span className={`pe-fb-kpi-value${(value?.openMarkups ?? 0) ? ' critical' : ''}`}>{(value?.openMarkups ?? 0).toLocaleString()}</span><span className="pe-fb-kpi-sub">House and Senate marks</span><span className="pe-fb-kpi-hint">See movement →</span></button>
    <button className="pe-fb-kpi" type="button" onClick={onActions}><span className="pe-fb-kpi-label">Open actions</span><span className="pe-fb-kpi-value accent">{actionsLoading ? '—' : actionCount.toLocaleString()}</span><span className="pe-fb-kpi-sub">on lines you monitor</span><span className="pe-fb-kpi-hint">Open actions →</span></button>
  </div>;
}

function CatalogTable({ rows, loading, selected, busyCode, onOpen, onSelect, onWatch }: {
  rows: ProgramElementListItem[];
  loading: boolean;
  selected: string[];
  busyCode: string | null;
  onOpen: (code: string) => void;
  onSelect: (code: string) => void;
  onWatch: (row: ProgramElementListItem) => void;
}) {
  if (loading) return <div style={{ padding: 16 }}><PeFbSkeleton rows={8} /></div>;
  if (!rows.length) return <PeFbEmpty description="No budget lines match these filters." />;
  const currentFy = rows.map((row) => row.latestCurrentFy).find((fy) => fy != null);
  const currentLabel = currentFy != null ? `FY${String(currentFy).slice(-2)} current` : 'Current';
  return <table className="pe-fb-table"><colgroup><col style={{ width: 38 }} /><col style={{ width: 110 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 110 }} /><col style={{ width: 90 }} /><col style={{ width: 64 }} /><col style={{ width: 140 }} /><col style={{ width: 98 }} /></colgroup><thead><tr><th /><th>Code</th><th>Title</th><th>Service</th><th className="right">{currentLabel}</th><th className="right">Δ vs req</th><th className="center">Bills</th><th>Signal</th><th>Monitor</th></tr></thead><tbody>{rows.map((row) => {
    const checked = selected.includes(row.peCode);
    const delta = rowDelta(row);
    const bills = row.billCount;
    return <tr className={checked ? 'selected' : ''} key={row.peCode} onClick={() => onOpen(row.peCode)}>
      <td><button className={`pe-fb-select${checked ? ' selected' : ''}`} type="button" aria-label={`${checked ? 'Remove' : 'Select'} ${row.peCode}`} aria-pressed={checked} onClick={(event) => { event.stopPropagation(); onSelect(row.peCode); }}>{checked ? <CapiroCheckIcon /> : null}</button></td>
      <td><span className="pe-fb-code">{row.peCode}</span></td><td className="pe-fb-title-cell">{row.title}</td>
      <td><span className="pe-fb-service"><i className="pe-fb-dot" style={{ background: serviceColor(row.service) }} />{serviceLabel(row.service)}</span></td>
      <td className="right pe-fb-money">{row.latestCurrent == null ? '—' : fmtMoneyM(row.latestCurrent)}</td>
      <td className={`right pe-fb-delta${delta == null ? '' : delta < 0 ? ' down' : delta > 0 ? ' up' : ''}`}>{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}</td>
      <td className="center pe-fb-bills">{bills == null ? '—' : bills}</td>
      <td>{row.actionSignalType ? <ActionSignalChipVNext type={row.actionSignalType} tone={row.actionSignalTone} /> : row.signalType ? <SignalPillVNext item={row} /> : <span className="pe-fb-muted">—</span>}</td>
      <td><button className={`pe-fb-btn compact${row.watched ? ' monitoring' : ''}`} type="button" disabled={busyCode === row.peCode} onClick={(event) => { event.stopPropagation(); onWatch(row); }}>{row.watched ? 'Monitoring' : 'Monitor'}</button></td>
    </tr>;
  })}</tbody></table>;
}

function CompareView({ codes, onBack, onOpen }: { codes: string[]; onBack: () => void; onOpen: (code: string) => void }) {
  const api = useApi();
  const queries = useQueries({ queries: codes.map((code) => ({ queryKey: ['program-element-detail', code, 'compare-approved'], queryFn: () => getProgramElementDetail(api, code), staleTime: 300_000 })) });
  const details = queries.map((query) => query.data).filter((item): item is ProgramElementDetail => Boolean(item));
  const loading = queries.some((query) => query.isLoading);
  const failed = queries.some((query) => query.isError);
  const rows = comparisonRows(details);
  const exportComparison = () => downloadCsv(`program-element-comparison-${codes.join('-')}.csv`, [['Field', ...details.map((detail) => detail.peCode)], ...rows.filter((row) => !row.group).map((row) => [row.label, ...row.values])]);
  return <section className="pe-fb-root"><button className="pe-fb-breadcrumb" type="button" onClick={onBack}>Program elements <span>›</span> <b>Compare</b></button><header className="pe-fb-compare-head"><div><h1>Compare program elements</h1><p>Funding, movement, coverage, and engagement side by side.</p></div><div className="pe-fb-compare-actions"><button className="pe-fb-btn" type="button" onClick={onBack}>Add another line</button><button className="pe-fb-btn" type="button" disabled={loading || details.length < 2} onClick={exportComparison}><CapiroDownloadIcon /> Export comparison</button></div></header>{failed ? <PeFbErrorState message="One or more Program Elements could not be loaded" description="Unavailable values remain blank rather than being inferred." /> : loading ? <PeFbSkeleton rows={14} /> : <div className="pe-fb-compare-scroll"><div style={{ '--compare-count': details.length } as CSSProperties}><div className="pe-fb-compare-row head"><div />{details.map((detail) => <button style={{ border: 0, textAlign: 'left', cursor: 'pointer' }} type="button" key={detail.peCode} onClick={() => onOpen(detail.peCode)}><span className="pe-fb-code">{detail.peCode}</span><strong>{detail.title}</strong><small>{serviceLabel(detail.service)}</small></button>)}</div>{rows.map((row) => <div className={`pe-fb-compare-row${row.group ? ' group' : ''}`} key={row.label}><div>{row.label}</div>{row.values.map((value, index) => <div key={`${row.label}-${details[index]?.peCode}`}>{value}</div>)}</div>)}</div></div>}</section>;
}

function comparisonRows(details: ProgramElementDetail[]): Array<{ label: string; values: string[]; group?: boolean }> {
  const series = details.map((detail) => buildFundingSeries(detail.years ?? []));
  const latestFy = Math.max(0, ...series.flatMap((points) => points.map((point) => point.fy)));
  const point = (index: number) => series[index]?.find((candidate) => candidate.fy === latestFy);
  const amount = (index: number, field: 'request' | 'house' | 'senate' | 'enacted' | 'current') => {
    const value = point(index); if (!value) return '—';
    const dollars = field === 'request' ? value.request : field === 'house' ? value.hacDMark ?? value.hascMark : field === 'senate' ? value.sacDMark ?? value.sascMark : field === 'enacted' ? value.enacted : value.current.value;
    return dollars == null ? '—' : fmtMoneyM(dollars);
  };
  const delta = (index: number) => { const value = point(index); if (!value || value.request == null || value.request === 0 || value.current.value == null) return '—'; const pct = ((value.current.value - value.request) / Math.abs(value.request)) * 100; return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`; };
  const group = (label: string) => ({ label, values: details.map(() => ''), group: true });
  return [group(`Funding stages · FY${latestFy || '—'}`),{ label: "President's budget", values: details.map((_detail, index) => amount(index, 'request')) },{ label: 'House mark', values: details.map((_detail, index) => amount(index, 'house')) },{ label: 'Senate mark', values: details.map((_detail, index) => amount(index, 'senate')) },{ label: 'Enacted', values: details.map((_detail, index) => amount(index, 'enacted')) },group('Deltas'),{ label: 'Δ vs request', values: details.map((_detail, index) => delta(index)) },group('Sponsors and coverage'),{ label: 'Appropriation', values: details.map((detail) => detail.appropriationType ?? '—') },{ label: 'Budget activity', values: details.map((detail) => detail.budgetActivity ?? '—') },{ label: 'Bills touching', values: details.map((detail) => String(detail.billCount ?? '—')) },group('Your engagement'),{ label: 'Monitored', values: details.map((detail) => detail.currentUserIsWatching ? 'Yes' : 'No') }];
}

function actionTone(item: MovementFeedItem): 'critical' | 'positive' | 'notable' | 'info' {
  if (item.action === 'cut' || item.action === 'termination') return 'critical';
  if (item.action === 'add') return 'positive';
  if (item.action === 'hold') return 'notable';
  return 'info';
}
function actionIcon(item: MovementFeedItem) {
  if (item.action === 'cut' || item.action === 'termination') return <PeFbTrendDownIcon />;
  if (item.action === 'add') return <PeFbTrendUpIcon />;
  if (item.action === 'new_start') return <PeFbFlagIcon />;
  if (item.action === 'transfer') return <PeFbSwapIcon />;
  return <PeFbInfoCircleIcon />;
}
function MovementFeed({ onOpen }: { onOpen: (code: string) => void }) {
  const api = useApi();
  const query = useQuery({ queryKey: ['budget-lines-movement'], queryFn: () => getMovement(api), staleTime: 60_000 });
  if (query.isLoading) return <PeFbSkeleton rows={12} />;
  if (query.isError || !query.data) return <PeFbErrorState message="Unable to load movement data" />;
  const movement = query.data;
  return <><div className="pe-fb-kpis"><div className="pe-fb-kpi"><span className="pe-fb-kpi-label">Actions · FY{movement.openFy}</span><span className="pe-fb-kpi-value">{movement.kpis.actions}</span><span className="pe-fb-kpi-sub">normalized committee events</span></div><div className="pe-fb-kpi"><span className="pe-fb-kpi-label">Adds</span><span className="pe-fb-kpi-value" style={{ color: 'var(--capiro-color-success)' }}>+{fmtMoneyM(movement.kpis.addsTotal)}</span><span className="pe-fb-kpi-sub">committee increases</span></div><div className="pe-fb-kpi"><span className="pe-fb-kpi-label">Cuts</span><span className="pe-fb-kpi-value" style={{ color: 'var(--capiro-color-danger)' }}>−{fmtMoneyM(Math.abs(movement.kpis.cutsTotal))}</span><span className="pe-fb-kpi-sub">reductions and terminations</span></div><div className="pe-fb-kpi"><span className="pe-fb-kpi-label">Open in conference</span><span className="pe-fb-kpi-value">{movement.kpis.openInConference}</span><span className="pe-fb-kpi-sub">House–Senate divergence</span></div></div><div className="pe-fb-movement-layout"><div className="pe-fb-card"><div className="pe-fb-card-head"><h3>Signal feed</h3><small>chronological budget activity</small></div><div className="pe-fb-feed">{movement.feed.length ? movement.feed.map((item) => { const tone = actionTone(item); return <div className="pe-fb-feed-row" key={item.id} onClick={() => onOpen(item.peCode)}><span className={`pe-fb-feed-icon ${tone}`}>{actionIcon(item)}</span><div><div className="pe-fb-feed-title">{item.title}</div><div className="pe-fb-feed-meta"><span className="pe-fb-code">{item.peCode}</span><span><i className="pe-fb-dot" style={{ background: serviceColor(item.service) }} /> {serviceLabel(item.service)}</span><span>FY{item.fy}</span><span>{item.stage.replaceAll('_', '-')}</span>{item.note ? <span>{item.note}</span> : null}</div></div><span className="pe-fb-feed-amount" style={{ color: tone === 'critical' ? 'var(--capiro-color-danger)' : tone === 'positive' ? 'var(--capiro-color-success)' : 'var(--capiro-color-text-primary)' }}>{item.amount == null ? '—' : `${item.amount >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(item.amount))}`}</span></div>; }) : <PeFbEmpty description="No normalized movement is available for this cycle." />}</div></div><div className="pe-fb-card"><div className="pe-fb-card-head"><h3>Conference divergence</h3><small>widest gaps first</small></div>{movement.conference.length ? movement.conference.slice(0, 12).map((row) => <DivergenceRow key={row.peCode} row={row} onOpen={onOpen} />) : <PeFbEmpty description="No open House–Senate divergence this cycle." />}</div></div></>;
}
function DivergenceRow({ row, onOpen }: { row: Awaited<ReturnType<typeof getMovement>>['conference'][number]; onOpen: (code: string) => void }) {
  const max = Math.max(1, row.house ?? 0, row.senate ?? 0, row.request ?? 0);
  return <div className="pe-fb-divergence" onClick={() => onOpen(row.peCode)}><div className="pe-fb-divergence-top"><span className="pe-fb-code">{row.peCode}</span><span className="pe-fb-divergence-title">{row.title}</span><span className="pe-fb-divergence-gap">{row.gap == null ? '—' : fmtMoneyM(row.gap)}</span></div><div className="pe-fb-divergence-bars"><i style={{ width: `${((row.house ?? 0) / max) * 100}%` }} /><i style={{ width: `${((row.senate ?? 0) / max) * 100}%` }} /></div></div>;
}

const MONEY_STAGES = [{ key: 'request', label: "President's budget", color: '#8a8780' },{ key: 'house', label: 'House mark', color: '#a26913' },{ key: 'senate', label: 'Senate mark', color: '#2c5bd4' },{ key: 'enacted', label: 'Enacted', color: '#2e6b43' }] as const;
type MoneyStage = (typeof MONEY_STAGES)[number]['key'];
function CycleMoneyGraph({ onOpen }: { onOpen: (code: string) => void }) {
  const api = useApi();
  const [service, setService] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['budget-lines-movement'], queryFn: () => getMovement(api), staleTime: 60_000 });
  if (query.isLoading) return <PeFbSkeleton rows={12} />;
  if (query.isError || !query.data) return <PeFbErrorState message="Unable to load cycle funding" />;
  const movement = query.data;
  const rows = movement.conference.filter((row) => !service || (row.service ?? '').toUpperCase() === service);
  const services = [...new Set(movement.conference.map((row) => row.service).filter(Boolean) as string[])];
  const value = (row: (typeof rows)[number], key: MoneyStage) => key === 'request' ? row.request : key === 'house' ? row.house : key === 'senate' ? row.senate : null;
  const totals = MONEY_STAGES.map((stage) => ({ ...stage, value: rows.reduce((sum, row) => sum + (value(row, stage.key) ?? 0), 0) }));
  const requestTotal = totals[0]?.value ?? 0;
  return <><div className="pe-fb-money-toolbar"><div className="pe-fb-facets" style={{ marginTop: 0 }}><span className="pe-fb-facet-label">Service</span><button className={`pe-fb-facet${!service ? ' active' : ''}`} type="button" onClick={() => setService(null)}>All</button>{services.map((item) => <button className={`pe-fb-facet${service === item.toUpperCase() ? ' active' : ''}`} key={item} type="button" onClick={() => setService(item.toUpperCase())}>{serviceLabel(item)}</button>)}</div><span>FY{movement.openFy} cycle · same-year positions only</span></div><div className="pe-fb-stage-kpis">{totals.map((stage) => { const delta = stage.value - requestTotal; return <div className="pe-fb-stage-kpi" key={stage.key} style={{ '--stage-color': stage.color } as CSSProperties}><small>{stage.label}</small><strong>{stage.key === 'enacted' ? 'pending' : stage.value >= 1000 ? `$${(stage.value / 1000).toFixed(2)}B` : fmtMoneyM(stage.value)}</strong><span style={{ color: stage.key === 'enacted' ? 'var(--capiro-color-warning)' : delta < 0 ? 'var(--capiro-color-danger)' : delta > 0 ? 'var(--capiro-color-success)' : 'var(--capiro-color-text-muted)' }}>{stage.key === 'request' ? `${rows.length} compared lines` : stage.key === 'enacted' ? 'conference open' : `${delta >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(delta))} vs request`}</span></div>; })}</div><div className="pe-fb-card"><div className="pe-fb-card-head"><h3>Funding by stage</h3><small>House and Senate positions around the request</small></div><div className="pe-fb-money-table">{rows.length ? rows.map((row) => { const max = Math.max(1, row.request ?? 0, row.house ?? 0, row.senate ?? 0); return <div className="pe-fb-money-row" key={row.peCode} onClick={() => onOpen(row.peCode)}><div className="pe-fb-money-line"><span className="pe-fb-code">{row.peCode}</span><strong>{row.title}</strong><small><i className="pe-fb-dot" style={{ background: serviceColor(row.service) }} />{serviceLabel(row.service)} · {row.basis}</small></div>{MONEY_STAGES.map((stage) => { const dollars = value(row, stage.key); const delta = dollars != null && row.request != null ? dollars - row.request : null; return <div className="pe-fb-money-cell" key={stage.key}><div className="pe-fb-stage-bar"><i style={{ '--bar-width': dollars == null ? '0%' : `${Math.max(3, (dollars / max) * 100)}%`, '--bar-color': stage.color } as CSSProperties} /></div><div className="pe-fb-stage-value">{dollars == null ? stage.key === 'enacted' ? 'pending' : 'not published' : fmtMoneyM(dollars)}{delta != null && stage.key !== 'request' && Math.abs(delta) > .01 ? <span style={{ color: delta < 0 ? 'var(--capiro-color-danger)' : 'var(--capiro-color-success)' }}>{delta >= 0 ? '+' : '−'}{fmtMoneyM(Math.abs(delta))}</span> : null}</div></div>; })}</div>; }) : <PeFbEmpty description="No comparable current-cycle positions are available." />}</div></div></>;
}
