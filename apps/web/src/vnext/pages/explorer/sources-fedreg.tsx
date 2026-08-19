/**
 * Data Explorer vNext — Federal Register sources: the full document explorer
 * and the Comment Deadlines preset (same endpoint, `openCommentOnly: true`,
 * pinned `sort: 'comment-close'`, its own query key). Verbatim port.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  ExplorerFedRegRow,
  ExplorerResponse,
  FedRegFacets,
} from '../../../pages/explorer/explorerTypes.js';
import {
  XpFilterBar,
  XpMultiSelect,
  XpSortControl,
  XpToggleChip,
} from './explorer-controls.js';
import { MonoTag, PlainTag, XpTable } from './explorer-table.js';
import { formatDate, PAGE_SIZE } from './explorer-format.js';

function commentDaysPill(d: string, closedLabel: string): { sev: 'critical' | 'notable' | 'info'; text: string } {
  const days = Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const sev: 'critical' | 'notable' | 'info' = days <= 3 ? 'critical' : days <= 14 ? 'notable' : 'info';
  return { sev, text: days <= 0 ? 'closed' : closedLabel.replace('{days}', String(days)) };
}

/* ── Federal Register Documents ─────────────────────────────────────────── */

export function FedRegExplorer({
  onRowClick,
}: {
  onRowClick: (id: string, row: ExplorerFedRegRow) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [significantOnly, setSignificantOnly] = useState(false);
  const [openCommentOnly, setOpenCommentOnly] = useState(true);
  const [sort, setSort] = useState('comment-close');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [q, types, agencies, topics, significantOnly, openCommentOnly, sort]);

  const facets = useQuery<FedRegFacets>({
    queryKey: ['explorer-fed-reg-facets'],
    queryFn: async () => (await api.get<FedRegFacets>('/api/explorer/fed-reg-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const rowsQuery = useQuery<ExplorerResponse<ExplorerFedRegRow>>({
    queryKey: ['explorer-fed-reg', q, types, agencies, topics, significantOnly, openCommentOnly, sort, page],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<ExplorerFedRegRow>>('/api/explorer/federal-register', {
          params: {
            q: q || undefined,
            types: types.length ? types.join(',') : undefined,
            agencies: agencies.length ? agencies.join(',') : undefined,
            topics: topics.length ? topics.join(',') : undefined,
            significantOnly: significantOnly ? true : undefined,
            openCommentOnly: openCommentOnly ? true : undefined,
            sort,
            page,
            pageSize: PAGE_SIZE,
          },
        })
      ).data,
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search title or abstract…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => {
          setSearchInput('');
          setQ('');
        }}
        controls={
          <>
            <XpMultiSelect
              label="Type"
              placeholder="Any"
              options={(facets.data?.types ?? []).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
              values={types}
              onChange={setTypes}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Agency"
              placeholder="Any agency"
              options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))}
              values={agencies}
              onChange={setAgencies}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Topic"
              placeholder="Any topic"
              options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))}
              values={topics}
              onChange={setTopics}
              loading={facets.isLoading}
            />
            <XpToggleChip
              label="Significant rules only"
              active={significantOnly}
              onToggle={() => setSignificantOnly((v) => !v)}
            />
            <XpToggleChip
              label="Comment period open"
              active={openCommentOnly}
              onToggle={() => setOpenCommentOnly((v) => !v)}
            />
            <XpSortControl
              value={sort}
              onChange={setSort}
              options={[
                { value: 'comment-close', label: 'Closing soonest' },
                { value: 'publication', label: 'Most recent' },
              ]}
            />
          </>
        }
      />

      <XpTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Type', dataIndex: 'type', width: 130, render: (t: string) => <MonoTag>{t.replace(/_/g, ' ')}</MonoTag> },
          {
            title: 'Title',
            dataIndex: 'title',
            ellipsis: true,
            render: (title: string, r: ExplorerFedRegRow) =>
              r.htmlUrl ? (
                <a href={r.htmlUrl} target="_blank" rel="noreferrer">
                  {title}
                </a>
              ) : (
                title
              ),
          },
          {
            title: 'Agency',
            dataIndex: 'agencyNames',
            width: 220,
            render: (agencies: string[]) => (
              <span>
                {agencies.slice(0, 1).join('')}
                {agencies.length > 1 ? <span className="xp-muted"> +{agencies.length - 1}</span> : null}
              </span>
            ),
          },
          {
            title: 'Comment closes',
            dataIndex: 'commentEndDate',
            width: 150,
            render: (d: string | null) => {
              if (!d) return <span className="xp-muted">-</span>;
              const { sev, text } = commentDaysPill(d, '{days}d');
              return (
                <span className="xp-num">
                  <span className={`xp-pill xp-pill--${sev}`}>{text}</span>
                  {formatDate(d)}
                </span>
              );
            },
          },
          {
            title: 'Significant',
            dataIndex: 'significantRule',
            width: 110,
            render: (b: boolean) => (b ? <PlainTag tone="warning">significant</PlainTag> : null),
          },
        ]}
      />
    </>
  );
}

/* ── Comment Deadlines (Federal Register, open-comment preset) ──────────── */

export function CommentDeadlinesExplorer({
  onRowClick,
}: {
  onRowClick: (id: string, row: ExplorerFedRegRow) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [agencies, setAgencies] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, agencies]);

  const facets = useQuery<FedRegFacets>({
    queryKey: ['explorer-fed-reg-facets'],
    queryFn: async () => (await api.get<FedRegFacets>('/api/explorer/fed-reg-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const rowsQuery = useQuery<ExplorerResponse<ExplorerFedRegRow>>({
    queryKey: ['explorer-comment-deadlines', q, agencies, page],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<ExplorerFedRegRow>>('/api/explorer/federal-register', {
          params: {
            q: q || undefined,
            agencies: agencies.length ? agencies.join(',') : undefined,
            openCommentOnly: true,
            sort: 'comment-close',
            page,
            pageSize: PAGE_SIZE,
          },
        })
      ).data,
    placeholderData: (previous) => previous,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search rule title or abstract…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => {
          setSearchInput('');
          setQ('');
        }}
        controls={
          <XpMultiSelect
            label="Agency"
            placeholder="Any agency"
            options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))}
            values={agencies}
            onChange={setAgencies}
            loading={facets.isLoading}
          />
        }
      />

      <XpTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          {
            title: 'Comment closes',
            dataIndex: 'commentEndDate',
            width: 170,
            render: (d: string | null) => {
              if (!d) return <span className="xp-muted">-</span>;
              const { sev, text } = commentDaysPill(d, '{days}d left');
              return (
                <span className="xp-num">
                  <span className={`xp-pill xp-pill--${sev}`}>{text}</span>
                  {formatDate(d)}
                </span>
              );
            },
          },
          {
            title: 'Title',
            dataIndex: 'title',
            ellipsis: true,
            render: (title: string, r: ExplorerFedRegRow) =>
              r.htmlUrl ? (
                <a href={r.htmlUrl} target="_blank" rel="noreferrer">
                  {title}
                </a>
              ) : (
                title
              ),
          },
          {
            title: 'Agency',
            dataIndex: 'agencyNames',
            width: 220,
            render: (a: string[]) => (
              <span>
                {a.slice(0, 1).join('')}
                {a.length > 1 ? <span className="xp-muted"> +{a.length - 1}</span> : null}
              </span>
            ),
          },
          {
            title: 'Type',
            dataIndex: 'type',
            width: 140,
            render: (t: string) => <MonoTag>{t.replace(/_/g, ' ')}</MonoTag>,
          },
        ]}
      />
    </>
  );
}
