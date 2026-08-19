/**
 * Data Explorer vNext — congressional sources: Congress Bills, Hearings,
 * GAO Reports, CRS Reports. Query keys/endpoints/params/copy verbatim from
 * the canonical DataExplorerPage explorers.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  BillFacets,
  CrsFacets,
  ExplorerBillRow,
  ExplorerCrsRow,
  ExplorerGaoRow,
  ExplorerHearingRow,
  ExplorerResponse,
  GaoFacets,
  HearingFacets,
} from '../../../pages/explorer/explorerTypes.js';
import {
  XpFilterBar,
  XpMultiSelect,
  XpSelect,
  XpSortControl,
  XpToggleChip,
} from './explorer-controls.js';
import { ChipList, MonoTag, XpTable } from './explorer-table.js';
import { formatDate, PAGE_SIZE, partyName } from './explorer-format.js';

/* ── Congress Bills ─────────────────────────────────────────────────────── */

export function BillsExplorer({
  onRowClick,
}: {
  onRowClick: (id: string, row: ExplorerBillRow) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [congress, setCongress] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [parties, setParties] = useState<string[]>([]);
  const [chambers, setChambers] = useState<string[]>([]);
  const [sort, setSort] = useState('action');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [q, congress, subjects, parties, chambers, sort]);

  const facets = useQuery<BillFacets>({
    queryKey: ['explorer-bill-facets'],
    queryFn: async () => (await api.get<BillFacets>('/api/explorer/bill-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const rowsQuery = useQuery<ExplorerResponse<ExplorerBillRow>>({
    queryKey: ['explorer-bills', q, congress, subjects, parties, chambers, sort, page],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<ExplorerBillRow>>('/api/explorer/congress-bills', {
          params: {
            q: q || undefined,
            congress: congress.length ? congress.join(',') : undefined,
            subjects: subjects.length ? subjects.join(',') : undefined,
            sponsorParty: parties.length ? parties.join(',') : undefined,
            originChamber: chambers.length ? chambers.join(',') : undefined,
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
        searchPlaceholder="Search bill title or sponsor…"
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
              label="Congress"
              placeholder="Any"
              options={(facets.data?.congresses ?? []).map((c) => ({
                value: String(c),
                label: `${c}th`,
              }))}
              values={congress}
              onChange={setCongress}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Chamber"
              placeholder="Any"
              options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c }))}
              values={chambers}
              onChange={setChambers}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Party"
              placeholder="Any"
              options={(facets.data?.parties ?? []).map((p) => ({ value: p, label: partyName(p) }))}
              values={parties}
              onChange={setParties}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Subject"
              placeholder="Any subject"
              options={(facets.data?.subjects ?? []).map((s) => ({ value: s, label: s }))}
              values={subjects}
              onChange={setSubjects}
              loading={facets.isLoading}
            />
            <XpSortControl
              value={sort}
              onChange={setSort}
              options={[
                { value: 'action', label: 'Latest action' },
                { value: 'introduced', label: 'Recently introduced' },
                { value: 'cosponsors', label: 'Most cosponsors' },
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
          {
            title: 'Bill',
            dataIndex: 'billType',
            width: 110,
            render: (_: unknown, r: ExplorerBillRow) => (
              <span className="xp-num xp-w600">
                {r.billType} {r.billNumber}
              </span>
            ),
          },
          { title: 'Title', dataIndex: 'title', ellipsis: true },
          {
            title: 'Sponsor',
            dataIndex: 'sponsorName',
            width: 200,
            render: (name: string | null, r: ExplorerBillRow) =>
              name ? (
                <span>
                  {name}
                  {r.sponsorParty ? (
                    <span className={`xp-party-pill xp-party-pill--${r.sponsorParty.toLowerCase()}`}>
                      {r.sponsorParty}
                    </span>
                  ) : null}
                </span>
              ) : (
                '-'
              ),
          },
          {
            title: 'Cosponsors',
            dataIndex: 'cosponsorsCount',
            width: 100,
            align: 'right' as const,
            render: (v: number) => <span className="xp-num">{v}</span>,
          },
          {
            title: 'Latest action',
            dataIndex: 'latestActionText',
            ellipsis: true,
            render: (text: string | null, r: ExplorerBillRow) => (
              <span className="xp-stack">
                <span className="xp-stack__main">{text ?? '-'}</span>
                {r.latestActionDate ? (
                  <span className="xp-num xp-stack__sub">{formatDate(r.latestActionDate)}</span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </>
  );
}

/* ── Committee hearings ─────────────────────────────────────────────────── */

export function HearingsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerHearingRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [chambers, setChambers] = useState<string[]>([]);
  const [committees, setCommittees] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [dateFilter, setDateFilter] = useState<'upcoming' | 'past' | 'all'>('upcoming');
  const [sort, setSort] = useState('soonest');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, chambers, committees, types, dateFilter, sort]);

  const facets = useQuery<HearingFacets>({
    queryKey: ['explorer-hearing-facets'],
    queryFn: async () => (await api.get<HearingFacets>('/api/explorer/hearing-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerHearingRow>>({
    queryKey: ['explorer-hearings', q, chambers, committees, types, dateFilter, sort, page],
    queryFn: async () =>
      (await api.get<ExplorerResponse<ExplorerHearingRow>>('/api/explorer/hearings', {
        params: {
          q: q || undefined,
          chambers: chambers.length ? chambers.join(',') : undefined,
          committees: committees.length ? committees.join(',') : undefined,
          types: types.length ? types.join(',') : undefined,
          dateFilter,
          sort,
          page,
          pageSize: PAGE_SIZE,
        },
      })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search hearing title, committee, or location…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpSelect
              label="When"
              value={dateFilter}
              onChange={(v) => setDateFilter(v as 'upcoming' | 'past' | 'all')}
              options={[
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'past', label: 'Past' },
                { value: 'all', label: 'All dates' },
              ]}
            />
            <XpMultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
            <XpMultiSelect label="Committee" placeholder="Any" options={(facets.data?.committees ?? []).map((c) => ({ value: c, label: c }))} values={committees} onChange={setCommittees} loading={facets.isLoading} />
            <XpMultiSelect label="Type" placeholder="Any" options={(facets.data?.types ?? []).map((t) => ({ value: t, label: t }))} values={types} onChange={setTypes} loading={facets.isLoading} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'soonest', label: 'Soonest first' },
              { value: 'recent', label: 'Most recent first' },
            ]} />
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
          { title: 'Date', dataIndex: 'date', width: 120, render: (d: string, r: ExplorerHearingRow) => <span className="xp-num">{formatDate(d)}{r.time ? ` · ${r.time}` : ''}</span> },
          { title: 'Chamber', dataIndex: 'chamber', width: 90 },
          { title: 'Committee', dataIndex: 'committeeName', ellipsis: true },
          { title: 'Title', dataIndex: 'title', ellipsis: true },
          { title: 'Type', dataIndex: 'type', width: 100, render: (t: string | null) => (t ? <MonoTag>{t}</MonoTag> : '-') },
          { title: 'Witnesses', dataIndex: 'witnesses', width: 100, align: 'right' as const, render: (w: string[]) => <span className="xp-num">{w.length}</span> },
        ]}
      />
    </>
  );
}

/* ── GAO reports ────────────────────────────────────────────────────────── */

export function GaoExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerGaoRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [reportTypes, setReportTypes] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, reportTypes, topics, agencies, sort]);

  const facets = useQuery<GaoFacets>({
    queryKey: ['explorer-gao-facets'],
    queryFn: async () => (await api.get<GaoFacets>('/api/explorer/gao-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerGaoRow>>({
    queryKey: ['explorer-gao', q, reportTypes, topics, agencies, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerGaoRow>>('/api/explorer/gao', {
      params: { q: q || undefined, reportTypes: reportTypes.length ? reportTypes.join(',') : undefined, topics: topics.length ? topics.join(',') : undefined, agencies: agencies.length ? agencies.join(',') : undefined, sort, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search GAO report title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Type" placeholder="Any" options={(facets.data?.reportTypes ?? []).map((t) => ({ value: t, label: t }))} values={reportTypes} onChange={setReportTypes} loading={facets.isLoading} />
            <XpMultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <XpMultiSelect label="Agency" placeholder="Any agency" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Most recent' },
              { value: 'recs', label: 'Most recommendations' },
            ]} />
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
          { title: 'Report #', dataIndex: 'id', width: 150, render: (id: string) => <span className="xp-num xp-mono-sm">{id}</span> },
          { title: 'Type', dataIndex: 'reportType', width: 130, render: (t: string | null) => (t ? <MonoTag>{t}</MonoTag> : '-') },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (title: string, r: ExplorerGaoRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{title}</a> : title) },
          { title: 'Topics', dataIndex: 'topics', width: 220, render: (topics: string[]) => <ChipList items={topics} max={3} /> },
          { title: 'Recs', dataIndex: 'recommendations', width: 70, align: 'right' as const, render: (n: number | null) => <span className="xp-num">{n ?? '-'}</span> },
          { title: 'Date', dataIndex: 'publishDate', width: 110, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── CRS reports ────────────────────────────────────────────────────────── */

export function CrsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerCrsRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, topics, activeOnly]);

  const facets = useQuery<CrsFacets>({
    queryKey: ['explorer-crs-facets'],
    queryFn: async () => (await api.get<CrsFacets>('/api/explorer/crs-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerCrsRow>>({
    queryKey: ['explorer-crs', q, topics, activeOnly, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerCrsRow>>('/api/explorer/crs', {
      params: { q: q || undefined, topics: topics.length ? topics.join(',') : undefined, activeOnly: activeOnly ? true : undefined, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search CRS title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <XpToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
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
          { title: 'Report #', dataIndex: 'id', width: 100, render: (id: string) => <span className="xp-num xp-mono-sm">{id}</span> },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (title: string, r: ExplorerCrsRow) => (r.htmlUrl ? <a href={r.htmlUrl} target="_blank" rel="noreferrer">{title}</a> : title) },
          { title: 'Topics', dataIndex: 'topics', width: 220, render: (t: string[]) => <ChipList items={t} max={3} /> },
          { title: 'Authors', dataIndex: 'authors', width: 140, render: (a: string[]) => (a.length ? a.slice(0, 1).join(', ') + (a.length > 1 ? ` +${a.length - 1}` : '') : '-') },
          { title: 'Date', dataIndex: 'date', width: 110, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
        ]}
      />
    </>
  );
}
