import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Card, CardHead, Pill, type PillTone } from '../portfolio-primitives.js';
import { useCapiroToast } from '../../../components/feedback/toast.js';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import {
  getRelevantPesForClient,
  formatScorePct,
  type RelevantPeRow,
} from '../../../../pages/clients/relevance-api.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  KIND_LABELS,
  SOURCE_LABELS,
  formatDeadline,
  moneyLine,
  opportunityDetailPath,
  type ClientFundingOpportunitySummary,
  type FundingOpportunity,
  type OpportunityWorkflowStatus,
} from '../../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { LinkBtn, SecondaryBtn, CouldNotLoad, DomainStatsStrip } from './IntelligenceTab.js';
import './intelligence-tab.css';

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
  const oppsQ = useQuery<ClientFundingOpportunitySummary>({
    queryKey: ['client-funding-opportunities', client.id],
    queryFn: async () =>
      (
        await api.get<ClientFundingOpportunitySummary>(
          `/api/intelligence/clients/${client.id}/opportunities/summary`,
        )
      ).data,
    enabled: Boolean(client.id) && foReady && foEnabled,
    staleTime: 2 * 60_000,
    retry: 1,
  });
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
      const pursuing = c.pursuing;
      return [
        [String(c.activeGrants + c.activeContracts), 'Active grants & contracts'],
        [String(pursuing), 'Pursuing'],
        [String(c.saved), 'Saved'],
        [relevantPrograms, 'Programs shown'],
        [
          oppsQ.data.nextDeadline
            ? formatDeadline(oppsQ.data.nextDeadline.responseDeadline, null).text
            : 'None stated',
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
        qc.invalidateQueries(
          { queryKey: ['client-funding-opportunities', client.id] },
          { throwOnError: true },
        ),
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
    <div className="cap-pf-anim-rise capiro-intel capiro-intel-stack-24">
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
        {/* There is no dedicated funding-sync API — this invalidates the SAME
            query keys FundingPanel's own opportunities/PE-relevance queries
            use, so a click forces a real re-read rather than a fabricated delay. */}
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
function workflowStatusPill(status: OpportunityWorkflowStatus | null): {
  label: string;
  tone: PillTone;
  dotless: boolean;
} {
  switch (status) {
    case 'pursuing':
      return { label: 'Pursuing', tone: 'brand', dotless: false };
    case 'won':
      return { label: 'Won', tone: 'success', dotless: false };
    case 'saved':
      return { label: 'Saved', tone: 'gray', dotless: true };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'gray', dotless: true };
    case 'lost':
      return { label: 'Lost', tone: 'gray', dotless: true };
    case 'expired':
      return { label: 'Expired', tone: 'gray', dotless: true };
    case 'suggested':
      return { label: 'Suggested', tone: 'gray', dotless: true };
    default:
      return { label: 'Match', tone: 'gray', dotless: true };
  }
}

function FundingPanel({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  // Loading, errors, and unavailable features have distinct states.
  const { enabled: foEnabled, ready: foReady } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const opportunitiesQ = useQuery<ClientFundingOpportunitySummary>({
    queryKey: ['client-funding-opportunities', client.id],
    queryFn: async () =>
      (
        await api.get<ClientFundingOpportunitySummary>(
          `/api/intelligence/clients/${client.id}/opportunities/summary`,
        )
      ).data,
    enabled: Boolean(client.id) && foReady && foEnabled,
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const realOpportunities =
    foReady && foEnabled && opportunitiesQ.isSuccess ? opportunitiesQ.data : null;
  const opportunityRows = realOpportunities
    ? [...realOpportunities.topGrants, ...realOpportunities.topContracts].slice(0, 6)
    : [];
  const opportunitiesFailed = foReady && foEnabled && opportunitiesQ.isError;
  const opportunitiesDisabled = foReady && !foEnabled;

  // Item 4: Open budget / Open PE. Real PE ids + titles from the relevance
  // engine (minScore 0.5).
  const pesQ = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    staleTime: 60_000,
  });
  const realPes = pesQ.isSuccess ? pesQ.data.data : null;
  const pesFailed = pesQ.isError;

  return (
    <div className="capiro-intel-stack-24">
      {/* The nested Overview/Opportunities/Programs/Pursuits bar is gone: its
          state was never read — all four options rendered these same two
          cards. Dead chrome that promises filtering is worse than none. */}
      <div className="cap-pf-grid-intel">
        {/* Opportunities */}
        <Card>
          <div className="capiro-intel-panel-head">
            <span className="capiro-intel-panel-head-copy">
              <span className="capiro-intel-title-md" style={{ display: 'block' }}>
                Opportunities
              </span>
              <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
                Matches use capabilities, facilities, eligibility, agencies, and Strategy context.
              </span>
            </span>
            {realOpportunities ? (
              <LinkBtn
                onClick={() =>
                  navigate(
                    `/intelligence/opportunities?view=inbox&clientId=${encodeURIComponent(client.id)}`,
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
                    {realOpportunities.emptyExplanation ??
                      'No opportunity currently clears the relevance threshold for this client.'}
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

function RealOppRow({ o, clientId }: { o: FundingOpportunity; clientId: string }) {
  const money = moneyLine(o);
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const soon =
    deadline.daysRemaining != null && deadline.daysRemaining >= 0 && deadline.daysRemaining <= 14;
  const {
    label: statusLabel,
    tone: statusTone,
    dotless,
  } = workflowStatusPill(o.workflow?.status ?? null);
  return (
    <div className="capiro-intel-opp-row">
      <span className="capiro-intel-opp-kind">{KIND_LABELS[o.kind]}</span>
      <span className="capiro-intel-opp-main">
        <span className="capiro-intel-opp-title">
          <Link
            to={opportunityDetailPath({
              source: o.source,
              sourceRecordId: o.sourceRecordId,
              clientId,
            })}
            style={{ color: 'inherit' }}
          >
            {o.title}
          </Link>
        </span>
        <span className="capiro-intel-opp-agency">{o.agency ?? SOURCE_LABELS[o.source]}</span>
      </span>
      <span className="capiro-intel-opp-money">
        <span className="capiro-intel-opp-amount">{money.value}</span>
        <span
          className={
            soon ? 'capiro-intel-opp-due capiro-intel-opp-due--soon' : 'capiro-intel-opp-due'
          }
        >
          {deadline.daysRemaining != null ? `Due ${deadline.text}` : deadline.text}
        </span>
      </span>
      <span className="capiro-intel-opp-pills">
        <Pill tone={statusTone} dotless={dotless}>
          {statusLabel}
        </Pill>
      </span>
    </div>
  );
}

function RealProgramRow({ pe, onOpen }: { pe: RelevantPeRow; onOpen: () => void }) {
  return (
    <div className="capiro-intel-pe-card">
      <div className="capiro-intel-pe-top">
        <span className="capiro-intel-pe-code">{pe.peCode}</span>
        <span className="capiro-intel-pe-title">{pe.title ?? pe.peCode}</span>
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
