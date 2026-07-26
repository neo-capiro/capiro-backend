import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Drawer, Empty, Input, InputNumber, Pagination, Select, Skeleton, Table, Tag, Typography } from 'antd';
import {
  AuditOutlined,
  BankOutlined,
  BookOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  GlobalOutlined,
  ReadOutlined,
  ScheduleOutlined,
  SearchOutlined,
  SolutionOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { stateBillStatusLabel } from '@capiro/shared';
import { useApi } from '../../lib/use-api.js';
import {
  type BillFacets,
  type ContractorDetail,
  type ContractorFacets,
  type CrsDetail,
  type CrsFacets,
  type ExplorerBillRow,
  type ExplorerContractorRow,
  type ExplorerCrsRow,
  type ExplorerFaraRow,
  type ExplorerFecRow,
  type ExplorerFedRegRow,
  type ExplorerGaoRow,
  type ExplorerHearingRow,
  type ExplorerIntelArticleRow,
  type ExplorerLdaFilingRow,
  type ExplorerResponse,
  type ExplorerFederalAssistanceAwardRow,
  type ExplorerFederalAwardRow,
  type ExplorerFederalGrantRow,
  type ExplorerSamOppRow,
  type ExplorerStateLegislatorRow,
  type ExplorerSecRow,
  type ExplorerStateBillRow,
  type FaraDetail,
  type FaraFacets,
  type FecDetail,
  type FecFacets,
  type FedRegDetail,
  type FedRegFacets,
  type GaoDetail,
  type GaoFacets,
  type HearingDetail,
  type HearingFacets,
  type IntelArticleDetail,
  type IntelArticleFacets,
  type LdaFacets,
  type LdaFilingDetail,
  type SamOppFacets,
  type FederalAssistanceAwardFacets,
  type FederalAwardFacets,
  type FederalGrantFacets,
  type StateLegislatorFacets,
  type SecDetail,
  type SecFacets,
  type StateBillFacets,
} from './explorerTypes.js';
import { BillDetailBody } from './bill-detail.js';
import { StateBillDetailBody } from './state-bill-detail.js';

const PAGE_SIZE = 25;

type SourceKey =
  | 'lda'
  | 'contractors'
  | 'bills'
  | 'fedreg'
  | 'hearings'
  | 'gao'
  | 'crs'
  | 'fec'
  | 'fara'
  | 'sec'
  | 'sam-opps'
  | 'federal-awards'
  | 'federal-assistance-awards'
  | 'federal-grants'
  | 'state-legislators'
  | 'articles'
  | 'state-bills'
  | 'comment-deadlines';

interface SourceMeta {
  key: SourceKey;
  label: string;
  description: string;
  icon: ReactNode;
}

const SOURCES: SourceMeta[] = [
  { key: 'articles', label: 'News Feed', description: 'Latest coverage from Politico, Roll Call, The Hill and other tracked outlets.', icon: <ReadOutlined /> },
  { key: 'lda', label: 'LDA Filings', description: 'Lobbying Disclosure Act, 500K+ filings, 5 years.', icon: <BookOutlined /> },
  { key: 'contractors', label: 'Federal Contractors', description: 'Top contractors with no-bid totals + agency mix.', icon: <BankOutlined /> },
  { key: 'bills', label: 'Congress Bills', description: 'Bills with sponsor, latest action, subject tags.', icon: <FileTextOutlined /> },
  { key: 'fedreg', label: 'Federal Register', description: 'Proposed/final rules, comment-period deadlines.', icon: <GlobalOutlined /> },
  { key: 'hearings', label: 'Hearings', description: 'Committee hearings and markups by chamber + date.', icon: <ScheduleOutlined /> },
  { key: 'gao', label: 'GAO Reports', description: 'GAO oversight reports + recommendations by topic.', icon: <FileSearchOutlined /> },
  { key: 'crs', label: 'CRS Reports', description: 'Congressional Research Service briefings.', icon: <ReadOutlined /> },
  { key: 'fec', label: 'FEC Contributions', description: 'Itemized political contributions, by cycle.', icon: <DollarOutlined /> },
  { key: 'fara', label: 'FARA Filings', description: 'Foreign agent registrations by country/principal.', icon: <GlobalOutlined /> },
  { key: 'sec', label: 'SEC Filings', description: '8-K, 10-Q, S-1 from SEC EDGAR.', icon: <AuditOutlined /> },
  { key: 'sam-opps', label: 'SAM.gov Opportunities', description: 'DoD contract opportunities & solicitations from SAM.gov.', icon: <SolutionOutlined /> },
  // Source keys are deep-linked — only the labels change here. "Federal Grants"
  // read as awarded money; this source is Grants.gov OPPORTUNITIES (NOFOs).
  // Awarded federal assistance is a separate source (Workstream I).
  { key: 'federal-awards', label: 'Federal Contract Awards (DoD)', description: 'USAspending contract award line items — agency, contractor, amount. DoD scope.', icon: <DollarOutlined /> },
  { key: 'federal-assistance-awards', label: 'Federal Grant Awards', description: 'USAspending awarded grants and cooperative agreements — recipient, UEI, Assistance Listing, obligated vs outlayed. Awarded money, not opportunities.', icon: <DollarOutlined /> },
  { key: 'federal-grants', label: 'Grant Opportunities', description: 'Grants.gov funding opportunities (NOFOs) by agency, deadline, ceiling — not awarded money.', icon: <BankOutlined /> },
  { key: 'state-bills', label: 'State Bills', description: 'State legislation via LegiScan.', icon: <SolutionOutlined /> },
  { key: 'state-legislators', label: 'State Legislators', description: 'State house & senate members by state, chamber, party.', icon: <TeamOutlined /> },
  { key: 'comment-deadlines', label: 'Comment Deadlines', description: 'Open comment periods on federal rules, closing soonest.', icon: <ClockCircleOutlined /> },
];

type DrillIn = { source: SourceKey; id: string; rowSummary: ReactNode } | null;

export function DataExplorerPage() {
  // ?source=<key> deep-links to a specific tab. Dashboard's "Needs Attention"
  // Comments tile uses this to land users directly on comment-deadlines.
  const [searchParams, setSearchParams] = useSearchParams();
  // ?bill=<congressBillId> deep-links straight to a Congress bill's detail
  // drawer (used by the Client Intelligence bill-pipeline cards). It implies
  // the "bills" tab even when ?source= is absent or different.
  const billParam = searchParams.get('bill');
  const initialSource = (() => {
    const fromUrl = searchParams.get('source') as SourceKey | null;
    if (billParam) return 'bills';
    return fromUrl && SOURCES.some((s) => s.key === fromUrl) ? fromUrl : 'articles';
  })();
  const [source, setSource] = useState<SourceKey>(initialSource);
  const activeSource = SOURCES.find((s) => s.key === source) ?? SOURCES[0]!;
  const [drillIn, setDrillIn] = useState<DrillIn>(
    billParam ? { source: 'bills', id: billParam, rowSummary: billParam } : null,
  );

  // Keep ?source= in sync if the user changes tab manually. Replace (not push)
  // so the back button still leaves the page as a whole, not tab-by-tab.
  useEffect(() => {
    const current = searchParams.get('source');
    if (current !== source) {
      const next = new URLSearchParams(searchParams);
      next.set('source', source);
      setSearchParams(next, { replace: true });
    }
    // We intentionally do not depend on searchParams here, only react to a
    // user-driven `source` change. Including searchParams loops with itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // React to ?bill= changing while already on the page (e.g. clicking a
  // different bill card from a deep-linked Explorer view): switch to the
  // bills tab and open that bill's detail drawer.
  useEffect(() => {
    if (!billParam) return;
    setSource('bills');
    setDrillIn((prev) =>
      prev && prev.source === 'bills' && prev.id === billParam
        ? prev
        : { source: 'bills', id: billParam, rowSummary: billParam },
    );
  }, [billParam]);

  return (
    <section className="explorer-page redesign">
      <header className="explorer-page-head">
        <div>
          <h1>Intelligence Center</h1>
          <p className="explorer-page-dek">
            Search and filter every federal data source Capiro tracks. Click a row to inspect the full record.
          </p>
        </div>
      </header>

      <nav className="explorer-source-tabs" role="tablist" aria-label="Data sources">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={source === s.key}
            title={s.description}
            className={`explorer-source-tab${source === s.key ? ' is-active' : ''}`}
            onClick={() => setSource(s.key)}
          >
            <span className="explorer-source-tab-icon" aria-hidden>
              {s.icon}
            </span>
            <span className="explorer-source-tab-label">{s.label}</span>
          </button>
        ))}
      </nav>

      <p className="explorer-source-caption">{activeSource.description}</p>

      <div className="explorer-source-body">
        {source === 'lda' ? <LdaFilingsExplorer onRowClick={(id, row) => setDrillIn({ source: 'lda', id, rowSummary: row.clientName })} /> : null}
        {source === 'contractors' ? <ContractorsExplorer onRowClick={(id, row) => setDrillIn({ source: 'contractors', id, rowSummary: row.name })} /> : null}
        {source === 'bills' ? <BillsExplorer onRowClick={(id, row) => setDrillIn({ source: 'bills', id, rowSummary: `${row.billType} ${row.billNumber}` })} /> : null}
        {source === 'fedreg' ? <FedRegExplorer onRowClick={(id, row) => setDrillIn({ source: 'fedreg', id, rowSummary: row.title })} /> : null}
        {source === 'hearings' ? <HearingsExplorer onRowClick={(id, row) => setDrillIn({ source: 'hearings', id, rowSummary: row.title })} /> : null}
        {source === 'gao' ? <GaoExplorer onRowClick={(id, row) => setDrillIn({ source: 'gao', id, rowSummary: row.title })} /> : null}
        {source === 'crs' ? <CrsExplorer onRowClick={(id, row) => setDrillIn({ source: 'crs', id, rowSummary: row.title })} /> : null}
        {source === 'fec' ? <FecExplorer onRowClick={(id, row) => setDrillIn({ source: 'fec', id, rowSummary: row.contributorName ?? row.committeeName ?? '' })} /> : null}
        {source === 'fara' ? <FaraExplorer onRowClick={(id, row) => setDrillIn({ source: 'fara', id, rowSummary: row.registrantName })} /> : null}
        {source === 'sec' ? <SecExplorer onRowClick={(id, row) => setDrillIn({ source: 'sec', id, rowSummary: row.companyName })} /> : null}
        {source === 'sam-opps' ? <SamOppsExplorer /> : null}
        {source === 'federal-awards' ? <FederalAwardsExplorer /> : null}
        {source === 'federal-assistance-awards' ? <FederalAssistanceAwardsExplorer /> : null}
        {source === 'federal-grants' ? <FederalGrantsExplorer /> : null}
        {source === 'state-legislators' ? <StateLegislatorsExplorer /> : null}
        {source === 'articles' ? <ArticlesExplorer onRowClick={(id, row) => setDrillIn({ source: 'articles', id, rowSummary: row.title })} /> : null}
        {source === 'state-bills' ? <StateBillsExplorer onRowClick={(id, row) => setDrillIn({ source: 'state-bills', id, rowSummary: `${row.state} ${row.identifier}` })} /> : null}
        {source === 'comment-deadlines' ? <CommentDeadlinesExplorer onRowClick={(id, row) => setDrillIn({ source: 'comment-deadlines', id, rowSummary: row.title })} /> : null}
      </div>

      <ExplorerDrillInDrawer drillIn={drillIn} onClose={() => setDrillIn(null)} />
    </section>
  );
}

/* ── LDA Filings ────────────────────────────────────────────────────────── */

function LdaFilingsExplorer({
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
      <ExplorerFilterBar
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
            <MultiSelect
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
            <MultiSelect
              label="Filing type"
              placeholder="Any type"
              options={(facets.data?.filingTypes ?? []).map((t) => ({ value: t, label: t }))}
              values={filingTypes}
              onChange={setFilingTypes}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="State"
              placeholder="Any state"
              options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))}
              values={states}
              onChange={setStates}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="Period"
              placeholder="Any period"
              options={(facets.data?.periods ?? []).map((p) => ({ value: p, label: p }))}
              values={periods}
              onChange={setPeriods}
              loading={facets.isLoading}
            />
            <MultiSelect
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
            <NumberRange
              label="Income ($)"
              minValue={minIncome}
              maxValue={maxIncome}
              onMinChange={setMinIncome}
              onMaxChange={setMaxIncome}
            />
            <SortControl
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

      <ExplorerTable
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
              <span className="num">
                {year}
                {row.filingPeriod ? ` · ${row.filingPeriod}` : ''}
              </span>
            ),
          },
          {
            title: 'Type',
            dataIndex: 'filingType',
            width: 80,
            render: (t: string) => <Tag className="redesign-mono-tag">{t}</Tag>,
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
            render: (s: string | null) =>
              s ? <span className="state-pill num">{s}</span> : '-',
          },
          {
            title: 'Income',
            dataIndex: 'income',
            width: 110,
            align: 'right' as const,
            render: (v: number | null) => (
              <span className="num" style={{ fontWeight: 500 }}>
                {formatMoney(v)}
              </span>
            ),
          },
          {
            title: 'Issues',
            dataIndex: 'issueCodes',
            width: 200,
            render: (codes: string[]) => (
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {codes.slice(0, 4).map((c) => (
                  <Tag key={c} className="redesign-mono-tag">
                    {c}
                  </Tag>
                ))}
                {codes.length > 4 ? <Tag>+{codes.length - 4}</Tag> : null}
              </span>
            ),
          },
        ]}
      />
    </>
  );
}

/* ── Federal Contractors ────────────────────────────────────────────────── */

function ContractorsExplorer({
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
      <ExplorerFilterBar
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
            <MultiSelect
              label="Category"
              placeholder="Any category"
              options={(facets.data?.categories ?? []).map((c) => ({ value: c, label: c }))}
              values={categories}
              onChange={setCategories}
              loading={facets.isLoading}
            />
            <ToggleChip
              label="Has no-bid awards"
              active={hasNoBid}
              onToggle={() => setHasNoBid((v) => !v)}
            />
            <NumberRange
              label="Total contracts ($)"
              minValue={minContracts}
              maxValue={maxContracts}
              onMinChange={setMinContracts}
              onMaxChange={setMaxContracts}
            />
            <SortControl
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

      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Rank', dataIndex: 'rankByContracts', width: 80, render: (v: number | null) => v ? `#${v}` : '-' },
          { title: 'Contractor', dataIndex: 'name', ellipsis: true },
          { title: 'Category', dataIndex: 'category', width: 130, render: (c: string | null) => c ?? '-' },
          {
            title: 'Total Contracts',
            dataIndex: 'totalContracts',
            width: 140,
            align: 'right' as const,
            render: (v: number | null) => <span className="num">{formatMoney(v)}</span>,
          },
          {
            title: 'No-bid Total',
            dataIndex: 'noBidTotal',
            width: 130,
            align: 'right' as const,
            render: (v: number | null) => (
              <span className="num" style={{ color: v && v > 0 ? 'var(--critical)' : 'var(--ink-3)' }}>
                {formatMoney(v)}
              </span>
            ),
          },
          { title: 'UEI', dataIndex: 'uei', width: 130, render: (u: string | null) => u ? <span className="num" style={{ fontSize: 11 }}>{u}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── Congress Bills ─────────────────────────────────────────────────────── */

function BillsExplorer({
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
      <ExplorerFilterBar
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
            <MultiSelect
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
            <MultiSelect
              label="Chamber"
              placeholder="Any"
              options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c }))}
              values={chambers}
              onChange={setChambers}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="Party"
              placeholder="Any"
              options={(facets.data?.parties ?? []).map((p) => ({ value: p, label: partyName(p) }))}
              values={parties}
              onChange={setParties}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="Subject"
              placeholder="Any subject"
              options={(facets.data?.subjects ?? []).map((s) => ({ value: s, label: s }))}
              values={subjects}
              onChange={setSubjects}
              loading={facets.isLoading}
            />
            <SortControl
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

      <ExplorerTable
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
              <span className="num" style={{ fontWeight: 600 }}>
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
                    <span className={`party-pill ${r.sponsorParty.toLowerCase()}`} style={{ marginLeft: 6 }}>
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
            render: (v: number) => <span className="num">{v}</span>,
          },
          {
            title: 'Latest action',
            dataIndex: 'latestActionText',
            ellipsis: true,
            render: (text: string | null, r: ExplorerBillRow) => (
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12.5 }}>{text ?? '-'}</span>
                {r.latestActionDate ? (
                  <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {formatDate(r.latestActionDate)}
                  </span>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </>
  );
}

/* ── Federal Register Documents ─────────────────────────────────────────── */

function FedRegExplorer({
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
      <ExplorerFilterBar
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
            <MultiSelect
              label="Type"
              placeholder="Any"
              options={(facets.data?.types ?? []).map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))}
              values={types}
              onChange={setTypes}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="Agency"
              placeholder="Any agency"
              options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))}
              values={agencies}
              onChange={setAgencies}
              loading={facets.isLoading}
            />
            <MultiSelect
              label="Topic"
              placeholder="Any topic"
              options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))}
              values={topics}
              onChange={setTopics}
              loading={facets.isLoading}
            />
            <ToggleChip
              label="Significant rules only"
              active={significantOnly}
              onToggle={() => setSignificantOnly((v) => !v)}
            />
            <ToggleChip
              label="Comment period open"
              active={openCommentOnly}
              onToggle={() => setOpenCommentOnly((v) => !v)}
            />
            <SortControl
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

      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Type', dataIndex: 'type', width: 130, render: (t: string) => <Tag className="redesign-mono-tag">{t.replace(/_/g, ' ')}</Tag> },
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
                {agencies.length > 1 ? <span style={{ color: 'var(--ink-3)' }}> +{agencies.length - 1}</span> : null}
              </span>
            ),
          },
          {
            title: 'Comment closes',
            dataIndex: 'commentEndDate',
            width: 150,
            render: (d: string | null) => {
              if (!d) return <span style={{ color: 'var(--ink-3)' }}>-</span>;
              const days = Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              const sev: 'critical' | 'notable' | 'info' =
                days <= 3 ? 'critical' : days <= 14 ? 'notable' : 'info';
              return (
                <span className="num">
                  <span className={`pill ${sev}`} style={{ marginRight: 8 }}>
                    {days <= 0 ? 'closed' : `${days}d`}
                  </span>
                  {formatDate(d)}
                </span>
              );
            },
          },
          {
            title: 'Significant',
            dataIndex: 'significantRule',
            width: 110,
            render: (b: boolean) => (b ? <Tag color="gold">significant</Tag> : null),
          },
        ]}
      />
    </>
  );
}

/* ── Comment Deadlines (Federal Register, open-comment preset) ──────────── */

function CommentDeadlinesExplorer({
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
      <ExplorerFilterBar
        searchPlaceholder="Search rule title or abstract…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => {
          setSearchInput('');
          setQ('');
        }}
        controls={
          <MultiSelect
            label="Agency"
            placeholder="Any agency"
            options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))}
            values={agencies}
            onChange={setAgencies}
            loading={facets.isLoading}
          />
        }
      />

      <ExplorerTable
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
              if (!d) return <span style={{ color: 'var(--ink-3)' }}>-</span>;
              const days = Math.ceil((new Date(d).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              const sev: 'critical' | 'notable' | 'info' =
                days <= 3 ? 'critical' : days <= 14 ? 'notable' : 'info';
              return (
                <span className="num">
                  <span className={`pill ${sev}`} style={{ marginRight: 8 }}>
                    {days <= 0 ? 'closed' : `${days}d left`}
                  </span>
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
                {a.length > 1 ? <span style={{ color: 'var(--ink-3)' }}> +{a.length - 1}</span> : null}
              </span>
            ),
          },
          {
            title: 'Type',
            dataIndex: 'type',
            width: 140,
            render: (t: string) => <Tag className="redesign-mono-tag">{t.replace(/_/g, ' ')}</Tag>,
          },
        ]}
      />
    </>
  );
}

/* ── Committee hearings ─────────────────────────────────────────────────── */

function HearingsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerHearingRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search hearing title, committee, or location…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <label className="explorer-filter">
              <span className="explorer-filter-label">When</span>
              <Select
                value={dateFilter}
                onChange={(v) => setDateFilter(v as 'upcoming' | 'past' | 'all')}
                style={{ minWidth: 130 }}
                options={[
                  { value: 'upcoming', label: 'Upcoming' },
                  { value: 'past', label: 'Past' },
                  { value: 'all', label: 'All dates' },
                ]}
              />
            </label>
            <MultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
            <MultiSelect label="Committee" placeholder="Any" options={(facets.data?.committees ?? []).map((c) => ({ value: c, label: c }))} values={committees} onChange={setCommittees} loading={facets.isLoading} />
            <MultiSelect label="Type" placeholder="Any" options={(facets.data?.types ?? []).map((t) => ({ value: t, label: t }))} values={types} onChange={setTypes} loading={facets.isLoading} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'soonest', label: 'Soonest first' },
              { value: 'recent', label: 'Most recent first' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Date', dataIndex: 'date', width: 120, render: (d: string, r: ExplorerHearingRow) => <span className="num">{formatDate(d)}{r.time ? ` · ${r.time}` : ''}</span> },
          { title: 'Chamber', dataIndex: 'chamber', width: 90 },
          { title: 'Committee', dataIndex: 'committeeName', ellipsis: true },
          { title: 'Title', dataIndex: 'title', ellipsis: true },
          { title: 'Type', dataIndex: 'type', width: 100, render: (t: string | null) => t ? <Tag className="redesign-mono-tag">{t}</Tag> : '-' },
          { title: 'Witnesses', dataIndex: 'witnesses', width: 100, align: 'right' as const, render: (w: string[]) => <span className="num">{w.length}</span> },
        ]}
      />
    </>
  );
}

/* ── GAO reports ────────────────────────────────────────────────────────── */

function GaoExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerGaoRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search GAO report title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Type" placeholder="Any" options={(facets.data?.reportTypes ?? []).map((t) => ({ value: t, label: t }))} values={reportTypes} onChange={setReportTypes} loading={facets.isLoading} />
            <MultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <MultiSelect label="Agency" placeholder="Any agency" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Most recent' },
              { value: 'recs', label: 'Most recommendations' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Report #', dataIndex: 'id', width: 150, render: (id: string) => <span className="num" style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 11 }}>{id}</span> },
          { title: 'Type', dataIndex: 'reportType', width: 130, render: (t: string | null) => t ? <Tag className="redesign-mono-tag">{t}</Tag> : '-' },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (title: string, r: ExplorerGaoRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer">{title}</a> : title },
          { title: 'Topics', dataIndex: 'topics', width: 220, render: (topics: string[]) => <ChipList items={topics} max={3} /> },
          { title: 'Recs', dataIndex: 'recommendations', width: 70, align: 'right' as const, render: (n: number | null) => <span className="num">{n ?? '-'}</span> },
          { title: 'Date', dataIndex: 'publishDate', width: 110, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── CRS reports ────────────────────────────────────────────────────────── */

function CrsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerCrsRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search CRS title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <ToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Report #', dataIndex: 'id', width: 100, render: (id: string) => <span className="num" style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 11 }}>{id}</span> },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (title: string, r: ExplorerCrsRow) => r.htmlUrl ? <a href={r.htmlUrl} target="_blank" rel="noreferrer">{title}</a> : title },
          { title: 'Topics', dataIndex: 'topics', width: 220, render: (t: string[]) => <ChipList items={t} max={3} /> },
          { title: 'Authors', dataIndex: 'authors', width: 140, render: (a: string[]) => a.length ? a.slice(0, 1).join(', ') + (a.length > 1 ? ` +${a.length - 1}` : '') : '-' },
          { title: 'Date', dataIndex: 'date', width: 110, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── FEC contributions ──────────────────────────────────────────────────── */

function FecExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerFecRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search contributor, employer, candidate or committee…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Cycle" placeholder="Any" options={(facets.data?.cycles ?? []).map((c) => ({ value: String(c), label: String(c) }))} values={cycles} onChange={setCycles} loading={facets.isLoading} />
            <MultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <label className="explorer-filter">
              <span className="explorer-filter-label">Amount ($)</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Input
                  style={{ width: 110 }}
                  value={minAmount}
                  onChange={(e) => setMinAmount(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="Min"
                />
                <span className="explorer-filter-label" style={{ margin: 0 }}>–</span>
                <Input
                  style={{ width: 110 }}
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="Max"
                />
              </span>
            </label>
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest amount' },
              { value: 'date', label: 'Most recent' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Date', dataIndex: 'contributionDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
          { title: 'Contributor', dataIndex: 'contributorName', ellipsis: true, render: (n: string | null, r: ExplorerFecRow) => (
            <span>
              <span>{n ?? '-'}</span>
              {r.contributorEmployer ? <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}>{r.contributorEmployer}</span> : null}
            </span>
          ) },
          { title: 'Recipient', dataIndex: 'committeeName', ellipsis: true, render: (n: string | null, r: ExplorerFecRow) => (
            <span>
              <span>{n ?? '-'}</span>
              {r.candidateName ? <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)' }}>for {r.candidateName}</span> : null}
            </span>
          ) },
          { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right' as const, render: (v: number) => <span className="num" style={{ fontWeight: 500 }}>{formatMoney(v)}</span> },
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string | null) => s ? <span className="state-pill num">{s}</span> : '-' },
          { title: 'Cycle', dataIndex: 'cycle', width: 80, render: (c: number) => <span className="num">{c}</span> },
        ]}
      />
    </>
  );
}

/* ── FARA registrations ─────────────────────────────────────────────────── */

function FaraExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerFaraRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search registrant, foreign principal, or description…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Country" placeholder="Any country" options={(facets.data?.countries ?? []).map((c) => ({ value: c, label: c }))} values={countries} onChange={setCountries} loading={facets.isLoading} />
            <MultiSelect label="Status" placeholder="Any" options={(facets.data?.statuses ?? []).map((s) => ({ value: s, label: s }))} values={statuses} onChange={setStatuses} loading={facets.isLoading} />
            <MultiSelect label="State" placeholder="Any state" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Most recent registration' },
              { value: 'oldest', label: 'Oldest first' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Reg #', dataIndex: 'registrationNumber', width: 110, render: (r: string) => <span className="num" style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 11 }}>{r}</span> },
          { title: 'Registrant', dataIndex: 'registrantName', ellipsis: true },
          { title: 'Foreign Principal', dataIndex: 'foreignPrincipal', ellipsis: true },
          { title: 'Country', dataIndex: 'country', width: 130, render: (c: string | null) => c ?? '-' },
          { title: 'Status', dataIndex: 'status', width: 110, render: (s: string | null) => s ? <Tag color={s.toLowerCase() === 'active' ? 'green' : 'default'}>{s}</Tag> : '-' },
          { title: 'Registered', dataIndex: 'registrationDate', width: 110, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── SEC filings ────────────────────────────────────────────────────────── */

function SecExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerSecRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search company, description, or CIK…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Form type" placeholder="Any" options={(facets.data?.formTypes ?? []).map((t) => ({ value: t, label: t }))} values={formTypes} onChange={setFormTypes} loading={facets.isLoading} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'Date', dataIndex: 'filingDate', width: 100, render: (d: string) => <span className="num">{formatDate(d)}</span> },
          { title: 'Form', dataIndex: 'formType', width: 90, render: (t: string) => <Tag className="redesign-mono-tag">{t}</Tag> },
          { title: 'Company', dataIndex: 'companyName', ellipsis: true },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'CIK', dataIndex: 'cik', width: 110, render: (c: string) => <span className="num" style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 11 }}>{c}</span> },
        ]}
      />
    </>
  );
}

/* ── SAM.gov contract opportunities ─────────────────────────────────────── */

function SamOppsExplorer() {
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
      <ExplorerFilterBar
        searchPlaceholder="Search title, description, agency, office, or solicitation #…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Notice type" placeholder="Any" options={(facets.data?.noticeTypes ?? []).map((t) => ({ value: t, label: t }))} values={noticeTypes} onChange={setNoticeTypes} loading={facets.isLoading} />
            <MultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <label className="explorer-filter">
              <span className="explorer-filter-label">NAICS</span>
              <Input style={{ width: 110 }} value={naics} onChange={(e) => setNaics(e.target.value.replace(/[^\d]/g, ''))} placeholder="e.g. 3345" />
            </label>
            <label className="explorer-filter">
              <span className="explorer-filter-label">PSC</span>
              <Input style={{ width: 90 }} value={psc} onChange={(e) => setPsc(e.target.value.toUpperCase())} placeholder="e.g. 58" />
            </label>
            <ToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Newest posted' },
              { value: 'deadline', label: 'Response deadline (soonest)' },
              { value: 'oldest', label: 'Oldest posted' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={openNotice}
        columns={[
          { title: 'Posted', dataIndex: 'postedDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (t: string, r: ExplorerSamOppRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t}</a> : t },
          { title: 'Type', dataIndex: 'noticeType', width: 150, render: (t: string) => <Tag className="redesign-mono-tag">{t}</Tag> },
          { title: 'Agency', dataIndex: 'agency', width: 200, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'Office', dataIndex: 'office', width: 170, ellipsis: true, render: (o: string | null) => o ?? '-' },
          { title: 'NAICS', dataIndex: 'naicsCode', width: 80, render: (n: string | null) => n ? <span className="num">{n}</span> : '-' },
          { title: 'Deadline', dataIndex: 'responseDeadline', width: 110, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── Federal awards (USAspending) ───────────────────────────────────────── */

function FederalAwardsExplorer() {
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
      <ExplorerFilterBar
        searchPlaceholder="Search contractor, description, agency, program, or PIID…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <MultiSelect label="State (PoP)" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <MultiSelect label="Fiscal year" placeholder="Any" options={(facets.data?.fiscalYears ?? []).map((y) => ({ value: String(y), label: String(y) }))} values={fiscalYears} onChange={setFiscalYears} loading={facets.isLoading} />
            <label className="explorer-filter">
              <span className="explorer-filter-label">Amount ($)</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Input style={{ width: 110 }} value={minAmount} onChange={(e) => setMinAmount(e.target.value.replace(/[^\d]/g, ''))} placeholder="Min" />
                <span className="explorer-filter-label" style={{ margin: 0 }}>–</span>
                <Input style={{ width: 110 }} value={maxAmount} onChange={(e) => setMaxAmount(e.target.value.replace(/[^\d]/g, ''))} placeholder="Max" />
              </span>
            </label>
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest amount' },
              { value: 'recent', label: 'Most recent action' },
              { value: 'oldest', label: 'Oldest action' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={openAward}
        columns={[
          { title: 'Action date', dataIndex: 'actionDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
          { title: 'Contractor', dataIndex: 'contractorName', width: 200, ellipsis: true, render: (n: string | null, r: ExplorerFederalAwardRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n ?? '(unnamed)'}</a> : (n ?? '-') },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'Agency', dataIndex: 'awardingAgency', width: 160, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right' as const, render: (v: number | null) => <span className="num" style={{ fontWeight: 500 }}>{formatMoney(v)}</span> },
          { title: 'PE', dataIndex: 'peCode', width: 90, render: (p: string | null) => p ? <span className="num" style={{ fontFamily: 'var(--font-mono-rd)', fontSize: 11 }}>{p}</span> : '-' },
          { title: 'FY', dataIndex: 'fundingFy', width: 60, render: (y: number | null) => y ? <span className="num">{y}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── Federal grants (Grants.gov) ────────────────────────────────────────── */

function FederalGrantsExplorer() {
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
      <ExplorerFilterBar
        searchPlaceholder="Search grant title, description, agency, or opportunity #…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <MultiSelect label="Status" placeholder="Any" options={(facets.data?.statuses ?? []).map((s) => ({ value: s, label: s }))} values={statuses} onChange={setStatuses} loading={facets.isLoading} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'recent', label: 'Newest posted' },
              { value: 'close', label: 'Closing soonest' },
              { value: 'oldest', label: 'Oldest posted' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={openGrant}
        columns={[
          { title: 'Posted', dataIndex: 'openDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
          { title: 'Title', dataIndex: 'title', ellipsis: true, render: (t: string, r: ExplorerFederalGrantRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{t}</a> : t },
          { title: 'Agency', dataIndex: 'agency', width: 200, ellipsis: true },
          { title: 'Instrument', dataIndex: 'fundingInstrument', width: 130, render: (i: string | null) => i ? <Tag className="redesign-mono-tag">{i}</Tag> : '-' },
          { title: 'Ceiling', dataIndex: 'awardCeiling', width: 120, align: 'right' as const, render: (v: number | null) => <span className="num">{formatMoney(v)}</span> },
          { title: 'Closes', dataIndex: 'closeDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
          { title: 'Status', dataIndex: 'status', width: 90, render: (s: string | null) => s ? <Tag>{s}</Tag> : '-' },
        ]}
      />
    </>
  );
}

/* ── Federal assistance awards (USAspending, awarded grants) ────────────── */

/**
 * Awarded federal financial assistance — the money that actually went out the
 * door, as distinct from the Grant Opportunities source above (Grants.gov
 * NOFOs, which are forecasts).
 *
 * Obligated and outlayed get their own columns and are never combined:
 * committed and paid are different facts, and a blended figure would answer
 * neither question. `activeOnly` defaults to FALSE here, unlike the SAM.gov and
 * state-legislator sources — this table is a historical record, and defaulting
 * to active-only would silently hide most of it behind a filter the user never
 * asked for.
 */
function FederalAssistanceAwardsExplorer() {
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
      <ExplorerFilterBar
        searchPlaceholder="Search recipient, description, agency, Assistance Listing, FAIN, or exact UEI…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Agency" placeholder="Any" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
            <MultiSelect label="Assistance Listing" placeholder="Any" options={(facets.data?.listings ?? []).map((l) => ({ value: l.code, label: l.title ? `${l.code} — ${l.title}` : l.code }))} values={listings} onChange={setListings} loading={facets.isLoading} />
            <MultiSelect label="State (PoP)" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <label className="explorer-filter">
              <span className="explorer-filter-label">District</span>
              <Input style={{ width: 90 }} maxLength={2} value={district} onChange={(e) => setDistrict(e.target.value.toUpperCase())} placeholder="e.g. 23" />
            </label>
            <MultiSelect label="Award type" placeholder="Any" options={(facets.data?.awardTypes ?? []).map((t) => ({ value: t.code, label: t.label ?? t.code }))} values={awardTypes} onChange={setAwardTypes} loading={facets.isLoading} />
            <NumberRange label="Obligated ($)" minValue={minAmount} maxValue={maxAmount} onMinChange={setMinAmount} onMaxChange={setMaxAmount} />
            <ToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
            <SortControl value={sort} onChange={setSort} options={[
              { value: 'amount', label: 'Largest obligated' },
              { value: 'recent', label: 'Most recently started' },
              { value: 'ending', label: 'Ending soonest' },
            ]} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={openAward}
        columns={[
          { title: 'Recipient', dataIndex: 'recipientName', width: 210, ellipsis: true, render: (n: string | null, r: ExplorerFederalAssistanceAwardRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n ?? '(unnamed)'}</a> : (n ?? '-') },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'Agency', dataIndex: 'awardingAgency', width: 170, ellipsis: true, render: (a: string | null) => a ?? '-' },
          { title: 'ALN', dataIndex: 'assistanceListingNumber', width: 80, render: (c: string | null) => c ? <Tag className="redesign-mono-tag">{c}</Tag> : '-' },
          { title: 'Type', dataIndex: 'awardTypeLabel', width: 130, ellipsis: true, render: (l: string | null) => l ?? '-' },
          { title: 'Obligated', dataIndex: 'totalObligatedAmount', width: 120, align: 'right' as const, render: (v: number | null) => <span className="num" style={{ fontWeight: 500 }}>{formatMoney(v)}</span> },
          { title: 'Outlayed', dataIndex: 'totalOutlayedAmount', width: 110, align: 'right' as const, render: (v: number | null) => <span className="num">{formatMoney(v)}</span> },
          { title: 'PoP', dataIndex: 'popState', width: 80, render: (_s: string | null, r: ExplorerFederalAssistanceAwardRow) => r.popState ? (r.popCongressionalDistrict ? `${r.popState}-${r.popCongressionalDistrict}` : r.popState) : '-' },
          { title: 'Ends', dataIndex: 'endDate', width: 100, render: (d: string | null) => d ? <span className="num">{formatDate(d)}</span> : '-' },
        ]}
      />
    </>
  );
}

/* ── State legislators (OpenStates) ─────────────────────────────────────── */

function StateLegislatorsExplorer() {
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

  const chamberLabel = (c: string) => c === 'upper' ? 'Senate' : c === 'lower' ? 'House' : c;

  return (
    <>
      <ExplorerFilterBar
        searchPlaceholder="Search legislator name or district…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <MultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: chamberLabel(c) }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
            <MultiSelect label="Party" placeholder="Any" options={(facets.data?.parties ?? []).map((pp) => ({ value: pp, label: pp }))} values={parties} onChange={setParties} loading={facets.isLoading} />
            <ToggleChip label="Active only" active={activeOnly} onToggle={() => setActiveOnly((v) => !v)} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={openLegislator}
        columns={[
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string) => <span className="state-pill num">{s}</span> },
          { title: 'Name', dataIndex: 'name', ellipsis: true, render: (n: string, r: ExplorerStateLegislatorRow) => r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{n}</a> : n },
          { title: 'Chamber', dataIndex: 'chamber', width: 110, render: (c: string | null) => c ? chamberLabel(c) : '-' },
          { title: 'District', dataIndex: 'district', width: 110, render: (d: string | null) => d ?? '-' },
          { title: 'Party', dataIndex: 'party', width: 120, render: (p: string | null) => p ? <Tag>{p}</Tag> : '-' },
          { title: 'Email', dataIndex: 'email', ellipsis: true, render: (e: string | null) => e ? <a href={`mailto:${e}`} onClick={(ev) => ev.stopPropagation()}>{e}</a> : '-' },
        ]}
      />
    </>
  );
}

/* ── Intel articles (news feed) ─────────────────────────────────────────── */

function ArticlesExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerIntelArticleRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, sources, topics, agencies]);

  const facets = useQuery<IntelArticleFacets>({
    queryKey: ['explorer-article-facets'],
    queryFn: async () => (await api.get<IntelArticleFacets>('/api/explorer/intel-article-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerIntelArticleRow>>({
    queryKey: ['explorer-articles', q, sources, topics, agencies, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerIntelArticleRow>>('/api/explorer/intel-articles', {
      params: { q: q || undefined, sources: sources.length ? sources.join(',') : undefined, topics: topics.length ? topics.join(',') : undefined, agencies: agencies.length ? agencies.join(',') : undefined, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <ExplorerFilterBar
        searchPlaceholder="Search article title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="Source" placeholder="Any" options={(facets.data?.sources ?? []).map((s) => ({ value: s, label: s }))} values={sources} onChange={setSources} loading={facets.isLoading} />
            <MultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <MultiSelect label="Agency" placeholder="Any agency" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
          </>
        }
      />
      <NewsFeed
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        onArticleClick={onRowClick}
      />
    </>
  );
}

/* ── News feed (editorial layout for the Intel articles source) ─────────── */

function NewsFeed({
  loading,
  rows,
  total,
  page,
  onPageChange,
  onArticleClick,
}: {
  loading: boolean;
  rows: ExplorerIntelArticleRow[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onArticleClick: (id: string, row: ExplorerIntelArticleRow) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="news-feed">
        <div className="news-feed-body">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="news-feed explorer-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No articles match these filters." />
      </div>
    );
  }

  return (
    <div className={`news-feed${loading ? ' is-loading' : ''}`}>
      <div className="explorer-table-meta news-feed-meta">
        <span className="news-feed-count">
          <b>{total.toLocaleString()}</b> article{total === 1 ? '' : 's'} · showing{' '}
          {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}
        </span>
      </div>
      <div className="news-list">
        {rows.map((row, i) => (
          <NewsItem
            key={row.id}
            row={row}
            lead={page === 1 && i === 0}
            onClick={() => onArticleClick(row.id, row)}
          />
        ))}
      </div>
      {total > PAGE_SIZE ? (
        <div className="explorer-pagination">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={onPageChange}
            showSizeChanger={false}
          />
        </div>
      ) : null}
    </div>
  );
}

function NewsItem({
  row,
  lead,
  onClick,
}: {
  row: ExplorerIntelArticleRow;
  lead: boolean;
  onClick: () => void;
}) {
  const brand = sourceBrand(row.source, row.url);
  const tags = [...new Set([...row.topics, ...row.agencies])];
  return (
    <article
      className={`news-item${lead ? ' news-item--lead' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <SourceLogo brand={brand} />
      <div className="news-body">
        <div className="news-meta">
          <span className="news-source" style={{ color: brand.color }}>
            {brand.label}
          </span>
          <span className="news-dot" aria-hidden>
            ·
          </span>
          <span className="news-time num">{relativeTime(row.publishedAt)}</span>
          {row.author ? (
            <>
              <span className="news-dot" aria-hidden>
                ·
              </span>
              <span className="news-author">{row.author}</span>
            </>
          ) : null}
        </div>
        <h3 className="news-headline">{row.title}</h3>
        {row.summary ? <p className="news-summary">{row.summary}</p> : null}
        {tags.length ? (
          <div className="news-topics">
            {tags.slice(0, lead ? 6 : 4).map((t) => (
              <Tag key={t} className="redesign-mono-tag">
                {t}
              </Tag>
            ))}
            {tags.length > (lead ? 6 : 4) ? <Tag>+{tags.length - (lead ? 6 : 4)}</Tag> : null}
          </div>
        ) : null}
      </div>
      <a
        className="news-read"
        href={row.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        Read <GlobalOutlined />
      </a>
    </article>
  );
}

function SourceLogo({ brand }: { brand: SourceBrand }) {
  const [imgOk, setImgOk] = useState(Boolean(brand.host));
  return (
    <span className="news-logo" style={{ '--brand': brand.color } as CSSProperties}>
      {brand.host && imgOk ? (
        <img
          src={`https://icons.duckduckgo.com/ip3/${brand.host}.ico`}
          alt=""
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      ) : (
        <span className="news-logo-mono">{brand.mono}</span>
      )}
    </span>
  );
}

interface SourceBrand {
  label: string;
  host: string;
  color: string;
  mono: string;
}

// Curated brand colors for the outlets Capiro tracks most heavily; anything
// else falls back to a deterministic hue derived from the source name so each
// outlet keeps a stable, recognizable mark across sessions.
const OUTLET_BRANDS: Record<string, string> = {
  politico: '#e5121e',
  'roll call': '#0b6db3',
  rollcall: '#0b6db3',
  'the hill': '#1a8fd0',
  axios: '#0a3ab8',
  punchbowl: '#d94436',
  'punchbowl news': '#d94436',
  reuters: '#ff8000',
  bloomberg: '#1a1a2e',
  'the new york times': '#1a1a1a',
  'washington post': '#1a1a1a',
  'the washington post': '#1a1a1a',
  'wall street journal': '#1a1a1a',
  npr: '#c0143c',
  cnn: '#cc0000',
  'associated press': '#ff322e',
  ap: '#ff322e',
  'federal news network': '#16518a',
  govexec: '#0a6b53',
  'government executive': '#0a6b53',
  'defense news': '#2c5bd4',
  'inside health policy': '#2e6b43',
};

function sourceBrand(source: string | null, url: string | null): SourceBrand {
  const label = (source ?? '').trim();
  const key = label.toLowerCase();
  let host = '';
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const hostKey = host.replace(/\.(com|org|net|gov|news|co)(\.[a-z]{2})?$/i, '');
  const color =
    OUTLET_BRANDS[key] ??
    OUTLET_BRANDS[hostKey] ??
    hashColor(key || host || 'news');
  return { label: label || host || 'News', host, color, mono: monogram(label || host) };
}

function monogram(name: string): string {
  const cleaned = name.replace(/^the\s+/i, '').trim();
  const words = cleaned.split(/[\s.]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || 'N';
}

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 52%, 42%)`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

/* ── State bills ────────────────────────────────────────────────────────── */

function StateBillsExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerStateBillRow) => void }) {
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
      <ExplorerFilterBar
        searchPlaceholder="Search bill title, identifier, sponsor, or action…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <MultiSelect label="State" placeholder="Any" options={(facets.data?.states ?? []).map((s) => ({ value: s, label: s }))} values={states} onChange={setStates} loading={facets.isLoading} />
            <MultiSelect label="Subject" placeholder="Any subject" options={(facets.data?.subjects ?? []).map((s) => ({ value: s, label: s }))} values={subjects} onChange={setSubjects} loading={facets.isLoading} />
            <MultiSelect label="Sponsor party" placeholder="Any" options={(facets.data?.parties ?? []).map((p) => ({ value: p, label: p }))} values={sponsorParty} onChange={setSponsorParty} loading={facets.isLoading} />
            <MultiSelect label="Chamber" placeholder="Any" options={(facets.data?.chambers ?? []).map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} values={chambers} onChange={setChambers} loading={facets.isLoading} />
          </>
        }
      />
      <ExplorerTable
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        rowKey="id"
        onRowClick={onRowClick}
        columns={[
          { title: 'State', dataIndex: 'state', width: 70, render: (s: string) => <span className="state-pill num">{s}</span> },
          { title: 'Bill', dataIndex: 'identifier', width: 100, render: (id: string) => <span className="num" style={{ fontWeight: 600 }}>{id}</span> },
          { title: 'Title', dataIndex: 'title', ellipsis: true },
          { title: 'Status', dataIndex: 'status', width: 130, render: (s: string | null | undefined) => (s ? <Tag className="redesign-mono-tag">{stateBillStatusLabel(s)}</Tag> : '-') },
          { title: 'Sponsor', dataIndex: 'sponsorName', width: 180, render: (n: string | null, r: ExplorerStateBillRow) => n ? (
            <span>
              {n}
              {r.sponsorParty ? <span style={{ marginLeft: 6, fontSize: 10.5, fontFamily: 'var(--font-mono-rd)', color: 'var(--ink-3)' }}>({r.sponsorParty})</span> : null}
            </span>
          ) : '-' },
          { title: 'Latest action', dataIndex: 'latestActionText', ellipsis: true, render: (text: string | null, r: ExplorerStateBillRow) => (
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12.5 }}>{text ?? '-'}</span>
              {r.latestActionDate ? <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{formatDate(r.latestActionDate)}</span> : null}
            </span>
          ) },
        ]}
      />
    </>
  );
}

/* ── Drill-in drawer ────────────────────────────────────────────────────── */

function ExplorerDrillInDrawer({
  drillIn,
  onClose,
}: {
  drillIn: DrillIn;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={drillIn !== null}
      onClose={onClose}
      width={Math.min(640, typeof window !== 'undefined' ? window.innerWidth - 60 : 640)}
      destroyOnClose
      title={
        drillIn ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {SOURCES.find((s) => s.key === drillIn.source)?.label}
            </span>
            <span style={{ color: 'var(--ink-4)' }}>·</span>
            <span style={{ fontWeight: 600, color: 'var(--ink-1)' }}>{drillIn.rowSummary}</span>
          </span>
        ) : null
      }
      className="explorer-drill-drawer"
    >
      {drillIn ? <DrillInContent drillIn={drillIn} /> : null}
    </Drawer>
  );
}

function DrillInContent({ drillIn }: { drillIn: NonNullable<DrillIn> }) {
  if (drillIn.source === 'lda') return <LdaFilingDetailView id={drillIn.id} />;
  if (drillIn.source === 'bills') return <BillDetailView id={drillIn.id} />;
  if (drillIn.source === 'contractors') return <ContractorDetailView id={drillIn.id} />;
  if (drillIn.source === 'fedreg' || drillIn.source === 'comment-deadlines')
    return <FedRegDetailView id={drillIn.id} />;
  if (drillIn.source === 'hearings') return <HearingDetailView id={drillIn.id} />;
  if (drillIn.source === 'gao') return <GaoDetailView id={drillIn.id} />;
  if (drillIn.source === 'crs') return <CrsDetailView id={drillIn.id} />;
  if (drillIn.source === 'fec') return <FecDetailView id={drillIn.id} />;
  if (drillIn.source === 'fara') return <FaraDetailView id={drillIn.id} />;
  if (drillIn.source === 'sec') return <SecDetailView id={drillIn.id} />;
  if (drillIn.source === 'articles') return <IntelArticleDetailView id={drillIn.id} />;
  if (drillIn.source === 'state-bills') return <StateBillDetailView id={drillIn.id} />;
  return (
    <div style={{ padding: 24, fontSize: 12.5, color: 'var(--ink-3)' }}>
      Detailed view for this source isn't wired yet.
    </div>
  );
}

function LdaFilingDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<LdaFilingDetail | null>({
    queryKey: ['explorer-lda-detail', id],
    queryFn: async () => (await api.get<LdaFilingDetail>(`/api/explorer/lda-filings/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Filing not found." />;
  const { filing, registrantRecent, clientRecent, issueCodes } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Filing">
        <DrillKV label="Filing UUID" value={<span className="num">{filing.filingUuid}</span>} />
        <DrillKV label="Type" value={filing.filingType} />
        <DrillKV label="Year / period" value={`${filing.filingYear}${filing.filingPeriod ? ` · ${filing.filingPeriod}` : ''}`} />
        <DrillKV label="Posted" value={filing.dtPosted ? formatDate(filing.dtPosted) : '-'} />
        <DrillKV label="Income" value={<span className="num">{formatMoney(filing.income)}</span>} />
        <DrillKV label="Expenses" value={<span className="num">{formatMoney(filing.expenses ?? null)}</span>} />
        <DrillKV label="Registrant" value={filing.registrantName} />
        <DrillKV label="Client" value={`${filing.clientName}${filing.clientState ? ` (${filing.clientState})` : ''}`} />
      </DrillSection>

      {issueCodes.length ? (
        <DrillSection title="Issue codes">
          <ul className="drill-list">
            {issueCodes.map((c) => (
              <li key={c.code}>
                <Tag className="redesign-mono-tag">{c.code}</Tag>
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {registrantRecent.length ? (
        <DrillSection title={`Other recent filings by ${filing.registrantName}`}>
          <ul className="drill-list">
            {registrantRecent.map((r) => (
              <li key={r.id}>
                <span className="num">{r.filingYear}{r.filingPeriod ? ` · ${r.filingPeriod}` : ''}</span>
                <span>{r.clientName}</span>
                <span className="num drill-amount">{formatMoney(r.income)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {clientRecent.length ? (
        <DrillSection title={`Other lobbying for ${filing.clientName}`}>
          <ul className="drill-list">
            {clientRecent.map((r) => (
              <li key={r.id}>
                <span className="num">{r.filingYear}{r.filingPeriod ? ` · ${r.filingPeriod}` : ''}</span>
                <span>{r.registrantName}</span>
                <span className="num drill-amount">{formatMoney(r.income)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

// Delegates to the shared BillDetailBody (bill-detail.tsx) so the Explorer
// drill-in and the Radar BillDrawer (P7) render the identical detail from ONE
// fetch hook — no duplicated query/render logic.
function BillDetailView({ id }: { id: string }) {
  return <BillDetailBody id={id} />;
}

function ContractorDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<ContractorDetail | null>({
    queryKey: ['explorer-contractor-detail', id],
    queryFn: async () => (await api.get<ContractorDetail>(`/api/explorer/federal-contractors/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Contractor not found." />;
  const { contractor } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Contractor">
        <DrillKV label="Name" value={contractor.name} />
        <DrillKV label="UEI" value={contractor.uei ? <span className="num" style={{ fontFamily: 'var(--font-mono-rd)' }}>{contractor.uei}</span> : '-'} />
        <DrillKV label="Category" value={contractor.category ?? '-'} />
        <DrillKV label="Rank" value={contractor.rankByContracts ? `#${contractor.rankByContracts}` : '-'} />
        <DrillKV label="Total contracts" value={<span className="num">{formatMoney(contractor.totalContracts)}</span>} />
        <DrillKV label="No-bid total" value={<span className="num" style={{ color: contractor.noBidTotal && contractor.noBidTotal > 0 ? 'var(--critical)' : 'var(--ink-3)' }}>{formatMoney(contractor.noBidTotal)}</span>} />
      </DrillSection>

      {contractor.topAgencies?.length ? (
        <DrillSection title="Top agencies">
          <ul className="drill-list">
            {contractor.topAgencies.slice(0, 10).map((a, i) => (
              <li key={i}>
                <span>{a.name}</span>
                <span className="num drill-amount">{formatMoney(a.amount)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}

      {contractor.yearlySpend?.length ? (
        <DrillSection title="Yearly spend">
          <ul className="drill-list">
            {contractor.yearlySpend.slice(0, 8).map((y) => (
              <li key={y.year}>
                <span className="num">{y.year}</span>
                <span className="num drill-amount">{formatMoney(y.amount)}</span>
              </li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

function FedRegDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FedRegDetail | null>({
    queryKey: ['explorer-fed-reg-detail', id],
    queryFn: async () => (await api.get<FedRegDetail>(`/api/explorer/federal-register/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Document not found." />;
  const { document } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Document">
        <DrillKV label="Title" value={document.title} />
        <DrillKV label="Type" value={document.type.replace(/_/g, ' ')} />
        <DrillKV label="Doc #" value={<span className="num">{document.documentNumber}</span>} />
        <DrillKV label="Agency" value={document.agencyNames.join(' / ')} />
        <DrillKV label="Published" value={formatDate(document.publicationDate)} />
        <DrillKV label="Comment closes" value={document.commentEndDate ? formatDate(document.commentEndDate) : '-'} />
        <DrillKV label="Effective" value={document.effectiveDate ? formatDate(document.effectiveDate) : '-'} />
        <DrillKV label="Significant rule" value={document.significantRule ? 'Yes' : 'No'} />
        {document.htmlUrl ? <DrillKV label="Federal Register" value={<a href={document.htmlUrl} target="_blank" rel="noreferrer">View on FederalRegister.gov →</a>} /> : null}
      </DrillSection>

      {document.abstract ? (
        <DrillSection title="Abstract">
          <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)' }}>{document.abstract}</p>
        </DrillSection>
      ) : null}

      {document.topics?.length ? (
        <DrillSection title="Topics">
          <ChipList items={document.topics} max={20} />
        </DrillSection>
      ) : null}
    </div>
  );
}

function HearingDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<HearingDetail | null>({
    queryKey: ['explorer-hearing-detail', id],
    queryFn: async () => (await api.get<HearingDetail>(`/api/explorer/hearings/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Hearing not found." />;
  const { hearing } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Hearing">
        <DrillKV label="Title" value={hearing.title} />
        <DrillKV label="Chamber" value={hearing.chamber} />
        <DrillKV label="Committee" value={hearing.committeeName} />
        {hearing.committeeCode ? <DrillKV label="Code" value={<span className="num">{hearing.committeeCode}</span>} /> : null}
        <DrillKV label="Date" value={formatDate(hearing.date)} />
        {hearing.time ? <DrillKV label="Time" value={hearing.time} /> : null}
        {hearing.location ? <DrillKV label="Location" value={hearing.location} /> : null}
        {hearing.type ? <DrillKV label="Type" value={hearing.type} /> : null}
        {hearing.url ? <DrillKV label="Source" value={<a href={hearing.url} target="_blank" rel="noreferrer">Open hearing page →</a>} /> : null}
      </DrillSection>
      {hearing.witnesses?.length ? (
        <DrillSection title={`Witnesses (${hearing.witnesses.length})`}>
          <ul className="drill-list">
            {hearing.witnesses.map((w, i) => (
              <li key={i}><span>{w}</span></li>
            ))}
          </ul>
        </DrillSection>
      ) : null}
    </div>
  );
}

function GaoDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<GaoDetail | null>({
    queryKey: ['explorer-gao-detail', id],
    queryFn: async () => (await api.get<GaoDetail>(`/api/explorer/gao/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="GAO report not found." />;
  const { report } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Report">
        <DrillKV label="Title" value={report.title} />
        <DrillKV label="ID" value={<span className="num">{report.id}</span>} />
        {report.reportType ? <DrillKV label="Type" value={report.reportType} /> : null}
        {report.publishDate ? <DrillKV label="Published" value={formatDate(report.publishDate)} /> : null}
        {report.recommendations != null ? <DrillKV label="Recommendations" value={<span className="num">{report.recommendations}</span>} /> : null}
        {report.url ? <DrillKV label="Source" value={<a href={report.url} target="_blank" rel="noreferrer">Open on gao.gov →</a>} /> : null}
      </DrillSection>
      {report.summary ? (
        <DrillSection title="Summary">
          <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)' }}>{report.summary}</p>
        </DrillSection>
      ) : null}
      {report.topics?.length ? <DrillSection title="Topics"><ChipList items={report.topics} max={20} /></DrillSection> : null}
      {report.agencies?.length ? <DrillSection title="Agencies"><ChipList items={report.agencies} max={20} /></DrillSection> : null}
    </div>
  );
}

function CrsDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<CrsDetail | null>({
    queryKey: ['explorer-crs-detail', id],
    queryFn: async () => (await api.get<CrsDetail>(`/api/explorer/crs/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="CRS report not found." />;
  const { report } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Report">
        <DrillKV label="Title" value={report.title} />
        <DrillKV label="ID" value={<span className="num">{report.id}</span>} />
        {report.date ? <DrillKV label="Date" value={formatDate(report.date)} /> : null}
        <DrillKV label="Active" value={report.active ? 'Yes' : 'Archived'} />
        {report.htmlUrl ? <DrillKV label="HTML" value={<a href={report.htmlUrl} target="_blank" rel="noreferrer">Open HTML →</a>} /> : null}
        {report.pdfUrl ? <DrillKV label="PDF" value={<a href={report.pdfUrl} target="_blank" rel="noreferrer">Open PDF →</a>} /> : null}
      </DrillSection>
      {report.summary ? <DrillSection title="Summary"><p style={{ fontSize: 13, lineHeight: 1.55 }}>{report.summary}</p></DrillSection> : null}
      {report.authors?.length ? <DrillSection title="Authors"><ChipList items={report.authors} max={10} /></DrillSection> : null}
      {report.topics?.length ? <DrillSection title="Topics"><ChipList items={report.topics} max={20} /></DrillSection> : null}
    </div>
  );
}

function FecDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FecDetail | null>({
    queryKey: ['explorer-fec-detail', id],
    queryFn: async () => (await api.get<FecDetail>(`/api/explorer/fec-contributions/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Contribution not found." />;
  const { contribution: c } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Contribution">
        <DrillKV label="Amount" value={<span className="num drill-amount">{formatMoney(c.amount)}</span>} />
        {c.contributionDate ? <DrillKV label="Date" value={formatDate(c.contributionDate)} /> : null}
        {c.cycle ? <DrillKV label="Cycle" value={<span className="num">{c.cycle}</span>} /> : null}
        {c.receiptType ? <DrillKV label="Type" value={c.receiptType} /> : null}
        {c.state ? <DrillKV label="State" value={c.state} /> : null}
        {c.transactionId ? <DrillKV label="Tx ID" value={<span className="num">{c.transactionId}</span>} /> : null}
      </DrillSection>
      <DrillSection title="Contributor">
        {c.contributorName ? <DrillKV label="Name" value={c.contributorName} /> : null}
        {c.contributorEmployer ? <DrillKV label="Employer" value={c.contributorEmployer} /> : null}
        {c.contributorOccupation ? <DrillKV label="Occupation" value={c.contributorOccupation} /> : null}
      </DrillSection>
      <DrillSection title="Recipient">
        {c.committeeName ? <DrillKV label="Committee" value={c.committeeName} /> : null}
        <DrillKV label="Committee ID" value={<span className="num">{c.committeeId}</span>} />
        {c.candidateName ? <DrillKV label="Candidate" value={c.candidateName} /> : null}
        {c.candidateId ? <DrillKV label="Candidate ID" value={<span className="num">{c.candidateId}</span>} /> : null}
      </DrillSection>
      {c.memoText ? <DrillSection title="Memo"><p style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{c.memoText}</p></DrillSection> : null}
    </div>
  );
}

function FaraDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<FaraDetail | null>({
    queryKey: ['explorer-fara-detail', id],
    queryFn: async () => (await api.get<FaraDetail>(`/api/explorer/fara/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="FARA registration not found." />;
  const { registration: r } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Registration">
        <DrillKV label="Registrant" value={r.registrantName} />
        <DrillKV label="Reg. #" value={<span className="num">{r.registrationNumber}</span>} />
        {r.status ? <DrillKV label="Status" value={r.status} /> : null}
        {r.registrationDate ? <DrillKV label="Registered" value={formatDate(r.registrationDate)} /> : null}
        {r.terminationDate ? <DrillKV label="Terminated" value={formatDate(r.terminationDate)} /> : null}
        {r.state ? <DrillKV label="State" value={r.state} /> : null}
      </DrillSection>
      <DrillSection title="Foreign Principal">
        <DrillKV label="Principal" value={r.foreignPrincipal} />
        {r.country ? <DrillKV label="Country" value={r.country} /> : null}
      </DrillSection>
      {r.description ? <DrillSection title="Description"><p style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{r.description}</p></DrillSection> : null}
      {r.services ? <DrillSection title="Services"><p style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{r.services}</p></DrillSection> : null}
    </div>
  );
}

function SecDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<SecDetail | null>({
    queryKey: ['explorer-sec-detail', id],
    queryFn: async () => (await api.get<SecDetail>(`/api/explorer/sec/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Filing not found." />;
  const { filing: f } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Filing">
        <DrillKV label="Company" value={f.companyName} />
        <DrillKV label="CIK" value={<span className="num">{f.cik}</span>} />
        <DrillKV label="Form" value={<Tag className="redesign-mono-tag">{f.formType}</Tag>} />
        <DrillKV label="Accession #" value={<span className="num">{f.accessionNumber}</span>} />
        <DrillKV label="Filed" value={formatDate(f.filingDate)} />
        {f.reportDate ? <DrillKV label="Reporting period" value={formatDate(f.reportDate)} /> : null}
        {f.sic ? <DrillKV label="SIC" value={<span className="num">{f.sic}</span>} /> : null}
        {f.stateOfIncorp ? <DrillKV label="State of incorporation" value={f.stateOfIncorp} /> : null}
        {f.fiscalYearEnd ? <DrillKV label="Fiscal year end" value={<span className="num">{f.fiscalYearEnd}</span>} /> : null}
        {f.url ? <DrillKV label="EDGAR" value={<a href={f.url} target="_blank" rel="noreferrer">Open on SEC.gov →</a>} /> : null}
        {f.primaryDoc ? <DrillKV label="Primary doc" value={<span className="num">{f.primaryDoc}</span>} /> : null}
      </DrillSection>
      {f.description ? <DrillSection title="Description"><p style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{f.description}</p></DrillSection> : null}
    </div>
  );
}

function IntelArticleDetailView({ id }: { id: string }) {
  const api = useApi();
  const query = useQuery<IntelArticleDetail | null>({
    queryKey: ['explorer-article-detail', id],
    queryFn: async () => (await api.get<IntelArticleDetail>(`/api/explorer/intel-articles/${id}`)).data,
  });
  if (query.isLoading) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!query.data) return <Empty description="Article not found." />;
  const { article: a } = query.data;
  return (
    <div className="drill-content">
      <DrillSection title="Article">
        <DrillKV label="Title" value={a.title} />
        <DrillKV label="Source" value={<Tag className="redesign-mono-tag">{a.source}</Tag>} />
        {a.author ? <DrillKV label="Author" value={a.author} /> : null}
        <DrillKV label="Published" value={formatDate(a.publishedAt)} />
        <DrillKV label="Link" value={<a href={a.url} target="_blank" rel="noreferrer">Open article →</a>} />
        {a.feedUrl ? <DrillKV label="Feed" value={<a href={a.feedUrl} target="_blank" rel="noreferrer">{a.feedUrl}</a>} /> : null}
      </DrillSection>
      {a.summary ? <DrillSection title="Summary"><p style={{ fontSize: 13, lineHeight: 1.55 }}>{a.summary}</p></DrillSection> : null}
      {a.content ? <DrillSection title="Excerpt"><p style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>{a.content}</p></DrillSection> : null}
      {a.topics?.length ? <DrillSection title="Topics"><ChipList items={a.topics} max={20} /></DrillSection> : null}
      {a.agencies?.length ? <DrillSection title="Agencies"><ChipList items={a.agencies} max={20} /></DrillSection> : null}
    </div>
  );
}

// Delegates to the shared StateBillDetailBody (state-bill-detail.tsx, S7.3) so
// the Explorer drill-in and the Radar bill drawer's jurisdiction-aware body
// render identically with no duplicated fetch logic (mirrors BillDetailView).
function StateBillDetailView({ id }: { id: string }) {
  return <StateBillDetailBody id={id} />;
}

function DrillSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="drill-section">
      <h3 className="drill-section-title">{title}</h3>
      {children}
    </section>
  );
}

function DrillKV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="drill-kv">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

function ChipList({ items, max }: { items: string[]; max: number }) {
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.slice(0, max).map((it) => (
        <Tag key={it} className="redesign-mono-tag">
          {it}
        </Tag>
      ))}
      {items.length > max ? <Tag>+{items.length - max}</Tag> : null}
    </span>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function ExplorerFilterBar({
  searchPlaceholder,
  searchInput,
  onSearchInput,
  onSearchSubmit,
  onClearSearch,
  controls,
}: {
  searchPlaceholder: string;
  searchInput: string;
  onSearchInput: (value: string) => void;
  onSearchSubmit: () => void;
  onClearSearch: () => void;
  controls: ReactNode;
}) {
  return (
    <div className="explorer-filter-bar">
      <Input
        allowClear
        size="large"
        prefix={<SearchOutlined />}
        value={searchInput}
        placeholder={searchPlaceholder}
        onChange={(event) => onSearchInput(event.target.value)}
        onPressEnter={onSearchSubmit}
        onClear={onClearSearch}
        className="explorer-search-input"
      />
      <div className="explorer-filter-controls">{controls}</div>
    </div>
  );
}

function MultiSelect({
  label,
  placeholder,
  options,
  values,
  onChange,
  loading,
}: {
  label: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (values: string[]) => void;
  loading?: boolean;
}) {
  return (
    <label className="explorer-filter">
      <span className="explorer-filter-label">{label}</span>
      <Select
        mode="multiple"
        allowClear
        maxTagCount="responsive"
        placeholder={placeholder}
        options={options}
        value={values}
        loading={loading}
        onChange={(next) => onChange(next as string[])}
        style={{ minWidth: 160 }}
      />
    </label>
  );
}

function SortControl({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="explorer-filter">
      <span className="explorer-filter-label">Sort</span>
      <Select
        options={options}
        value={value}
        onChange={(next) => onChange(next as string)}
        style={{ minWidth: 180 }}
      />
    </label>
  );
}

function NumberRange({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
}: {
  label: string;
  minValue: number | null;
  maxValue: number | null;
  onMinChange: (value: number | null) => void;
  onMaxChange: (value: number | null) => void;
}) {
  return (
    <label className="explorer-filter">
      <span className="explorer-filter-label">{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <InputNumber
          placeholder="Min"
          min={0}
          value={minValue}
          onChange={(v) => onMinChange(typeof v === 'number' ? v : null)}
          controls={false}
          style={{ width: 110 }}
          formatter={(v) => (v ? `$${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '')}
          parser={(v) => (v ? Number(v.replace(/[$,]/g, '')) : 0)}
        />
        <span className="explorer-filter-label" style={{ margin: 0 }}>–</span>
        <InputNumber
          placeholder="Max"
          min={0}
          value={maxValue}
          onChange={(v) => onMaxChange(typeof v === 'number' ? v : null)}
          controls={false}
          style={{ width: 110 }}
          formatter={(v) => (v ? `$${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '')}
          parser={(v) => (v ? Number(v.replace(/[$,]/g, '')) : 0)}
        />
      </span>
    </label>
  );
}

function ToggleChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`explorer-toggle-chip${active ? ' is-active' : ''}`}
      onClick={onToggle}
    >
      <span className="explorer-toggle-checkbox" aria-hidden>
        {active ? '✓' : ''}
      </span>
      {label}
    </button>
  );
}

function ExplorerTable<T extends { id: string }>({
  loading,
  rows,
  total,
  page,
  onPageChange,
  rowKey,
  columns,
  onRowClick,
}: {
  loading: boolean;
  rows: T[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  rowKey: keyof T;
  columns: Parameters<typeof Table<T>>[0]['columns'];
  onRowClick?: (id: string, row: T) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="explorer-table-shell">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="explorer-table-shell explorer-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No rows match these filters." />
      </div>
    );
  }

  return (
    <div className="explorer-table-shell">
      <div className="explorer-table-meta">
        <Typography.Text type="secondary">
          <b>{total.toLocaleString()}</b> record{total === 1 ? '' : 's'} · showing{' '}
          {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}
        </Typography.Text>
      </div>
      <Table<T>
        size="middle"
        rowKey={rowKey as string}
        dataSource={rows}
        columns={columns}
        pagination={false}
        loading={loading}
        onRow={(record) =>
          onRowClick
            ? {
                onClick: () => onRowClick(record.id, record),
                style: { cursor: 'pointer' },
              }
            : {}
        }
      />
      {total > PAGE_SIZE ? (
        <div className="explorer-pagination">
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={onPageChange}
            showSizeChanger={false}
          />
        </div>
      ) : null}
    </div>
  );
}

/* ── Formatters ──────────────────────────────────────────────────────────── */

function formatMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function partyName(short: string): string {
  if (short === 'D') return 'Democrat';
  if (short === 'R') return 'Republican';
  if (short === 'I') return 'Independent';
  return short;
}

const _placeholder = useMemo;
void _placeholder;
