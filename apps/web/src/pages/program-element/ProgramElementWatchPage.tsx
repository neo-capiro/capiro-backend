import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Empty, Skeleton, Tabs, Tag, Tooltip, message } from 'antd';
import {
  BellFilled,
  BellOutlined,
  FileSearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import { IntelligenceChips } from './IntelligenceChips.js';
import { PdocDetailPanel, type PdocDetail } from './PdocDetailPanel.js';
import { DescriptionPanel, type DescriptionSource } from './DescriptionPanel.js';
import {
  AppropriabilityPanel,
  BudgetActionsFeed,
  IncumbentMapPanel,
  LinkedLinesRail,
  MaturityLadderPanel,
  RelationshipGraphPanel,
} from './BudgetLinePanels.js';
import {
  getBudgetActions,
  getBudgetLineRelationships,
  getIncumbents,
  getProgramElementBillActions,
  getProgramElementBills,
  getProgramElementContractors,
  getProgramElementDeltas,
  getProgramElementDetail,
  getProgramElementPersonnel,
  getProgramElementSources,
  getProgramElementIntelligence,
  getProgramElementProjects,
  getProgramElementRelated,
  getProgramElementProvisions,
  getProgramElementOpportunities,
  getProgramElementProcurementLines,
} from './api.js';
import { FyHistoryChart } from './FyHistoryChart.js';
import { FundingNarrativePanel } from './FundingNarrativePanel.js';
import { buildFundingSeries, STAGE_LABEL } from './funding-model.js';
import { BillsTouchingPePanel } from './BillsTouchingPePanel.js';
import { ContractorsPanel } from './ContractorsPanel.js';
import { ProofPackPanel } from './ProofPackPanel.js';
import { WhatChangedPanel } from './WhatChangedPanel.js';
import { ProgramsPanel } from './ProgramsPanel.js';
import { getProgramsForPe } from './programs-api.js';
import { ClientRelevancePanel } from './ClientRelevancePanel.js';
import { getRelevantClientsForPe } from '../clients/relevance-api.js';
import { FyDetailDrawer } from './FyDetailDrawer.js';
import { LinkCrmContactModal } from './LinkCrmContactModal.js';
import { ProgramTeamPanel } from './ProgramTeamPanel.js';
import { ProjectsPanel } from './ProjectsPanel.js';
import { ProvisionsPanel } from './ProvisionsPanel.js';
import { ProcurementActivityPanel } from './ProcurementActivityPanel.js';
import { RelatedPesPanel } from './RelatedPesPanel.js';
import { SecondaryDistributionPanel } from './SecondaryDistributionPanel.js';
import { LINE_TYPES, useWatchToggle } from './pe-shared.js';
import { PeTrustHeader } from './PeTrustHeader.js';
import { PeLoadState } from './PeLoadState.js';
import {
  anyEnabledSecondaryFailed,
  filterTabsForLineType,
  parsePeWatchFy,
  parsePeWatchTab,
  peWatchQueryEnabled,
  resolvePeSurfaceState,
  serializePeWatchUrlState,
  yearsHaveStageValue,
  type PeWatchTab,
} from './trust-model.js';
import { Sparkline, LineChart, DeltaBars, Donut, HBars, fmtMoneyM } from './charts/index.js';
import type {
  ProgramElementBill,
  ProgramElementContractorsResponse,
  ProgramElementHistoryRow,
  ProgramElementYearPoint,
  ProgramTeamPerson,
} from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceFromRaw(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const candidate = raw as { sourceAttribution?: unknown };
  if (!candidate.sourceAttribution || typeof candidate.sourceAttribution !== 'object') return {};
  const src = candidate.sourceAttribution as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function toHistoryRow(year: ProgramElementYearPoint): ProgramElementHistoryRow {
  return {
    id: year.id,
    fy: year.fy,
    request: numberOrNull(year.request),
    hascMark: numberOrNull(year.hascMark),
    sascMark: numberOrNull(year.sascMark),
    hacDMark: numberOrNull(year.hacDMark),
    sacDMark: numberOrNull(year.sacDMark),
    conference: numberOrNull(year.conference),
    ndaaConference: numberOrNull(year.ndaaConference),
    enacted: numberOrNull(year.enacted),
    // Phase 5: never flag "projected enacted" — missing enacted stays null.
    projectedEnacted: false,
    sourceAttribution: sourceFromRaw(year.raw),
  };
}

function toHistoryRows(years: ProgramElementYearPoint[]): ProgramElementHistoryRow[] {
  return [...years].sort((a, b) => a.fy - b.fy).map(toHistoryRow);
}

/** Most recent FY where a metric has a real (non-null) value — explicit $0 counts. */
function latestMeaningful(
  years: ProgramElementYearPoint[],
  field: 'request' | 'enacted' | 'conference',
): { fy: number; value: number } | undefined {
  for (const y of [...years].sort((a, b) => b.fy - a.fy)) {
    const raw = y[field];
    if (raw == null) continue;
    const num = Number(raw);
    // Phase 5 B6: do not skip num===0 — a real zero is a real stage value.
    if (Number.isFinite(num)) return { fy: y.fy, value: num };
  }
  return undefined;
}

function formatSyncedDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusPillClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes('active') || normalized.includes('enacted')) return 'success';
  if (normalized.includes('terminat') || normalized.includes('cancel')) return 'critical';
  return 'muted';
}

function peBadge(detail: {
  budgetActivity: string | null;
  appropriationType: string | null;
}): string {
  const ba = detail.budgetActivity ?? '';
  const m = ba.match(/(\d(?:\.\d)?)/);
  if (m) return `BA ${m[1]}`;
  return detail.appropriationType ? detail.appropriationType.slice(0, 6) : 'PE';
}

const KIND_COLOR: Record<string, string> = {
  intro: '#8A8780',
  report: '#2C5BD4',
  markup: '#A26913',
  pass: '#2A57CE',
  law: '#2E6B43',
};

/** Classify a bill's latest-action text into a timeline milestone kind. */
function classifyAction(text: string | null | undefined): keyof typeof KIND_COLOR {
  const t = (text ?? '').toLowerCase();
  if (t.includes('became law') || t.includes('public law') || t.includes('signed by president'))
    return 'law';
  if (t.includes('passed') || t.includes('agreed to')) return 'pass';
  if (t.includes('markup') || t.includes('ordered to be reported')) return 'markup';
  if (t.includes('reported')) return 'report';
  return 'intro';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function fyLabel(fy: number): string {
  return `FY${String(fy).slice(-2)}`;
}

/** Line type from appropriation (mirrors LINE_TYPE_FOR in budget-lines-read.service).
 *  Drives which type-specific tabs/panels the 360 profile shows. */
function lineTypeFor(appropriationType: string | null | undefined): string | null {
  const t = (appropriationType ?? '').toUpperCase();
  if (t.startsWith('RDT')) return 'RDTE_PE';
  if (t === 'PROC') return 'PROCUREMENT_BLIN';
  if (t === 'OM') return 'OM_BLI';
  return null;
}

/** A chart-surface card wrapper matching the redesign spec. */
function ChartCard({
  title,
  sub,
  extra,
  span2,
  pad,
  children,
}: {
  title: string;
  sub?: string;
  extra?: React.ReactNode;
  span2?: boolean;
  pad?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`pe-surface pe-chart-surface${span2 ? ' span-2' : ''}`}>
      <div className="pe-surface-head">
        <h3>{title}</h3>
        {sub ? <span className="pe-surface-sub">{sub}</span> : null}
        {extra}
      </div>
      <div className={`pe-chart-body${pad ? ' pad' : ''}`}>{children}</div>
    </div>
  );
}

export function ProgramElementWatchPage() {
  const { peCode = '' } = useParams<{ peCode: string }>();
  const normalizedPeCode = peCode.toUpperCase();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const api = useApi();
  const pePresent = normalizedPeCode.length > 0;

  const urlTab = parsePeWatchTab(searchParams.get('tab'));
  const urlFy = parsePeWatchFy(searchParams.get('fy'));
  const [activeTab, setActiveTab] = useState<PeWatchTab>(urlTab);
  const [selectedFy, setSelectedFy] = useState<number | null>(urlFy);
  const [drawerOpen, setDrawerOpen] = useState(urlFy != null);
  const [linkTarget, setLinkTarget] = useState<{ id: string; name: string } | null>(null);

  // Keep local tab/fy in sync when the user lands via a shared deep-link.
  useEffect(() => {
    setActiveTab(urlTab);
  }, [urlTab]);
  useEffect(() => {
    if (urlFy != null) {
      setSelectedFy(urlFy);
      setDrawerOpen(true);
    }
  }, [urlFy]);

  const writeUrl = useCallback(
    (next: { tab?: PeWatchTab; fy?: number | null }) => {
      const tab = next.tab ?? activeTab;
      const fy = next.fy !== undefined ? next.fy : selectedFy;
      const qs = serializePeWatchUrlState({ tab, fy });
      setSearchParams(qs ? new URLSearchParams(qs) : new URLSearchParams(), { replace: true });
    },
    [activeTab, selectedFy, setSearchParams],
  );

  const onTabChange = (key: string) => {
    const tab = parsePeWatchTab(key);
    setActiveTab(tab);
    writeUrl({ tab });
  };

  const watch = useWatchToggle();

  const q = (bucket: Parameters<typeof peWatchQueryEnabled>[1]) =>
    peWatchQueryEnabled(activeTab, bucket, pePresent);

  const detailQuery = useQuery({
    queryKey: ['program-element-detail', normalizedPeCode],
    queryFn: () => getProgramElementDetail(api, normalizedPeCode),
    staleTime: 5 * 60 * 1000,
    enabled: pePresent,
  });

  // Always-on for hero BPM counts / classification when detail opens.
  const billsQuery = useQuery({
    queryKey: ['program-element-bills', normalizedPeCode],
    queryFn: () => getProgramElementBills(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('bills'),
  });

  const contractorsQuery = useQuery({
    queryKey: ['program-element-contractors', normalizedPeCode],
    queryFn: () => getProgramElementContractors(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('contractors'),
  });

  const programTeamQuery = useQuery({
    queryKey: ['program-element-personnel', normalizedPeCode],
    queryFn: () => getProgramElementPersonnel(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('personnel'),
  });

  const sourcesQuery = useQuery({
    queryKey: ['program-element-sources', normalizedPeCode],
    queryFn: () => getProgramElementSources(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('sources'),
  });

  const programsQuery = useQuery({
    queryKey: ['program-element-programs', normalizedPeCode],
    queryFn: () => getProgramsForPe(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('programs'),
  });

  const clientRelevanceQuery = useQuery({
    queryKey: ['program-element-client-relevance', normalizedPeCode],
    queryFn: () => getRelevantClientsForPe(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('clientRelevance'),
  });

  const intelligenceQuery = useQuery({
    queryKey: ['program-element-intelligence', normalizedPeCode],
    queryFn: () => getProgramElementIntelligence(api, normalizedPeCode),
    enabled: q('intelligence'),
    staleTime: 5 * 60 * 1000,
  });

  const deltasQuery = useQuery({
    queryKey: ['program-element-deltas', normalizedPeCode],
    queryFn: () => getProgramElementDeltas(api, normalizedPeCode, { limit: 25 }),
    staleTime: 60 * 1000,
    enabled: q('deltas'),
  });

  const projectsQuery = useQuery({
    queryKey: ['program-element-projects', normalizedPeCode],
    queryFn: () => getProgramElementProjects(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('projects'),
  });

  const relatedQuery = useQuery({
    queryKey: ['program-element-related', normalizedPeCode],
    queryFn: () => getProgramElementRelated(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('related'),
  });

  const provisionsQuery = useQuery({
    queryKey: ['program-element-provisions', normalizedPeCode],
    queryFn: () => getProgramElementProvisions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('provisions'),
  });

  const opportunitiesQuery = useQuery({
    queryKey: ['program-element-opportunities', normalizedPeCode],
    queryFn: () => getProgramElementOpportunities(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('opportunities'),
  });

  const procurementLinesQuery = useQuery({
    queryKey: ['program-element-procurement-lines', normalizedPeCode],
    queryFn: () => getProgramElementProcurementLines(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('procurementLines'),
  });

  const actionsQuery = useQuery({
    queryKey: ['program-element-actions', normalizedPeCode],
    queryFn: () => getBudgetActions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('actions'),
  });

  const relationshipsQuery = useQuery({
    queryKey: ['program-element-relationships', normalizedPeCode],
    queryFn: () => getBudgetLineRelationships(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('relationships'),
  });

  const incumbentsQuery = useQuery({
    queryKey: ['program-element-incumbents', normalizedPeCode],
    queryFn: () => getIncumbents(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('incumbents'),
  });

  const billActionsQuery = useQuery({
    queryKey: ['program-element-bill-actions', normalizedPeCode],
    queryFn: () => getProgramElementBillActions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: q('billActions'),
  });

  const errorStatus = (() => {
    const err = detailQuery.error as { response?: { status?: number }; status?: number } | null;
    if (!err) return null;
    return err.response?.status ?? err.status ?? null;
  })();

  const secondaryFailed = anyEnabledSecondaryFailed([
    { enabled: q('bills'), isError: billsQuery.isError },
    { enabled: q('intelligence'), isError: intelligenceQuery.isError },
    { enabled: q('sources'), isError: sourcesQuery.isError },
    { enabled: q('contractors'), isError: contractorsQuery.isError },
    { enabled: q('personnel'), isError: programTeamQuery.isError },
    { enabled: q('programs'), isError: programsQuery.isError },
    { enabled: q('clientRelevance'), isError: clientRelevanceQuery.isError },
    { enabled: q('deltas'), isError: deltasQuery.isError },
    { enabled: q('projects'), isError: projectsQuery.isError },
    { enabled: q('related'), isError: relatedQuery.isError },
    { enabled: q('provisions'), isError: provisionsQuery.isError },
    { enabled: q('opportunities'), isError: opportunitiesQuery.isError },
    { enabled: q('procurementLines'), isError: procurementLinesQuery.isError },
    { enabled: q('actions'), isError: actionsQuery.isError },
    { enabled: q('relationships'), isError: relationshipsQuery.isError },
    { enabled: q('incumbents'), isError: incumbentsQuery.isError },
    { enabled: q('billActions'), isError: billActionsQuery.isError },
  ]);

  const yearRows = detailQuery.data?.years ?? [];
  const surfaceState = resolvePeSurfaceState({
    peCodePresent: pePresent,
    isLoading: detailQuery.isLoading,
    isError: detailQuery.isError,
    errorStatus,
    hasDetail: Boolean(detailQuery.data),
    yearCount: yearRows.length,
    hasStageValue: yearsHaveStageValue(yearRows),
    unsupported: Boolean(detailQuery.data?.unsupportedSourceFamily),
    secondaryFailed,
  });

  const refetchEnabledSecondaries = () => {
    if (q('bills')) void billsQuery.refetch();
    if (q('intelligence')) void intelligenceQuery.refetch();
    if (q('sources')) void sourcesQuery.refetch();
    if (q('contractors')) void contractorsQuery.refetch();
    if (q('personnel')) void programTeamQuery.refetch();
    if (q('programs')) void programsQuery.refetch();
    if (q('clientRelevance')) void clientRelevanceQuery.refetch();
    if (q('deltas')) void deltasQuery.refetch();
    if (q('projects')) void projectsQuery.refetch();
    if (q('related')) void relatedQuery.refetch();
    if (q('provisions')) void provisionsQuery.refetch();
    if (q('opportunities')) void opportunitiesQuery.refetch();
    if (q('procurementLines')) void procurementLinesQuery.refetch();
    if (q('actions')) void actionsQuery.refetch();
    if (q('relationships')) void relationshipsQuery.refetch();
    if (q('incumbents')) void incumbentsQuery.refetch();
    if (q('billActions')) void billActionsQuery.refetch();
  };

  if (!pePresent) {
    return <Alert type="warning" message="Missing PE code" showIcon />;
  }

  if (surfaceState === 'loading' || surfaceState === 'failed' || surfaceState === 'not_found' || surfaceState === 'unsupported') {
    return (
      <PeLoadState
        state={surfaceState}
        peCode={normalizedPeCode}
        onRetry={() => {
          void detailQuery.refetch();
        }}
      />
    );
  }

    const detail = detailQuery.data;
  if (!detail) {
    return (
      <PeLoadState
        state="failed"
        peCode={normalizedPeCode}
        onRetry={() => {
          void detailQuery.refetch();
        }}
      />
    );
  }
  const detailRaw =
    (
      detail as {
        raw?: { pDocDetail?: PdocDetail | null; op5Detail?: DescriptionSource['op5Detail'] } | null;
      }
    ).raw ?? {};
  const pDocDetail = detailRaw.pDocDetail ?? null;
  // PdocDetailPanel already shows its own "Source: ... P-40 exhibit" line when it
  // renders (i.e. when the line has structured P-40 fields); only pass the
  // source-book fallback here for lines where pDocDetail exists but is otherwise
  // empty (so PdocDetailPanel itself renders null) — avoids a duplicate citation.
  const pdocPanelWillRender =
    !!pDocDetail &&
    (!!pDocDetail.procurementQty?.length ||
      !!pDocDetail.netProcurementM?.length ||
      !!pDocDetail.unitCostK?.length ||
      !!pDocDetail.unitCostM?.length ||
      !!pDocDetail.mdapCode ||
      !!pDocDetail.idCode ||
      !!pDocDetail.relatedPEs ||
      !!pDocDetail.llm?.acquisitionStrategy ||
      !!pDocDetail.llm?.programOffice ||
      !!pDocDetail.llm?.contractors?.length ||
      !!pDocDetail.llm?.milestones?.length ||
      !!pDocDetail.llm?.risks?.length);
  const years = detail.years ?? [];
  const chartYears = [...years].sort((a, b) => a.fy - b.fy);
  const latestRequest = latestMeaningful(years, 'request');
  const latestEnacted = latestMeaningful(years, 'enacted');
  const historyRows = toHistoryRows(years);
  // Canonical per-FY funding lifecycle — the SINGLE source every funding chart
  // on this page reads (Overview trajectory, Funding-tab bar, delta bars) so
  // they cannot disagree. See funding-model.ts.
  const funding = buildFundingSeries(years);
  // Latest FY that has a furthest-along ("current") value — drives the headline
  // stat so the number always states which stage it represents.
  const latestCurrent = [...funding].reverse().find((p) => p.current.value != null);
  const hasBudgetData = years.length > 0;

  // The PE's own most recent year carrying ANY real budget field (not just
  // request/enacted — a mark-only or conference-only year still counts as "current").
  // If that predates the catalog's current cycle FY (the year most PEs have a live
  // PB request), the line has dropped out of the current justification books —
  // e.g. RDT&E finished and the program moved to procurement — so it reads as
  // intentionally historical rather than a broken/empty-looking page.
  const peLatestFy = years.reduce<number | null>((max, y) => {
    const hasAny = [
      y.request,
      y.hascMark,
      y.sascMark,
      y.hacDMark,
      y.sacDMark,
      y.ndaaConference,
      y.conference,
      y.enacted,
    ].some((v) => numberOrNull(v) != null);
    if (!hasAny) return max;
    return max == null || y.fy > max ? y.fy : max;
  }, null);
  const isHistoricalOnly =
    peLatestFy != null && detail.currentCycleFy != null && peLatestFy < detail.currentCycleFy;
  const bills: ProgramElementBill[] = billsQuery.data ?? [];
  const contractors: ProgramElementContractorsResponse = contractorsQuery.data ?? {
    namedPrimes: [],
    data: [],
    todo: null,
  };
  const programTeam: ProgramTeamPerson[] = programTeamQuery.data ?? [];

  // Enacted-vs-request delta for the latest enacted FY (drives the green subtext).
  const enactedDeltaPct = (() => {
    if (!latestEnacted) return null;
    const reqForFy = years.find((y) => y.fy === latestEnacted.fy)?.request;
    const req = numberOrNull(reqForFy);
    if (req == null || req === 0) return null;
    return ((latestEnacted.value - req) / req) * 100;
  })();

  // ── Derived chart data ────────────────────────────────────────────────────
  // Phase 5: keep explicit zeros in sparklines (only drop true nulls).
  const reqSpark = chartYears
    .map((y) => numberOrNull(y.request))
    .filter((v): v is number => v != null);
  const encSpark = chartYears
    .map((y) => numberOrNull(y.enacted))
    .filter((v): v is number => v != null);

  // Overview trajectory: the President's request (dashed baseline) vs the
  // "current" number per FY — the furthest-along stage from the shared
  // funding-model (enacted → conference → committee mark → request). Plotting
  // `current` (not raw enacted) is what makes this agree with the Funding-tab
  // bar chart: a not-yet-enacted year shows its conference/committee value on
  // both, instead of a request line here and a conference bar there.
  const lineLabels = funding.map((p) => fyLabel(p.fy));
  const lineSeries = [
    {
      name: 'Current',
      color: 'var(--accent)',
      values: funding.map((p) => p.current.value),
    },
    {
      name: 'Request',
      color: '#B0433B',
      dash: '5 4',
      values: funding.map((p) => p.request),
    },
  ];

  const bothYears = chartYears.filter(
    (y) => numberOrNull(y.enacted) != null && numberOrNull(y.request) != null,
  );
  const wins = bothYears.filter(
    (y) => (numberOrNull(y.enacted) as number) >= (numberOrNull(y.request) as number),
  ).length;
  const winRate = bothYears.length ? `${Math.round((wins / bothYears.length) * 100)}%` : '—';

  // Congress-vs-request delta from the shared funding-model: congressional
  // position (furthest-along stage EXCLUDING request) minus request. Null for
  // request-only years (no position yet) — the delta bar shows a placeholder,
  // not a fake 0. `basis` names the stage the position came from.
  const deltaData = funding.map((p) => ({
    fy: fyLabel(p.fy),
    delta: p.deltaVsRequest,
    basis: p.congressional.stage === 'none' ? null : STAGE_LABEL[p.congressional.stage],
  }));

  // Committee-positions drill-down: every stage value for the latest FY that
  // carries any committee/conference/enacted mark. Sourced from the same
  // funding-model points (already numeric-coerced) as the trajectory + bars.
  const markYear = [...funding]
    .reverse()
    .find((p) =>
      [
        p.hascMark,
        p.sascMark,
        p.hacDMark,
        p.sacDMark,
        p.ndaaConference,
        p.conference,
        p.enacted,
      ].some((v) => v != null),
    );
  const markBars = markYear
    ? (
        [
          { label: 'PB request', value: markYear.request, color: 'var(--ink-3)' },
          { label: 'HASC', value: markYear.hascMark, color: '#7A9BE6' },
          { label: 'SASC', value: markYear.sascMark, color: '#4E78D8' },
          { label: 'HAC-D', value: markYear.hacDMark, color: '#7A3FB5' },
          { label: 'SAC-D', value: markYear.sacDMark, color: '#A26913' },
          { label: 'NDAA Conf. (auth.)', value: markYear.ndaaConference, color: 'var(--accent)' },
          { label: 'Conference (approps.)', value: markYear.conference, color: 'var(--accent)' },
          { label: 'Enacted', value: markYear.enacted, color: 'var(--success)' },
        ] as Array<{ label: string; value: number | null; color: string }>
      ).filter((b): b is { label: string; value: number; color: string } => b.value != null)
    : [];

  const datedBills = bills.filter((b) => b.latestActionDate);
  const recentActivity = [...datedBills]
    .sort((a, b) => (a.latestActionDate! < b.latestActionDate! ? 1 : -1))
    .slice(0, 4);
  // LEG-A: plot the FULL per-bill action history (stage-classified server-side)
  // when sync-congress has stored it; fall back to latest-action snapshots for
  // bills whose history hasn't been ingested. Blanket authorizers (NDAA-scale
  // peCodeCount) are capped to their most recent actions so a 700-PE bill's
  // procedural churn doesn't drown the PE-specific story.
  const historyEvents = billActionsQuery.data ?? [];

  // LEG-A: attach the (already-fetched) stage-classified action feed to each bill
  // so the bill-timeline swimlane renders full per-bill histories rather than a
  // single latest-action dot. historyEvents is capped server-side; bills with no
  // events in the feed fall back to their latestAction inside the panel.
  const billsWithActions: ProgramElementBill[] = bills.map((b) => ({
    ...b,
    actions: historyEvents
      .filter((e) => e.billId === b.id)
      .map((e, i) => ({
        id: `${e.billId}-${e.date}-${i}`,
        date: e.date,
        text: e.text,
        type: e.type,
        chamber: e.chamber,
      })),
  }));

  const projects = projectsQuery.data ?? [];

  const byOrg = Object.entries(
    programTeam.reduce<Record<string, number>>((acc, p) => {
      const key = p.organization || 'Unattributed';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  )
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
  const conf = programTeam.reduce(
    (a, p) => {
      if (p.confidence >= 0.8) a.high += 1;
      else if (p.confidence >= 0.5) a.med += 1;
      else a.low += 1;
      return a;
    },
    { high: 0, med: 0, low: 0 },
  );
  const confData = [
    { label: 'High', value: conf.high, color: 'var(--success)' },
    { label: 'Medium', value: conf.med, color: 'var(--notable)' },
    { label: 'Low', value: conf.low, color: 'var(--ink-3)' },
  ].filter((d) => d.value > 0);

  const openFy = (fy: number) => {
    setSelectedFy(fy);
    setDrawerOpen(true);
    writeUrl({ fy });
  };

  const reqFmt = latestRequest ? fmtMoneyM(latestRequest.value) : null;
  const enactedFmt = latestEnacted ? fmtMoneyM(latestEnacted.value) : null;

  // Line-type-aware profile: the 8-tab shell is common, but type-specific surfaces
  // vary. Derive from appropriation (immediate on detail); fall back to the
  // intelligence-cache lineType. Unknown type keeps the fuller RDT&E-style layout.
  const lineType =
    lineTypeFor(detail.appropriationType) ?? intelligenceQuery.data?.lineType ?? null;
  const isRdte = lineType === 'RDTE_PE' || lineType === null;
  const isProc = lineType === 'PROCUREMENT_BLIN';

  // Drop procurement/incumbents tabs that do not apply; fall back to overview.
  const allowedTabs = filterTabsForLineType(
    ['overview', 'funding', 'procurement', 'legislation', 'relationships', 'incumbents', 'team', 'approp', 'proof'],
    lineType,
  );
  const effectiveTab: PeWatchTab = allowedTabs.includes(activeTab) ? activeTab : 'overview';

  // ── Tab content ─────────────────────────────────────────────────────────
  const overviewTab = (
    <div className="pe-dt-panel">
      <DescriptionPanel
        description={detail.description}
        source={{
          op5Detail: detailRaw.op5Detail ?? null,
          pDocSourceBookOnly: !pdocPanelWillRender ? (pDocDetail?.sourceBook ?? null) : null,
        }}
      />
      <ChartCard
        title="Funding trajectory"
        sub="President's request vs. enacted"
        span2
        extra={
          <div className="pe-chart-legend">
            <span className="pe-cl">
              <span className="pe-cl-ln accent" />
              Current
            </span>
            <span className="pe-cl">
              <span className="pe-cl-ln req" />
              Request
            </span>
          </div>
        }
      >
        {hasBudgetData ? (
          <>
            <LineChart
              labels={lineLabels}
              series={lineSeries}
              height={252}
              mode="area"
              onPointClick={(i) => {
                const yr = funding[i];
                if (yr) openFy(yr.fy);
              }}
            />
            <div className="pe-chart-foot">
              <div className="pe-cf-item">
                <span className="pe-cf-l">Current (latest)</span>
                <span className="pe-cf-v">
                  {latestCurrent && latestCurrent.current.value != null
                    ? `${fmtMoneyM(latestCurrent.current.value)} · ${STAGE_LABEL[latestCurrent.current.stage]} · ${fyLabel(latestCurrent.fy)}`
                    : '—'}
                </span>
              </div>
              <div className="pe-cf-item">
                <span className="pe-cf-l">Realization rate over request</span>
                <span className="pe-cf-v up">{winRate}</span>
              </div>
              <div className="pe-cf-item">
                <span className="pe-cf-l">Latest request</span>
                <span className="pe-cf-v">
                  {latestRequest
                    ? `${fmtMoneyM(latestRequest.value)} · ${fyLabel(latestRequest.fy)}`
                    : '—'}
                </span>
              </div>
              <div className="pe-cf-item">
                <span className="pe-cf-l">Latest enacted</span>
                <span className="pe-cf-v">
                  {latestEnacted
                    ? `${fmtMoneyM(latestEnacted.value)} · ${fyLabel(latestEnacted.fy)}`
                    : '—'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <Empty description="No budget-year data has been synced for this Program Element yet." />
        )}
      </ChartCard>

      <ChartCard title="Recent activity" sub="latest actions on this PE">
        {recentActivity.length ? (
          <div className="pe-ov-activity">
            {recentActivity.map((b) => {
              const kind = classifyAction(b.latestActionText);
              return (
                <div key={b.id} className="pe-ov-act-row">
                  <span className="pe-ov-act-dot" style={{ background: KIND_COLOR[kind] }} />
                  <div className="pe-ov-act-main">
                    <div className="pe-ov-act-t">{truncate(b.latestActionText ?? b.title, 90)}</div>
                    <div className="pe-ov-act-m">
                      <span className="pe-code-badge sm">
                        {b.billType} {b.billNumber}
                      </span>
                      <span className="pe-dot-sep">·</span>
                      {b.congress}th Congress
                    </div>
                  </div>
                  <span className="pe-ov-act-d">
                    {b.latestActionDate
                      ? new Date(b.latestActionDate).toLocaleDateString('en-US', {
                          month: 'short',
                          year: 'numeric',
                        })
                      : ''}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No dated legislative actions yet."
          />
        )}
      </ChartCard>

      {/* Linked lines — the money graph around this line (§1.3) */}
      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Linked lines</h3>
          <span className="pe-surface-sub">the money graph around this line</span>
        </div>
        <div className="bl-panel-body">
          <LinkedLinesRail
            relationships={relationshipsQuery.data}
            loading={relationshipsQuery.isLoading}
            onOpen={(pe) => navigate(`/program-elements/${pe}`)}
          />
        </div>
      </div>

      {/* Normalized budget actions (§1.2), latest four */}
      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Budget actions</h3>
          <span className="pe-surface-sub">normalized committee events · latest</span>
        </div>
        <div className="bl-panel-body">
          <BudgetActionsFeed
            actions={actionsQuery.data}
            loading={actionsQuery.isLoading}
            limit={4}
          />
        </div>
      </div>

      {isRdte ? (
        <div className="pe-surface pe-plain-surface">
          <ProjectsPanel
          projects={projectsQuery.isError ? undefined : projects}
          loading={projectsQuery.isLoading}
          errored={projectsQuery.isError}
          onRetry={() => void projectsQuery.refetch()}
        />
        </div>
      ) : null}
    </div>
  );

  const fundingTab = (
    <div className="pe-dt-panel">
      <ChartCard
        title="Congress vs. request delta"
        sub="Adds (green) or cuts (red) vs the President's Budget — enacted where final, else the latest committee mark"
        span2
        pad
      >
        {hasBudgetData ? (
          <DeltaBars data={deltaData} height={168} />
        ) : (
          <Empty description="No budget-year data yet." />
        )}
      </ChartCard>

      <ChartCard
        title="Committee positions"
        sub={markYear ? `Latest marked cycle · ${fyLabel(markYear.fy)}` : 'Committee marks'}
        span2
        pad
      >
        {markBars.length ? (
          <HBars data={markBars} fmt={(v) => fmtMoneyM(v)} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No committee marks recorded for this PE."
          />
        )}
      </ChartCard>

      <div className="pe-surface pe-plain-surface span-2">
        {hasBudgetData ? (
          <FyHistoryChart
            rows={historyRows}
            loading={detailQuery.isLoading}
            onFyClick={(fy) => {
              openFy(fy);
              message.info(`Selected FY ${fy}`);
            }}
          />
        ) : (
          <Card title="Funding timeline">
            <Empty description="No budget-year data has been synced for this Program Element yet." />
          </Card>
        )}
      </div>

      {/* Phase 4 (4.1): assembled request→marks→enactment narrative for the current cycle. */}
      <div className="pe-surface pe-plain-surface span-2">
        <FundingNarrativePanel peCode={normalizedPeCode} />
      </div>
    </div>
  );

  // Procurement-only detail: P-40 secondary distribution (recipients · quantity ·
  // unit cost) + the P-Doc detail. These carry data only for PROCUREMENT_BLIN lines,
  // so they get their own tab there instead of rendering empty on RDT&E/O&M.
  const procurementDetailTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <SecondaryDistributionPanel
          data={procurementLinesQuery.data}
          loading={procurementLinesQuery.isLoading}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <PdocDetailPanel
          detail={pDocDetail}
          onOpenPe={(pe) => navigate(`/program-elements/${pe}`)}
        />
      </div>
    </div>
  );

  const legislationTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <BillsTouchingPePanel
          bills={billsWithActions}
          loading={billsQuery.isLoading}
          errored={billsQuery.isError}
          onRetry={() => void billsQuery.refetch()}
        />
      </div>

      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Budget actions</h3>
          <span className="pe-surface-sub">every normalized committee event on this line</span>
        </div>
        <div className="bl-panel-body">
          <BudgetActionsFeed
            actions={actionsQuery.data}
            loading={actionsQuery.isLoading}
            errored={actionsQuery.isError}
            onRetry={() => void actionsQuery.refetch()}
          />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProvisionsPanel
          provisions={provisionsQuery.isError ? undefined : provisionsQuery.data}
          loading={provisionsQuery.isLoading}
          errored={provisionsQuery.isError}
          onRetry={() => void provisionsQuery.refetch()}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProcurementActivityPanel
          opportunities={opportunitiesQuery.isError ? undefined : opportunitiesQuery.data}
          loading={opportunitiesQuery.isLoading}
          errored={opportunitiesQuery.isError}
          onRetry={() => void opportunitiesQuery.refetch()}
        />
      </div>
    </div>
  );

  const relationshipsTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Relationship graph</h3>
          <span className="pe-surface-sub">typed, evidence-bearing edges · dashed = candidate</span>
        </div>
        <div className="bl-panel-body">
          <RelationshipGraphPanel
            peCode={normalizedPeCode}
            relationships={relationshipsQuery.isError ? undefined : relationshipsQuery.data}
            loading={relationshipsQuery.isLoading}
            errored={relationshipsQuery.isError}
            onRetry={() => void relationshipsQuery.refetch()}
            onOpen={(pe) => navigate(`/program-elements/${pe}`)}
          />
        </div>
      </div>
      {isRdte ? (
        <div className="pe-surface pe-plain-surface span-2">
          <div className="pe-surface-head">
            <h3>Transition maturity</h3>
            <span className="pe-surface-sub">research → contracts · per-rung evidence</span>
          </div>
          <div className="bl-panel-body">
            <MaturityLadderPanel ladder={intelligenceQuery.data?.maturityLadder} />
          </div>
        </div>
      ) : null}
      <div className="pe-surface pe-plain-surface span-2">
        <ProgramsPanel
          programs={programsQuery.isError ? undefined : programsQuery.data}
          loading={programsQuery.isLoading}
          errored={programsQuery.isError}
          onRetry={() => void programsQuery.refetch()}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <RelatedPesPanel
          related={relatedQuery.isError ? undefined : relatedQuery.data}
          loading={relatedQuery.isLoading}
          errored={relatedQuery.isError}
          onRetry={() => void relatedQuery.refetch()}
        />
      </div>
    </div>
  );

  const appropriabilityTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <div className="bl-panel-body">
          <AppropriabilityPanel approp={intelligenceQuery.data?.appropriability} />
        </div>
      </div>
    </div>
  );

  const teamTab = (
    <div className="pe-dt-panel">
      <ChartCard title="Roster by organization" pad>
        {programTeamQuery.isError ? (
          <PeSecondaryFailed
            label="program team roster"
            testId="pe-secondary-failed-personnel-roster"
            onRetry={() => void programTeamQuery.refetch()}
          />
        ) : byOrg.length ? (
          <HBars data={byOrg} fmt={(v) => v} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No identified personnel yet." />
        )}
      </ChartCard>
      <ChartCard title="Identification confidence">
        {programTeamQuery.isError ? (
          <PeSecondaryFailed
            label="program team confidence"
            testId="pe-secondary-failed-personnel-confidence"
            onRetry={() => void programTeamQuery.refetch()}
          />
        ) : confData.length ? (
          <div className="pe-donut-block">
            <Donut
              data={confData}
              size={128}
              thickness={22}
              centerLabel={String(programTeam.length)}
              centerSub="people"
            />
            <div className="pe-donut-legend">
              {confData.map((c) => (
                <div key={c.label} className="pe-dl-row">
                  <span className="pe-dl-sw" style={{ background: c.color }} />
                  <span className="pe-dl-name">{c.label} confidence</span>
                  <span className="pe-dl-val">{c.value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No identified personnel yet." />
        )}
      </ChartCard>

      <div className="pe-surface pe-plain-surface span-2">
        <ProgramTeamPanel
          personnel={programTeamQuery.isError ? [] : programTeam}
          loading={programTeamQuery.isLoading}
          errored={programTeamQuery.isError}
          onRetry={() => void programTeamQuery.refetch()}
          onViewAllSources={() => navigate('/directory')}
          onLinkCrmContact={(personId) => {
            const person = programTeam.find((candidate) => candidate.id === personId);
            setLinkTarget({ id: personId, name: person?.fullName ?? 'this person' });
          }}
        />
      </div>
    </div>
  );

  const incumbentsTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Incumbent map</h3>
          <span className="pe-surface-sub">performer → award → budget triangulation</span>
        </div>
        <div className="bl-panel-body">
          <IncumbentMapPanel
            incumbents={incumbentsQuery.isError ? undefined : incumbentsQuery.data}
            loading={incumbentsQuery.isLoading}
            errored={incumbentsQuery.isError}
            onRetry={() => void incumbentsQuery.refetch()}
          />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ContractorsPanel
          contractors={contractorsQuery.isError ? undefined : contractors}
          loading={contractorsQuery.isLoading}
          errored={contractorsQuery.isError}
          onRetry={() => void contractorsQuery.refetch()}
        />
      </div>
    </div>
  );

  const proofPackTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <WhatChangedPanel
          deltas={deltasQuery.isError ? undefined : deltasQuery.data?.data}
          loading={deltasQuery.isLoading}
          errored={deltasQuery.isError}
          onRetry={() => void deltasQuery.refetch()}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ClientRelevancePanel
          clients={clientRelevanceQuery.isError ? undefined : clientRelevanceQuery.data}
          loading={clientRelevanceQuery.isLoading}
          errored={clientRelevanceQuery.isError}
          onRetry={() => void clientRelevanceQuery.refetch()}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProofPackPanel
          sources={sourcesQuery.isError ? undefined : sourcesQuery.data}
          loading={sourcesQuery.isLoading}
          errored={sourcesQuery.isError}
          onRetry={() => void sourcesQuery.refetch()}
        />
      </div>
    </div>
  );

  const relCount = relationshipsQuery.data?.length ?? 0;
  // Line-type-aware tab set: money-graph tabs are common; Procurement detail shows
  // only for procurement lines. Incumbents (award-evidenced + R-3 performers) shows
  // for RDT&E and Procurement — award linkage is actually strongest on Procurement
  // lines (acq-program map resolution), so gating it RDT&E-only hid real data.
  // O&M lines have neither R-3 exhibits nor meaningful award-PE linkage yet, so they
  // skip it.
  const tabItems = [
    { key: 'overview', label: 'Overview', children: overviewTab },
    { key: 'funding', label: 'Funding', children: fundingTab },
    ...(isProc
      ? [{ key: 'procurement', label: 'Procurement detail', children: procurementDetailTab }]
      : []),
    {
      key: 'legislation',
      label: <TabLabel text="Legislation" count={bills.length} />,
      children: legislationTab,
    },
    {
      key: 'relationships',
      label: <TabLabel text="Relationships" count={relCount} />,
      children: relationshipsTab,
    },
    ...(isRdte || isProc
      ? [
          {
            key: 'incumbents',
            label: <TabLabel text="Incumbents" count={incumbentsQuery.data?.length ?? 0} />,
            children: incumbentsTab,
          },
        ]
      : []),
    {
      key: 'team',
      label: <TabLabel text="People & office" count={programTeam.length} />,
      children: teamTab,
    },
    { key: 'approp', label: 'Appropriability', children: appropriabilityTab },
    { key: 'proof', label: 'Proof pack', children: proofPackTab },
  ];

  return (
    <section className="pe-watch-page redesign" data-testid="pe-state-complete">
      {/* ── Navy hero banner ──────────────────────────────────────────── */}
      <header className="pe-hero">
        <div className="pe-hero-main">
          <div className="pe-hero-badge">{peBadge(detail)}</div>
          <div className="pe-hero-body">
            <div className="pe-hero-eyebrow">
              <span className="pe-hero-kicker">
                {(intelligenceQuery.data?.lineType &&
                  LINE_TYPES[intelligenceQuery.data.lineType]?.label) ??
                  'Budget Line Watch'}
              </span>
              <span className="pe-hero-code">{detail.peCode}</span>
            </div>
            <h1 className="pe-hero-title">{detail.title}</h1>
            <div className="pe-hero-meta">
              {detail.appropriationType ? (
                <span>
                  Appropriation <b>{detail.appropriationType}</b>
                </span>
              ) : null}
              <span>
                Service <b data-testid="pe-sector-tag">{detail.service ?? 'N/A'}</b>
              </span>
              {detail.budgetActivity ? (
                <span>
                  Budget activity <b>{detail.budgetActivity}</b>
                </span>
              ) : null}
            </div>
            <div className="pe-hero-meta pe-hero-meta-2">
              {detail.firstSeenFy ? (
                <span>
                  Tracked since <b>FY{detail.firstSeenFy}</b>
                </span>
              ) : null}
              {detail.lastSyncedAt ? (
                <span className="pe-hero-synced">
                  <i className="dot success" />
                  Last synced <b>{formatSyncedDate(detail.lastSyncedAt)}</b>
                </span>
              ) : null}
            </div>
            <div className="pe-hero-tags">
              {detail.budgetActivity ? (
                <span className="pe-tag">{detail.budgetActivity}</span>
              ) : null}
              {detail.appropriationType ? (
                <span className="pe-tag">{detail.appropriationType}</span>
              ) : null}
              {detail.status ? (
                <span className={`pill ${statusPillClass(detail.status)}`}>{detail.status}</span>
              ) : null}
              {isHistoricalOnly ? (
                <Tooltip
                  title={`No FY${detail.currentCycleFy} entry in the current budget cycle — this line's last budget-year record was FY${peLatestFy}. Likely wound down, transitioned to a later acquisition phase, or superseded; not necessarily an ingestion gap.`}
                >
                  <span className="pill muted">
                    Historical — no FY{detail.currentCycleFy} entry
                  </span>
                </Tooltip>
              ) : null}
            </div>
            <IntelligenceChips intel={intelligenceQuery.data} />
          </div>
        </div>
        <div className="pe-hero-actions">
          <Button
            className={`pe-watch-btn${detail.currentUserIsWatching ? ' is-watching' : ''}`}
            type={detail.currentUserIsWatching ? 'primary' : 'default'}
            icon={detail.currentUserIsWatching ? <BellFilled /> : <BellOutlined />}
            loading={watch.isPending}
            onClick={() =>
              watch.mutate(
                { peCode: normalizedPeCode, watching: !detail.currentUserIsWatching },
                {
                  onSuccess: (_r, vars) => {
                    if (vars.watching)
                      message.success("You'll be notified when this PE has updates");
                  },
                },
              )
            }
          >
            {detail.currentUserIsWatching ? 'Watching this PE' : 'Watch this PE'}
          </Button>
          <Button
            className="pe-hero-dark-btn"
            icon={<FileSearchOutlined />}
            onClick={() => navigate('/program-elements')}
          >
            Find program
          </Button>
          <Button
            className="pe-hero-dark-btn"
            icon={<ThunderboltOutlined />}
            onClick={() => navigate('/program-elements/mark-up-monitor')}
          >
            Mark-up monitor
          </Button>
        </div>
      </header>

      {/* ── KPI strip with inline sparklines ──────────────────────────── */}
      <div className="pe-strip">
        <div className="pe-strip-cell">
          <div className="pe-strip-label">
            Latest Request
            {latestRequest ? <span className="pe-fy-pill">FY{latestRequest.fy}</span> : null}
            {reqSpark.length > 1 ? (
              <span className="pe-strip-spark">
                <Sparkline data={reqSpark} width={56} height={20} area={false} color="#B0433B" />
              </span>
            ) : null}
          </div>
          <div className="pe-strip-value">
            {reqFmt ?? <span className="pe-strip-empty">—</span>}
          </div>
          <div className="pe-strip-sub">President&apos;s Budget submission</div>
        </div>

        <div className="pe-strip-cell">
          <div className="pe-strip-label">
            Latest Enacted
            {latestEnacted ? <span className="pe-fy-pill">FY{latestEnacted.fy}</span> : null}
            {encSpark.length > 1 ? (
              <span className="pe-strip-spark">
                <Sparkline
                  data={encSpark}
                  width={56}
                  height={20}
                  area={false}
                  color="var(--accent)"
                />
              </span>
            ) : null}
          </div>
          <div className="pe-strip-value pe-strip-value-pos">
            {enactedFmt ?? <span className="pe-strip-empty">—</span>}
          </div>
          <div className="pe-strip-sub">
            {enactedDeltaPct != null ? (
              <>
                <b className="pe-pos">
                  {enactedDeltaPct >= 0 ? '+' : ''}
                  {enactedDeltaPct.toFixed(1)}%
                </b>{' '}
                over that yr&apos;s request
              </>
            ) : (
              'Enacted appropriation'
            )}
          </div>
        </div>

        <div className="pe-strip-cell">
          <div className="pe-strip-label">Realization rate</div>
          <div className="pe-strip-value pe-strip-value-pos">{winRate}</div>
          <div className="pe-strip-sub">enacted ≥ request, cumulative</div>
        </div>

        <div className="pe-strip-cell">
          <div className="pe-strip-label">Bills touching this PE</div>
          <div className="pe-strip-value">{bills.length}</div>
          <div className="pe-strip-sub">Linked legislation</div>
        </div>
      </div>

      <PeTrustHeader
        peCode={detail.peCode}
        title={detail.title}
        years={years}
        catalogCurrentCycleFy={detail.currentCycleFy}
        lastSyncedAt={detail.lastSyncedAt}
        sourceCount={detail.sourceCount}
        projectCount={detail.projectCount}
        billCount={detail.billCount ?? bills.length}
        description={detail.description}
        reconciliationConflictCount={detail.openReconciliationConflictCount ?? 0}
        extraCaveats={
          isHistoricalOnly
            ? [
                `This line's last mark-bearing year (FY${peLatestFy}) predates the catalog mode-request cycle (FY${detail.currentCycleFy}). Treat dollars as historical unless a newer ingest lands.`,
              ]
            : []
        }
      />

      {surfaceState === 'partial' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Partial data"
          description="Detail loaded but at least one secondary panel failed. Failed sections are not silent empties — retry or switch tabs after recovery."
          action={
            <Button
              size="small"
              onClick={() => {
                void detailQuery.refetch();
                refetchEnabledSecondaries();
              }}
              data-testid="pe-state-retry"
            >
              Retry failed panels
            </Button>
          }
        />
      ) : null}

      {surfaceState === 'not_ingested' ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Not yet ingested"
          description="PE identity is known, but no budget-year rows have been ingested for this code."
          data-testid="pe-banner-not-ingested"
        />
      ) : null}

      {surfaceState === 'complete_empty' ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Ingested structure without stage dollars"
          description="Budget-year rows exist but no stage values (including $0) are populated yet. This is complete empty — not a silent failure."
          data-testid="pe-banner-complete-empty"
        />
      ) : null}

      {/* ── Sub-tabs (lazy: only the active tab's secondary queries fire) ── */}
      <Tabs
        className="pe-detail-tabs"
        activeKey={effectiveTab}
        onChange={onTabChange}
        destroyOnHidden
                items={tabItems}
      />

      <FyDetailDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          writeUrl({ fy: null });
        }}
        peCode={detail.peCode}
        selectedFy={selectedFy}
        timeline={years}
      />

      <LinkCrmContactModal
        open={linkTarget !== null}
        personId={linkTarget?.id ?? null}
        personName={linkTarget?.name ?? null}
        onClose={() => setLinkTarget(null)}
      />
    </section>
  );
}

function TabLabel({ text, count }: { text: string; count: number }) {
  return (
    <span className="pe-tab-label">
      {text}
      {count > 0 ? (
        <Tag className="pe-tab-count" bordered={false}>
          {count}
        </Tag>
      ) : null}
    </span>
  );
}
