import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Alert, Pagination, Switch, Tooltip, Typography } from 'antd';
import { CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import { ActionBoardPage } from '../actions/ActionBoardPage.js';
import { useActionsList } from '../actions/actions-api.js';
import {
  getCapabilities,
  getProgramElementSummary,
  getProgramElementWatchlistFeed,
  getProgramElementsList,
  getWatchSignals,
} from './api.js';
import type { ProgramElementListItem } from './types.js';
import { LINE_TYPES, serviceLabel, useWatchToggle } from './pe-shared.js';
import { serviceColor } from './charts/index.js';
import { FinderSummaryStrip } from './FinderSummaryStrip.js';
import { FinderCatalogTable } from './FinderCatalogTable.js';
import { FinderWatchlist } from './FinderWatchlist.js';
import { PeAlertEmailControl } from './PeAlertEmailControl.js';
import { CapabilityFinder } from './CapabilityFinder.js';
import { MovementView } from './MovementView.js';
import { MoneyGraphView } from './MoneyGraphView.js';
import './program-elements-redesign.css';

const PAGE_SIZE = 50;
const FACET_LINE_TYPES = ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI'] as const;
const OPEN_ACTION_STATUSES = new Set(['dismissed', 'archived']);

type PrimaryTab = 'explore' | 'movement' | 'actions' | 'watch';
type SearchMode = 'code' | 'capability';
type MovementMode = 'feed' | 'graph';

function initialPrimaryTab(value: string | null): PrimaryTab {
  if (value === 'movement' || value === 'actions' || value === 'watch') return value;
  return 'explore';
}

export function ProgramElementFinderPage() {
  const api = useApi();
  const navigate = useNavigate();
  const me = useMe();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState<PrimaryTab>(() =>
    initialPrimaryTab(searchParams.get('tab') ?? searchParams.get('view')),
  );
  const [searchMode, setSearchMode] = useState<SearchMode>(() =>
    searchParams.get('mode') === 'capability' ? 'capability' : 'code',
  );
  const [movementMode, setMovementMode] = useState<MovementMode>(() =>
    searchParams.get('movement') === 'graph' ? 'graph' : 'feed',
  );
  const [term, setTerm] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [lineType, setLineType] = useState<string | null>(null);
  const [capabilitySlug, setCapabilitySlug] = useState<string | null>(null);
  const [capabilityQuery, setCapabilityQuery] = useState<string | null>(null);
  const [hasDataOnly, setHasDataOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const q = term.trim();
  const watch = useWatchToggle();
  const busyCode = watch.isPending ? (watch.variables?.peCode ?? null) : null;

  const onOpen = (peCode: string) => navigate(`/program-elements/${encodeURIComponent(peCode)}`);
  const onToggleWatch = (row: ProgramElementListItem) =>
    watch.mutate({ peCode: row.peCode, watching: !row.watched });

  const withPageReset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  const selectTab = (next: PrimaryTab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'explore') params.delete('tab');
    else params.set('tab', next);
    params.delete('view');
    setSearchParams(params, { replace: true });
  };

  const selectSearchMode = (next: SearchMode) => {
    setSearchMode(next);
    setTerm('');
    setCapabilitySlug(null);
    setCapabilityQuery(null);
    const params = new URLSearchParams(searchParams);
    if (next === 'code') params.delete('mode');
    else params.set('mode', next);
    setSearchParams(params, { replace: true });
  };

  const selectMovementMode = (next: MovementMode) => {
    setMovementMode(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'feed') params.delete('movement');
    else params.set('movement', next);
    setSearchParams(params, { replace: true });
  };

  const summaryQuery = useQuery({
    queryKey: ['program-element-summary', hasDataOnly],
    queryFn: () => getProgramElementSummary(api, { has_data: hasDataOnly ? 'true' : undefined }),
    staleTime: 60 * 1000,
  });

  const listQuery = useQuery({
    queryKey: ['program-element-finder', 'index', q, service, lineType, hasDataOnly, page],
    queryFn: () =>
      getProgramElementsList(api, {
        q: q || undefined,
        service: service || undefined,
        line_type: lineType || undefined,
        has_data: hasDataOnly ? 'true' : undefined,
        page,
        limit: PAGE_SIZE,
      }),
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: tab === 'explore' && searchMode === 'code',
  });

  const capabilitiesQuery = useQuery({
    queryKey: ['budget-lines-capabilities'],
    queryFn: () => getCapabilities(api),
    staleTime: 5 * 60 * 1000,
  });

  const openCapability = (slug: string) => {
    setCapabilitySlug(slug);
    setCapabilityQuery(null);
    const capability = (capabilitiesQuery.data ?? []).find((item) => item.slug === slug);
    setTerm(capability?.name.split(' / ')[0] ?? '');
  };

  const submitCapabilitySearch = () => {
    const needle = q.toLowerCase();
    if (!needle) return;
    const hit = (capabilitiesQuery.data ?? []).find(
      (capability) =>
        capability.name.toLowerCase().includes(needle) ||
        capability.aliases.some((alias) => alias.toLowerCase().includes(needle)),
    );
    if (hit) {
      openCapability(hit.slug);
      return;
    }
    setCapabilitySlug(null);
    setCapabilityQuery(q);
  };

  const watchedQuery = useQuery({
    queryKey: ['program-element-finder', 'watch', service],
    queryFn: () =>
      getProgramElementsList(api, {
        watched: 'true',
        service: service || undefined,
        limit: 100,
      }),
    staleTime: 30 * 1000,
    enabled: tab === 'watch',
  });

  const watchedRows = watchedQuery.data?.data ?? [];
  const watchedCodes = useMemo(() => watchedRows.map((row) => row.peCode), [watchedRows]);

  const feedQuery = useQuery({
    queryKey: ['program-element-watchlist', 'feed', watchedCodes.join(',')],
    queryFn: () => getProgramElementWatchlistFeed(api, watchedCodes),
    staleTime: 60 * 1000,
    enabled: tab === 'watch' && watchedCodes.length > 0,
  });

  const watchSignalsQuery = useQuery({
    queryKey: ['budget-lines-watch-signals'],
    queryFn: () => getWatchSignals(api),
    staleTime: 60 * 1000,
    enabled: tab === 'watch',
  });

  const actionsQuery = useActionsList({ page: 1, limit: 100 });
  const openActionCount = useMemo(
    () =>
      (actionsQuery.data?.data ?? []).filter((action) => !OPEN_ACTION_STATUSES.has(action.status))
        .length,
    [actionsQuery.data],
  );

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const watchingCount = summaryQuery.data?.watched ?? watchedRows.length;
  const isAdmin = me.data?.role === 'capiro_admin' || me.data?.role === 'user_admin';
  const serviceFacets = useMemo(
    () =>
      (summaryQuery.data?.byService ?? [])
        .filter((item): item is { service: string; count: number } => Boolean(item.service))
        .map((item) => ({
          code: item.service.toUpperCase(),
          label: serviceLabel(item.service),
          count: item.count,
          color: serviceColor(item.service),
        }))
        .sort((left, right) => right.count - left.count),
    [summaryQuery.data?.byService],
  );
  const commonCapabilities = (capabilitiesQuery.data ?? []).slice(0, 5);

  return (
    <section className="pe-finder pe-redesign redesign">
      <header className="pe-rd-page-head">
        <div className="pe-rd-page-copy">
          <h1>Program elements</h1>
          <p>
            Every RDT&amp;E program element, procurement BLIN and O&amp;M line, with the
            money that moved and what to do about it.
          </p>
        </div>
        <div className="pe-rd-page-actions">
          {isAdmin ? (
            <button type="button" className="pe-rd-btn" onClick={() => navigate('/program-elements/contacts')}>
              {me.data?.role === 'capiro_admin' ? 'Contact queue' : 'Suggest a contact'}
            </button>
          ) : null}
          <button
            type="button"
            className="pe-rd-btn"
            onClick={() => navigate('/program-elements/mark-up-monitor')}
          >
            Mark-up monitor
          </button>
          <button
            type="button"
            className="pe-rd-btn pe-rd-btn-primary"
            onClick={() => navigate('/clients?section=program-elements')}
          >
            Monitored · {watchingCount}
          </button>
        </div>
      </header>

      <nav className="pe-rd-tabs" aria-label="Program element views">
        {(['explore', 'movement', 'actions'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? 'is-active' : ''}
            onClick={() => selectTab(item)}
          >
            {item === 'explore' ? 'Explore' : item === 'movement' ? 'Movement' : 'Actions'}
            {item === 'actions' && openActionCount > 0 ? (
              <span className="pe-rd-tab-count">{openActionCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === 'explore' ? (
        <>
          <div className="pe-rd-search-card">
            <div className="pe-rd-search-row">
              <div className="pe-rd-segment" aria-label="Search mode">
                <button
                  type="button"
                  className={searchMode === 'code' ? 'is-active' : ''}
                  onClick={() => selectSearchMode('code')}
                >
                  Code or title
                </button>
                <button
                  type="button"
                  className={searchMode === 'capability' ? 'is-active' : ''}
                  onClick={() => selectSearchMode('capability')}
                >
                  Capability
                </button>
              </div>
              <label className="pe-rd-search-input">
                <SearchOutlined aria-hidden="true" />
                <input
                  value={term}
                  onChange={(event) => {
                    withPageReset(() => setTerm(event.target.value));
                    if (searchMode === 'capability') {
                      setCapabilitySlug(null);
                      setCapabilityQuery(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && searchMode === 'capability') {
                      event.preventDefault();
                      submitCapabilitySearch();
                    }
                  }}
                  placeholder={
                    searchMode === 'capability'
                      ? 'Describe a capability — e.g. counter-UAS, undersea sensing'
                      : 'Search code or title — e.g. 0603270A, electronic warfare'
                  }
                  aria-label={searchMode === 'capability' ? 'Search by capability' : 'Search code or title'}
                />
              </label>
            </div>

            <div className="pe-rd-facet-row">
              <span className="pe-rd-facet-label">
                {searchMode === 'capability' ? 'Common capabilities' : 'Service'}
              </span>
              {searchMode === 'capability'
                ? commonCapabilities.map((capability) => {
                    const active = capabilitySlug === capability.slug;
                    return (
                      <button
                        key={capability.slug}
                        type="button"
                        className={`pe-rd-facet${active ? ' is-active' : ''}`}
                        onClick={() => {
                          if (active) {
                            setCapabilitySlug(null);
                            setCapabilityQuery(null);
                            setTerm('');
                          } else {
                            openCapability(capability.slug);
                          }
                        }}
                      >
                        {capability.name.split(' / ')[0]}
                      </button>
                    );
                  })
                : serviceFacets.map((facet) => {
                    const active = service?.toUpperCase() === facet.code;
                    return (
                      <button
                        key={facet.code}
                        type="button"
                        className={`pe-rd-facet${active ? ' is-active' : ''}`}
                        onClick={() =>
                          withPageReset(() => setService(active ? null : facet.code))
                        }
                      >
                        <span className="pe-rd-facet-dot" style={{ background: facet.color }} />
                        {facet.label}
                      </button>
                    );
                  })}
              <button
                type="button"
                className={`pe-rd-more${advancedOpen ? ' is-active' : ''}`}
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
              >
                More filters
              </button>
            </div>

            {advancedOpen ? (
              <div className="pe-rd-advanced">
                <div className="pe-rd-advanced-group">
                  <span>Line type</span>
                  <button
                    type="button"
                    className={!lineType ? 'is-active' : ''}
                    onClick={() => withPageReset(() => setLineType(null))}
                  >
                    All
                  </button>
                  {FACET_LINE_TYPES.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className={lineType === key ? 'is-active' : ''}
                      onClick={() => withPageReset(() => setLineType(lineType === key ? null : key))}
                    >
                      <span style={{ background: LINE_TYPES[key]!.color }} />
                      {LINE_TYPES[key]!.short}
                    </button>
                  ))}
                </div>
                <Tooltip title="Hide program elements with no FY history, awards, or linked bills yet.">
                  <label className="pe-rd-data-toggle">
                    <Switch
                      size="small"
                      checked={hasDataOnly}
                      onChange={(checked) => withPageReset(() => setHasDataOnly(checked))}
                    />
                    Has data
                  </label>
                </Tooltip>
                <button type="button" className="pe-rd-monitoring-link" onClick={() => selectTab('watch')}>
                  Monitoring tools
                </button>
              </div>
            ) : null}
          </div>

          <FinderSummaryStrip
            summary={summaryQuery.data}
            loading={summaryQuery.isLoading}
            actionCount={openActionCount}
            actionsLoading={actionsQuery.isLoading}
            onOpenPortfolio={() => navigate('/clients?section=program-elements')}
            onOpenMovement={() => selectTab('movement')}
            onOpenActions={() => selectTab('actions')}
          />

          {searchMode === 'capability' ? (
            <CapabilityFinder
              key={capabilityQuery ?? capabilitySlug ?? 'capability-default'}
              initialSlug={capabilitySlug}
              initialQuery={capabilityQuery}
              onOpen={onOpen}
            />
          ) : (
            <div className="pe-rd-results-card">
              <div className="pe-rd-results-head">
                <h3>Budget lines</h3>
                {!listQuery.isError ? (
                  <span className="pe-rd-results-count">
                    {total.toLocaleString()} shown
                    {total > PAGE_SIZE ? ` · page ${page} of ${Math.ceil(total / PAGE_SIZE)}` : ''}
                  </span>
                ) : null}
                {service ? (
                  <button
                    type="button"
                    className="pe-rd-filter-chip"
                    onClick={() => withPageReset(() => setService(null))}
                  >
                    {serviceLabel(service)} <CloseOutlined />
                  </button>
                ) : null}
                {lineType ? (
                  <button
                    type="button"
                    className="pe-rd-filter-chip"
                    onClick={() => withPageReset(() => setLineType(null))}
                  >
                    {LINE_TYPES[lineType]?.short ?? lineType} <CloseOutlined />
                  </button>
                ) : null}
              </div>

              {listQuery.isError ? (
                <div className="pe-rd-alert-wrap">
                  <Alert
                    type="error"
                    showIcon
                    message="Unable to load budget lines"
                    description={
                      listQuery.error instanceof Error
                        ? listQuery.error.message
                        : 'Please retry in a moment.'
                    }
                  />
                </div>
              ) : (
                <FinderCatalogTable
                  rows={rows}
                  loading={listQuery.isLoading}
                  onOpen={onOpen}
                  onToggleWatch={onToggleWatch}
                  watchBusyCode={busyCode}
                />
              )}

              {total > PAGE_SIZE ? (
                <div className="pe-rd-pagination">
                  <Pagination
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={total}
                    showSizeChanger={false}
                    onChange={(next) => setPage(next)}
                    showTotal={(count, range) =>
                      `${range[0]}-${range[1]} of ${count.toLocaleString()}`
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : tab === 'movement' ? (
        <div className="pe-rd-movement">
          <div className="pe-rd-movement-toolbar">
            <div className="pe-rd-segment">
              <button
                type="button"
                className={movementMode === 'feed' ? 'is-active' : ''}
                onClick={() => selectMovementMode('feed')}
              >
                Signal feed
              </button>
              <button
                type="button"
                className={movementMode === 'graph' ? 'is-active' : ''}
                onClick={() => selectMovementMode('graph')}
              >
                Money graph
              </button>
            </div>
            <span>
              Current cycle · President&apos;s Budget → committee marks → enacted
            </span>
          </div>
          {movementMode === 'feed' ? <MovementView onOpen={onOpen} /> : <MoneyGraphView onOpen={onOpen} />}
        </div>
      ) : tab === 'actions' ? (
        <div className="pe-rd-actions-embed">
          <ActionBoardPage />
        </div>
      ) : (
        <div className="pe-rd-monitoring-tools">
          <div className="pe-rd-monitoring-head">
            <div>
              <h2>Monitoring tools</h2>
              <p>
                Monitored program elements now live in Portfolio. This utility view preserves the
                existing signal feed and email controls.
              </p>
            </div>
            <button type="button" className="pe-rd-btn" onClick={() => selectTab('explore')}>
              Back to Explore
            </button>
          </div>
          {(watchSignalsQuery.data?.length ?? 0) > 0 ? (
            <div className="pe-idx-card bl-watch-signals">
              <div className="pe-idx-card-head">
                <h3>Budget-action signals</h3>
                <span className="pe-idx-count">normalized committee events on monitored lines</span>
              </div>
              <div className="bl-panel-body">
                <div className="bl-mv-feed">
                  {(watchSignalsQuery.data ?? []).slice(0, 8).map((signal) => (
                    <div key={signal.id} className="bl-mv-row" onClick={() => onOpen(signal.peCode)}>
                      <div className="bl-mv-main">
                        <div className="bl-mv-t">
                          {signal.title}{' '}
                          <span className="bl-stage-chip">{signal.stage.replace('_', '-')}</span>
                        </div>
                        {signal.note ? <div className="bl-mv-why">{signal.note}</div> : null}
                        <div className="bl-mv-meta">
                          <span className="pe-code-badge sm">{signal.peCode}</span>
                          <span className="pe-dot-sep">·</span>FY{signal.fy}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {watchedQuery.isError ? (
            <Alert type="error" showIcon message="Unable to load your monitored lines" />
          ) : (
            <FinderWatchlist
              watchedRows={watchedRows}
              watchingCount={watchingCount}
              feed={feedQuery.data ?? []}
              loading={watchedQuery.isLoading}
              feedLoading={feedQuery.isLoading && watchedCodes.length > 0}
              onOpen={onOpen}
              onToggleWatch={onToggleWatch}
              watchBusyCode={busyCode}
            />
          )}
          <div className="pe-rd-alert-control">
            <PeAlertEmailControl />
          </div>
          <Typography.Paragraph type="secondary" className="pe-watchlist-foot">
            Signals are drawn from your intelligence change feed, scoped to the program elements
            you monitor. Email alerts deliver the same signals as a daily digest.
          </Typography.Paragraph>
        </div>
      )}
    </section>
  );
}
