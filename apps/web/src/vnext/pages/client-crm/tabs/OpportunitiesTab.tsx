import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, CardHead, Pill, TabPageHead, type PillTone } from '../portfolio-primitives.js';
import { OPPS, PROGRAMS } from '../portfolio-fixtures.js';
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
      const pursuing =
        oppsQ.data.topGrants.filter((o) => o.workflow?.status === 'pursuing').length +
        oppsQ.data.topContracts.filter((o) => o.workflow?.status === 'pursuing').length;
      return [
        [String(c.activeGrants + c.activeContracts), 'Active opportunities'],
        [String(pursuing), 'Pursuing'],
        ['—', 'Largest ceiling'],
        [relevantPrograms, 'Relevant programs'],
        ['—', 'Next deadline'],
      ];
    }
    return [
      ['—', 'Active opportunities'],
      ['—', 'Pursuing'],
      ['—', 'Largest ceiling'],
      [relevantPrograms, 'Relevant programs'],
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

  return (
    <div className="cap-pf-anim-rise capiro-intel capiro-intel-stack-24">
      <TabPageHead
        title="Funding & Budget"
        sub="Grant and contract opportunities, active pursuits, and relevant defense budget programs in one domain."
        actions={
          // There is no dedicated funding-sync API — this invalidates the SAME
          // query keys FundingPanel's own opportunities/PE-relevance queries
          // use, so a click forces a real re-read rather than a fabricated delay.
          <SecondaryBtn
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ['client-funding-opportunities', client.id] });
              void qc.invalidateQueries({ queryKey: ['client-pe-relevance', client.id] });
            }}
          >
            Sync sources
          </SecondaryBtn>
        }
      />
      <DomainStatsStrip view="funding" realValues={realStats} />
      <FundingPanel client={client} />
    </div>
  );
}

/** Workflow status → pill presentation. Reads the real `OpportunityWorkflow.status`
 * enum directly; `null` means no workflow row exists yet (nothing decided either way). */
function workflowStatusPill(status: OpportunityWorkflowStatus | null): { label: string; tone: PillTone; dotless: boolean } {
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

  // Item 5: Opportunities list. `funding_opportunities` is a per-tenant CANARY
  // flag (see funding-opportunities-flag.guard.ts) — "off" means "not rolled
  // out to this tenant yet," not "this tenant doesn't get this feature." The
  // backend 404s every route behind it when off; there is no teaser payload.
  // Showing the OPPS design fixture indefinitely in that state — invented
  // company names, dollar amounts and deadlines, with no indication they are
  // not real — is exactly the failure mode this surface's own rule elsewhere
  // forbids ("never fake a number a real query could have answered"), and it
  // is inconsistent with how every other canary-gated surface in this app
  // behaves (Dashboard's X Feed, District Nexus v2 both show an honest
  // "not available" state instead of a fake one). The fixture now renders
  // ONLY during the genuine loading flash — before flags have resolved, or
  // while an enabled tenant's own query is still in flight.
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
  const realOpportunities = foReady && foEnabled && opportunitiesQ.isSuccess ? opportunitiesQ.data : null;
  const opportunityRows = realOpportunities
    ? [...realOpportunities.topGrants, ...realOpportunities.topContracts].slice(0, 6)
    : [];
  // A confirmed fetch error on an ENABLED feature must not fall back to the
  // OPPS fixture either.
  const opportunitiesFailed = foReady && foEnabled && opportunitiesQ.isError;
  // Confirmed OFF (flags have resolved and the tenant isn't canaried in) —
  // distinct from "still loading," which is the only state the fixture may
  // still stand in for.
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
              <span className="capiro-intel-title-md" style={{ display: 'block' }}>Opportunities</span>
              <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
                Matches use capabilities, facilities, eligibility, agencies, and Strategy context.
              </span>
            </span>
            {realOpportunities ? (
              <LinkBtn onClick={() => navigate(`/intelligence/opportunities?clientId=${client.id}`)}>
                View all {realOpportunities.counts.activeGrants + realOpportunities.counts.activeContracts}
              </LinkBtn>
            ) : opportunitiesFailed || opportunitiesDisabled ? null : (
              <LinkBtn>View all 7</LinkBtn>
            )}
          </div>
          {opportunitiesFailed ? (
            <CouldNotLoad what="Funding opportunities" error={opportunitiesQ.error} onRetry={() => void opportunitiesQ.refetch()} />
          ) : opportunitiesDisabled ? (
            <FeatureNotEnabled what="Funding opportunities" />
          ) : (
            <div className="capiro-intel-panel-body">
              {realOpportunities ? (
                opportunityRows.length ? (
                  opportunityRows.map((o) => <RealOppRow key={o.id} o={o} />)
                ) : (
                  <p className="capiro-intel-note capiro-intel-note-inset">
                    {realOpportunities.emptyExplanation ??
                      'No opportunity currently clears the relevance threshold for this client.'}
                  </p>
                )
              ) : (
                OPPS.map((o) => <OppRow key={o.title} o={o} />)
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
            <CouldNotLoad what="Relevant budget programs" error={pesQ.error} onRetry={() => void pesQ.refetch()} />
          ) : (
            <div className="capiro-intel-panel-body-16">
              {realPes ? (
                realPes.length ? (
                  realPes.map((pe) => (
                    <RealProgramRow key={pe.peCode} pe={pe} onOpen={() => navigate(`/program-elements/${pe.peCode}`)} />
                  ))
                ) : (
                  <p className="capiro-intel-note capiro-intel-note-inset">
                    No program elements scored above the relevance threshold for this client.
                  </p>
                )
              ) : (
                PROGRAMS.map((p) => <ProgramCard key={p.code} p={p} />)
              )}
              {/* The "Pursuit pipeline" pills that used to sit here were two
                  permanently-hardcoded names ("Army AGV · Qualifying", "ONR
                  Autonomy · Saved") with, per the prior comment here, "no wired
                  data source yet" — not even a fixture standing in for a real
                  feature, just invented content with no backing endpoint for
                  every client. Removed rather than left permanently fake; the
                  real opportunities list above already surfaces each
                  opportunity's actual workflow status (Pursuing/Saved/…). */}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RealOppRow({ o }: { o: FundingOpportunity }) {
  const money = moneyLine(o);
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const soon = deadline.daysRemaining != null && deadline.daysRemaining >= 0 && deadline.daysRemaining <= 14;
  const { label: statusLabel, tone: statusTone, dotless } = workflowStatusPill(o.workflow?.status ?? null);
  return (
    <div className="capiro-intel-opp-row">
      <span className="capiro-intel-opp-kind">{KIND_LABELS[o.kind]}</span>
      <span className="capiro-intel-opp-main">
        <span className="capiro-intel-opp-title">
          {o.sourceUrl ? (
            <a href={o.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              {o.title}
            </a>
          ) : (
            o.title
          )}
        </span>
        <span className="capiro-intel-opp-agency">{o.agency ?? SOURCE_LABELS[o.source]}</span>
      </span>
      <span className="capiro-intel-opp-money">
        <span className="capiro-intel-opp-amount">{money.value}</span>
        <span className={soon ? 'capiro-intel-opp-due capiro-intel-opp-due--soon' : 'capiro-intel-opp-due'}>
          {deadline.daysRemaining != null ? `Due ${deadline.text}` : deadline.text}
        </span>
      </span>
      <span className="capiro-intel-opp-pills">
        <Pill tone="gray" dotless>{o.relevanceScore}% fit</Pill>
        <Pill tone={statusTone} dotless={dotless}>{statusLabel}</Pill>
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

function OppRow({ o }: { o: (typeof OPPS)[number] }) {
  const statusTone = o.status === 'Pursuing' ? 'brand' : 'gray';
  return (
    <button type="button" className="capiro-intel-opp-row">
      {/* Fixture rows use a fixed 26px badge height (vs. the real row's
          min-height: 26px, which lets long real KIND_LABELS wrap) — harmless
          layout-only override, not a color/token concern. */}
      <span className="capiro-intel-opp-kind" style={{ height: 26 }}>
        {o.type}
      </span>
      <span className="capiro-intel-opp-main">
        <span className="capiro-intel-opp-title">{o.title}</span>
        <span className="capiro-intel-opp-agency">{o.agency}</span>
      </span>
      <span className="capiro-intel-opp-money">
        <span className="capiro-intel-opp-amount">{o.amount}</span>
        <span className={o.soon ? 'capiro-intel-opp-due capiro-intel-opp-due--soon' : 'capiro-intel-opp-due'}>Due {o.due}</span>
      </span>
      <span className="capiro-intel-opp-pills">
        <Pill tone="gray" dotless>{o.fit}% fit</Pill>
        <Pill tone={statusTone as PillTone} dotless={o.status === 'Match'}>{o.status}</Pill>
      </span>
    </button>
  );
}

function ProgramCard({ p }: { p: (typeof PROGRAMS)[number] }) {
  return (
    <div className="capiro-intel-pe-card">
      <div className="capiro-intel-pe-top">
        <span className="capiro-intel-pe-code">{p.code}</span>
        <span className="capiro-intel-pe-title">{p.name}</span>
      </div>
      <div className="capiro-intel-pe-figures">
        {([['PB', p.pb], ['Auth', p.auth], ['Approp', p.approp]] as const).map(([label, value], i) => (
          <span key={label} className="capiro-intel-pe-figure-row">
            {i > 0 ? <span className="capiro-intel-pe-figure-sep">—</span> : null}
            <span style={{ flex: '0 0 auto' }}>
              <span className="capiro-intel-eyebrow-xs" style={{ display: 'block' }}>{label}</span>
              <span className="capiro-intel-pe-figure-value">{value}</span>
            </span>
          </span>
        ))}
      </div>
      <div className="capiro-intel-pe-foot">
        <LinkBtn>Open PE →</LinkBtn>
        <span className="capiro-intel-spacer" />
        <Pill tone={p.down ? 'error' : 'success'}>{p.delta}</Pill>
      </div>
    </div>
  );
}
