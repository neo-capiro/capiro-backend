import { useMemo, useState, type CSSProperties } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { Alert, Button, Empty, Modal, Pagination, Skeleton, Switch, Tooltip } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  DownOutlined,
  DownloadOutlined,
  FallOutlined,
  FlagOutlined,
  InfoCircleOutlined,
  RiseOutlined,
  SearchOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { ActionBoardPage } from '../actions/ActionBoardPage.js';
import { useActionsList } from '../actions/actions-api.js';
import {
  getCapabilities,
  getMovement,
  getProgramElementDetail,
  getProgramElementSummary,
  getProgramElementsList,
} from './api.js';
import type {
  MovementFeedItem,
  ProgramElementDetail,
  ProgramElementListItem,
  ProgramElementSummary,
} from './types.js';
import {
  ActionSignalChip,
  LINE_TYPES,
  SignalPill,
  serviceLabel,
  useWatchToggle,
} from './pe-shared.js';
import { fmtMoneyM, serviceColor } from './charts/index.js';
import { buildFundingSeries } from './funding-model.js';
import { CapabilityFinder } from './CapabilityFinder.js';
import { PeAlertEmailControl } from './PeAlertEmailControl.js';
import './program-elements-final.css';

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

export function ProgramElementFinderPage() {
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
  const watch = useWatchToggle();
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
    <section className="pe-finder pe-final">
      <header className="pe-final-page-head">
        <div className="pe-final-page-copy">
          <h1>Program elements</h1>
          <p>
            Every RDT&amp;E program element, procurement BLIN and O&amp;M line, with the
            money that moved and what to do about it.
          </p>
        </div>
        <div className="pe-final-page-actions">
          <div className="pe-final-menu-wrap">
            <button className="pe-final-btn" type="button" onClick={() => setToolsOpen((open) => !open)}>
              Monitoring tools <DownOutlined />
            </button>
            {toolsOpen ? (
              <div className="pe-final-menu">
                <MenuItem title="Signal feed" detail="Chronological budget activity across monitored lines" onClick={() => { setToolsOpen(false); selectTab('movement'); selectMovement('feed'); }} />
                <MenuItem title="Email alert settings" detail="Digest cadence and critical updates" onClick={() => { setToolsOpen(false); setAlertsOpen(true); }} />
                <MenuItem title="Contact review queue" detail="Acquisition personnel awaiting verification" onClick={() => navigate('/program-elements/contacts')} />
                <MenuItem title="Mark-up monitor" detail="Committee marks and House–Senate divergence" onClick={() => navigate('/program-elements/mark-up-monitor')} />
              </div>
            ) : null}
          </div>
          <div className="pe-final-menu-wrap">
            <button className="pe-final-btn" type="button" onClick={() => setExportOpen((open) => !open)}>
              <DownloadOutlined /> Export <DownOutlined />
            </button>
            {exportOpen ? (
              <div className="pe-final-menu">
                <MenuItem title="Results CSV" detail="Export the visible catalog rows" onClick={() => exportRows(false)} />
                <MenuItem title="Selection CSV" detail="Export selected lines" disabled={!selectedCodes.length} onClick={() => exportRows(true)} />
                <MenuItem title="Source package" detail="Available from an individual line profile" disabled onClick={() => {}} />
                <MenuItem title="Results brief PDF" detail="PDF export is not supported by the current surface" disabled onClick={() => {}} />
              </div>
            ) : null}
          </div>
          <button className="pe-final-btn primary" type="button" onClick={() => navigate('/clients?section=program-elements')}>
            Monitored · {watchingCount}
          </button>
        </div>
      </header>

      <nav className="pe-final-tabs" aria-label="Program Element views">
        {(['explore', 'movement', 'actions'] as const).map((item) => (
          <button className={tab === item ? 'active' : ''} key={item} type="button" onClick={() => selectTab(item)}>
            {item === 'explore' ? 'Explore' : item === 'movement' ? 'Movement' : 'Actions'}
            {item === 'actions' && openActionCount > 0 ? <span className="pe-final-count">{openActionCount}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'explore' ? (
        <>
          <div className="pe-final-search">
            <div className="pe-final-search-row">
              <div className="pe-final-segment" aria-label="Search mode">
                <button className={searchMode === 'code' ? 'active' : ''} type="button" onClick={() => selectMode('code')}>Code or title</button>
                <button className={searchMode === 'capability' ? 'active' : ''} type="button" onClick={() => selectMode('capability')}>Capability</button>
              </div>
              <label className="pe-final-search-input">
                <SearchOutlined />
                <input
                  aria-label={searchMode === 'capability' ? 'Search by capability' : 'Search code or title'}
                  value={term}
                  placeholder={searchMode === 'capability' ? 'Describe a capability — e.g. counter-UAS, undersea sensing' : 'Search code or title — e.g. 0603270A, electronic warfare'}
                  onChange={(event) => { setTerm(event.target.value); setPage(1); if (searchMode === 'capability') { setCapabilitySlug(null); setCapabilityQuery(null); } }}
                  onKeyDown={(event) => { if (event.key === 'Enter' && searchMode === 'capability') { event.preventDefault(); submitCapability(); } }}
                />
              </label>
            </div>
            <div className="pe-final-facets">
              <span className="pe-final-facet-label">{searchMode === 'capability' ? 'Common capabilities' : 'Service'}</span>
              {searchMode === 'capability'
                ? commonCapabilities.map((capability) => (
                    <button className={`pe-final-facet${capabilitySlug === capability.slug ? ' active' : ''}`} key={capability.slug} type="button" onClick={() => openCapability(capability.slug)}>
                      {capability.name.split(' / ')[0]}
                    </button>
                  ))
                : serviceFacets.map((facet) => (
                    <button className={`pe-final-facet${service === facet.code ? ' active' : ''}`} key={facet.code} type="button" onClick={() => { setService(service === facet.code ? null : facet.code); setPage(1); }}>
                      <i className="pe-final-dot" style={{ background: facet.color }} /> {facet.label}
                    </button>
                  ))}
              <button className={`pe-final-facet${filtersOpen ? ' active' : ''}`} type="button" onClick={() => setFiltersOpen((open) => !open)}>More filters</button>
            </div>
            {filtersOpen ? (
              <div className="pe-final-advanced">
                <span className="pe-final-facet-label">Line type</span>
                <button className={`pe-final-facet${!lineType ? ' active' : ''}`} type="button" onClick={() => { setLineType(null); setPage(1); }}>All</button>
                {LINE_TYPE_KEYS.map((key) => (
                  <button className={`pe-final-facet${lineType === key ? ' active' : ''}`} key={key} type="button" onClick={() => { setLineType(lineType === key ? null : key); setPage(1); }}>
                    <i className="pe-final-dot" style={{ background: LINE_TYPES[key]!.color }} /> {LINE_TYPES[key]!.short}
                  </button>
                ))}
                <Tooltip title="Hide catalog records that do not yet have FY history, awards, or linked bills.">
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11 }}>
                    <Switch size="small" checked={hasDataOnly} onChange={(checked) => { setHasDataOnly(checked); setPage(1); }} /> Has data
                  </label>
                </Tooltip>
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
            <CapabilityFinder
              key={capabilityQuery ?? capabilitySlug ?? 'capability-default'}
              initialSlug={capabilitySlug}
              initialQuery={capabilityQuery}
              onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)}
            />
          ) : (
            <div className="pe-final-card">
              <div className="pe-final-card-head">
                <h3>Budget lines</h3>
                {!list.isError ? <small>{Math.min(rows.length, total)} of {total.toLocaleString()} shown</small> : null}
                <small className="push">Select up to 4 lines to compare</small>
              </div>
              {list.isError ? (
                <div style={{ padding: 16 }}><Alert type="error" showIcon message="Unable to load budget lines" action={<Button size="small" onClick={() => void list.refetch()}>Retry</Button>} /></div>
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
              {total > PAGE_SIZE ? <div className="pe-final-pagination"><Pagination current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={setPage} showTotal={(count, range) => `${range[0]}-${range[1]} of ${count.toLocaleString()}`} /></div> : null}
            </div>
          )}

          {selectedCodes.length ? (
            <div className="pe-final-selection" aria-label="Selected Program Elements">
              <strong>{selectedCodes.length} selected</strong>
              <div className="pe-final-selection-codes">{selectedCodes.map((code) => <span key={code}>{code}</span>)}</div>
              <small>Up to 4</small>
              <button type="button" onClick={() => setSelectedCodes([])}>Clear</button>
              <button className="primary" type="button" disabled={selectedCodes.length < 2} onClick={openCompare}>Compare</button>
            </div>
          ) : null}
        </>
      ) : tab === 'movement' ? (
        <div>
          <div className="pe-final-movement-toolbar">
            <div className="pe-final-segment">
              <button className={movementMode === 'feed' ? 'active' : ''} type="button" onClick={() => selectMovement('feed')}>Signal feed</button>
              <button className={movementMode === 'graph' ? 'active' : ''} type="button" onClick={() => selectMovement('graph')}>Money graph</button>
            </div>
            <span>Current cycle · President&apos;s Budget → committee marks → enacted</span>
          </div>
          {movementMode === 'feed' ? <MovementFeed onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)} /> : <CycleMoneyGraph onOpen={(code) => navigate(`/program-elements/${encodeURIComponent(code)}`)} />}
        </div>
      ) : (
        <div className="pe-final"><ActionBoardPage /></div>
      )}

      <Modal open={alertsOpen} title="Email alert settings" footer={null} onCancel={() => setAlertsOpen(false)} destroyOnClose><PeAlertEmailControl /></Modal>
    </section>
  );
}

function MenuItem({ title, detail, onClick, disabled }: { title: string; detail: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick}><span><strong>{title}</strong><small>{detail}</small></span></button>;
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
  if (loading && !value) return <div className="pe-final-kpis">{[0,1,2,3].map((item) => <div className="pe-final-kpi" key={item}><Skeleton active paragraph={{ rows: 2 }} /></div>)}</div>;
  const requestLabel = value?.latestRequestFy ? `FY${String(value.latestRequestFy).slice(-2)} request` : 'Latest request';
  return <div className="pe-final-kpis">
    <button className="pe-final-kpi" type="button" onClick={onPortfolio}><span className="pe-final-kpi-label">Lines in catalog</span><span className="pe-final-kpi-value">{(value?.tracked ?? 0).toLocaleString()}</span><span className="pe-final-kpi-sub">{(value?.watched ?? 0).toLocaleString()} monitored in Portfolio</span><span className="pe-final-kpi-hint">Open Portfolio →</span></button>
    <div className="pe-final-kpi"><span className="pe-final-kpi-label">{requestLabel}</span><span className="pe-final-kpi-value">{value?.totalRequest == null ? '—' : fmtMoneyM(value.totalRequest, 0)}</span><span className="pe-final-kpi-sub">across tracked lines</span></div>
    <button className="pe-final-kpi" type="button" onClick={onMovement}><span className="pe-final-kpi-label">Open markups</span><span className={`pe-final-kpi-value${(value?.openMarkups ?? 0) ? ' critical' : ''}`}>{(value?.openMarkups ?? 0).toLocaleString()}</span><span className="pe-final-kpi-sub">lines with active committee marks</span><span className="pe-final-kpi-hint">See movement →</span></button>
    <button className="pe-final-kpi" type="button" onClick={onActions}><span className="pe-final-kpi-label">Open actions</span><span className="pe-final-kpi-value accent">{actionsLoading ? '—' : actionCount.toLocaleString()}</span><span className="pe-final-kpi-sub">on monitored lines</span><span className="pe-final-kpi-hint">Open actions →</span></button>
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
  if (loading) return <div style={{ padding: 16 }}><Skeleton active paragraph={{ rows: 8 }} /></div>;
  if (!rows.length) return <Empty description="No budget lines match these filters." />;
  return <table className="pe-final-table"><colgroup><col style={{ width: 38 }} /><col style={{ width: 110 }} /><col /><col style={{ width: 110 }} /><col style={{ width: 105 }} /><col style={{ width: 95 }} /><col style={{ width: 125 }} /><col style={{ width: 98 }} /></colgroup><thead><tr><th /><th>Code</th><th>Title</th><th>Service</th><th className="right">Current</th><th className="right">Δ vs req</th><th>Latest signal</th><th /></tr></thead><tbody>{rows.map((row) => {
    const checked = selected.includes(row.peCode);
    const delta = rowDelta(row);
    return <tr className={checked ? 'selected' : ''} key={row.peCode} onClick={() => onOpen(row.peCode)}>
      <td><button className={`pe-final-select${checked ? ' selected' : ''}`} type="button" aria-label={`${checked ? 'Remove' : 'Select'} ${row.peCode}`} aria-pressed={checked} onClick={(event) => { event.stopPropagation(); onSelect(row.peCode); }}>{checked ? <CheckOutlined /> : null}</button></td>
      <td><span className="pe-final-code">{row.peCode}</span></td><td className="pe-final-title-cell">{row.title}</td>
      <td><span className="pe-final-service"><i className="pe-final-dot" style={{ background: serviceColor(row.service) }} />{serviceLabel(row.service)}</span></td>
      <td className="right pe-final-money">{row.latestCurrent == null ? '—' : fmtMoneyM(row.latestCurrent)}</td>
      <td className={`right pe-final-delta${delta == null ? '' : delta < 0 ? ' down' : delta > 0 ? ' up' : ''}`}>{delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}</td>
      <td>{row.actionSignalType ? <ActionSignalChip type={row.actionSignalType} tone={row.actionSignalTone} /> : row.signalType ? <SignalPill item={row} /> : <span className="pe-final-muted">No movement</span>}</td>
      <td><button className={`pe-final-btn${row.watched ? ' monitoring' : ''}`} style={{ height: 28, padding: '0 9px', fontSize: 10.5 }} type="button" disabled={busyCode === row.peCode} onClick={(event) => { event.stopPropagation(); onWatch(row); }}>{row.watched ? 'Monitoring' : 'Monitor'}</button></td>
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
  return <section className="pe-final"><button className="pe-final-breadcrumb" type="button" onClick={onBack}>Program elements <span>›</span> <b>Compare</b></button><header className="pe-final-compare-head"><div><h1>Compare program elements</h1><p>Funding, movement, coverage, and engagement side by side.</p></div><div className="pe-final-compare-actions"><button className="pe-final-btn" type="button" onClick={onBack}>Add another line</button><button className="pe-final-btn" type="button" disabled={loading || details.length < 2} onClick={exportComparison}><DownloadOutlined /> Export comparison</button></div></header>{failed ? <Alert type="error" showIcon message="One or more Program Elements could not be loaded" description="Unavailable values remain blank rather than being inferred." /> : loading ? <Skeleton active paragraph={{ rows: 14 }} /> : <div className="pe-final-compare-scroll"><div style={{ '--compare-count': details.length } as CSSProperties}><div className="pe-final-compare-row head"><div />{details.map((detail) => <button style={{ border: 0, textAlign: 'left', cursor: 'pointer' }} type="button" key={detail.peCode} onClick={() => onOpen(detail.peCode)}><span className="pe-final-code">{detail.peCode}</span><strong>{detail.title}</strong><small>{serviceLabel(detail.service)}</small></button>)}</div>{rows.map((row) => <div className={`pe-final-compare-row${row.group ? ' group' : ''}`} key={row.label}><div>{row.label}</div>{row.values.map((value, index) => <div key={`${row.label}-${details[index]?.peCode}`}>{value}</div>)}</div>)}</div></div>}</section>;
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
  if (item.action === 'cut' || item.action === 'termination') return <FallOutlined />;
  if (item.action === 'add') return <RiseOutlined />;
  if (item.action === 'new_start') return <FlagOutlined />;
  if (item.action === 'transfer') return <SwapOutlined />;
  return <InfoCircleOutlined />;
}
function MovementFeed({ onOpen }: { onOpen: (code: string) => void }) {
  const api = useApi();
  const query = useQuery({ queryKey: ['budget-lines-movement'], queryFn: () => getMovement(api), staleTime: 60_000 });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 12 }} />;
  if (query.isError || !query.data) return <Alert type="error" showIcon message="Unable to load movement data" />;
  const movement = query.data;
  return <><div className="pe-final-kpis"><div className="pe-final-kpi"><span className="pe-final-kpi-label">Actions · FY{movement.openFy}</span><span className="pe-final-kpi-value">{movement.kpis.actions}</span><span className="pe-final-kpi-sub">normalized committee events</span></div><div className="pe-final-kpi"><span className="pe-final-kpi-label">Adds</span><span className="pe-final-kpi-value" style={{ color: 'var(--pef-positive)' }}>+{fmtMoneyM(movement.kpis.addsTotal)}</span><span className="pe-final-kpi-sub">committee increases</span></div><div className="pe-final-kpi"><span className="pe-final-kpi-label">Cuts</span><span className="pe-final-kpi-value" style={{ color: 'var(--pef-critical)' }}>−{fmtMoneyM(Math.abs(movement.kpis.cutsTotal))}</span><span className="pe-final-kpi-sub">reductions and terminations</span></div><div className="pe-final-kpi"><span className="pe-final-kpi-label">Open in conference</span><span className="pe-final-kpi-value">{movement.kpis.openInConference}</span><span className="pe-final-kpi-sub">House–Senate divergence</span></div></div><div className="pe-final-movement-layout"><div className="pe-final-card"><div className="pe-final-card-head"><h3>Signal feed</h3><small>chronological budget activity</small></div><div className="pe-final-feed">{movement.feed.length ? movement.feed.map((item) => { const tone = actionTone(item); return <div className="pe-final-feed-row" key={item.id} onClick={() => onOpen(item.peCode)}><span className={`pe-final-feed-icon ${tone}`}>{actionIcon(item)}</span><div><div className="pe-final-feed-title">{item.title}</div><div className="pe-final-feed-meta"><span className="pe-final-code">{item.peCode}</span><span><i className="pe-final-dot" style={{ background: serviceColor(item.service) }} /> {serviceLabel(item.service)}</span><span>FY{item.fy}</span><span>{item.stage.replaceAll('_', '-')}</span>{item.note ? <span>{item.note}</span> : null}</div></div><span className="pe-final-feed-amount" style={{ color: tone === 'critical' ? 'var(--pef-critical)' : tone === 'positive' ? 'var(--pef-positive)' : 'var(--pef-ink)' }}>{item.amount == null ? '—' : `${item.amount >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(item.amount))}`}</span></div>; }) : <Empty description="No normalized movement is available for this cycle." />}</div></div><div className="pe-final-card"><div className="pe-final-card-head"><h3>Conference divergence</h3><small>widest gaps first</small></div>{movement.conference.length ? movement.conference.slice(0, 12).map((row) => <DivergenceRow key={row.peCode} row={row} onOpen={onOpen} />) : <Empty description="No open House–Senate divergence this cycle." />}</div></div></>;
}
function DivergenceRow({ row, onOpen }: { row: Awaited<ReturnType<typeof getMovement>>['conference'][number]; onOpen: (code: string) => void }) {
  const max = Math.max(1, row.house ?? 0, row.senate ?? 0, row.request ?? 0);
  return <div className="pe-final-divergence" onClick={() => onOpen(row.peCode)}><div className="pe-final-divergence-top"><span className="pe-final-code">{row.peCode}</span><span className="pe-final-divergence-title">{row.title}</span><span className="pe-final-divergence-gap">{row.gap == null ? '—' : fmtMoneyM(row.gap)}</span></div><div className="pe-final-divergence-bars"><i style={{ width: `${((row.house ?? 0) / max) * 100}%` }} /><i style={{ width: `${((row.senate ?? 0) / max) * 100}%` }} /></div></div>;
}

const MONEY_STAGES = [{ key: 'request', label: "President's budget", color: '#8a8780' },{ key: 'house', label: 'House mark', color: '#a26913' },{ key: 'senate', label: 'Senate mark', color: '#2c5bd4' },{ key: 'enacted', label: 'Enacted', color: '#2e6b43' }] as const;
type MoneyStage = (typeof MONEY_STAGES)[number]['key'];
function CycleMoneyGraph({ onOpen }: { onOpen: (code: string) => void }) {
  const api = useApi();
  const [service, setService] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['budget-lines-movement'], queryFn: () => getMovement(api), staleTime: 60_000 });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 12 }} />;
  if (query.isError || !query.data) return <Alert type="error" showIcon message="Unable to load cycle funding" />;
  const movement = query.data;
  const rows = movement.conference.filter((row) => !service || (row.service ?? '').toUpperCase() === service);
  const services = [...new Set(movement.conference.map((row) => row.service).filter(Boolean) as string[])];
  const value = (row: (typeof rows)[number], key: MoneyStage) => key === 'request' ? row.request : key === 'house' ? row.house : key === 'senate' ? row.senate : null;
  const totals = MONEY_STAGES.map((stage) => ({ ...stage, value: rows.reduce((sum, row) => sum + (value(row, stage.key) ?? 0), 0) }));
  const requestTotal = totals[0]?.value ?? 0;
  return <><div className="pe-final-money-toolbar"><div className="pe-final-facets" style={{ marginTop: 0 }}><span className="pe-final-facet-label">Service</span><button className={`pe-final-facet${!service ? ' active' : ''}`} type="button" onClick={() => setService(null)}>All</button>{services.map((item) => <button className={`pe-final-facet${service === item.toUpperCase() ? ' active' : ''}`} key={item} type="button" onClick={() => setService(item.toUpperCase())}>{serviceLabel(item)}</button>)}</div><span>FY{movement.openFy} cycle · same-year positions only</span></div><div className="pe-final-stage-kpis">{totals.map((stage) => { const delta = stage.value - requestTotal; return <div className="pe-final-stage-kpi" key={stage.key} style={{ '--stage-color': stage.color } as CSSProperties}><small>{stage.label}</small><strong>{stage.key === 'enacted' ? 'pending' : stage.value >= 1000 ? `$${(stage.value / 1000).toFixed(2)}B` : fmtMoneyM(stage.value)}</strong><span style={{ color: stage.key === 'enacted' ? 'var(--pef-notable)' : delta < 0 ? 'var(--pef-critical)' : delta > 0 ? 'var(--pef-positive)' : 'var(--pef-ink-3)' }}>{stage.key === 'request' ? `${rows.length} compared lines` : stage.key === 'enacted' ? 'conference open' : `${delta >= 0 ? '+' : '−'}${fmtMoneyM(Math.abs(delta))} vs request`}</span></div>; })}</div><div className="pe-final-card"><div className="pe-final-card-head"><h3>Funding by stage</h3><small>House and Senate positions around the request</small></div><div className="pe-final-money-table">{rows.length ? rows.map((row) => { const max = Math.max(1, row.request ?? 0, row.house ?? 0, row.senate ?? 0); return <div className="pe-final-money-row" key={row.peCode} onClick={() => onOpen(row.peCode)}><div className="pe-final-money-line"><span className="pe-final-code">{row.peCode}</span><strong>{row.title}</strong><small><i className="pe-final-dot" style={{ background: serviceColor(row.service) }} />{serviceLabel(row.service)} · {row.basis}</small></div>{MONEY_STAGES.map((stage) => { const dollars = value(row, stage.key); const delta = dollars != null && row.request != null ? dollars - row.request : null; return <div className="pe-final-money-cell" key={stage.key}><div className="pe-final-stage-bar"><i style={{ '--bar-width': dollars == null ? '0%' : `${Math.max(3, (dollars / max) * 100)}%`, '--bar-color': stage.color } as CSSProperties} /></div><div className="pe-final-stage-value">{dollars == null ? stage.key === 'enacted' ? 'pending' : 'not published' : fmtMoneyM(dollars)}{delta != null && stage.key !== 'request' && Math.abs(delta) > .01 ? <span style={{ color: delta < 0 ? 'var(--pef-critical)' : 'var(--pef-positive)' }}>{delta >= 0 ? '+' : '−'}{fmtMoneyM(Math.abs(delta))}</span> : null}</div></div>; })}</div>; }) : <Empty description="No comparable current-cycle positions are available." />}</div></div></>;
}
