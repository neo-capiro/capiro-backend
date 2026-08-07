import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Segmented, Select, Skeleton, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { FundingOpportunityInbox } from './FundingOpportunityInbox.js';
import { FundingOpportunityExplore } from './FundingOpportunityExplore.js';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { readEnum, useUrlState } from './funding-opportunities-url-state.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  FUNDING_OPPORTUNITIES_INBOX_FEATURE,
} from './funding-opportunities-api.js';
import './funding-opportunities.css';

const { Title, Paragraph } = Typography;

interface ClientLite {
  id: string;
  name: string;
  status?: string;
}

export const OPPORTUNITY_VIEWS = ['inbox', 'explore'] as const;
export type OpportunityView = (typeof OPPORTUNITY_VIEWS)[number];

/**
 * Funding Opportunities.
 *
 * ── P11: this file is now a SHELL ────────────────────────────────────────────
 *
 * It owns the three things both views share — the feature gate, the client
 * selector, and which view is showing — and nothing else. The catalog that used to
 * live here moved verbatim into {@link FundingOpportunityExplore}; the new default
 * is {@link FundingOpportunityInbox}.
 *
 * ── The flag decides what "default" means, and nothing else ──────────────────
 *
 * With `funding_opportunities_client_inbox` OFF, this page behaves exactly as it
 * did before P11: one view, the raw catalog, no view switcher, no inbox request.
 * That is not a courtesy — it is the rollback path. Turning the flag off restores
 * the previous product without a deploy.
 *
 * With it ON, the inbox is the landing view and the catalog becomes
 * "Explore federal opportunities": still complete, still the research tool, just
 * no longer the answer to "what should my team do today".
 *
 * ── Deep links ───────────────────────────────────────────────────────────────
 *
 * `?clientId=<id>` is the link every client surface already emits and it keeps
 * working: with the inbox on it narrows the inbox to that client, with the inbox
 * off it scores the catalog against them, exactly as before. `?view=explore` on
 * top of it reaches the old page even for a tenant with the inbox enabled, so no
 * existing bookmark loses its destination.
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
   * `?view=inbox` link belonging to a tenant whose flag was turned back off lands
   * on a working page rather than on a 404 from a route they cannot reach.
   */
  const view: OpportunityView = inboxAvailable
    ? readEnum<OpportunityView>(url.get('view'), OPPORTUNITY_VIEWS, 'inbox')
    : 'explore';

  const clients = useQuery<ClientLite[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
    enabled: ready && enabled,
  });

  function setClient(next: string | undefined) {
    // Cursor and page belong to the PREVIOUS client's result set. Carrying either
    // across a client change lands the reader on a page that does not exist.
    url.set({ clientId: next ?? null, cursor: null, page: null });
  }

  function setView(next: OpportunityView) {
    url.set({ view: next === 'inbox' ? null : next, cursor: null, page: null });
  }

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunities-freshness'] });
  }

  if (!ready) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (!enabled) {
    return (
      <Alert
        type="info"
        showIcon
        message="Funding Opportunities is not enabled for this workspace"
        description="Grants.gov and SAM.gov opportunity matching is available on request."
      />
    );
  }

  const visibleClients = (clients.data ?? []).filter((client) => client.status !== 'archived');
  const clientName = visibleClients.find((c) => c.id === clientId)?.name;

  return (
    <div className="fo-page">
      <header className="fo-page__header">
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Funding Opportunities
          </Title>
          <Paragraph type="secondary" style={{ margin: '4px 0 0', maxWidth: 760, fontSize: 12 }}>
            Grants and government contract opportunities a client could <strong>pursue</strong>.
            These are future competitions, not awarded funding. A grant ceiling is not what a
            client will receive, and SAM.gov often states no value at all.
          </Paragraph>
        </div>
        <Space>
          <Select
            allowClear
            showSearch
            placeholder="Select a client"
            style={{ width: 260 }}
            value={clientId}
            loading={clients.isLoading}
            optionFilterProp="label"
            onChange={(value) => setClient(value ?? undefined)}
            options={visibleClients.map((client) => ({ label: client.name, value: client.id }))}
            aria-label="Client"
          />
          <Button icon={<ReloadOutlined />} onClick={refresh}>
            Refresh
          </Button>
        </Space>
      </header>

      {inboxAvailable ? (
        <Segmented<OpportunityView>
          value={view}
          onChange={setView}
          aria-label="Funding Opportunities view"
          options={[
            { value: 'inbox', label: 'Triage inbox' },
            { value: 'explore', label: 'Explore federal opportunities' },
          ]}
        />
      ) : null}

      {/*
        The pursuit pipeline (P35) sits ABOVE the existing views rather than
        replacing one of them, and renders NOTHING when its flag is off. That is
        what "the flag off retains the current tabs" means concretely: the
        Segmented control above and both views below are untouched, because
        `workflow_status` is still the column every code path writes.
      */}
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
