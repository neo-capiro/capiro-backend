/**
 * Data Explorer vNext — state-level sources: State Bills (LegiScan) and
 * State Legislators (OpenStates). Verbatim port of the canonical explorers.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stateBillStatusLabel } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import type {
  ExplorerResponse,
  ExplorerStateBillRow,
  ExplorerStateLegislatorRow,
  StateBillFacets,
  StateLegislatorFacets,
} from '../../../pages/explorer/explorerTypes.js';
import { XpFilterBar, XpMultiSelect, XpToggleChip } from './explorer-controls.js';
import { MonoTag, PlainTag, XpTable } from './explorer-table.js';
import { formatDate, PAGE_SIZE } from './explorer-format.js';

/* ── State bills ────────────────────────────────────────────────────────── */

export function StateBillsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerStateBillRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [sponsorParty, setSponsorParty] = useState<string[]>([]);
  const [chambers, setChambers] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, states, subjects, sponsorParty, chambers]);

  const facets = useQuery<StateBillFacets>({
    queryKey: ['explorer-state-bill-facets'],
    queryFn: async () => (await api.get<StateBillFacets>('/api/explorer/state-bill-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerStateBillRow>>({
    queryKey: ['explorer-state-bills', q, states, subjects, sponsorParty, chambers, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerStateBillRow>>('/api/explorer/state-bills', {
      params: { q: q || undefined, states: states.length ? states.join(',') : undefined, subjects: subjects.length ? subjects.join(',') : undefined, sponsorParty: sponsorParty.length ? sponsorParty.join(',') : undefined, chambers: chambers.length ? chambers.join(',') : undefined, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search bill title, identifier, sponsor, or action…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpMultiSelect label="Subject" placeholder="Any subject" options={(facets.data?.subjects ?? []).map((s) => ({ value: s, label: s }))} values={subjects} onChange={setSubjects} loading={facets.isLoading} />
            <XpMultiSelect label="Sponsor party" placeholder="Any" options={(facets.data?.parties ?? []).map((p) => ({ value: p, label: p }))} values={sponsorParty} onChange={setSponsorParty} loading={facets.isLoading} />
            <XpMultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
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
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string) => <span className="xp-state-pill xp-num">{s}</span> },
          { title: 'Bill', dataIndex: 'identifier', width: 100, render: (id: string) => <span className="xp-num xp-w600">{id}</span> },
          { title: 'Title', dataIndex: 'title', ellipsis: true },
          { title: 'Status', dataIndex: 'status', width: 130, render: (s: string | null | undefined) => (s ? <MonoTag>{stateBillStatusLabel(s)}</MonoTag> : '-') },
          { title: 'Sponsor', dataIndex: 'sponsorName', width: 180, render: (n: string | null, r: ExplorerStateBillRow) => (n ? (
            <span>
              {n}
              {r.sponsorParty ? <span className="xp-party-suffix">({r.sponsorParty})</span> : null}
            </span>
          ) : '-') },
          { title: 'Latest action', dataIndex: 'latestActionText', ellipsis: true, render: (text: string | null, r: ExplorerStateBillRow) => (
            <span className="xp-stack">
              <span className="xp-stack__main">{text ?? '-'}</span>
              {r.latestActionDate ? <span className="xp-num xp-stack__sub">{formatDate(r.latestActionDate)}</span> : null}
            </span>
          ) },
        ]}
      />
    </>
  );
}

/* ── State legislators (OpenStates) ─────────────────────────────────────── */

export function StateLegislatorsExplorer() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [states, setStates] = useState<string[]>([]);
  const [chambers, setChambers] = useState<string[]>([]);
  const [parties, setParties] = useState<string[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, states, chambers, parties, activeOnly]);

  const facets = useQuery<StateLegislatorFacets>({
    queryKey: ['explorer-state-legislator-facets'],
    queryFn: async () => (await api.get<StateLegislatorFacets>('/api/explorer/state-legislator-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerStateLegislatorRow>>({
    queryKey: ['explorer-state-legislators', q, states, chambers, parties, activeOnly, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerStateLegislatorRow>>('/api/explorer/state-legislators', {
      params: {
        q: q || undefined,
        states: states.length ? states.join(',') : undefined,
        chambers: chambers.length ? chambers.join(',') : undefined,
        parties: parties.length ? parties.join(',') : undefined,
        activeOnly: activeOnly ? undefined : 'false',
        page, pageSize: PAGE_SIZE,
      },
    })).data,
    placeholderData: (p) => p,
  });

  const openLegislator = (_id: string, row: ExplorerStateLegislatorRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  const chamberLabel = (c: string) => (c === 'upper' ? 'Senate' : c === 'lower' ? 'House' : c);

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search legislator name or district…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpMultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: chamberLabel(c) }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
            <XpMultiSelect label="Party" placeholder="Any" options={(facets.data?.parties ?? []).map((pp) => ({ value: pp, label: pp }))} values={parties} onChange={setParties} loading={facets.isLoading} />
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
        onRowClick={openLegislator}
        columns={[
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string) => <span className="xp-state-pill xp-num">{s}</span> },
          { title: 'Name', dataIndex: 'name', ellipsis: true, render: (n: string, r: ExplorerStateLegislatorRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n}</a> : n) },
          { title: 'Chamber', dataIndex: 'chamber', width: 110, render: (c: string | null) => (c ? chamberLabel(c) : '-') },
          { title: 'District', dataIndex: 'district', width: 110, render: (d: string | null) => d ?? '-' },
          { title: 'Party', dataIndex: 'party', width: 120, render: (p: string | null) => (p ? <PlainTag>{p}</PlainTag> : '-') },
          { title: 'Email', dataIndex: 'email', ellipsis: true, render: (e: string | null) => (e ? <a href={`mailto:${e}`} onClick={(ev) => ev.stopPropagation()}>{e}</a> : '-') },
        ]}
      />
    </>
  );
}
