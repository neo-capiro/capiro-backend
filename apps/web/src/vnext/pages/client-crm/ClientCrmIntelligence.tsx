import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { getClientDistrictNexus } from '../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { getClientLdaFilings } from '../../../pages/clients/intelligence-v1/lda-filings-api.js';
import { getRelevantPesForClient } from '../../../pages/clients/relevance-api.js';
import {
  trackerKeys,
  trackerPaths,
  type TrackerSummary,
} from '../../../pages/clients/tracker/tracker-api.js';
import { intelTrackerPaths } from '../../../pages/clients/tracker/intel-tracker-api.js';
import type { ClientFacility } from '../../../pages/clients/facilities-api.js';
import type { IntelligenceView } from './client-crm-routing.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Intelligence — Figma `906:3930` (Overview), `906:4215` (Legislative),
 * `906:4500` (Regulatory), `906:4785` (Funding & Budget), `907:2592` (Federal
 * Footprint) and `907:2701` (District Nexus).
 *
 * §11: every view reads its OWNING domain service. The client intelligence data
 * layer already exists under `pages/clients/intelligence-v1/`, so this is a
 * re-skin of that data, not a second implementation of it — the same finding
 * the handoff frames made for Program Elements and LegiWatch.
 *
 * Product-wide invariant enforced throughout: missing evidence is rendered as
 * missing, never as a zero.
 */
export function ClientCrmIntelligence({
  client,
  view,
}: {
  client: Client;
  view: IntelligenceView;
}) {
  switch (view) {
    case 'legislative':
      return <LegislativeView client={client} />;
    case 'regulatory':
      return <RegulatoryView client={client} />;
    case 'funding':
      return <FundingView client={client} />;
    case 'footprint':
      return <FootprintView client={client} />;
    case 'district':
      return <DistrictView client={client} />;
    case 'overview':
    default:
      return <IntelOverview client={client} />;
  }
}

/* ─────────────────────────────── shared shell ────────────────────────────── */

function Screen({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="capiro-crm__body">
      <div className="capiro-crm__page-head">
        <div>
          <h2 className="capiro-crm__page-title">{title}</h2>
          <p className="capiro-crm__page-sub">{sub}</p>
        </div>
        <span className="capiro-crm__page-head-spacer" />
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * One card with the four states every data-backed surface owes (§7). `empty`
 * and `unavailable` are separate props on purpose: "the source failed" and
 * "the source returned nothing" must not render the same way.
 */
function DataCard<T>({
  title,
  query,
  empty,
  children,
  provenance,
  action,
}: {
  title: string;
  query: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  empty: string;
  children: (data: T) => ReactNode;
  provenance?: string;
  action?: ReactNode;
}) {
  return (
    <section className="capiro-crm__card capiro-elevation-widget">
      <div className="capiro-crm__card-head">
        <h3 className="capiro-crm__card-title">{title}</h3>
        <span className="capiro-crm__page-head-spacer" />
        {action}
      </div>

      {query.isLoading ? (
        <div className="capiro-crm__skeleton" style={{ height: 160 }} aria-hidden />
      ) : query.isError ? (
        <div className="capiro-crm__state capiro-crm__state--error" role="status">
          {/* Names the failed source rather than showing zero. */}
          <span>
            {query.error instanceof Error ? query.error.message : 'This source could not be read'}
          </span>
          <CapiroButton variant="quiet" size="compact" onClick={() => void query.refetch()}>
            Retry
          </CapiroButton>
        </div>
      ) : isEmpty(query.data) ? (
        <div className="capiro-crm__state" role="status">
          {empty}
        </div>
      ) : (
        children(query.data as T)
      )}

      {provenance ? <p className="capiro-crm__meta capiro-crm__provenance">{provenance}</p> : null}
    </section>
  );
}

function isEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  // Paged envelopes ({ data, total }) are empty when their page is.
  if (typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data.length === 0;
  }
  return false;
}

function Rows({
  items,
}: {
  items: Array<{ id: string; title: string; meta?: string | null; badge?: string }>;
}) {
  return (
    <ul className="capiro-crm__rows">
      {items.map((item) => (
        <li key={item.id} className="capiro-crm__pinned">
          <span className="capiro-crm__row-title">{item.title}</span>
          {item.meta ? (
            <span className="capiro-crm__meta capiro-crm__row-meta">{item.meta}</span>
          ) : null}
          {item.badge ? <CapiroBadge>{item.badge}</CapiroBadge> : null}
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── 906:3930 Overview ─────────────────────────── */

function IntelOverview({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  const health = useQuery({
    queryKey: ['client-health-score', client.id],
    queryFn: async () =>
      (await api.get<{ score?: number; components?: Array<{ label: string; value: number }> }>(
        `/api/intelligence/clients/${client.id}/health-score`,
      )).data,
    staleTime: 5 * 60 * 1000,
  });

  const changes = useQuery({
    queryKey: ['intel-changes-snap', client.id],
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - 7);
      return (
        await api.get<Array<{ id: string; title: string; severity: string }>>(
          '/api/intelligence/changes',
          { params: { clientId: client.id, since: since.toISOString() } },
        )
      ).data;
    },
    staleTime: 2 * 60 * 1000,
  });

  return (
    <Screen
      title="Intelligence overview"
      sub="What changed for this client in the last seven days, and where the evidence came from."
      action={
        <CapiroButton
          variant="secondary"
          size="compact"
          onClick={() => navigate(`/clients?clientId=${client.id}&tab=intelligence&view=legislative`)}
        >
          Open legislative
        </CapiroButton>
      }
    >
      <div className="capiro-crm__grid capiro-crm__grid--even">
        <DataCard
          title="Recent changes"
          query={changes}
          empty="No tracked changes in the last seven days."
          provenance="Source: intelligence change feed · last 7 days"
        >
          {(rows) => (
            <Rows
              items={rows.slice(0, 8).map((row) => ({
                id: row.id,
                title: row.title,
                meta: row.severity,
              }))}
            />
          )}
        </DataCard>

        <DataCard
          title="Client health"
          query={health}
          empty="No health score has been computed for this client."
          provenance="Source: intelligence health score"
        >
          {(data) => (
            <div className="capiro-crm__metrics">
              {/* A missing score renders as an em dash, not 0. */}
              <div className="capiro-crm__metric">
                <p
                  className={`capiro-crm__metric-value${data.score == null ? ' capiro-crm__metric-value--unavailable' : ''}`}
                >
                  {data.score == null ? '—' : Math.round(data.score)}
                </p>
                <p className="capiro-crm__meta">Overall</p>
              </div>
              {(data.components ?? []).slice(0, 3).map((component) => (
                <div key={component.label} className="capiro-crm__metric">
                  <p className="capiro-crm__metric-value">{Math.round(component.value)}</p>
                  <p className="capiro-crm__meta">{component.label}</p>
                </div>
              ))}
            </div>
          )}
        </DataCard>
      </div>
    </Screen>
  );
}

/* ──────────────────────────── 906:4215 Legislative ───────────────────────── */

function LegislativeView({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();
  const { enabled: trackerV2, ready } = useIntelFeature('tracker_v2');

  const summary = useQuery<TrackerSummary>({
    queryKey: trackerKeys.summary(client.id),
    queryFn: async () =>
      (
        await api.get<TrackerSummary>(
          trackerV2 ? intelTrackerPaths.summary(client.id) : trackerPaths.summary(client.id),
        )
      ).data,
    enabled: ready,
    staleTime: 60_000,
  });

  return (
    <Screen
      title="Legislative"
      sub="Bills and hearings this client is tracking, through LegiWatch."
      action={
        // Legacy tracker/radar/legiwatch links resolve here; the canonical
        // module still owns the work states and packet actions.
        <CapiroButton variant="secondary" size="compact" onClick={() => navigate('/legiwatch')}>
          Open LegiWatch
        </CapiroButton>
      }
    >
      <div className="capiro-crm__grid capiro-crm__grid--even">
        <DataCard
          title="Tracker"
          query={summary}
          empty="Nothing on this client's board yet."
          provenance={`Source: ${trackerV2 ? 'intelligence tracker v2' : 'tracker'}`}
        >
          {(data) => (
            <div className="capiro-crm__metrics">
              <div className="capiro-crm__metric">
                <p className="capiro-crm__metric-value">{data.boardCount}</p>
                <p className="capiro-crm__meta">On the board</p>
              </div>
              <div className="capiro-crm__metric">
                <p className="capiro-crm__metric-value">{data.unread}</p>
                <p className="capiro-crm__meta">Unread</p>
              </div>
            </div>
          )}
        </DataCard>

        <section className="capiro-crm__card capiro-elevation-widget">
          <div className="capiro-crm__card-head">
            <h3 className="capiro-crm__card-title">Watchlist and packets</h3>
          </div>
          <p className="capiro-crm__foot">
            Bill packets, work states and hearing moments stay in LegiWatch, which owns those
            mutations. This view links to them rather than keeping a second copy.
          </p>
          <div className="capiro-crm-fill__actions">
            <CapiroButton variant="quiet" size="compact" onClick={() => navigate('/legiwatch?tab=bills')}>
              Bills
            </CapiroButton>
            <CapiroButton
              variant="quiet"
              size="compact"
              onClick={() => navigate('/legiwatch?tab=hearings')}
            >
              Hearings
            </CapiroButton>
            <CapiroButton
              variant="quiet"
              size="compact"
              onClick={() => navigate('/legiwatch?tab=watchlist')}
            >
              Watchlist
            </CapiroButton>
          </div>
        </section>
      </div>
    </Screen>
  );
}

/* ───────────────────────────── 906:4500 Regulatory ───────────────────────── */

function RegulatoryView({ client }: { client: Client }) {
  const api = useApi();

  const alerts = useQuery({
    queryKey: ['comment-alerts'],
    queryFn: async () =>
      (await api.get<{ alerts: Array<Record<string, unknown>> }>('/api/intelligence/comment-alerts'))
        .data,
    staleTime: 5 * 60 * 1000,
  });

  const rows = (alerts.data?.alerts ?? []).filter((row) => row.clientId === client.id);
  const scoped = { ...alerts, data: alerts.data ? rows : undefined };

  return (
    <Screen
      title="Regulatory"
      sub="Federal Register matters and comment windows linked to this client."
    >
      <div className="capiro-crm__grid">
        <DataCard
          title="Comment windows"
          query={scoped}
          empty="No regulatory matters are linked to this client."
          provenance="Source: Federal Register comment alerts"
        >
          {(items) => (
            <Rows
              items={(items as Array<Record<string, unknown>>).slice(0, 12).map((row, index) => ({
                id: String(row.id ?? index),
                title: String(row.title ?? 'Regulatory matter'),
                // Lifecycle state is only shown when the record asserts one —
                // §11 forbids inferring it without evidence.
                meta: row.closesAt
                  ? `Closes ${new Date(String(row.closesAt)).toLocaleDateString()}`
                  : 'No closing date published',
              }))}
            />
          )}
        </DataCard>
      </div>
    </Screen>
  );
}

/* ──────────────────────── 906:4785 Funding & Budget ──────────────────────── */

function FundingView({ client }: { client: Client }) {
  const api = useApi();

  const opportunities = useQuery({
    queryKey: ['client-funding-opportunities', client.id],
    queryFn: async () =>
      (
        await api.get<{ total?: number; items?: Array<{ id: string; title: string; agency?: string }> }>(
          `/api/intelligence/clients/${client.id}/opportunities/summary`,
        )
      ).data,
    staleTime: 5 * 60 * 1000,
  });

  const pes = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    staleTime: 60_000,
  });

  return (
    <Screen
      title="Funding & budget"
      sub="Program elements and funding opportunities relevant to this client."
    >
      <div className="capiro-crm__grid capiro-crm__grid--even">
        <DataCard
          title="Program elements"
          query={pes}
          empty="No program elements scored above the relevance threshold."
          provenance="Source: client ⇄ PE relevance engine · min score 0.5"
        >
          {(response) => (
            <Rows
              items={response.data.slice(0, 10).map((row) => ({
                id: row.peCode,
                title: row.title ?? row.peCode,
                // Budget stages are NOT summed or collapsed (§11); this row
                // carries the PE identity and its relevance score only.
                meta: `${row.peCode} · relevance ${row.score.toFixed(2)}`,
              }))}
            />
          )}
        </DataCard>

        <DataCard
          title="Funding opportunities"
          query={opportunities}
          empty="No matched opportunities for this client."
          provenance="Source: funding opportunity matcher"
        >
          {(data) => (
            <>
              <div className="capiro-crm__metrics">
                <div className="capiro-crm__metric">
                  <p
                    className={`capiro-crm__metric-value${data.total == null ? ' capiro-crm__metric-value--unavailable' : ''}`}
                  >
                    {data.total ?? '—'}
                  </p>
                  <p className="capiro-crm__meta">Matched</p>
                </div>
              </div>
              {data.items?.length ? (
                <Rows
                  items={data.items.slice(0, 8).map((item) => ({
                    id: item.id,
                    title: item.title,
                    meta: item.agency ?? null,
                  }))}
                />
              ) : null}
            </>
          )}
        </DataCard>
      </div>
    </Screen>
  );
}

/* ─────────────────────── 907:2592 Federal Footprint ──────────────────────── */

function FootprintView({ client }: { client: Client }) {
  const api = useApi();

  const filings = useQuery({
    queryKey: ['client-lda-filings', client.id],
    queryFn: async () => getClientLdaFilings(api, client.id),
    staleTime: 2 * 60 * 1000,
  });

  const rows = filings.data?.filings ?? [];
  const scoped = { ...filings, data: filings.data ? rows : undefined };

  return (
    <Screen
      title="Federal footprint"
      sub="Federal lobbying disclosures on record for this client."
    >
      <div className="capiro-crm__grid">
        <DataCard
          title="LDA filings"
          query={scoped}
          empty="No LDA filings are on record. Absent filings are not the same as no federal activity."
          provenance="Source: Senate/House LDA disclosures"
        >
          {(items) => (
            <Rows
              items={items.slice(0, 12).map((row) => ({
                id: row.filingUuid,
                title: row.registrantName,
                meta: [
                  row.filingPeriod,
                  String(row.filingYear),
                  // A zero amount is a real disclosed zero; an absent one is not
                  // rendered as $0.
                  Number.isFinite(row.amount) ? `$${row.amount.toLocaleString()}` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              }))}
            />
          )}
        </DataCard>
      </div>
    </Screen>
  );
}

/* ───────────────────────── 907:2701 District Nexus ───────────────────────── */

function DistrictView({ client }: { client: Client }) {
  const api = useApi();

  // Facilities are the existing records — §11 forbids duplicating them here.
  const facilities = useQuery<ClientFacility[]>({
    queryKey: ['client-facilities', client.id],
    queryFn: async () =>
      (await api.get<ClientFacility[]>(`/api/clients/${client.id}/facilities`)).data,
    staleTime: 60_000,
  });

  const nexus = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: async () => getClientDistrictNexus(api, client.id),
    staleTime: 2 * 60 * 1000,
  });

  return (
    <Screen
      title="District nexus"
      sub="Where this client operates, and who currently represents those districts."
    >
      <div className="capiro-crm__grid capiro-crm__grid--even">
        <DataCard
          title="Facilities"
          query={facilities}
          empty="No facilities recorded for this client."
          provenance="Source: client facilities"
        >
          {(rows) => (
            <Rows
              items={rows.map((facility) => ({
                id: facility.id,
                title: facility.name,
                meta:
                  [facility.city, facility.state].filter(Boolean).join(', ') ||
                  'No location recorded',
                // A blank district means "not resolved", not "no district", so
                // the badge is omitted rather than showing a placeholder.
                badge: facility.congressionalDistrict
                  ? `${facility.state ?? ''}-${facility.congressionalDistrict}`
                  : undefined,
              }))}
            />
          )}
        </DataCard>

        <DataCard
          title="District nexus"
          query={nexus}
          empty="No district nexus has been resolved for this client."
          provenance="Source: district nexus engine · current districts"
        >
          {(data) => {
            const districts = (data as { districts?: Array<Record<string, unknown>> })?.districts ?? [];
            return districts.length === 0 ? (
              <p className="capiro-crm__foot">
                Resolved, but no districts matched this client&apos;s facilities.
              </p>
            ) : (
              <Rows
                items={districts.slice(0, 12).map((row, index) => ({
                  id: String(row.district ?? index),
                  title: String(row.district ?? 'District'),
                  meta: String(row.memberName ?? 'Representation not resolved'),
                }))}
              />
            );
          }}
        </DataCard>
      </div>
    </Screen>
  );
}
