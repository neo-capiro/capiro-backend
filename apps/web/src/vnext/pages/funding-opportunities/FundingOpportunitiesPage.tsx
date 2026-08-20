import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readEnum,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { FundingOpportunityExplore } from './FundingOpportunityExplore.js';
import { FundingOpportunityInbox } from './FundingOpportunityInbox.js';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { FovAlert, FovSegmented, FovSkeletonRows } from './fov-ui.js';
import './funding-opportunities-vnext.css';

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

export const OPPORTUNITY_VIEWS = ['explore', 'inbox'] as const;
export type OpportunityView = (typeof OPPORTUNITY_VIEWS)[number];

/**
 * Funding Opportunities — vNext port of the canonical shell.
 *
 * It owns the three things both views share — the feature gate, the client
 * selector, and which view is showing — and nothing else.
 *
 * Flag semantics are IDENTICAL to canonical: with
 * `funding_opportunities_client_inbox` OFF this page is one view, the raw
 * catalog, no view switcher, no inbox request (the rollback path). With it ON,
 * the inbox is the landing view. `?clientId=<id>` deep links keep working, and
 * `?view=explore` reaches the catalog even for a tenant with the inbox
 * enabled. The `funding_opportunities` gate itself renders the same skeleton
 * (not ready) and the same named not-enabled state.
 */
export function FundingOpportunitiesPage() {
  const { enabled, ready } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const inboxFlag = useIntelFeature(FUNDING_OPPORTUNITIES_INBOX_FEATURE);
  const api = useApi();
  const qc = useQueryClient();
  const url = useUrlState();

  const clientId = url.get('clientId') ?? undefined;
  const inboxAvailable = inboxFlag.ready && inboxFlag.enabled;
  /**
   * `explore` is the fallback whenever the inbox is not available, so a stale
   * `?view=inbox` link belonging to a tenant whose flag was turned back off
   * lands on a working page rather than on a 404.
   */
  const view: OpportunityView = inboxAvailable
    ? readEnum<OpportunityView>(url.get('view'), OPPORTUNITY_VIEWS, 'explore')
    : 'explore';

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });

  function setClient(next: string | undefined) {
    // Cursor and page belong to the PREVIOUS client's result set. Carrying
    // either across a client change lands the reader on a page that does not
    // exist.
    url.set({ clientId: next ?? null, cursor: null, page: null });
  }

  function setView(next: OpportunityView) {
    url.set({ view: next === 'explore' ? null : next, cursor: null, page: null });
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunities-freshness'] });
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

  const visibleClients = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const clientName = visibleClients.find((c) => c.id === clientId)?.name;

  return (
    <div className="fov fov-page">
      <header className="fov-page__header">
        <div>
          <h2 className="fov-page__title">Funding Opportunities</h2>
          <p className="fov-page__subtitle">
            Grants and government contract opportunities a client could <strong>pursue</strong>.
            These are future competitions, not awarded funding. A grant ceiling is not what a
            client will receive, and SAM.gov often states no value at all.
          </p>
        </div>
        <div className="fov-page__controls">
          <select
            className="capiro-select fov-filter-input"
            style={{ width: 260 }}
            value={clientId ?? ''}
            onChange={(event) => setClient(event.target.value || undefined)}
            aria-label="Client"
            aria-busy={clients.isLoading || undefined}
          >
            <option value="">Select a client</option>
            {visibleClients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <CapiroButton onClick={refresh}>Refresh</CapiroButton>
        </div>
      </header>

      {inboxAvailable ? (
        <FovSegmented<OpportunityView>
          value={view}
          onChange={setView}
          ariaLabel="Funding Opportunities view"
          options={[
            { value: 'explore', label: 'Explore federal opportunities' },
            { value: 'inbox', label: 'Triage inbox' },
          ]}
        />
      ) : null}

      {/* The pursuit pipeline (P35) sits ABOVE the existing views rather than
          replacing one of them, and renders NOTHING when its flag is off. */}
      {view === 'inbox' ? <FundingOpportunityPipeline clientId={clientId ?? null} /> : null}

      {view === 'inbox' ? (
        <FundingOpportunityInbox
          clientId={clientId}
          clientName={clientName}
          onSelectClient={setClient}
        />
      ) : (
        <FundingOpportunityExplore clientId={clientId} />
      )}
    </div>
  );
}
