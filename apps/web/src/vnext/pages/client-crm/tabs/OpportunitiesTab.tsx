import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Card, CardHead, Pill, type PillTone } from '../portfolio-primitives.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { useApi } from '../../../../lib/use-api.js';
import { refreshOpportunityQueries } from '../../../pages/funding-opportunities/opportunity-query-cache.js';
import { decodeHtmlEntities } from '../../../../lib/html-entities.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import {
  getRelevantPesForClient,
  formatScorePct,
  type RelevantPeRow,
} from '../../../../pages/clients/relevance-api.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  deadlineLabel,
  opportunityDeadline,
  emptyExplanation,
  opportunityTypeLabel,
  opportunityValueLabel,
  sourceLabel,
  useClientFundingOpportunitiesV2,
  clientOpportunityDetailPath,
  pursuingCount,
} from '../../../adapters/legacy/useClientFundingOpportunitiesV2.js';
import type { OpportunitySearchRecordV2 } from '@capiro/shared';
import { LinkBtn, SecondaryBtn, CouldNotLoad, DomainStatsStrip } from './IntelligenceTab.js';
import './intelligence-tab.css';
import './opportunities-tab.css';

/**
 * Opportunities — a top-level client directory (spec §10.4's former "Funding &
 * Budget" domain, moved out of the Intelligence tab). Grant/contract
 * opportunities matched to the client, plus relevant defense budget programs.
 * Same queries, same components, same "never fake a permanently-unavailable
 * control" rules as the rest of the client-intelligence surface it was
 * carved out of — only the routing changed, not the data or its states.
 */

/** Real domain-stats-strip values from the same queries FundingPanel below
 * runs. react-query dedupes by key, so this is no extra network traffic. */
function useOpportunitiesStats(client: Client): Array<[string, string]> | undefined {
  const api = useApi();
  const { enabled: foEnabled, ready: foReady } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const { search: oppsQ, pipeline, pipelineFeature } = useClientFundingOpportunitiesV2(client.id);
  const pesQ = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    staleTime: 60_000,
  });

  // "Relevant programs" (pesQ) carries no dependency on the funding_opportunities
  // canary flag — it never did — so it must not be held hostage by the other
  // four cells, which do. Same "fill in from whichever query answers first"
  // rule Legislative & Regulatory already applies in IntelligenceTab.
  if ((foReady && foEnabled && oppsQ.isSuccess) || pesQ.isSuccess) {
    const relevantPrograms = pesQ.isSuccess ? String(pesQ.data.data.length) : '—';
    if (foReady && foEnabled && oppsQ.isSuccess) {
      const c = oppsQ.data.counts;
      const pursuing = pipelineFeature.ready && pipelineFeature.enabled ? pursuingCount(pipeline.data) : null;
      const active = c.grants == null || c.contracts == null ? '—' : String(c.grants + c.contracts);
      return [
        [active, 'Active grants & contracts'],
        [pursuing == null ? '—' : String(pursuing), 'Pursuing'],
        ['Unavailable', 'Saved'],
        [relevantPrograms, 'Programs shown'],
        [
          deadlineLabel((oppsQ.data.opportunities ?? []).find((row) => row.deadline)?.deadline ?? null),
          'Next deadline',
        ],
      ];
    }
    return [
      ['—', 'Active grants & contracts'],
      ['—', 'Pursuing'],
      ['—', 'Saved'],
      [relevantPrograms, 'Programs shown'],
      ['—', 'Next deadline'],
    ];
  }
  return undefined;
}

/**
 * A canary feature flag confirmed OFF for this tenant — not an error (nothing
 * to retry) and not "no results" (there is no result to have). Same visual
 * treatment as CouldNotLoad, since both are "this card has no real content
 * to show and says so honestly," but distinct copy: retrying a flag that is
 * off will never turn it on.
 */
function FeatureNotEnabled({ what }: { what: string }) {
  return (
    <div className="capiro-intel-error">
      <p className="capiro-intel-error-text">{what} is not enabled for this account yet.</p>
    </div>
  );
}

export function ClientCrmOpportunitiesProto({ client }: { client: Client }) {
  const qc = useQueryClient();
  const realStats = useOpportunitiesStats(client);
  const toast = useCapiroToast();
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshOpportunityQueries(qc, client.id),
        qc.invalidateQueries(
          { queryKey: ['client-pe-relevance', client.id] },
          { throwOnError: true },
        ),
      ]);
      toast.success('Current records refreshed.');
    } catch {
      toast.error('Some records could not refresh. Please try again.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="cap-pf-anim-rise capiro-intel capiro-intel-stack-24 capiro-client-opportunities">
      {/* No TabPageHead here, unlike every sibling tab. Those each sit under a
          record-surface header whose description says something DIFFERENT from
          their own; this panel's did not — it restated the surface description
          verbatim but for "in one place" / "in one domain", under a title
          ("Funding & Budget") that contradicted the row the user had just
          clicked ("Opportunities"). That reads as two headings for one thing.
          Carried over from when this was a domain INSIDE Intelligence, where
          the domain name was what distinguished it from the other three in the
          stack; standing alone it distinguishes nothing. The surface header
          already names and describes this tab, so only the action remains. */}
      <div className="capiro-intel-actions-row">
        <SecondaryBtn onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </SecondaryBtn>
      </div>
      <DomainStatsStrip view="funding" realValues={realStats} />
      <FundingPanel client={client} />
    </div>
  );
}

/** Workflow status → pill presentation. Reads the real `OpportunityWorkflow.status`
 * enum directly; `null` means no workflow row exists yet (nothing decided either way). */
function FundingPanel({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  // Loading, errors, and unavailable features have distinct states.
  const { enabled: foEnabled, ready: foReady } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const { search: opportunitiesQ } = useClientFundingOpportunitiesV2(client.id);
  const realOpportunities = foReady && foEnabled && opportunitiesQ.isSuccess ? opportunitiesQ.data : null;
  const opportunityRows = realOpportunities?.opportunities.slice(0, 6) ?? [];
  const opportunitiesFailed = foReady && foEnabled && opportunitiesQ.isError;
  const opportunitiesDisabled = foReady && !foEnabled;

  const pesQ = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    staleTime: 60_000,
  });
  const realPes = pesQ.isSuccess ? pesQ.data.data : null;
  const pesFailed = pesQ.isError;

  return (
    <div className="capiro-intel-stack-24">
      <div className="cap-pf-grid-intel capiro-client-opportunities__grid">
        {/* Opportunities */}
        <Card>
          <div className="capiro-intel-panel-head">
            <span className="capiro-intel-panel-head-copy">
              <span className="capiro-intel-title-md" style={{ display: 'block' }}>
                Opportunities
              </span>
              <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
                Fit uses capabilities, funding priorities, award history, and relevant programs.
                Organization types help check grant eligibility separately.
              </span>
            </span>
            {realOpportunities ? (
              <LinkBtn
                onClick={() =>
                  navigate(
                    `/intelligence/opportunities?client=${encodeURIComponent(client.id)}&tab=opportunities`,
                  )
                }
              >
                Open recommendations
              </LinkBtn>
            ) : null}
          </div>
          {opportunitiesFailed ? (
            <CouldNotLoad
              what="Funding opportunities"
              error={opportunitiesQ.error}
              onRetry={() => void opportunitiesQ.refetch()}
            />
          ) : opportunitiesDisabled ? (
            <FeatureNotEnabled what="Funding opportunities" />
          ) : (
            <div className="capiro-intel-panel-body">
              {realOpportunities ? (
                opportunityRows.length ? (
                  opportunityRows.map((o) => <RealOppRow key={o.id} o={o} clientId={client.id} />)
                ) : (
                  <p className="capiro-intel-note capiro-intel-note-inset">
                    {emptyExplanation(realOpportunities)}
                  </p>
                )
              ) : (
                <LoadingRows label="Loading funding opportunities" />
              )}
            </div>
          )}
        </Card>

        {/* Relevant budget programs */}
        <Card>
          <CardHead
            title="Relevant budget programs"
            action={<LinkBtn onClick={() => navigate('/program-elements')}>Open budget</LinkBtn>}
          />
          {pesFailed ? (
            <CouldNotLoad
              what="Relevant budget programs"
              error={pesQ.error}
              onRetry={() => void pesQ.refetch()}
            />
          ) : (
            <div className="capiro-intel-panel-body-16">
              {realPes ? (
                realPes.length ? (
                  realPes.map((pe) => (
                    <RealProgramRow
                      key={pe.peCode}
                      pe={pe}
                      onOpen={() => navigate(`/program-elements/${pe.peCode}`)}
                    />
                  ))
                ) : (
                  <p className="capiro-intel-note capiro-intel-note-inset">
                    No program elements scored above the relevance threshold for this client.
                  </p>
                )
              ) : (
                <LoadingRows label="Loading relevant budget programs" />
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RealOppRow({ o, clientId }: { o: OpportunitySearchRecordV2; clientId: string }) {
  const stage = o.decoration?.workflow.stage ?? null;
  const workflowStatus = o.decoration?.workflow.status ?? null;
  const deadlinePresentation = opportunityDeadline(o.deadline, workflowStatus ?? stage, o.lifecycle);
  const deadline = deadlinePresentation.value;
  const soon = deadlinePresentation.daysRemaining != null && deadlinePresentation.daysRemaining >= 0 && deadlinePresentation.daysRemaining <= 14;
  const statusLabel = stage ? stage.replaceAll('_', ' ') : workflowStatus ?? 'Match';
  const statusTone: PillTone = stage === 'pursuing' ? 'brand' : 'gray';
  const dotless = stage !== 'pursuing';
  return (
    <div className="capiro-intel-opp-row">
      <span className="capiro-intel-opp-main">
        <span className="capiro-intel-opp-title">
          <Link
            to={clientOpportunityDetailPath(clientId, o.source, o.sourceRecordId)}
            style={{ color: 'inherit' }}
          >
            {decodeHtmlEntities(o.title)}
          </Link>
        </span>
        <span className="capiro-intel-opp-agency">{o.agency ?? sourceLabel(o.source)}</span>
        {o.matchedSignals[0] ? (
          <span className="capiro-intel-opp-agency">
            {o.matchedSignals[0].matchedOn}
          </span>
        ) : null}
        <span className="capiro-intel-opp-agency" title={o.eligibility?.reason ?? 'Eligibility was not stated by the source.'}>
          Eligibility: {o.eligibility?.state?.replaceAll('_', ' ') ?? 'unknown'}
        </span>
      </span>
      <div className="capiro-client-opportunities__metadata">
        <span className="capiro-intel-opp-kind">{opportunityTypeLabel(o.type)}</span>
        <span className="capiro-intel-opp-money">
          <span className="capiro-intel-opp-amount">{opportunityValueLabel(o.value, o.valueBasis)}</span>
          <span
            className={
              soon ? 'capiro-intel-opp-due capiro-intel-opp-due--soon' : 'capiro-intel-opp-due'
            }
          >
            {o.deadline ? `Due ${deadline}` : deadline}
          </span>
        </span>
        <span className="capiro-intel-opp-pills">
          <Pill tone={statusTone} dotless={dotless}>
            {statusLabel}
          </Pill>
        </span>
      </div>
    </div>
  );
}

function RealProgramRow({ pe, onOpen }: { pe: RelevantPeRow; onOpen: () => void }) {
  return (
    <div className="capiro-intel-pe-card">
      <div className="capiro-intel-pe-top">
        <span className="capiro-intel-pe-code">{pe.peCode}</span>
        <span className="capiro-intel-pe-title">{decodeHtmlEntities(pe.title ?? pe.peCode)}</span>
      </div>
      <div className="capiro-intel-pe-rel">
        <span className="capiro-intel-eyebrow-xs">Relevance</span>
        <span className="capiro-intel-pe-figure-value">{formatScorePct(pe.score)}</span>
      </div>
      <div className="capiro-intel-pe-foot">
        <LinkBtn onClick={onOpen}>Open PE →</LinkBtn>
      </div>
    </div>
  );
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div aria-label={label} role="status" aria-busy="true" style={{ padding: 16 }}>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          aria-hidden="true"
          style={{
            height: 48,
            marginBottom: 12,
            borderRadius: 8,
            background: 'var(--capiro-color-surface-secondary, #f2f4f7)',
          }}
        />
      ))}
      <span>{label}…</span>
    </div>
  );
}
