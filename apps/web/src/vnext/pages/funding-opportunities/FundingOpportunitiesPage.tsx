import { useState } from 'react';
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
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
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
export const OPPORTUNITY_VIEWS = ['inbox', 'explore', 'pipeline'] as const;
export type OpportunityView = (typeof OPPORTUNITY_VIEWS)[number];

/** Native vNext module; the surrounding application navigation belongs to the shell. */
export function FundingOpportunitiesPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const inboxFlag = useIntelFeature(FUNDING_OPPORTUNITIES_INBOX_FEATURE);
  const pipelineFlag = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();
  const [refreshing, setRefreshing] = useState(false);
  const clientId = url.get('clientId') ?? undefined;
  const inboxAvailable = inboxFlag.ready && inboxFlag.enabled;
  const boardAvailable = inboxAvailable && pipelineFlag.ready && pipelineFlag.enabled;
  const view = readEnum<OpportunityView>(
    url.get('view'),
    inboxAvailable ? OPPORTUNITY_VIEWS : ['explore'],
    inboxAvailable ? 'inbox' : 'explore',
  );
  const board = view === 'pipeline' && boardAvailable && url.get('layout') === 'board';
  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });
  const visibleClients = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const clientName = visibleClients.find((client) => client.id === clientId)?.name;

  function setClient(next: string | undefined) {
    url.set({ clientId: next ?? null, cursor: null, page: null, detail: null });
  }
  function setView(next: OpportunityView) {
    // Explicit explore remains explicit now that Recommended is the default.
    url.set({
      view: next,
      filter: null,
      cursor: null,
      page: null,
      detail: null,
      layout: null,
    });
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all(
        [
          'funding-opportunities',
          'funding-opportunity-inbox',
          'funding-opportunities-freshness',
          'funding-opportunity-pipeline',
          'funding-opportunity-detail',
          'funding-opportunity-forecast',
          'funding-opportunity-feed',
          'funding-opportunity-feed-detail',
          'funding-opportunity-action-plan',
          'engagement-tasks',
          'client-funding-opportunities',
        ].map((key) => qc.invalidateQueries({ queryKey: [key] }, { throwOnError: true })),
      );
      toast.success('Current opportunity records refreshed.');
    } catch {
      toast.error('Some records could not refresh. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }
  async function copyViewLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('View link copied.');
    } catch {
      toast.error('The browser could not copy this view link.');
    }
  }

  if (!ready || !inboxFlag.ready)
    return (
      <div className="fov">
        <FovSkeletonRows rows={6} />
      </div>
    );
  if (!enabled)
    return (
      <div className="fov">
        <FovAlert tone="info" message="Funding Opportunities is not enabled for this workspace" />
      </div>
    );

  return (
    <div className={`fov fov-page fo-module fo-module--${view}`}>
      <header className="fo-module-hero">
        <div className="fo-module-hero__copy">
          <h1>Funding Opportunities</h1>
          <p>Find a fit for your clients, decide what to pursue, and keep the next step in view.</p>
        </div>
        <div className="fo-module-hero__actions">
          <div className="fo-module-action-row">
            <CapiroButton onClick={() => void copyViewLink()}>Copy view link</CapiroButton>
            <CapiroButton loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </CapiroButton>
          </div>
        </div>
      </header>
      {inboxAvailable ? (
        <div className="fo-module-tabs" role="tablist" aria-label="Funding Opportunities view">
          {(
            [
              { value: 'inbox', label: 'Recommended' },
              { value: 'explore', label: 'Browse' },
              { value: 'pipeline', label: 'Tracking' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              id={`fo-view-${tab.value}`}
              aria-controls="fo-view-panel"
              aria-selected={view === tab.value}
              tabIndex={view === tab.value ? 0 : -1}
              onKeyDown={(event) => {
                const index = OPPORTUNITY_VIEWS.indexOf(tab.value);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % 3
                    : event.key === 'ArrowLeft'
                      ? (index + 2) % 3
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 2
                          : null;
                if (next == null) return;
                event.preventDefault();
                const target = OPPORTUNITY_VIEWS[next]!;
                setView(target);
                document.getElementById(`fo-view-${target}`)?.focus();
              }}
              className={view === tab.value ? 'is-active' : undefined}
              onClick={() => setView(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <main
        id="fo-view-panel"
        role={inboxAvailable ? 'tabpanel' : undefined}
        aria-labelledby={inboxAvailable ? `fo-view-${view}` : undefined}
        className={`fo-module-body fo-module-body--${view}`}
      >
        {!inboxAvailable ? (
          <p className="fov-muted">
            Recommendations and tracking are not enabled for this workspace. You can browse source
            records below.
          </p>
        ) : null}
        <div className="fo-view-toolbar">
          <label className="fo-scope-control">
            <span className="fo-sr-only">Client</span>
            <select
              value={clientId ?? ''}
              onChange={(event) => setClient(event.target.value || undefined)}
              aria-label="Client"
              aria-busy={clients.isLoading || undefined}
            >
              <option value="">
                {view === 'pipeline'
                  ? 'Select a client'
                  : view === 'explore'
                    ? 'Research without a client'
                    : 'All accessible clients'}
              </option>
              {clientId && !visibleClients.some((client) => client.id === clientId) ? (
                <option value={clientId}>
                  {clients.isLoading ? 'Loading selected client…' : 'Selected client unavailable'}
                </option>
              ) : null}
              {visibleClients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <span aria-hidden="true">⌄</span>
          </label>
          {view === 'pipeline' && clientId && boardAvailable ? (
            <div className="fov-row" role="group" aria-label="Tracking view">
              <CapiroButton aria-pressed={!board} onClick={() => url.set({ layout: null })}>
                List
              </CapiroButton>
              <CapiroButton aria-pressed={board} onClick={() => url.set({ layout: 'board' })}>
                Pursuit board
              </CapiroButton>
            </div>
          ) : null}
        </div>
        {clients.isError ? (
          <FovAlert
            tone="error"
            message="Clients could not be loaded"
            action={<CapiroButton onClick={() => void clients.refetch()}>Retry</CapiroButton>}
          />
        ) : null}
        {view === 'pipeline' ? (
          clientId ? (
            board ? (
              <FundingOpportunityPipeline clientId={clientId} />
            ) : (
              <FundingOpportunityInbox
                key={`tracking:${clientId}`}
                clientId={clientId}
                clientName={clientName}
                onSelectClient={setClient}
                mode="tracking"
              />
            )
          ) : (
            <section className="fo-pipeline-client-empty" data-testid="fo-pipeline-client-empty">
              <h2>Choose a client to see tracked work</h2>
              <p>
                Use the client selector above to find saved opportunities, watched forecasts, and
                active pursuits.
              </p>
            </section>
          )
        ) : view === 'inbox' ? (
          <FundingOpportunityInbox
            key={`recommended:${clientId ?? 'all'}`}
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
