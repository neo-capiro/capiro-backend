/**
 * Funding Opportunities v2 — capiro-internal workspace.
 *
 * A faithful build of "Capiro Funding Opportunities v2 (standalone).html" gated to
 * the capiro-internal tenant at the route (see FundingOpportunitiesV2Gate in
 * App.tsx). Five destinations — Explore · Matched · Triage · Pipeline · Coverage —
 * sit under App Shell v2's bands. Every row binds to the real funding-opportunities
 * API; decorative mockup-only affordances (Saved views, Add pursuit, Retry sweep)
 * are omitted because no backend supports them, never faked.
 *
 * The honesty rules carry over verbatim from the legacy surface: null money is
 * never $0, eligibility and relevance stay separate, and a machine recommendation
 * never moves a stage (only a human decision does, via the P08 action endpoint).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import { readEnum, readInt, useUrlState } from '../funding-opportunities-url-state.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE,
  FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE,
  FUNDING_OPPORTUNITIES_BUDGET_FEATURE,
  FUNDING_OPPORTUNITIES_RISK_FEATURE,
  FUNDING_OPPORTUNITIES_MERI_FEATURE,
  FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE,
  decodeOpportunityRef,
  encodeOpportunityRef,
  type OpportunityRef,
  type FundingOpportunityListResponse,
  type InboxResponse,
  type InboxFilter,
  type InboxSource,
  type PipelineBoardView,
  pipelineBoardApiPath,
} from '../funding-opportunities-api.js';
import { FoV2Drawer } from './FoV2Drawer.js';
import { FoV2Explore } from './FoV2Explore.js';
import { FoV2Pipeline } from './FoV2Pipeline.js';
import { FoV2Queue } from './FoV2Queue.js';
import { FoV2Coverage } from './FoV2Coverage.js';
import { formatInboxCount } from './fo-v2-model.js';
import './fo-v2.css';

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

type Dest = 'explore' | 'matched' | 'triage' | 'pipeline' | 'coverage';
const DESTS: Array<{ key: Dest; label: string }> = [
  { key: 'explore', label: 'Explore' },
  { key: 'matched', label: 'Matched' },
  { key: 'triage', label: 'Triage' },
  { key: 'pipeline', label: 'Pipeline' },
];

const QUEUES: InboxFilter[] = [
  'needs_review',
  'deadlines',
  'recently_changed',
  'monitoring',
  'passed',
];
const QUEUE_LABELS: Record<string, string> = {
  needs_review: 'Needs review',
  deadlines: 'Deadlines ≤ 30 d',
  recently_changed: 'Recently changed',
  monitoring: 'Monitoring',
  passed: 'Passed',
};

export function FundingOpportunitiesV2Page() {
  const { notification } = AntApp.useApp();
  const api = useApi();
  const qc = useQueryClient();
  const url = useUrlState();

  const master = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const inboxFlag = useIntelFeature(FUNDING_OPPORTUNITIES_INBOX_FEATURE);
  const pipelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const forecastsFlag = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const documentsFlag = useIntelFeature(FUNDING_OPPORTUNITIES_DOCUMENTS_FEATURE);
  const landscapeFlag = useIntelFeature(FUNDING_OPPORTUNITIES_LANDSCAPE_FEATURE);
  const budgetFlag = useIntelFeature(FUNDING_OPPORTUNITIES_BUDGET_FEATURE);
  const riskFlag = useIntelFeature(FUNDING_OPPORTUNITIES_RISK_FEATURE);
  const meriFlag = useIntelFeature(FUNDING_OPPORTUNITIES_MERI_FEATURE);
  const noticeHistoryFlag = useIntelFeature(FUNDING_OPPORTUNITIES_NOTICE_HISTORY_FEATURE);

  const dest: Dest = readEnum<Dest>(
    url.get('dest'),
    ['explore', 'matched', 'triage', 'pipeline', 'coverage'],
    'triage',
  );
  const queue = readEnum<InboxFilter>(url.get('queue'), QUEUES as InboxFilter[], 'needs_review');
  const view = readEnum<'board' | 'list'>(url.get('view'), ['board', 'list'], 'board');
  const density = readEnum<'standard' | 'compact'>(
    url.get('density'),
    ['standard', 'compact'],
    'standard',
  );
  const clientId = url.get('clientId') ?? undefined;
  const sourceFilter = url.get('source') ?? '';
  const detailParam = url.get('detail');
  const detailRef: OpportunityRef | null = decodeOpportunityRef(detailParam);

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: master.ready && master.enabled,
  });

  // Freshness for the header sync line + the explore source-unreachable banner.
  const freshness = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities-freshness'],
    queryFn: async () =>
      (
        await api.get<FundingOpportunityListResponse>(
          '/api/intelligence/opportunities?pageSize=1&activeState=active',
        )
      ).data,
    retry: 1,
    staleTime: 60_000,
    enabled: master.ready && master.enabled,
  });

  // Catalog counts for the Explore funnel figure.
  const catalogCount = freshness.data;

  const inboxAvailable = inboxFlag.ready && inboxFlag.enabled;

  // Triage inbox (the queue). Loaded for triage + matched; matched uses the union
  // of decision-context queues. When the inbox flag is off, triage falls back to
  // the catalog explore surface.
  const inboxParams = new URLSearchParams({ filter: queue });
  if (clientId) inboxParams.set('clientId', clientId);
  if (sourceFilter) inboxParams.set('source', sourceFilter);
  const inboxQueryString = inboxParams.toString();
  const inbox = useQuery<InboxResponse>({
    queryKey: ['funding-opportunity-inbox', inboxQueryString],
    queryFn: async () =>
      (await api.get<InboxResponse>(`/api/intelligence/opportunities/inbox?${inboxQueryString}`))
        .data,
    retry: 1,
    staleTime: 15_000,
    enabled: master.enabled && inboxAvailable && (dest === 'triage' || dest === 'matched'),
  });

  // Pipeline board (per-client). The board is a per-client surface; with no client
  // selected the pipeline tab shows a select-a-client empty state.
  const pipeline = useQuery<PipelineBoardView>({
    queryKey: ['fo-v2-pipeline', clientId],
    queryFn: async () => (await api.get<PipelineBoardView>(pipelineBoardApiPath(clientId!))).data,
    retry: 1,
    staleTime: 15_000,
    enabled: master.enabled && pipelineFlag.enabled && dest === 'pipeline' && Boolean(clientId),
  });

  function goDest(next: Dest) {
    url.set({ dest: next === 'triage' ? null : next, detail: null });
  }
  function goQueue(next: InboxFilter) {
    url.set({ queue: next === 'needs_review' ? null : next, detail: null });
  }
  function setClient(next: string | undefined) {
    url.set({ clientId: next ?? null, detail: null });
  }
  function setSource(next: string) {
    url.set({ source: next || null, detail: null });
  }
  function openDetail(ref: OpportunityRef) {
    url.set({ detail: encodeOpportunityRef(ref) });
  }
  function closeDetail() {
    url.set({ detail: null });
  }

  const visibleClients = (clients.data ?? []).filter((c) => c.status !== 'archived');
  const clientName = visibleClients.find((c) => c.id === clientId)?.name;

  // Header meta line: N clients · M records tracked.
  const headerMeta = useMemo(() => {
    const nClients = visibleClients.length;
    const records = catalogCount?.total;
    const recs = records != null ? records.toLocaleString() : '—';
    return `${nClients} CLIENT${nClients === 1 ? '' : 'S'} · ${recs} RECORDS TRACKED`;
  }, [visibleClients.length, catalogCount?.total]);

  // Sources-synced line: the freshest successful sync across rails.
  const syncLine = useMemo(() => {
    const rails = catalogCount?.freshness ?? [];
    const stamps = rails
      .map((f) => f.lastSyncedAt)
      .filter((s): s is string => Boolean(s))
      .map((s) => Date.parse(s))
      .filter((t) => Number.isFinite(t));
    if (!stamps.length) return { text: 'SOURCES NEVER SYNCED', stale: true };
    const mins = Math.max(0, Math.round((Date.now() - Math.max(...stamps)) / 60_000));
    const stale = rails.some((f) => f.lastRunStatus === 'error');
    return { text: `SOURCES SYNCED · ${mins} MIN AGO`, stale };
  }, [catalogCount?.freshness]);

  // Funnel counts.
  const funnelCounts: Record<Dest, string> = {
    explore: catalogCount?.total != null ? catalogCount.total.toLocaleString() : '—',
    matched: inbox.data
      ? formatInboxCount(inbox.data.counts?.needs_review as number | undefined)
      : '—',
    triage: inbox.data
      ? formatInboxCount(QUEUES.reduce((acc, q) => acc + (inbox.data!.counts?.[q] ?? 0), 0))
      : '—',
    pipeline: pipeline.data ? String(pipeline.data.counts.total) : '—',
    coverage: '—',
  };

  if (!master.ready) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!master.enabled) {
    return (
      <div className="fo-v2" style={{ padding: 24 }}>
        <div className="fo-v2-empty" data-testid="fo-v2-disabled">
          <div className="fo-v2-empty-tag">⊘ NOT ENABLED</div>
          <div className="fo-v2-empty-title">Funding Opportunities is not enabled</div>
          <div className="fo-v2-empty-body">
            Grants.gov and SAM.gov opportunity matching is available on request. Ask a workspace
            admin to turn on the <span className="fo-v2-mono">funding_opportunities</span>{' '}
            capability for this tenant.
          </div>
        </div>
      </div>
    );
  }

  const compact = density === 'compact';

  return (
    <div className="fo-v2" data-testid="fo-v2-page">
      {/* ── Header (58px) ── */}
      <header className="fo-v2-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 'none' }}>
          <div className="fo-v2-header-mark" aria-hidden>
            ◈
          </div>
          <div>
            <div className="fo-v2-eyebrow">Intelligence</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 5 }}>
              <div className="fo-v2-header-title">Funding Opportunities</div>
              <div className="fo-v2-header-meta">{headerMeta}</div>
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 10 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className={`fo-v2-sync-dot${syncLine.stale ? ' stale' : ''}`} aria-hidden />
          <span className="fo-v2-header-meta" data-testid="fo-v2-syncline">
            {syncLine.text}
          </span>
        </div>
        {/* Saved views / Add pursuit from the mockup are omitted: no backend supports
            them, and the v2 rule is to never fake an interactive affordance. */}
      </header>

      {/* ── Funnel (44px) ── */}
      <div className="fo-v2-funnel" role="tablist" aria-label="Funding opportunities views">
        {DESTS.map((d, i) => (
          <span key={d.key} style={{ display: 'flex', alignItems: 'stretch', flex: 'none' }}>
            <button
              type="button"
              role="tab"
              aria-selected={dest === d.key}
              className={`fo-v2-funnel-tab${dest === d.key ? ' active' : ''}`}
              onClick={() => goDest(d.key)}
            >
              {d.label}
              <span className="fo-v2-funnel-count">{funnelCounts[d.key]}</span>
            </button>
            {i < DESTS.length - 1 ? (
              <span className="fo-v2-funnel-sep" aria-hidden>
                →
              </span>
            ) : null}
          </span>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="fo-v2-mono"
            style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fov2-secondary)' }}
          >
            CLIENT
          </span>
          <select
            aria-label="Client"
            className="fo-v2-funnel-select"
            value={clientId ?? ''}
            onChange={(e) => setClient(e.target.value || undefined)}
            style={{ appearance: 'none', border: '1px solid var(--fov2-border)' }}
          >
            <option value="">All clients</option>
            {visibleClients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Body: rail + main + drawer ── */}
      <div
        style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', overflow: 'hidden' }}
      >
        {/* Rail */}
        <aside className="fo-v2-rail" aria-label="Queues and sources">
          {dest === 'triage' ? (
            <>
              <div className="fo-v2-rail-title">Queue</div>
              {QUEUES.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`fo-v2-rail-item${queue === q ? ' on' : ''}`}
                  onClick={() => goQueue(q)}
                >
                  <span className="fo-v2-rail-item-label">{QUEUE_LABELS[q]}</span>
                  <span className="fo-v2-rail-item-count">
                    {inbox.data ? formatInboxCount(inbox.data.counts?.[q]) : '—'}
                  </span>
                </button>
              ))}
            </>
          ) : dest === 'pipeline' ? (
            <>
              <div className="fo-v2-rail-title">Stage</div>
              {(pipeline.data?.counts.stages ?? []).map((s) => (
                <div key={s.stage} className="fo-v2-rail-item" style={{ cursor: 'default' }}>
                  <span className="fo-v2-rail-item-label">{s.stage}</span>
                  <span className="fo-v2-rail-item-count">{s.count}</span>
                </div>
              ))}
              {!pipeline.data ? (
                <div className="fo-v2-rail-item" style={{ cursor: 'default' }}>
                  <span className="fo-v2-rail-item-label">All pursuits</span>
                  <span className="fo-v2-rail-item-count">—</span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="fo-v2-rail-title">{dest === 'matched' ? 'Client' : 'Agency'}</div>
              {(dest === 'matched' ? visibleClients.map((c) => [c.name, c.id] as const) : []).map(
                ([label, id]) => (
                  <button
                    key={id}
                    type="button"
                    className={`fo-v2-rail-item${clientId === id ? ' on' : ''}`}
                    onClick={() => setClient(clientId === id ? undefined : id)}
                  >
                    <span className="fo-v2-rail-item-label">{label}</span>
                  </button>
                ),
              )}
              {dest === 'explore' ? (
                <div className="fo-v2-rail-item" style={{ cursor: 'default' }}>
                  <span className="fo-v2-rail-item-label">All agencies</span>
                  <span className="fo-v2-rail-item-count">
                    {catalogCount?.total != null ? catalogCount.total.toLocaleString() : '—'}
                  </span>
                </div>
              ) : null}
            </>
          )}

          <div className="fo-v2-rail-divider" />
          <div className="fo-v2-rail-title">Source</div>
          {[
            { key: '', label: 'All sources' },
            { key: 'sam_gov', label: 'SAM.gov' },
            { key: 'grants_gov', label: 'Grants.gov' },
          ].map((s) => {
            const rail = catalogCount?.freshness?.find((f) => f.source === s.key);
            const stale = rail?.lastRunStatus === 'error';
            const tag = s.key === '' ? null : stale ? 'STALE' : 'FRESH';
            const on = sourceFilter === s.key;
            return (
              <button
                key={s.key || 'all'}
                type="button"
                className="fo-v2-rail-src"
                onClick={() => setSource(on && s.key !== '' ? '' : s.key)}
                aria-pressed={on}
                style={{ textAlign: 'left', width: '100%' }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span className={`fo-v2-rail-src-box${on ? ' on' : ''}`} aria-hidden />
                  <span
                    className="fo-v2-rail-src-label"
                    style={{ color: on ? 'var(--fov2-ink)' : 'var(--fov2-secondary)' }}
                  >
                    {s.label}
                  </span>
                </span>
                {tag ? (
                  <span
                    className="fo-v2-rail-src-tag"
                    style={{ color: stale ? 'var(--fov2-info-ink)' : 'var(--fov2-success)' }}
                  >
                    {tag}
                  </span>
                ) : null}
              </button>
            );
          })}
          {forecastsFlag.enabled ? (
            <button
              type="button"
              className="fo-v2-rail-src"
              onClick={() => setSource(sourceFilter === 'agency_forecast' ? '' : 'agency_forecast')}
              aria-pressed={sourceFilter === 'agency_forecast'}
              style={{ textAlign: 'left', width: '100%' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span
                  className={`fo-v2-rail-src-box${sourceFilter === 'agency_forecast' ? ' on' : ''}`}
                  aria-hidden
                />
                <span
                  className="fo-v2-rail-src-label"
                  style={{
                    color:
                      sourceFilter === 'agency_forecast'
                        ? 'var(--fov2-ink)'
                        : 'var(--fov2-secondary)',
                  }}
                >
                  Agency forecasts
                </span>
              </span>
              <span className="fo-v2-rail-src-tag" style={{ color: 'var(--fov2-success)' }}>
                ON
              </span>
            </button>
          ) : null}

          <div style={{ flex: 1, minHeight: 14 }} />
          <button
            type="button"
            className={`fo-v2-rail-coverage${dest === 'coverage' ? ' on' : ''}`}
            onClick={() => goDest('coverage')}
          >
            COVERAGE &amp; PROFILES
          </button>
        </aside>

        {/* Main region */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* View bar */}
          {dest !== 'coverage' ? (
            <div className="fo-v2-viewbar">
              <span className="fo-v2-viewbar-title">{viewTitle(dest, queue)}</span>
              <span className="fo-v2-viewbar-meta">
                {viewMeta(dest, queue, inbox.data, clientName)}
              </span>
              <div style={{ flex: 1, minWidth: 8 }} />
              {dest === 'pipeline' ? (
                <span className="fo-v2-seg" role="group" aria-label="Pipeline view">
                  <button
                    type="button"
                    className={view === 'board' ? 'active' : ''}
                    aria-pressed={view === 'board'}
                    onClick={() => url.set({ view: null })}
                  >
                    BOARD
                  </button>
                  <button
                    type="button"
                    className={view === 'list' ? 'active' : ''}
                    aria-pressed={view === 'list'}
                    onClick={() => url.set({ view: 'list' })}
                  >
                    LIST
                  </button>
                </span>
              ) : null}
              {dest === 'triage' || dest === 'matched' ? (
                <span className="fo-v2-sort" aria-hidden>
                  {dest === 'matched' ? 'Match strength' : 'Deadline, soonest'} ▾
                </span>
              ) : null}
              <span className="fo-v2-seg" role="group" aria-label="Density">
                <button
                  type="button"
                  className={!compact ? 'active' : ''}
                  aria-pressed={!compact}
                  onClick={() => url.set({ density: null })}
                >
                  STANDARD
                </button>
                <button
                  type="button"
                  className={compact ? 'active' : ''}
                  aria-pressed={compact}
                  onClick={() => url.set({ density: 'compact' })}
                >
                  COMPACT
                </button>
              </span>
            </div>
          ) : null}

          {/* Stats strip (triage/matched/pipeline) */}
          {dest === 'triage' || dest === 'matched' || dest === 'pipeline' ? (
            <FoV2Stats inbox={inbox.data} pipeline={pipeline.data} compact={compact} />
          ) : null}

          {/* Destinations */}
          {dest === 'explore' ? (
            <FoV2Explore
              clientId={clientId}
              source={sourceFilter}
              freshness={catalogCount?.freshness ?? []}
              onOpen={openDetail}
              compact={compact}
            />
          ) : dest === 'pipeline' ? (
            <FoV2Pipeline
              clientId={clientId ?? null}
              clientName={clientName}
              view={view}
              board={pipeline.data}
              loading={pipeline.isPending}
              flagEnabled={pipelineFlag.enabled}
              onOpen={openDetail}
              compact={compact}
              notify={notification}
              onChanged={() => {
                void qc.invalidateQueries({ queryKey: ['fo-v2-pipeline', clientId] });
                void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
              }}
            />
          ) : dest === 'coverage' ? (
            <FoV2Coverage
              freshness={catalogCount?.freshness ?? []}
              flags={{
                documents: documentsFlag.enabled,
                landscape: landscapeFlag.enabled,
                budget: budgetFlag.enabled,
                risk: riskFlag.enabled,
                meri: meriFlag.enabled,
                noticeHistory: noticeHistoryFlag.enabled,
                forecasts: forecastsFlag.enabled,
                pipeline: pipelineFlag.enabled,
              }}
            />
          ) : (
            <FoV2Queue
              dest={dest}
              queue={queue}
              inbox={inbox.data}
              loading={inbox.isPending}
              inboxAvailable={inboxAvailable}
              onOpen={openDetail}
              compact={compact}
              clientId={clientId}
              notify={notification}
              onChanged={() => {
                void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
              }}
            />
          )}
        </div>

        {/* Detail drawer */}
        {detailRef ? (
          <FoV2Drawer
            refValue={detailRef}
            onClose={closeDetail}
            clients={visibleClients}
            meriEnabled={meriFlag.enabled}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
              void qc.invalidateQueries({ queryKey: ['fo-v2-pipeline'] });
              void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/* ── View bar copy (mockup viewCopyMap) ────────────────────────────────────── */
function viewTitle(dest: Dest, queue: InboxFilter): string {
  if (dest === 'explore') return 'EVERY SOURCE RECORD';
  if (dest === 'matched') return 'MATCHED TO A CLIENT PROFILE';
  if (dest === 'pipeline') return 'DECIDED PURSUITS';
  if (dest === 'coverage') return 'COVERAGE & PROFILES';
  const q: Record<string, string> = {
    needs_review: 'NEEDS REVIEW',
    deadlines: 'DEADLINES ≤ 30 DAYS',
    recently_changed: 'RECENTLY CHANGED',
    monitoring: 'MONITORING',
    passed: 'PASSED',
  };
  return q[queue] ?? 'NEEDS REVIEW';
}
function viewMeta(
  dest: Dest,
  queue: InboxFilter,
  inbox: InboxResponse | undefined,
  clientName?: string,
): string {
  if (dest === 'explore') return 'NO CLIENT CONTEXT APPLIED';
  if (dest === 'matched')
    return clientName
      ? `RANKED BY MATCH STRENGTH · ${clientName.toUpperCase()}`
      : 'RANKED BY MATCH STRENGTH';
  if (dest === 'pipeline') return 'STAGE CHANGES ARE HUMAN ACTIONS';
  const q: Record<string, string> = {
    needs_review: 'A DECISION IS BLOCKED ON ONE UNRESOLVED FACT',
    deadlines: 'ORDERED BY CLOSING DATE',
    recently_changed: 'MATERIAL CHANGES IN THE LAST 14 DAYS',
    monitoring: 'WATCHED, NO ACTION DUE THIS WEEK',
    passed: 'DURABLE HUMAN DECISIONS',
  };
  return q[queue] ?? '';
}

/* ── Stats strip ───────────────────────────────────────────────────────────── */
function FoV2Stats({
  inbox,
  pipeline,
  compact,
}: {
  inbox: InboxResponse | undefined;
  pipeline: PipelineBoardView | undefined;
  compact: boolean;
}) {
  const needsReview = inbox?.counts?.needs_review;
  const deadlines = inbox?.counts?.deadlines;
  const pursuing = pipeline?.counts.stages.find((s) => s.stage === 'pursuing')?.count;
  const submitted = pipeline?.counts.stages.find((s) => s.stage === 'submitted')?.count;
  const stats = [
    {
      label: 'NEEDS REVIEW',
      fig: formatInboxCount(needsReview as number | undefined),
      note: 'machine suggestions',
    },
    {
      label: 'DEADLINES ≤ 30 D',
      fig: formatInboxCount(deadlines as number | undefined),
      note: 'closing soon',
    },
    { label: 'PURSUING', fig: pursuing != null ? String(pursuing) : '—', note: 'active pursuits' },
    {
      label: 'SUBMITTED',
      fig: submitted != null ? String(submitted) : '—',
      note: 'awaiting outcome',
    },
  ];
  return (
    <div className="fo-v2-stats" data-testid="fo-v2-stats">
      {stats.map((s) => (
        <div key={s.label} className={`fo-v2-stat${compact ? ' compact' : ''}`}>
          <div className="fo-v2-stat-label">{s.label}</div>
          <div className="fo-v2-stat-fig">{s.fig}</div>
          <div className="fo-v2-stat-note">{s.note}</div>
        </div>
      ))}
    </div>
  );
}
