/**
 * Data Explorer vNext — procurement/assistance sources: SAM.gov Opportunities,
 * Federal Contract Awards (DoD), Federal Grant Awards (USAspending assistance),
 * Grant Opportunities (Grants.gov). Verbatim port of the canonical explorers.
 *
 * None of these has a drill-in detail view — clicking a row opens the public
 * source page in a new tab (canonical behavior).
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  ExplorerFederalAssistanceAwardRow,
  ExplorerFederalAwardRow,
  ExplorerFederalGrantRow,
  ExplorerResponse,
  ExplorerSamOppRow,
  FederalAssistanceAwardFacets,
  FederalAwardFacets,
  FederalGrantFacets,
  SamOppFacets,
} from '../../../pages/explorer/explorerTypes.js';
import {
  XpAmountRangeText,
  XpFilterBar,
  XpMultiSelect,
  XpNumberRange,
  XpSortControl,
  XpTextFilter,
  XpToggleChip,
} from './explorer-controls.js';
import { MonoTag, PlainTag, XpTable } from './explorer-table.js';
import { formatDate, formatMoney, PAGE_SIZE } from './explorer-format.js';

/* ── SAM.gov contract opportunities ─────────────────────────────────────── */

export function SamOppsExplorer() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [noticeTypes, setNoticeTypes] = useState<string[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [naics, setNaics] = useState('');
  const [psc, setPsc] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, noticeTypes, agencies, naics, psc, activeOnly, sort]);

  const facets = useQuery<SamOppFacets>({
    queryKey: ['explorer-sam-opp-facets'],
    queryFn: async () => (await api.get<SamOppFacets>('/api/explorer/sam-opportunity-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerSamOppRow>>({
    queryKey: ['explorer-sam-opps', q, noticeTypes, agencies, naics, psc, activeOnly, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerSamOppRow>>('/api/explorer/sam-opportunities', {
      params: {
        q: q || undefined,
        noticeTypes: noticeTypes.length ? noticeTypes.join(',') : undefined,
        agencies: agencies.length ? agencies.join(',') : undefined,
        naics: naics.trim() || undefined,
        psc: psc.trim() || undefined,
        activeOnly: activeOnly ? undefined : 'false',
        sort,
        page,
        pageSize: PAGE_SIZE,
      },
    })).data,
    placeholderData: (p) => p,
  });

  // No drill-in detail view for SAM opps — clicking a row opens the public
  // sam.gov notice page in a new tab.
  const openNotice = (_id: string, row: ExplorerSamOppRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search title, description, agency, office, or solicitation #…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Notice type" placeholder="Any" options={(facets.data?.noticeTypes ?? []).map((t) => ({ value: t, label: t }))} values={noticeTypes} onChange={setNoticeTypes} loading={facets.isLoading} />
            <XpMultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <XpTextFilter
              label="NAICS"
              value={naics}
              onChange={(v) => setNaics(v.replace(/[^\d]/g, ''))}
              placeholder="e.g. 3345"
              width={110}
            />
            <XpTextFilter
              label="PSC"
              value={psc}
              onChange={(v) => setPsc(v.toUpperCase())}
              placeholder="e.g. 58"
              width={90}
            />
            <XpToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Newest posted' },
              { value: 'deadline', label: 'Response deadline (soonest)' },
              { value: 'oldest', label: 'Oldest posted' },
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
        onRowClick={openNotice}
        columns={[
          { title: 'Posted', dataIndex: 'postedDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (t: string, r: ExplorerSamOppRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t}</a> : t) },
          { title: 'Type', dataIndex: 'noticeType', width: 150, render: (t: string) => <MonoTag>{t}</MonoTag> },
          { title: 'Agency', dataIndex: 'agency', width: 200, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'Office', dataIndex: 'office', width: 170, ellipsis: true, render: (o: string | null) => o ?? '-' },
          { title: 'NAICS', dataIndex: 'naicsCode', width: 80, render: (n: string | null) => (n ? <span className="xp-num">{n}</span> : '-') },
          { title: 'Deadline', dataIndex: 'responseDeadline', width: 110, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── Federal awards (USAspending) ───────────────────────────────────────── */

export function FederalAwardsExplorer() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [agencies, setAgencies] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [fiscalYears, setFiscalYears] = useState<string[]>([]);
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [sort, setSort] = useState('amount');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, agencies, states, fiscalYears, minAmount, maxAmount, sort]);

  const facets = useQuery<FederalAwardFacets>({
    queryKey: ['explorer-federal-award-facets'],
    queryFn: async () => (await api.get<FederalAwardFacets>('/api/explorer/federal-award-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerFederalAwardRow>>({
    queryKey: ['explorer-federal-awards', q, agencies, states, fiscalYears, minAmount, maxAmount, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerFederalAwardRow>>('/api/explorer/federal-awards', {
      params: {
        q: q || undefined,
        agencies: agencies.length ? agencies.join(',') : undefined,
        states: states.length ? states.join(',') : undefined,
        fiscalYears: fiscalYears.length ? fiscalYears.join(',') : undefined,
        minAmount: minAmount && Number(minAmount) > 0 ? Number(minAmount) : undefined,
        maxAmount: maxAmount && Number(maxAmount) > 0 ? Number(maxAmount) : undefined,
        sort, page, pageSize: PAGE_SIZE,
      },
    })).data,
    placeholderData: (p) => p,
  });

  const openAward = (_id: string, row: ExplorerFederalAwardRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search contractor, description, agency, program, or PIID…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <XpMultiSelect label="State (PoP)" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpMultiSelect label="Fiscal year" placeholder="Any" options={(facets.data?.fiscalYears ?? []).map((y) => ({ value: String(y), label: String(y) }))} values={fiscalYears} onChange={setFiscalYears} loading={facets.isLoading} />
            <XpAmountRangeText
              label="Amount ($)"
              minValue={minAmount}
              maxValue={maxAmount}
              onMinChange={setMinAmount}
              onMaxChange={setMaxAmount}
            />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest amount' },
              { value: 'recent', label: 'Most recent action' },
              { value: 'oldest', label: 'Oldest action' },
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
        onRowClick={openAward}
        columns={[
          { title: 'Action date', dataIndex: 'actionDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
          { title: 'Contractor', dataIndex: 'contractorName', width: 200, ellipsis: true, render: (n: string | null, r: ExplorerFederalAwardRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n ?? '(unnamed)'}</a> : (n ?? '-')) },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'Agency', dataIndex: 'awardingAgency', width: 160, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right' as const, render: (v: number | null) => <span className="xp-num xp-w500">{formatMoney(v)}</span> },
          { title: 'PE', dataIndex: 'peCode', width: 90, render: (p: string | null) => (p ? <span className="xp-num xp-mono-sm">{p}</span> : '-') },
          { title: 'FY', dataIndex: 'fundingFy', width: 60, render: (y: number | null) => (y ? <span className="xp-num">{y}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── Federal assistance awards (USAspending, awarded grants) ────────────── */

/**
 * Awarded federal financial assistance — the money that actually went out the
 * door, as distinct from the Grant Opportunities source (Grants.gov NOFOs,
 * which are forecasts).
 *
 * Obligated and outlayed get their own columns and are never combined:
 * committed and paid are different facts, and a blended figure would answer
 * neither question. `activeOnly` defaults to FALSE here, unlike the SAM.gov and
 * state-legislator sources — this table is a historical record, and defaulting
 * to active-only would silently hide most of it behind a filter the user never
 * asked for.
 */
export function FederalAssistanceAwardsExplorer() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [agencies, setAgencies] = useState<string[]>([]);
  const [listings, setListings] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [district, setDistrict] = useState('');
  const [awardTypes, setAwardTypes] = useState<string[]>([]);
  const [minAmount, setMinAmount] = useState<number | null>(null);
  const [maxAmount, setMaxAmount] = useState<number | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [sort, setSort] = useState('amount');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, agencies, listings, states, district, awardTypes, minAmount, maxAmount, activeOnly, sort]);

  const facets = useQuery<FederalAssistanceAwardFacets>({
    queryKey: ['explorer-federal-assistance-award-facets'],
    queryFn: async () => (await api.get<FederalAssistanceAwardFacets>('/api/explorer/federal-assistance-award-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerFederalAssistanceAwardRow>>({
    queryKey: ['explorer-federal-assistance-awards', q, agencies, listings, states, district, awardTypes, minAmount, maxAmount, activeOnly, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerFederalAssistanceAwardRow>>('/api/explorer/federal-assistance-awards', {
      params: {
        q: q || undefined,
        agencies: agencies.length ? agencies.join(',') : undefined,
        listings: listings.length ? listings.join(',') : undefined,
        states: states.length ? states.join(',') : undefined,
        district: district.trim() || undefined,
        awardTypes: awardTypes.length ? awardTypes.join(',') : undefined,
        minAmount: minAmount != null ? minAmount : undefined,
        maxAmount: maxAmount != null ? maxAmount : undefined,
        activeOnly: activeOnly ? 'true' : undefined,
        sort, page, pageSize: PAGE_SIZE,
      },
    })).data,
    placeholderData: (p) => p,
  });

  const openAward = (_id: string, row: ExplorerFederalAssistanceAwardRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search recipient, description, agency, Assistance Listing, FAIN, or exact UEI…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <XpMultiSelect label="Assistance Listing" placeholder="Any" options={(facets.data?.listings ?? []).map((l) => ({ value: l.code, label: l.title ? `${l.code} — ${l.title}` : l.code }))} values={listings} onChange={setListings} loading={facets.isLoading} />
            <XpMultiSelect label="State (PoP)" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpTextFilter
              label="District"
              value={district}
              onChange={(v) => setDistrict(v.toUpperCase())}
              placeholder="e.g. 23"
              maxLength={2}
              width={90}
            />
            <XpMultiSelect label="Award type" placeholder="Any" options={(facets.data?.awardTypes ?? []).map((t) => ({ value: t.code, label: t.label ?? t.code }))} values={awardTypes} onChange={setAwardTypes} loading={facets.isLoading} />
            <XpNumberRange label="Obligated ($)" minValue={minAmount} maxValue={maxAmount} onMinChange={setMinAmount} onMaxChange={setMaxAmount} />
            <XpToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest obligated' },
              { value: 'recent', label: 'Most recently started' },
              { value: 'ending', label: 'Ending soonest' },
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
        onRowClick={openAward}
        columns={[
          { title: 'Recipient', dataIndex: 'recipientName', width: 210, ellipsis: true, render: (n: string | null, r: ExplorerFederalAssistanceAwardRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n ?? '(unnamed)'}</a> : (n ?? '-')) },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'Agency', dataIndex: 'awardingAgency', width: 170, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'ALN', dataIndex: 'assistanceListingNumber', width: 80, render: (c: string | null) => (c ? <MonoTag>{c}</MonoTag> : '-') },
          { title: 'Type', dataIndex: 'awardTypeLabel', width: 130, ellipsis: true, render: (l: string | null) => l ?? '-' },
          { title: 'Obligated', dataIndex: 'totalObligatedAmount', width: 120, align: 'right' as const, render: (v: number | null) => <span className="xp-num xp-w500">{formatMoney(v)}</span> },
          { title: 'Outlayed', dataIndex: 'totalOutlayedAmount', width: 110, align: 'right' as const, render: (v: number | null) => <span className="xp-num">{formatMoney(v)}</span> },
          { title: 'PoP', dataIndex: 'popState', width: 80, render: (_s: string | null, r: ExplorerFederalAssistanceAwardRow) => (r.popState ? (r.popCongressionalDistrict ? `${r.popState}-${r.popCongressionalDistrict}` : r.popState) : '-') },
          { title: 'Ends', dataIndex: 'endDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── Federal grants (Grants.gov) ────────────────────────────────────────── */

export function FederalGrantsExplorer() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [agencies, setAgencies] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, agencies, statuses, sort]);

  const facets = useQuery<FederalGrantFacets>({
    queryKey: ['explorer-federal-grant-facets'],
    queryFn: async () => (await api.get<FederalGrantFacets>('/api/explorer/federal-grant-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerFederalGrantRow>>({
    queryKey: ['explorer-federal-grants', q, agencies, statuses, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerFederalGrantRow>>('/api/explorer/federal-grants', {
      params: {
        q: q || undefined,
        agencies: agencies.length ? agencies.join(',') : undefined,
        statuses: statuses.length ? statuses.join(',') : undefined,
        sort, page, pageSize: PAGE_SIZE,
      },
    })).data,
    placeholderData: (p) => p,
  });

  const openGrant = (_id: string, row: ExplorerFederalGrantRow) => {
    if (row.url) window.open(row.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search grant title, description, agency, or opportunity #…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <XpMultiSelect label="Status" placeholder="Any" options={(facets.data?.statuses ?? []).map((s) => ({ value: s, label: s }))} values={statuses} onChange={setStatuses} loading={facets.isLoading} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Newest posted' },
              { value: 'close', label: 'Closing soonest' },
              { value: 'oldest', label: 'Oldest posted' },
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
        onRowClick={openGrant}
        columns={[
          { title: 'Posted', dataIndex: 'openDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (t: string, r: ExplorerFederalGrantRow) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t}</a> : t) },
          { title: 'Agency', dataIndex: 'agency', width: 200, ellipsis: true },
          { title: 'Instrument', dataIndex: 'fundingInstrument', width: 130, render: (i: string | null) => (i ? <MonoTag>{i}</MonoTag> : '-') },
          { title: 'Ceiling', dataIndex: 'awardCeiling', width: 120, align: 'right' as const, render: (v: number | null) => <span className="xp-num">{formatMoney(v)}</span> },
          { title: 'Closes', dataIndex: 'closeDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
          { title: 'Status', dataIndex: 'status', width: 90, render: (s: string | null) => (s ? <PlainTag>{s}</PlainTag> : '-') },
        ]}
      />
    </>
  );
}
