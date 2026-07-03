import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
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
import {
  Sparkline,
  LineChart,
  DeltaBars,
  Donut,
  HBars,
  LegTimeline,
  fmtMoneyM,
  type LegEvent,
} from './charts/index.js';
import type {
  ProgramElementBill,
  ProgramElementContractorsResponse,
  ProgramElementHistoryRow,
  ProgramElementYearPoint,
  ProgramTeamPerson,
} from './types.js';

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
    enacted: numberOrNull(year.enacted),
    projectedEnacted: year.enacted == null,
    sourceAttribution: sourceFromRaw(year.raw),
  };
}

function toHistoryRows(years: ProgramElementYearPoint[]): ProgramElementHistoryRow[] {
  return [...years].sort((a, b) => a.fy - b.fy).map(toHistoryRow);
}

/** Most recent FY where a metric has a real (non-null, non-zero) value. */
function latestMeaningful(
  years: ProgramElementYearPoint[],
  field: 'request' | 'enacted' | 'conference',
): { fy: number; value: number } | undefined {
  for (const y of [...years].sort((a, b) => b.fy - a.fy)) {
    const raw = y[field];
    if (raw == null) continue;
    const num = Number(raw);
    if (Number.isFinite(num) && num !== 0) return { fy: y.fy, value: num };
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

function peBadge(detail: { budgetActivity: string | null; appropriationType: string | null }): string {
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
  const api = useApi();
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ id: string; name: string } | null>(null);

  const watch = useWatchToggle();

  const detailQuery = useQuery({
    queryKey: ['program-element-detail', normalizedPeCode],
    queryFn: () => getProgramElementDetail(api, normalizedPeCode),
    staleTime: 5 * 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const billsQuery = useQuery({
    queryKey: ['program-element-bills', normalizedPeCode],
    queryFn: () => getProgramElementBills(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const contractorsQuery = useQuery({
    queryKey: ['program-element-contractors', normalizedPeCode],
    queryFn: () => getProgramElementContractors(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const programTeamQuery = useQuery({
    queryKey: ['program-element-personnel', normalizedPeCode],
    queryFn: () => getProgramElementPersonnel(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const sourcesQuery = useQuery({
    queryKey: ['program-element-sources', normalizedPeCode],
    queryFn: () => getProgramElementSources(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const programsQuery = useQuery({
    queryKey: ['program-element-programs', normalizedPeCode],
    queryFn: () => getProgramsForPe(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const clientRelevanceQuery = useQuery({
    queryKey: ['program-element-client-relevance', normalizedPeCode],
    queryFn: () => getRelevantClientsForPe(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const intelligenceQuery = useQuery({
    queryKey: ['program-element-intelligence', normalizedPeCode],
    queryFn: () => getProgramElementIntelligence(api, normalizedPeCode),
    enabled: normalizedPeCode.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const deltasQuery = useQuery({
    queryKey: ['program-element-deltas', normalizedPeCode],
    queryFn: () => getProgramElementDeltas(api, normalizedPeCode, { limit: 25 }),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const projectsQuery = useQuery({
    queryKey: ['program-element-projects', normalizedPeCode],
    queryFn: () => getProgramElementProjects(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const relatedQuery = useQuery({
    queryKey: ['program-element-related', normalizedPeCode],
    queryFn: () => getProgramElementRelated(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const provisionsQuery = useQuery({
    queryKey: ['program-element-provisions', normalizedPeCode],
    queryFn: () => getProgramElementProvisions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const opportunitiesQuery = useQuery({
    queryKey: ['program-element-opportunities', normalizedPeCode],
    queryFn: () => getProgramElementOpportunities(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const procurementLinesQuery = useQuery({
    queryKey: ['program-element-procurement-lines', normalizedPeCode],
    queryFn: () => getProgramElementProcurementLines(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  // ── BL-2 money-graph reads ────────────────────────────────────────────────
  const actionsQuery = useQuery({
    queryKey: ['program-element-actions', normalizedPeCode],
    queryFn: () => getBudgetActions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const relationshipsQuery = useQuery({
    queryKey: ['program-element-relationships', normalizedPeCode],
    queryFn: () => getBudgetLineRelationships(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  const incumbentsQuery = useQuery({
    queryKey: ['program-element-incumbents', normalizedPeCode],
    queryFn: () => getIncumbents(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  // LEG-A: full stage-classified action history across the PE's bills.
  const billActionsQuery = useQuery({
    queryKey: ['program-element-bill-actions', normalizedPeCode],
    queryFn: () => getProgramElementBillActions(api, normalizedPeCode),
    staleTime: 60 * 1000,
    enabled: normalizedPeCode.length > 0,
  });

  if (!normalizedPeCode) {
    return <Alert type="warning" message="Missing PE code" showIcon />;
  }

  if (detailQuery.isLoading) {
    return (
      <section className="pe-watch-page redesign">
        <Skeleton active paragraph={{ rows: 3 }} />
        <div className="pe-strip">
          {[0, 1, 2, 3].map((idx) => (
            <div className="pe-strip-cell" key={idx}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Alert
        type="error"
        showIcon
        message="Unable to load program element"
        description="Please retry in a moment."
      />
    );
  }

  const detail = detailQuery.data;
  const detailRaw = (detail as { raw?: { pDocDetail?: PdocDetail | null; op5Detail?: DescriptionSource['op5Detail'] } | null })
    .raw ?? {};
  const pDocDetail = detailRaw.pDocDetail ?? null;
  // PdocDetailPanel already shows its own "Source: ... P-40 exhibit" line when it
  // renders (i.e. when the line has structured P-40 fields); only pass the
  // source-book fallback here for lines where pDocDetail exists but is otherwise
  // empty (so PdocDetailPanel itself renders null) — avoids a duplicate citation.
  const pdocPanelWillRender = !!pDocDetail && (
    !!pDocDetail.procurementQty?.length || !!pDocDetail.netProcurementM?.length ||
    !!pDocDetail.unitCostK?.length || !!pDocDetail.unitCostM?.length ||
    !!pDocDetail.mdapCode || !!pDocDetail.idCode || !!pDocDetail.relatedPEs ||
    !!pDocDetail.llm?.acquisitionStrategy || !!pDocDetail.llm?.programOffice ||
    !!pDocDetail.llm?.contractors?.length || !!pDocDetail.llm?.milestones?.length || !!pDocDetail.llm?.risks?.length
  );
  const years = detail.years ?? [];
  const chartYears = [...years].sort((a, b) => a.fy - b.fy);
  const latestRequest = latestMeaningful(years, 'request');
  const latestEnacted = latestMeaningful(years, 'enacted');
  const historyRows = toHistoryRows(years);
  const hasBudgetData = years.length > 0;

  // The PE's own most recent year carrying ANY real budget field (not just
  // request/enacted — a mark-only or conference-only year still counts as "current").
  // If that predates the catalog's current cycle FY (the year most PEs have a live
  // PB request), the line has dropped out of the current justification books —
  // e.g. RDT&E finished and the program moved to procurement — so it reads as
  // intentionally historical rather than a broken/empty-looking page.
  const peLatestFy = years.reduce<number | null>((max, y) => {
    const hasAny = [y.request, y.hascMark, y.sascMark, y.hacDMark, y.sacDMark, y.conference, y.enacted].some(
      (v) => numberOrNull(v) != null,
    );
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
  const reqSpark = chartYears
    .map((y) => numberOrNull(y.request))
    .filter((v): v is number => v != null && v !== 0);
  const encSpark = chartYears
    .map((y) => numberOrNull(y.enacted))
    .filter((v): v is number => v != null && v !== 0);

  const lineLabels = chartYears.map((y) => fyLabel(y.fy));
  const lineSeries = [
    { name: 'Enacted', color: 'var(--accent)', values: chartYears.map((y) => numberOrNull(y.enacted)) },
    {
      name: 'Request',
      color: '#B0433B',
      dash: '5 4',
      values: chartYears.map((y) => numberOrNull(y.request)),
    },
  ];

  const bothYears = chartYears.filter(
    (y) => numberOrNull(y.enacted) != null && numberOrNull(y.request) != null,
  );
  const wins = bothYears.filter(
    (y) => (numberOrNull(y.enacted) as number) >= (numberOrNull(y.request) as number),
  ).length;
  const winRate = bothYears.length ? `${Math.round((wins / bothYears.length) * 100)}%` : '—';

  const deltaData = chartYears.map((y) => {
    const enacted = numberOrNull(y.enacted);
    const request = numberOrNull(y.request);
    return {
      fy: fyLabel(y.fy),
      delta: enacted != null && request != null ? enacted - request : null,
    };
  });

  const markYear = [...chartYears]
    .reverse()
    .find((y) =>
      [y.hascMark, y.sascMark, y.hacDMark, y.sacDMark, y.conference, y.enacted].some(
        (v) => numberOrNull(v) != null,
      ),
    );
  const markBars = markYear
    ? (
        [
          { label: 'PB request', value: numberOrNull(markYear.request), color: 'var(--ink-3)' },
          { label: 'HASC', value: numberOrNull(markYear.hascMark), color: '#7A9BE6' },
          { label: 'SASC', value: numberOrNull(markYear.sascMark), color: '#4E78D8' },
          { label: 'HAC-D', value: numberOrNull(markYear.hacDMark), color: '#7A3FB5' },
          { label: 'SAC-D', value: numberOrNull(markYear.sacDMark), color: '#A26913' },
          { label: 'Conference', value: numberOrNull(markYear.conference), color: 'var(--accent)' },
          { label: 'Enacted', value: numberOrNull(markYear.enacted), color: 'var(--success)' },
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
  const timelineEvents: LegEvent[] =
    historyEvents.length > 0
      ? historyEvents
          .filter((e, i, all) => e.peCodeCount < 200 || all.findIndex((x) => x.billId === e.billId) >= i - 8)
          .slice(0, 60)
          .map((e) => ({
            date: e.date,
            label: truncate(e.stageLabel === 'Action' ? e.text : e.stageLabel, 22),
            num: `${e.billType} ${e.billNumber}`,
            kind: e.stage,
          }))
      : datedBills.map((b) => ({
          date: b.latestActionDate as string,
          label: truncate(b.latestActionText ?? b.title, 22),
          num: `${b.billType} ${b.billNumber}`,
          kind: classifyAction(b.latestActionText),
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
  };

  const reqFmt = latestRequest ? fmtMoneyM(latestRequest.value) : null;
  const enactedFmt = latestEnacted ? fmtMoneyM(latestEnacted.value) : null;

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
              Enacted
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
              onPointClick={(i) => { const yr = chartYears[i]; if (yr) openFy(yr.fy); }}
            />
            <div className="pe-chart-foot">
              <div className="pe-cf-item">
                <span className="pe-cf-l">Realization rate over request</span>
                <span className="pe-cf-v up">{winRate}</span>
              </div>
              <div className="pe-cf-item">
                <span className="pe-cf-l">Latest request</span>
                <span className="pe-cf-v">
                  {latestRequest ? `${fmtMoneyM(latestRequest.value)} · ${fyLabel(latestRequest.fy)}` : '—'}
                </span>
              </div>
              <div className="pe-cf-item">
                <span className="pe-cf-l">Latest enacted</span>
                <span className="pe-cf-v">
                  {latestEnacted ? `${fmtMoneyM(latestEnacted.value)} · ${fyLabel(latestEnacted.fy)}` : '—'}
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
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No dated legislative actions yet." />
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
          <BudgetActionsFeed actions={actionsQuery.data} loading={actionsQuery.isLoading} limit={4} />
        </div>
      </div>

      <div className="pe-surface pe-plain-surface">
        <ProjectsPanel projects={projects} loading={projectsQuery.isLoading} />
      </div>
    </div>
  );

  const fundingTab = (
    <div className="pe-dt-panel">
      <ChartCard
        title="Enacted vs. request delta"
        sub="Congress adds (green) or cuts (red) against the President's Budget"
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

      <div className="pe-surface pe-plain-surface span-2">
        <SecondaryDistributionPanel
          data={procurementLinesQuery.data}
          loading={procurementLinesQuery.isLoading}
        />
      </div>
    </div>
  );

  const legislationTab = (
    <div className="pe-dt-panel">
      <ChartCard
        title="Legislative timeline"
        sub="Bill actions touching this PE"
        span2
        pad
        extra={
          <div className="pe-chart-legend sm">
            <span className="pe-cl">
              <span className="pe-dotk" style={{ background: KIND_COLOR.report }} />
              Reported
            </span>
            <span className="pe-cl">
              <span className="pe-dotk" style={{ background: KIND_COLOR.markup }} />
              Markup
            </span>
            <span className="pe-cl">
              <span className="pe-dotk" style={{ background: KIND_COLOR.law }} />
              Enacted
            </span>
          </div>
        }
      >
        {timelineEvents.length ? (
          <LegTimeline events={timelineEvents} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No dated bill actions to plot yet."
          />
        )}
      </ChartCard>

      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Budget actions</h3>
          <span className="pe-surface-sub">every normalized committee event on this line</span>
        </div>
        <div className="bl-panel-body">
          <BudgetActionsFeed actions={actionsQuery.data} loading={actionsQuery.isLoading} />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <BillsTouchingPePanel bills={bills} loading={billsQuery.isLoading} />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProvisionsPanel provisions={provisionsQuery.data} loading={provisionsQuery.isLoading} />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProcurementActivityPanel
          opportunities={opportunitiesQuery.data}
          loading={opportunitiesQuery.isLoading}
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
            relationships={relationshipsQuery.data}
            loading={relationshipsQuery.isLoading}
            onOpen={(pe) => navigate(`/program-elements/${pe}`)}
          />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <div className="pe-surface-head">
          <h3>Transition maturity</h3>
          <span className="pe-surface-sub">research → contracts · per-rung evidence</span>
        </div>
        <div className="bl-panel-body">
          <MaturityLadderPanel ladder={intelligenceQuery.data?.maturityLadder} />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProgramsPanel programs={programsQuery.data} loading={programsQuery.isLoading} />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <RelatedPesPanel related={relatedQuery.data} loading={relatedQuery.isLoading} />
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
        {byOrg.length ? (
          <HBars data={byOrg} fmt={(v) => v} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No identified personnel yet." />
        )}
      </ChartCard>
      <ChartCard title="Identification confidence">
        {confData.length ? (
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
          personnel={programTeam}
          loading={programTeamQuery.isLoading}
          estimatedTotal={Math.max(programTeam.length, 6)}
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
          <IncumbentMapPanel incumbents={incumbentsQuery.data} loading={incumbentsQuery.isLoading} />
        </div>
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ContractorsPanel contractors={contractors} loading={contractorsQuery.isLoading} />
      </div>
    </div>
  );

  const proofPackTab = (
    <div className="pe-dt-panel">
      <div className="pe-surface pe-plain-surface span-2">
        <WhatChangedPanel deltas={deltasQuery.data?.data} loading={deltasQuery.isLoading} />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <PdocDetailPanel detail={pDocDetail} onOpenPe={(pe) => navigate(`/program-elements/${pe}`)} />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ClientRelevancePanel
          clients={clientRelevanceQuery.data}
          loading={clientRelevanceQuery.isLoading}
        />
      </div>
      <div className="pe-surface pe-plain-surface span-2">
        <ProofPackPanel sources={sourcesQuery.data} loading={sourcesQuery.isLoading} />
      </div>
    </div>
  );

  const relCount = relationshipsQuery.data?.length ?? 0;
  const tabItems = [
    { key: 'overview', label: 'Overview', children: overviewTab },
    { key: 'funding', label: 'Funding', children: fundingTab },
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
    {
      key: 'incumbents',
      label: <TabLabel text="Incumbents" count={incumbentsQuery.data?.length ?? 0} />,
      children: incumbentsTab,
    },
    {
      key: 'team',
      label: <TabLabel text="People & office" count={programTeam.length} />,
      children: teamTab,
    },
    { key: 'approp', label: 'Appropriability', children: appropriabilityTab },
    { key: 'proof', label: 'Proof pack', children: proofPackTab },
  ];

  return (
    <section className="pe-watch-page redesign">
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
              {detail.budgetActivity ? <span className="pe-tag">{detail.budgetActivity}</span> : null}
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
                  <span className="pill muted">Historical — no FY{detail.currentCycleFy} entry</span>
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
                    if (vars.watching) message.success("You'll be notified when this PE has updates");
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
                <Sparkline data={encSpark} width={56} height={20} area={false} color="var(--accent)" />
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

      {/* ── Sub-tabs ──────────────────────────────────────────────────── */}
      <Tabs className="pe-detail-tabs" defaultActiveKey="overview" items={tabItems} />

      <FyDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
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
