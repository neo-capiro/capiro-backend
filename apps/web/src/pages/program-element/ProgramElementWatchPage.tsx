import { Suspense, lazy, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { IntelligenceChips } from './IntelligenceChips.js';
import { PdocDetailPanel, type PdocDetail } from './PdocDetailPanel.js';
import { Alert, Button, Card, Col, Empty, Row, Skeleton, message } from 'antd';
import {
  BellFilled,
  BellOutlined,
  FileSearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useApi } from '../../lib/use-api.js';
import {
  getProgramElementBills,
  getProgramElementContractors,
  getProgramElementDeltas,
  getProgramElementDetail,
  getProgramElementPersonnel,
  getProgramElementSources,
  setProgramElementWatching,
  getProgramElementIntelligence,
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

/**
 * Most recent FY where a given metric actually has a meaningful value (non-null
 * and non-zero). Many PEs carry only a single real FY of data with 0/null in
 * later years; keying stat cards off the highest FY alone shows "$0 / —" and
 * makes the page look empty. This finds the latest FY that actually has data for
 * the requested field so the cards surface the real number.
 */
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

const LazyFyHistoryChart = lazy(async () => ({ default: FyHistoryChart }));
const LazyBillsTouchingPePanel = lazy(async () => ({ default: BillsTouchingPePanel }));
const LazyContractorsPanel = lazy(async () => ({ default: ContractorsPanel }));
const LazyProgramTeamPanel = lazy(async () => ({ default: ProgramTeamPanel }));
const LazyProofPackPanel = lazy(async () => ({ default: ProofPackPanel }));
const LazyProgramsPanel = lazy(async () => ({ default: ProgramsPanel }));
const LazyClientRelevancePanel = lazy(async () => ({ default: ClientRelevancePanel }));
const LazyWhatChangedPanel = lazy(async () => ({ default: WhatChangedPanel }));

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

/** Compact $m formatting for the KPI strip values, e.g. 297.74 -> "$297.7M". */
function formatMillions(value: number): { whole: string; suffix: string } {
  return { whole: `$${value.toFixed(1)}`, suffix: 'M' };
}

/** "PE 6.1" style short badge from a budget activity / appropriation hint. */
function peBadge(detail: { budgetActivity: string | null; appropriationType: string | null }): string {
  const ba = detail.budgetActivity ?? '';
  const m = ba.match(/(\d(?:\.\d)?)/);
  if (m) return `BA ${m[1]}`;
  return detail.appropriationType ? detail.appropriationType.slice(0, 6) : 'PE';
}

export function ProgramElementWatchPage() {
  const { peCode = '' } = useParams<{ peCode: string }>();
  const normalizedPeCode = peCode.toUpperCase();
  const navigate = useNavigate();
  const api = useApi();
  const queryClient = useQueryClient();
  const [selectedFy, setSelectedFy] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{ id: string; name: string } | null>(null);

  const watchMutation = useMutation({
    mutationFn: (watching: boolean) => setProgramElementWatching(api, normalizedPeCode, watching),
    onMutate: async (watching) => {
      const detailKey = ['program-element-detail', normalizedPeCode] as const;
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData(detailKey);
      queryClient.setQueryData(detailKey, (oldData: unknown) => {
        if (!oldData || typeof oldData !== 'object') return oldData;
        return {
          ...(oldData as Record<string, unknown>),
          currentUserIsWatching: watching,
        };
      });
      return { previous, detailKey };
    },
    onError: (_error, _watching, context) => {
      if (context?.detailKey) {
        queryClient.setQueryData(context.detailKey, context.previous);
      }
      message.error('Unable to update watch status. Please try again.');
    },
    onSuccess: (_result, watching) => {
      if (watching) {
        message.success("You'll be notified when this PE has updates");
      }
    },
    onSettled: (_result, _error, _watching, context) => {
      if (context?.detailKey) {
        queryClient.invalidateQueries({ queryKey: context.detailKey }).catch(() => undefined);
      }
    },
  });

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

  if (!normalizedPeCode) {
    return <Alert type="warning" message="Missing PE code" showIcon />;
  }

  if (detailQuery.isLoading) {
    return (
      <section className="pe-watch-page redesign">
        <Skeleton active paragraph={{ rows: 3 }} />
        <Row gutter={[16, 16]}>
          {[0, 1, 2, 3].map((idx) => (
            <Col key={idx} xs={24} md={12} xl={6}>
              <Card>
                <Skeleton active paragraph={{ rows: 1 }} title={false} />
              </Card>
            </Col>
          ))}
        </Row>
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
  const years = detail.years ?? [];
  const latestRequest = latestMeaningful(years, 'request');
  const latestEnacted = latestMeaningful(years, 'enacted');
  const latestConference = latestMeaningful(years, 'conference');
  const historyRows = toHistoryRows(years);
  const hasBudgetData = years.length > 0;
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

  const reqFmt = latestRequest ? formatMillions(latestRequest.value) : null;
  const enactedFmt = latestEnacted ? formatMillions(latestEnacted.value) : null;
  const confFmt = latestConference ? formatMillions(latestConference.value) : null;

  return (
    <section className="pe-watch-page redesign">
      {/* ── Navy hero banner ──────────────────────────────────────────── */}
      <header className="pe-hero">
        <div className="pe-hero-main">
          <div className="pe-hero-badge">{peBadge(detail)}</div>
          <div className="pe-hero-body">
            <div className="pe-hero-eyebrow">
              <span className="pe-hero-kicker">Program Element Watch</span>
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
            </div>
            <IntelligenceChips intel={intelligenceQuery.data} />
          </div>
        </div>
        <div className="pe-hero-actions">
          <Button
            className={`pe-watch-btn${detail.currentUserIsWatching ? ' is-watching' : ''}`}
            type={detail.currentUserIsWatching ? 'primary' : 'default'}
            icon={detail.currentUserIsWatching ? <BellFilled /> : <BellOutlined />}
            loading={watchMutation.isPending}
            onClick={() => watchMutation.mutate(!detail.currentUserIsWatching)}
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

      {/* ── KPI strip (one card, four divided cells) ──────────────────── */}
      <div className="pe-strip">
        <div className="pe-strip-cell">
          <div className="pe-strip-label">
            Latest Request
            {latestRequest ? <span className="pe-fy-pill">FY{latestRequest.fy}</span> : null}
          </div>
          <div className="pe-strip-value">
            {reqFmt ? (
              <>
                {reqFmt.whole}
                <small>{reqFmt.suffix}</small>
              </>
            ) : (
              <span className="pe-strip-empty">—</span>
            )}
          </div>
          <div className="pe-strip-sub">President&apos;s Budget submission</div>
        </div>

        <div className="pe-strip-cell">
          <div className="pe-strip-label">
            Latest Conference
            {latestConference ? <span className="pe-fy-pill">FY{latestConference.fy}</span> : null}
          </div>
          <div className="pe-strip-value">
            {confFmt ? (
              <>
                {confFmt.whole}
                <small>{confFmt.suffix}</small>
              </>
            ) : (
              <span className="pe-strip-empty">—</span>
            )}
          </div>
          <div className="pe-strip-sub">
            {confFmt ? 'Conference report' : 'Awaiting conference report'}
          </div>
        </div>

        <div className="pe-strip-cell">
          <div className="pe-strip-label">
            Latest Enacted
            {latestEnacted ? <span className="pe-fy-pill">FY{latestEnacted.fy}</span> : null}
          </div>
          <div className="pe-strip-value pe-strip-value-pos">
            {enactedFmt ? (
              <>
                {enactedFmt.whole}
                <small>{enactedFmt.suffix}</small>
              </>
            ) : (
              <span className="pe-strip-empty">—</span>
            )}
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
          <div className="pe-strip-label">Bills touching this PE</div>
          <div className="pe-strip-value">{bills.length}</div>
          <div className="pe-strip-sub">Linked legislation</div>
        </div>
      </div>

      {hasBudgetData ? (
        <Suspense
          fallback={
            <Card title="Funding timeline">
              <Skeleton active paragraph={{ rows: 6 }} />
            </Card>
          }
        >
          <LazyFyHistoryChart
            rows={historyRows}
            loading={detailQuery.isLoading}
            onFyClick={(fy) => {
              setSelectedFy(fy);
              setDrawerOpen(true);
              message.info(`Selected FY ${fy}`);
            }}
          />
        </Suspense>
      ) : (
        <Card title="Funding timeline">
          <Empty description="No budget-year data has been synced for this Program Element yet." />
        </Card>
      )}

      <PdocDetailPanel
        detail={((detail as { raw?: { pDocDetail?: PdocDetail | null } | null }).raw ?? {})?.pDocDetail}
        onOpenPe={(pe) => navigate(`/program-elements/${pe}`)}
      />

      <Suspense
        fallback={
          <Card title="Programs">
            <Skeleton active paragraph={{ rows: 3 }} />
          </Card>
        }
      >
        <LazyProgramsPanel programs={programsQuery.data} loading={programsQuery.isLoading} />
      </Suspense>

      <Suspense
        fallback={
          <Card title="Client relevance">
            <Skeleton active paragraph={{ rows: 3 }} />
          </Card>
        }
      >
        <LazyClientRelevancePanel
          clients={clientRelevanceQuery.data}
          loading={clientRelevanceQuery.isLoading}
        />
      </Suspense>

      <Suspense
        fallback={
          <Card title="What changed">
            <Skeleton active paragraph={{ rows: 3 }} />
          </Card>
        }
      >
        <LazyWhatChangedPanel deltas={deltasQuery.data?.data} loading={deltasQuery.isLoading} />
      </Suspense>

      <Row gutter={[16, 16]} className="pe-two-col">
        <Col xs={24} xl={15}>
          <Suspense
            fallback={
              <Card title="Top contractors touching this PE">
                <Skeleton active paragraph={{ rows: 4 }} />
              </Card>
            }
          >
            <LazyContractorsPanel contractors={contractors} loading={contractorsQuery.isLoading} />
          </Suspense>
        </Col>
        <Col xs={24} xl={9}>
          <Suspense
            fallback={
              <Card title="Bills touching this PE">
                <Skeleton active paragraph={{ rows: 4 }} />
              </Card>
            }
          >
            <LazyBillsTouchingPePanel bills={bills} loading={billsQuery.isLoading} />
          </Suspense>
        </Col>
      </Row>

      <Suspense
        fallback={
          <Card title="Sources & evidence">
            <Skeleton active paragraph={{ rows: 4 }} />
          </Card>
        }
      >
        <LazyProofPackPanel sources={sourcesQuery.data} loading={sourcesQuery.isLoading} />
      </Suspense>

      <Suspense
        fallback={
          <Card title="Program team">
            <Skeleton active paragraph={{ rows: 5 }} />
          </Card>
        }
      >
        <LazyProgramTeamPanel
          personnel={programTeam}
          loading={programTeamQuery.isLoading}
          estimatedTotal={Math.max(programTeam.length, 6)}
          onViewAllSources={() => navigate('/directory')}
          onLinkCrmContact={(personId) => {
            const person = programTeam.find((candidate) => candidate.id === personId);
            setLinkTarget({ id: personId, name: person?.fullName ?? 'this person' });
          }}
        />
      </Suspense>

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
