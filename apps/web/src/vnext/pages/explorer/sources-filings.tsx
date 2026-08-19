/**
 * Data Explorer vNext — filings-and-money sources: LDA Filings, Federal
 * Contractors, FARA, FEC Contributions, SEC Filings.
 *
 * Query keys, endpoints, params, facet handling, sort options, column set and
 * copy are verbatim from the canonical DataExplorerPage explorers.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  ContractorFacets,
  ExplorerContractorRow,
  ExplorerFaraRow,
  ExplorerFecRow,
  ExplorerLdaFilingRow,
  ExplorerResponse,
  ExplorerSecRow,
  FaraFacets,
  FecFacets,
  LdaFacets,
  SecFacets,
} from '../../../pages/explorer/explorerTypes.js';
import {
  XpAmountRangeText,
  XpFilterBar,
  XpMultiSelect,
  XpNumberRange,
  XpSortControl,
  XpToggleChip,
} from './explorer-controls.js';
import { MonoTag, PlainTag, XpTable } from './explorer-table.js';
import { formatDate, formatMoney, PAGE_SIZE } from './explorer-format.js';

/* ── LDA Filings ────────────────────────────────────────────────────────── */

export function LdaFilingsExplorer({
  onRowClick,
}: {
  onRowClick: (id: string, row: ExplorerLdaFilingRow) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [issueCodes, setIssueCodes] = useState<string[]>([]);
  const [years, setYears] = useState<string[]>([]);
  const [filingTypes, setFilingTypes] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [periods, setPeriods] = useState<string[]>([]);
  const [minIncome, setMinIncome] = useState<number | null>(null);
  const [maxIncome, setMaxIncome] = useState<number | null>(null);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [q, issueCodes, years, filingTypes, states, periods, minIncome, maxIncome, sort]);

  const facets = useQuery<LdaFacets>({
    queryKey: ['explorer-lda-facets'],
    queryFn: async () => (await api.get<LdaFacets>('/api/explorer/lda-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const rowsQuery = useQuery<ExplorerResponse<ExplorerLdaFilingRow>>({
    queryKey: ['explorer-lda-filings', q, issueCodes, years, filingTypes, states, periods, minIncome, maxIncome, sort, page],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<ExplorerLdaFilingRow>>('/api/explorer/lda-filings', {
          params: {
            q: q || undefined,
            issueCodes: issueCodes.length ? issueCodes.join(',') : undefined,
            years: years.length ? years.join(',') : undefined,
            filingTypes: filingTypes.length ? filingTypes.join(',') : undefined,
            states: states.length ? states.join(',') : undefined,
            periods: periods.length ? periods.join(',') : undefined,
            minIncome: minIncome != null && minIncome > 0 ? minIncome : undefined,
            maxIncome: maxIncome != null && maxIncome > 0 ? maxIncome : undefined,
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
        searchPlaceholder="Search client, registrant, description, state, or issue code…"
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
              label="Issue codes"
              placeholder="Any issue"
              options={(facets.data?.issueCodes ?? []).map((c) => ({
                value: c.code,
                label: `${c.code}, ${c.name}`,
              }))}
              values={issueCodes}
              onChange={setIssueCodes}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Filing type"
              placeholder="Any type"
              options={(facets.data?.filingTypes ?? []).map((t) => ({ value: t, label: t }))}
              values={filingTypes}
              onChange={setFilingTypes}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="State"
              placeholder="Any state"
              options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))}
              values={states}
              onChange={setStates}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Period"
              placeholder="Any period"
              options={(facets.data?.periods ?? []).map((p) => ({ value: p, label: p }))}
              values={periods}
              onChange={setPeriods}
              loading={facets.isLoading}
            />
            <XpMultiSelect
              label="Year"
              placeholder="Any year"
              options={(facets.data?.years ?? []).map((y) => ({
                value: String(y),
                label: String(y),
              }))}
              values={years}
              onChange={setYears}
              loading={facets.isLoading}
            />
            <XpNumberRange
              label="Income ($)"
              minValue={minIncome}
              maxValue={maxIncome}
              onMinChange={setMinIncome}
              onMaxChange={setMaxIncome}
            />
            <XpSortControl
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Recently posted' },
                { value: 'income', label: 'Highest income' },
                { value: 'year', label: 'Filing year (desc)' },
                { value: 'client', label: 'Client (A–Z)' },
                { value: 'registrant', label: 'Registrant (A–Z)' },
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
            title: 'Year / Period',
            dataIndex: 'filingYear',
            width: 110,
            render: (year: number, row: ExplorerLdaFilingRow) => (
              <span className="xp-num">
                {year}
                {row.filingPeriod ? ` · ${row.filingPeriod}` : ''}
              </span>
            ),
          },
          {
            title: 'Type',
            dataIndex: 'filingType',
            width: 80,
            render: (t: string) => <MonoTag>{t}</MonoTag>,
          },
          {
            title: 'Registrant',
            dataIndex: 'registrantName',
            ellipsis: true,
          },
          {
            title: 'Client',
            dataIndex: 'clientName',
            ellipsis: true,
          },
          {
            title: 'State',
            dataIndex: 'clientState',
            width: 70,
            render: (s: string | null) => (s ? <span className="xp-state-pill xp-num">{s}</span> : '-'),
          },
          {
            title: 'Income',
            dataIndex: 'income',
            width: 110,
            align: 'right' as const,
            render: (v: number | null) => <span className="xp-num xp-w500">{formatMoney(v)}</span>,
          },
          {
            title: 'Issues',
            dataIndex: 'issueCodes',
            width: 200,
            render: (codes: string[]) => (
              <span className="xp-chiplist">
                {codes.slice(0, 4).map((c) => (
                  <MonoTag key={c}>{c}</MonoTag>
                ))}
                {codes.length > 4 ? <PlainTag>+{codes.length - 4}</PlainTag> : null}
              </span>
            ),
          },
        ]}
      />
    </>
  );
}

/* ── Federal Contractors ────────────────────────────────────────────────── */

export function ContractorsExplorer({
  onRowClick,
}: {
  onRowClick: (id: string, row: ExplorerContractorRow) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [hasNoBid, setHasNoBid] = useState(false);
  const [minContracts, setMinContracts] = useState<number | null>(null);
  const [maxContracts, setMaxContracts] = useState<number | null>(null);
  const [sort, setSort] = useState('total');
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [q, categories, hasNoBid, minContracts, maxContracts, sort]);

  const facets = useQuery<ContractorFacets>({
    queryKey: ['explorer-contractor-facets'],
    queryFn: async () => (await api.get<ContractorFacets>('/api/explorer/contractor-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const rowsQuery = useQuery<ExplorerResponse<ExplorerContractorRow>>({
    queryKey: ['explorer-contractors', q, categories, hasNoBid, minContracts, maxContracts, sort, page],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<ExplorerContractorRow>>('/api/explorer/federal-contractors', {
          params: {
            q: q || undefined,
            categories: categories.length ? categories.join(',') : undefined,
            hasNoBid: hasNoBid ? true : undefined,
            minContracts: minContracts != null && minContracts > 0 ? minContracts : undefined,
            maxContracts: maxContracts != null && maxContracts > 0 ? maxContracts : undefined,
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
        searchPlaceholder="Search contractor name or UEI…"
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
              label="Category"
              placeholder="Any category"
              options={(facets.data?.categories ?? []).map((c) => ({ value: c, label: c }))}
              values={categories}
              onChange={setCategories}
              loading={facets.isLoading}
            />
            <XpToggleChip
              label="Has no-bid awards"
              active={hasNoBid}
              onToggle={() => setHasNoBid((v) => !v)}
            />
            <XpNumberRange
              label="Total contracts ($)"
              minValue={minContracts}
              maxValue={maxContracts}
              onMinChange={setMinContracts}
              onMaxChange={setMaxContracts}
            />
            <XpSortControl
              value={sort}
              onChange={setSort}
              options={[
                { value: 'total', label: 'Largest contracts' },
                { value: 'no-bid', label: 'Largest no-bid' },
                { value: 'name', label: 'Name (A–Z)' },
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
          { title: 'Rank', dataIndex: 'rankByContracts', width: 80, render: (v: number | null) => (v ? `#${v}` : '-') },
          { title: 'Contractor', dataIndex: 'name', ellipsis: true },
          { title: 'Category', dataIndex: 'category', width: 130, render: (c: string | null) => c ?? '-' },
          {
            title: 'Total Contracts',
            dataIndex: 'totalContracts',
            width: 140,
            align: 'right' as const,
            render: (v: number | null) => <span className="xp-num">{formatMoney(v)}</span>,
          },
          {
            title: 'No-bid Total',
            dataIndex: 'noBidTotal',
            width: 130,
            align: 'right' as const,
            render: (v: number | null) => (
              <span className={`xp-num ${v && v > 0 ? 'xp-danger' : 'xp-muted'}`}>{formatMoney(v)}</span>
            ),
          },
          { title: 'UEI', dataIndex: 'uei', width: 130, render: (u: string | null) => (u ? <span className="xp-num xp-mono-sm">{u}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── FARA registrations ─────────────────────────────────────────────────── */

export function FaraExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerFaraRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [countries, setCountries] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, countries, statuses, states, sort]);

  const facets = useQuery<FaraFacets>({
    queryKey: ['explorer-fara-facets'],
    queryFn: async () => (await api.get<FaraFacets>('/api/explorer/fara-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerFaraRow>>({
    queryKey: ['explorer-fara', q, countries, statuses, states, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerFaraRow>>('/api/explorer/fara', {
      params: { q: q || undefined, countries: countries.length ? countries.join(',') : undefined, statuses: statuses.length ? statuses.join(',') : undefined, states: states.length ? states.join(',') : undefined, sort, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search registrant, foreign principal, or description…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Country" placeholder="Any country" options={(facets.data?.countries ?? []).map((c) => ({ value: c, label: c }))} values={countries} onChange={setCountries} loading={facets.isLoading} />
            <XpMultiSelect label="Status" placeholder="Any" options={(facets.data?.statuses ?? []).map((s) => ({ value: s, label: s }))} values={statuses} onChange={setStatuses} loading={facets.isLoading} />
            <XpMultiSelect label="State" placeholder="Any state" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Most recent registration' },
              { value: 'oldest', label: 'Oldest first' },
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
          { title: 'Reg #', dataIndex: 'registrationNumber', width: 110, render: (r: string) => <span className="xp-num xp-mono-sm">{r}</span> },
          { title: 'Registrant', dataIndex: 'registrantName', ellipsis: true },
          { title: 'Foreign Principal', dataIndex: 'foreignPrincipal', ellipsis: true },
          { title: 'Country', dataIndex: 'country', width: 130, render: (c: string | null) => c ?? '-' },
          { title: 'Status', dataIndex: 'status', width: 110, render: (s: string | null) => (s ? <PlainTag tone={s.toLowerCase() === 'active' ? 'success' : 'neutral'}>{s}</PlainTag> : '-') },
          { title: 'Registered', dataIndex: 'registrationDate', width: 110, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
        ]}
      />
    </>
  );
}

/* ── FEC contributions ──────────────────────────────────────────────────── */

export function FecExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerFecRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [cycles, setCycles] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [minAmount, setMinAmount] = useState<string>('');
  const [maxAmount, setMaxAmount] = useState<string>('');
  const [sort, setSort] = useState('amount');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, cycles, states, minAmount, maxAmount, sort]);

  const facets = useQuery<FecFacets>({
    queryKey: ['explorer-fec-facets'],
    queryFn: async () => (await api.get<FecFacets>('/api/explorer/fec-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerFecRow>>({
    queryKey: ['explorer-fec', q, cycles, states, minAmount, maxAmount, sort, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerFecRow>>('/api/explorer/fec-contributions', {
      params: {
        q: q || undefined,
        cycles: cycles.length ? cycles.join(',') : undefined,
        states: states.length ? states.join(',') : undefined,
        minAmount: minAmount && Number(minAmount) > 0 ? Number(minAmount) : undefined,
        maxAmount: maxAmount && Number(maxAmount) > 0 ? Number(maxAmount) : undefined,
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
        searchPlaceholder="Search contributor, employer, candidate or committee…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Cycle" placeholder="Any" options={(facets.data?.cycles ?? []).map((c) => ({ value: String(c), label: String(c) }))} values={cycles} onChange={setCycles} loading={facets.isLoading} />
            <XpMultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <XpAmountRangeText
              label="Amount ($)"
              minValue={minAmount}
              maxValue={maxAmount}
              onMinChange={setMinAmount}
              onMaxChange={setMaxAmount}
            />
            <XpSortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest amount' },
              { value: 'date', label: 'Most recent' },
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
          { title: 'Date', dataIndex: 'contributionDate', width: 100, render: (d: string | null) => (d ? <span className="xp-num">{formatDate(d)}</span> : '-') },
          { title: 'Contributor', dataIndex: 'contributorName', ellipsis: true, render: (n: string | null, r: ExplorerFecRow) => (
            <span>
              <span>{n ?? '-'}</span>
              {r.contributorEmployer ? <span className="xp-subline">{r.contributorEmployer}</span> : null}
            </span>
          ) },
          { title: 'Recipient', dataIndex: 'committeeName', ellipsis: true, render: (n: string | null, r: ExplorerFecRow) => (
            <span>
              <span>{n ?? '-'}</span>
              {r.candidateName ? <span className="xp-subline">for {r.candidateName}</span> : null}
            </span>
          ) },
          { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right' as const, render: (v: number) => <span className="xp-num xp-w500">{formatMoney(v)}</span> },
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string | null) => (s ? <span className="xp-state-pill xp-num">{s}</span> : '-') },
          { title: 'Cycle', dataIndex: 'cycle', width: 80, render: (c: number) => <span className="xp-num">{c}</span> },
        ]}
      />
    </>
  );
}

/* ── SEC filings ────────────────────────────────────────────────────────── */

export function SecExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerSecRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [formTypes, setFormTypes] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, formTypes]);

  const facets = useQuery<SecFacets>({
    queryKey: ['explorer-sec-facets'],
    queryFn: async () => (await api.get<SecFacets>('/api/explorer/sec-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerSecRow>>({
    queryKey: ['explorer-sec', q, formTypes, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerSecRow>>('/api/explorer/sec', {
      params: { q: q || undefined, formTypes: formTypes.length ? formTypes.join(',') : undefined, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search company, description, or CIK…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Form type" placeholder="Any" options={(facets.data?.formTypes ?? []).map((t) => ({ value: t, label: t }))} values={formTypes} onChange={setFormTypes} loading={facets.isLoading} />
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
          { title: 'Date', dataIndex: 'filingDate', width: 100, render: (d: string) => <span className="xp-num">{formatDate(d)}</span> },
          { title: 'Form', dataIndex: 'formType', width: 90, render: (t: string) => <MonoTag>{t}</MonoTag> },
          { title: 'Company', dataIndex: 'companyName', ellipsis: true },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'CIK', dataIndex: 'cik', width: 110, render: (c: string) => <span className="xp-num xp-mono-sm">{c}</span> },
        ]}
      />
    </>
  );
}
