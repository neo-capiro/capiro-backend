import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readEnum,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  DIBBS_SOURCE,
  FORECAST_SOURCE,
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  FUNDING_OPPORTUNITIES_SBIR_FEATURE,
  SBIR_SOURCE,
  formatFreshness,
  formatInboxCount,
  pipelineBoardApiPath,
  type FundingOpportunityListResponse,
  type InboxResponse,
  type InboxSource,
  type OpportunitySourceFreshness,
  type PipelineBoardView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FundingOpportunityExplore } from './FundingOpportunityExplore.js';
import { FundingOpportunityInbox } from './FundingOpportunityInbox.js';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { FovAlert, FovSkeletonRows } from './fov-ui.js';
import './funding-opportunities-vnext.css';
import './funding-opportunities-prototype.css';

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

export const OPPORTUNITY_VIEWS = ['explore', 'inbox', 'pipeline'] as const;
export type OpportunityView = (typeof OPPORTUNITY_VIEWS)[number];

type SourceRailValue = InboxSource | '';

interface ModuleTab {
  value: OpportunityView;
  label: string;
  ariaLabel: string;
  badge?: string;
}

/**
 * Funding Opportunities — the real-data module mounted inside the existing
 * os.capiro.ai shell. This component deliberately owns no global navigation:
 * the top bar, left rail and Intelligence sub-navigation remain the shell's
 * responsibility. Everything below is scoped to this route and its existing
 * tenant-aware APIs.
 */
export function FundingOpportunitiesPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const inboxFlag = useIntelFeature(FUNDING_OPPORTUNITIES_INBOX_FEATURE);
  const pipelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const forecastsFlag = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const sbirFlag = useIntelFeature(FUNDING_OPPORTUNITIES_SBIR_FEATURE);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();

  const clientId = url.get('clientId') ?? undefined;
  const inboxAvailable = inboxFlag.ready && inboxFlag.enabled;
  const pipelineAvailable =
    inboxAvailable && pipelineFlag.ready && pipelineFlag.enabled;
  const forecastsEnabled = forecastsFlag.ready && forecastsFlag.enabled;
  const sbirEnabled = sbirFlag.ready && sbirFlag.enabled;

  const acceptedViews: readonly OpportunityView[] = pipelineAvailable
    ? OPPORTUNITY_VIEWS
    : inboxAvailable
      ? ['explore', 'inbox']
      : ['explore'];
  const view = readEnum<OpportunityView>(
    url.get('view'),
    acceptedViews,
    'explore',
  );

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });

  const catalogSummaryQuery = useMemo(() => {
    const params = new URLSearchParams({
      page: '1',
      pageSize: '1',
      activeState: 'active',
    });
    if (clientId) params.set('clientId', clientId);
    return params.toString();
  }, [clientId]);

  const catalogSummary = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities', 'module-summary', catalogSummaryQuery],
    queryFn: async () =>
      (
        await api.get<FundingOpportunityListResponse>(
          `/api/intelligence/opportunities?${catalogSummaryQuery}`,
        )
      ).data,
    staleTime: 30_000,
    retry: 1,
    enabled: ready && enabled,
  });

  const inboxSummaryQuery = useMemo(() => {
    const params = new URLSearchParams({ filter: 'needs_review' });
    if (clientId) params.set('clientId', clientId);
    return params.toString();
  }, [clientId]);

  const inboxSummary = useQuery<InboxResponse>({
    // This is the exact key the inbox uses for its default queue, so opening
    // the tab reuses the response rather than issuing a duplicate request.
    queryKey: ['funding-opportunity-inbox', inboxSummaryQuery],
    queryFn: async () =>
      (
        await api.get<InboxResponse>(
          `/api/intelligence/opportunities/inbox?${inboxSummaryQuery}`,
        )
      ).data,
    staleTime: 15_000,
    retry: 1,
    enabled: ready && enabled && inboxAvailable,
  });

  const pipelineSummary = useQuery<PipelineBoardView>({
    queryKey: ['funding-opportunity-pipeline', clientId],
    queryFn: async () =>
      (await api.get<PipelineBoardView>(pipelineBoardApiPath(clientId!))).data,
    staleTime: 15_000,
    retry: false,
    enabled: ready && enabled && pipelineAvailable && Boolean(clientId),
  });

  function setClient(next: string | undefined) {
    // Cursor and page belong to the previous client's result set.
    url.set({ clientId: next ?? null, cursor: null, page: null, detail: null });
  }

  function setView(next: OpportunityView) {
    url.set({
      view: next === 'explore' ? null : next,
      cursor: null,
      page: null,
      detail: null,
    });
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunities-freshness'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunity-pipeline'] });
    toast.success('Funding Opportunities refreshed from Capiro’s current records.');
  }

  async function saveCurrentView() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('View link copied — filters, client and page are in the URL.');
    } catch {
      toast.error('The browser could not copy this view link.');
    }
  }

  function exportPipeline() {
    const board = pipelineSummary.data;
    if (!board || board.cards.length === 0) {
      toast.error('There is no loaded pipeline data to export.');
      return;
    }
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['Opportunity', 'Source', 'Source record id', 'Stage', 'Stage basis', 'Response deadline'],
      ...board.cards.map((card) => [
        card.title ?? '',
        card.source,
        card.sourceRecordId ?? '',
        card.stage ?? '',
        card.stageBasis,
        card.responseDeadline ?? '',
      ]),
    ];
    const blob = new Blob([rows.map((row) => row.map(quote).join(',')).join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `funding-opportunity-pipeline-${clientId}.csv`;
    anchor.click();
    URL.revokeObjectURL(href);
    toast.success('Pipeline exported from the loaded board.');
  }

  if (!ready) {
    return (
      <div className="fov">
        <FovSkeletonRows rows={6} />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="fov">
        <FovAlert
          tone="info"
          message="Funding Opportunities is not enabled for this workspace"
          description="Grants.gov and SAM.gov opportunity matching is available on request."
        />
      </div>
    );
  }

  const visibleClients = (clients.data ?? []).filter(
    (client) => client.status !== 'archived',
  );
  const clientName = visibleClients.find((client) => client.id === clientId)?.name;
  const inboxCount = formatInboxCount(inboxSummary.data?.counts.needs_review);
  const pipelineTotal = pipelineSummary.data?.counts.total;
  const pipelineDerived = pipelineSummary.data?.counts.derivedFromWorkflowStatus;
  const catalogTotal = catalogSummary.data?.total;
  const catalogTotalLabel =
    catalogTotal == null
      ? 'Loading active records'
      : `${catalogTotal.toLocaleString()}${catalogSummary.data?.totalIsCapped ? '+' : ''} active records`;

  const hero =
    view === 'inbox'
      ? {
          eyebrow: `DECISION QUEUE · ${(clientName ?? 'ALL CLIENTS').toUpperCase()}`,
          title: 'Triage inbox',
          description:
            'One row per client-opportunity decision, newest evidence first. These are future competitions a client could pursue, not awarded funding.',
          status: `${inboxCount} need a decision`,
          tone: 'warning',
          actionLabel: 'Refresh',
          action: refresh,
        }
      : view === 'pipeline'
        ? {
            eyebrow: `PURSUIT PIPELINE · ${(clientName ?? 'PICK A CLIENT').toUpperCase()}`,
            title: 'Pursuit pipeline',
            description:
              'Stages a person recorded. Nothing moves until the server accepts it, and a move to a terminal stage asks for the outcome.',
            status:
              pipelineTotal == null
                ? 'Select a client'
                : `${pipelineTotal} staged · ${pipelineDerived ?? 0} derived`,
            tone: 'brand',
            actionLabel: 'Export board',
            action: exportPipeline,
          }
        : {
            eyebrow: 'FEDERAL CATALOG · RESEARCH',
            title: 'Explore catalog',
            description:
              'Every source record, scored against the selected client. A grant ceiling is not what a client will receive, and SAM.gov often states no value at all.',
            status: catalogTotalLabel,
            tone: 'success',
            actionLabel: 'Save this view',
            action: saveCurrentView,
          };

  const tabs: ModuleTab[] = [
    {
      value: 'explore',
      label: 'Explore catalog',
      // Preserve the established accessible name used by links and tests while
      // the visible label follows the approved prototype.
      ariaLabel: 'Explore federal opportunities',
    },
    ...(inboxAvailable
      ? [
          {
            value: 'inbox' as const,
            label: 'Triage inbox',
            ariaLabel: 'Triage inbox',
            badge: inboxCount,
          },
        ]
      : []),
    ...(pipelineAvailable
      ? [
          {
            value: 'pipeline' as const,
            label: 'Pursuit pipeline',
            ariaLabel: 'Pursuit pipeline',
            badge: pipelineTotal == null ? '—' : String(pipelineTotal),
          },
        ]
      : []),
  ];

  return (
    <div className={`fov fov-page fo-module fo-module--${view}`}>
      <span className="fo-sr-only">
        Funding Opportunities contains future competitions, not awarded funding.
      </span>

      <header className="fo-module-hero">
        <div className="fo-module-hero__copy">
          <span className="fo-module-eyebrow">{hero.eyebrow}</span>
          <h1>{hero.title}</h1>
          <p>{hero.description}</p>
        </div>
        <div className="fo-module-hero__actions">
          <div className="fo-module-action-row">
            <label className="fo-scope-control">
              <span className="fo-sr-only">Client</span>
              <select
                value={clientId ?? ''}
                onChange={(event) => setClient(event.target.value || undefined)}
                aria-label="Client"
                aria-busy={clients.isLoading || undefined}
              >
                <option value="">
                  {view === 'pipeline' ? 'Select a client' : 'All clients'}
                </option>
                {visibleClients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
              <span aria-hidden="true">⌄</span>
            </label>
            <CapiroButton onClick={hero.action}>{hero.actionLabel}</CapiroButton>
          </div>
          <span className={`fo-status-pill fo-status-pill--${hero.tone}`}>
            <i aria-hidden="true" />
            {hero.status}
          </span>
        </div>
      </header>

      {inboxAvailable ? (
        <div
          className="fo-module-tabs"
          role="tablist"
          aria-label="Funding Opportunities view"
        >
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-label={tab.ariaLabel}
              aria-selected={view === tab.value}
              className={view === tab.value ? 'is-active' : undefined}
              onClick={() => setView(tab.value)}
            >
              <span>{tab.label}</span>
              {tab.badge ? <b>{tab.badge}</b> : null}
            </button>
          ))}
        </div>
      ) : null}

      <main className={`fo-module-body fo-module-body--${view}`}>
        {view === 'inbox' ? (
          <FundingSourceRails
            activeSource={(url.get('source') as SourceRailValue | null) ?? ''}
            freshness={catalogSummary.data?.freshness}
            catalogTotal={catalogSummary.data?.total}
            catalogTotalIsCapped={catalogSummary.data?.totalIsCapped}
            forecastsEnabled={forecastsEnabled}
            sbirEnabled={sbirEnabled}
            onChange={(source) =>
              url.set({ source: source || null, cursor: null, detail: null })
            }
          />
        ) : null}

        {view === 'pipeline' ? (
          clientId ? (
            <FundingOpportunityPipeline clientId={clientId} />
          ) : (
            <section className="fo-pipeline-client-empty" data-testid="fo-pipeline-client-empty">
              <div aria-hidden="true">◇</div>
              <h2>The pipeline is one client’s board</h2>
              <p>
                Stages belong to a client-opportunity pair, so there is no cross-client board to
                show. Pick a client and the recorded stages appear.
              </p>
              <label className="fo-pipeline-client-picker">
                <span className="fo-sr-only">Choose a client for the pipeline</span>
                <select
                  value=""
                  onChange={(event) => setClient(event.target.value || undefined)}
                  aria-label="Choose a client for the pipeline"
                >
                  <option value="">Choose a client</option>
                  {visibleClients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )
        ) : view === 'inbox' ? (
          <FundingOpportunityInbox
            clientId={clientId}
            clientName={clientName}
            onSelectClient={setClient}
          />
        ) : (
          <FundingOpportunityExplore clientId={clientId} />
        )}
      </main>
    </div>
  );
}

/**
 * Compact relative time for a source-health timestamp — "42m", "3h",
 * "Yesterday", or a short date once it's stale enough that minutes/hours stop
 * being useful. Kept local rather than imported from an unrelated module: this
 * component owns no dependency outside the funding-opportunities API.
 */
function compactRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Unknown';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function FundingSourceRails({
  activeSource,
  freshness,
  catalogTotal,
  catalogTotalIsCapped,
  forecastsEnabled,
  sbirEnabled,
  onChange,
}: {
  activeSource: SourceRailValue;
  freshness: OpportunitySourceFreshness[] | undefined;
  catalogTotal: number | undefined;
  catalogTotalIsCapped: boolean | undefined;
  forecastsEnabled: boolean;
  sbirEnabled: boolean;
  onChange: (source: SourceRailValue) => void;
}) {
  const health = new Map((freshness ?? []).map((entry) => [entry.source, entry]));
  const railMeta = (source: 'grants_gov' | 'sam_gov') => {
    const entry = health.get(source);
    if (!entry) return 'Loading source health';
    if (entry.countsUnavailable || entry.activeRecordCount == null) {
      return `${compactRelativeTime(entry.lastSyncedAt)} · counts unavailable`;
    }
    const active = entry.activeRecordCount.toLocaleString();
    const ofTotal = entry.recordCount != null ? ` of ${entry.recordCount.toLocaleString()}` : '';
    return `${compactRelativeTime(entry.lastSyncedAt)} · ${active} active${ofTotal}`;
  };
  const railTone = (source: 'grants_gov' | 'sam_gov') => {
    const entry = health.get(source);
    if (!entry) return 'neutral';
    if (entry.neverSynced || entry.lastRunStatus === 'error') return 'error';
    if (entry.lastRunDegraded) return 'warning';
    return 'success';
  };

  const rails: Array<{
    value: SourceRailValue;
    label: string;
    meta: string;
    tone: 'neutral' | 'success' | 'warning' | 'error' | 'off';
    disabled?: boolean;
  }> = [
    {
      value: '',
      label: 'All sources',
      meta:
        catalogTotal == null
          ? 'Loading catalog totals'
          : `${catalogTotal.toLocaleString()}${catalogTotalIsCapped ? '+' : ''} active`,
      tone: 'neutral',
    },
    {
      value: 'grants_gov',
      label: 'Grants.gov',
      meta: railMeta('grants_gov'),
      tone: railTone('grants_gov'),
    },
    {
      value: 'sam_gov',
      label: 'SAM.gov',
      meta: railMeta('sam_gov'),
      tone: railTone('sam_gov'),
    },
    {
      value: DIBBS_SOURCE,
      label: 'DLA bid board',
      meta: 'Available to this workspace',
      tone: 'neutral',
    },
    {
      value: FORECAST_SOURCE,
      label: 'Agency forecasts',
      meta: forecastsEnabled ? 'Capability enabled' : 'Not enabled',
      tone: forecastsEnabled ? 'success' : 'off',
      disabled: !forecastsEnabled,
    },
    {
      value: SBIR_SOURCE,
      label: 'SBIR / STTR',
      meta: sbirEnabled ? 'Capability enabled' : 'Not enabled',
      tone: sbirEnabled ? 'success' : 'off',
      disabled: !sbirEnabled,
    },
  ];

  return (
    <section className="fo-source-rails" aria-label="Opportunity source rails">
      <div className="fo-source-rails__heading">
        <div>
          <span className="fo-module-eyebrow">SOURCE RAILS</span>
          <strong>Filter the decision queue by provider</strong>
        </div>
        <span>Source is a filter, not a separate workflow.</span>
      </div>
      <div className="fo-source-rails__grid">
        {rails.map((rail) => (
          <button
            key={rail.value || 'all'}
            type="button"
            disabled={rail.disabled}
            className={activeSource === rail.value ? 'is-active' : undefined}
            data-tone={rail.tone}
            onClick={() => onChange(rail.value)}
          >
            <i className={`is-${rail.tone}`} aria-hidden="true" />
            <span>
              <strong>{rail.label}</strong>
              <small>{rail.meta}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
