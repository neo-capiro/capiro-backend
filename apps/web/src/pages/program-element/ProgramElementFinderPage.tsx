import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Alert, Button, Input, Pagination, Segmented, Switch, Tooltip, Typography } from 'antd';
import { CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import {
  getCapabilities,
  getProgramElementSummary,
  getProgramElementWatchlistFeed,
  getProgramElementsList,
  getWatchSignals,
} from './api.js';
import type { ProgramElementListItem } from './types.js';
import { LINE_TYPES, serviceLabel, useWatchToggle } from './pe-shared.js';
import { FinderSummaryStrip } from './FinderSummaryStrip.js';
import { FinderCatalogTable } from './FinderCatalogTable.js';
import { FinderWatchlist } from './FinderWatchlist.js';
import { PeAlertEmailControl } from './PeAlertEmailControl.js';
import { CapabilityFinder, CapabilityHero } from './CapabilityFinder.js';
import { MovementView } from './MovementView.js';
import { MoneyGraphView } from './MoneyGraphView.js';

const PAGE_SIZE = 50;

// Line types shown on the facet strip. Reserved types (MILCON/TRANSFER/
// CLASSIFIED) appear automatically once their ingests land — the strip only
// renders types with live rows, so nothing fake shows meanwhile.
const FACET_LINE_TYPES = ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI'] as const;

export function ProgramElementFinderPage() {
  const api = useApi();
  const navigate = useNavigate();
  const me = useMe();

  const [view, setView] = useState<'index' | 'capability' | 'movement' | 'graph' | 'watch'>(
    'index',
  );
  const [term, setTerm] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [lineType, setLineType] = useState<string | null>(null);
  const [capabilitySlug, setCapabilitySlug] = useState<string | null>(null);
  const [capabilityQuery, setCapabilityQuery] = useState<string | null>(null);
  const [hasDataOnly, setHasDataOnly] = useState(false);
  const [page, setPage] = useState(1);

  const q = term.trim();
  const watch = useWatchToggle();
  const busyCode = watch.isPending ? (watch.variables?.peCode ?? null) : null;

  const onOpen = (peCode: string) => navigate(`/program-elements/${encodeURIComponent(peCode)}`);
  const onToggleWatch = (row: ProgramElementListItem) =>
    watch.mutate({ peCode: row.peCode, watching: !row.watched });

  // Reset to page 1 whenever a filter changes so we never sit on an out-of-range page.
  const withPageReset = (fn: () => void) => {
    fn();
    setPage(1);
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
    enabled: view === 'index',
  });

  // Capability taxonomy (F4). Also powers the catalog hero; empty until seeded.
  const capabilitiesQuery = useQuery({
    queryKey: ['budget-lines-capabilities'],
    queryFn: () => getCapabilities(api),
    staleTime: 5 * 60 * 1000,
  });
  const openCapability = (slug: string) => {
    setCapabilitySlug(slug);
    setCapabilityQuery(null);
    setView('capability');
  };
  // Hero free-text that matched no curated capability → semantic-search mode.
  const openCapabilitySearch = (query: string) => {
    setCapabilitySlug(null);
    setCapabilityQuery(query);
    setView('capability');
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
    enabled: view === 'watch',
  });

  const watchedRows = watchedQuery.data?.data ?? [];
  const watchedCodes = useMemo(() => watchedRows.map((r) => r.peCode), [watchedRows]);

  const feedQuery = useQuery({
    queryKey: ['program-element-watchlist', 'feed', watchedCodes.join(',')],
    queryFn: () => getProgramElementWatchlistFeed(api, watchedCodes),
    staleTime: 60 * 1000,
    enabled: view === 'watch' && watchedCodes.length > 0,
  });

  // BL-3: normalized budget actions on watched lines (the money-graph signal
  // feed — committee adds/cuts/new starts/terminations, not just delta events).
  const watchSignalsQuery = useQuery({
    queryKey: ['budget-lines-watch-signals'],
    queryFn: () => getWatchSignals(api),
    staleTime: 60 * 1000,
    enabled: view === 'watch',
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const watchingCount = summaryQuery.data?.watched ?? watchedRows.length;
  const isAdmin = me.data?.role === 'capiro_admin' || me.data?.role === 'user_admin';

  return (
    <section className="pe-finder">
      <header className="pe-finder-head">
        <div className="pe-finder-head-l">
          <h1>Budget Lines</h1>
          <p className="pe-finder-sub">
            Every RDT&amp;E program element, procurement BLIN, and O&amp;M budget line — one
            navigable, sourced graph across the President&apos;s Budget, committee marks, and
            enacted appropriations.
          </p>
        </div>
        <div className="pe-finder-head-actions">
          {isAdmin ? (
            <Button onClick={() => navigate('/program-elements/contacts')}>
              {me.data?.role === 'capiro_admin' ? 'Contact Review Queue' : 'Suggest a Contact'}
            </Button>
          ) : null}
          <Button type="primary" onClick={() => navigate('/program-elements/mark-up-monitor')}>
            Mark-up Monitor
          </Button>
        </div>
      </header>

      <Segmented
        className="pe-finder-tabs"
        value={view}
        onChange={(value) =>
          setView(value as 'index' | 'capability' | 'movement' | 'graph' | 'watch')
        }
        options={[
          { label: 'Budget lines', value: 'index' },
          { label: 'Capability finder', value: 'capability' },
          { label: 'Movement', value: 'movement' },
          { label: 'Money graph', value: 'graph' },
          { label: `Watchlist · ${watchingCount}`, value: 'watch' },
        ]}
      />

      {view === 'capability' ? (
        <CapabilityFinder
          key={capabilityQuery ?? capabilitySlug ?? 'default'}
          initialSlug={capabilitySlug}
          initialQuery={capabilityQuery}
          onOpen={onOpen}
        />
      ) : view === 'movement' ? (
        <MovementView onOpen={onOpen} />
      ) : view === 'graph' ? (
        <MoneyGraphView onOpen={onOpen} />
      ) : view === 'index' ? (
        <>
          <CapabilityHero
            capabilities={capabilitiesQuery.data ?? []}
            loading={capabilitiesQuery.isLoading}
            onFind={openCapability}
            onSearch={openCapabilitySearch}
          />
          <FinderSummaryStrip
            summary={summaryQuery.data}
            loading={summaryQuery.isLoading}
            serviceFilter={service}
            onServiceFilter={(code) => withPageReset(() => setService(code))}
          />

          <div className="pe-idx-card">
            <div className="pe-idx-card-head">
              <h3>All budget lines</h3>
              {!listQuery.isError ? (
                <span className="pe-idx-count">
                  {total.toLocaleString()} shown
                  {total > PAGE_SIZE ? ` · page ${page} of ${Math.ceil(total / PAGE_SIZE)}` : ''}
                </span>
              ) : null}
              {service ? (
                <button
                  type="button"
                  className="pe-filter-chip"
                  onClick={() => withPageReset(() => setService(null))}
                >
                  {serviceLabel(service)} <CloseOutlined />
                </button>
              ) : null}
              {lineType ? (
                <button
                  type="button"
                  className="pe-filter-chip"
                  onClick={() => withPageReset(() => setLineType(null))}
                >
                  {LINE_TYPES[lineType]?.short ?? lineType} <CloseOutlined />
                </button>
              ) : null}
              <div className="pe-idx-head-controls">
                <Tooltip title="Hide program elements with no FY history, awards, or linked bills yet.">
                  <span className="pe-hasdata-toggle">
                    <Switch
                      size="small"
                      checked={hasDataOnly}
                      onChange={(checked) => withPageReset(() => setHasDataOnly(checked))}
                    />
                    <span>Has data</span>
                  </span>
                </Tooltip>
                <Input
                  className="pe-idx-search"
                  value={term}
                  onChange={(e) => withPageReset(() => setTerm(e.target.value))}
                  placeholder="Search code or title…"
                  prefix={<SearchOutlined />}
                  allowClear
                />
              </div>
            </div>

            {/* line_type facet strip (money-graph reframe). Types render even at
                zero count so users learn the model; reserved types stay hidden. */}
            <div className="pe-typebar">
              <button
                type="button"
                className={`pe-typebtn${!lineType ? ' on' : ''}`}
                onClick={() => withPageReset(() => setLineType(null))}
              >
                All types
              </button>
              {FACET_LINE_TYPES.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`pe-typebtn${lineType === k ? ' on' : ''}`}
                  onClick={() => withPageReset(() => setLineType(lineType === k ? null : k))}
                >
                  <span className="pe-tb-swatch" style={{ background: LINE_TYPES[k]!.color }} />
                  {LINE_TYPES[k]!.short}
                </button>
              ))}
            </div>

            {listQuery.isError ? (
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
              <div className="pe-idx-pagination">
                <Pagination
                  current={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  showSizeChanger={false}
                  onChange={(next) => setPage(next)}
                  showTotal={(t, range) => `${range[0]}-${range[1]} of ${t.toLocaleString()}`}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {(watchSignalsQuery.data?.length ?? 0) > 0 ? (
            <div className="pe-idx-card bl-watch-signals">
              <div className="pe-idx-card-head">
                <h3>Budget-action signals</h3>
                <span className="pe-idx-count">
                  normalized committee events on your watched lines
                </span>
              </div>
              <div className="bl-panel-body">
                <div className="bl-mv-feed">
                  {(watchSignalsQuery.data ?? []).slice(0, 8).map((s) => (
                    <div key={s.id} className="bl-mv-row" onClick={() => onOpen(s.peCode)}>
                      <div className="bl-mv-main">
                        <div className="bl-mv-t">
                          {s.title}{' '}
                          <span className="bl-stage-chip">{s.stage.replace('_', '-')}</span>
                        </div>
                        {s.note ? <div className="bl-mv-why">{s.note}</div> : null}
                        <div className="bl-mv-meta">
                          <span className="pe-code-badge sm">{s.peCode}</span>
                          <span className="pe-dot-sep">·</span>FY{s.fy}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
          {watchedQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="Unable to load your watchlist"
              description="Please retry in a moment."
            />
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
          <div style={{ marginTop: 12 }}>
            <PeAlertEmailControl />
          </div>
          <Typography.Paragraph type="secondary" className="pe-watchlist-foot">
            Signals are drawn from your intelligence change feed, scoped to the program elements you
            watch. Email alerts deliver the same signals as a daily digest.
          </Typography.Paragraph>
        </>
      )}
    </section>
  );
}
