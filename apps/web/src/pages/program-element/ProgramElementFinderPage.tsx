import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Alert, Button, Input, Pagination, Segmented, Switch, Tooltip, Typography } from 'antd';
import { CloseOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import {
  getProgramElementSummary,
  getProgramElementWatchlistFeed,
  getProgramElementsList,
} from './api.js';
import type { ProgramElementListItem } from './types.js';
import { serviceLabel, useWatchToggle } from './pe-shared.js';
import { FinderSummaryStrip } from './FinderSummaryStrip.js';
import { FinderCatalogTable } from './FinderCatalogTable.js';
import { FinderWatchlist } from './FinderWatchlist.js';

const PAGE_SIZE = 50;

export function ProgramElementFinderPage() {
  const api = useApi();
  const navigate = useNavigate();
  const me = useMe();

  const [view, setView] = useState<'index' | 'watch'>('index');
  const [term, setTerm] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [hasDataOnly, setHasDataOnly] = useState(false);
  const [page, setPage] = useState(1);

  const q = term.trim();
  const watch = useWatchToggle();
  const busyCode = watch.isPending ? watch.variables?.peCode ?? null : null;

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
    queryKey: ['program-element-finder', 'index', q, service, hasDataOnly, page],
    queryFn: () =>
      getProgramElementsList(api, {
        q: q || undefined,
        service: service || undefined,
        has_data: hasDataOnly ? 'true' : undefined,
        page,
        limit: PAGE_SIZE,
      }),
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
    enabled: view === 'index',
  });

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

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const watchingCount = summaryQuery.data?.watched ?? watchedRows.length;
  const isAdmin = me.data?.role === 'capiro_admin' || me.data?.role === 'user_admin';

  return (
    <section className="pe-finder">
      <header className="pe-finder-head">
        <div className="pe-finder-head-l">
          <h1>Program Elements</h1>
          <p className="pe-finder-sub">
            Budget line items you track across the President&apos;s Budget, committee marks, and
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
        onChange={(value) => setView(value as 'index' | 'watch')}
        options={[
          { label: 'All elements', value: 'index' },
          { label: `Watchlist · ${watchingCount}`, value: 'watch' },
        ]}
      />

      {view === 'index' ? (
        <>
          <FinderSummaryStrip
            summary={summaryQuery.data}
            loading={summaryQuery.isLoading}
            serviceFilter={service}
            onServiceFilter={(code) => withPageReset(() => setService(code))}
          />

          <div className="pe-idx-card">
            <div className="pe-idx-card-head">
              <h3>All program elements</h3>
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

            {listQuery.isError ? (
              <Alert
                type="error"
                showIcon
                message="Unable to load program elements"
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
          <Typography.Paragraph type="secondary" className="pe-watchlist-foot">
            Signals are drawn from your intelligence change feed, scoped to the program elements you
            watch.
          </Typography.Paragraph>
        </>
      )}
    </section>
  );
}
