/**
 * Section: District Nexus
 *
 * Federal contract spend grouped by congressional district (place-of-performance),
 * the lobbyist's "dollars in your district" argument. Single data-driven engine:
 * USAspending federal_award rows matched to the client via confirmed `contracting`
 * intel mappings, joined to census_district demographics.
 *
 * Three honest states:
 *  - unlinked: no confirmed contractor mapping → deep-link to map one.
 *  - linked + districts: spend-by-district table + demographics + unmapped bucket.
 *  - linked + zero districts: awards mapped but districts not yet enriched.
 *
 * Data: GET /api/intelligence/clients/:clientId/district-nexus-spend.
 *
 * WS-H1: behind the `district_nexus_v2` flag this section instead renders
 * `DistrictNexusSectionV2`, which fires ONE query to the v2 endpoint and shows
 * contracts, awarded grants and explainable per-district nexus scores. The two
 * paths are separate components so the flag-off path stays the pre-existing
 * code exactly. Data: GET /api/intelligence/clients/:clientId/district-nexus-v2.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import { formatCompact } from '../mappers.js';
import {
  getClientDistrictNexus,
  getClientDistrictNexusV2,
  type ClientDistrictNexusV2,
  type ClientFacilityFootprint,
  type DistrictNexus,
  type DistrictNexusDistrictDetail,
  type DistrictNexusRow,
} from '../district-nexus-api.js';
import {
  bandOf,
  formatMoney,
  splitDistrictKey,
} from '../../../intelligence/district-nexus/district-nexus-format.js';
import {
  getClientRepresentation,
  type FacilityRepresentation,
  type FederalMemberSummary,
  type StateLegislatorSummary,
} from '../representation-api.js';

interface DistrictNexusSectionProps {
  clientId: string;
}

const pct = (v: number | null): string =>
  v == null ? '—' : `${(v <= 1 ? v * 100 : v).toFixed(1)}%`;
const num = (v: number | null): string => (v == null ? '—' : v.toLocaleString('en-US'));
const usd = (v: number | null): string =>
  v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`;

/**
 * Path to the WS-B district detail page, or null when this row's House seat
 * couldn't be resolved (non-voting delegate / multiple-or-undefined
 * district sentinel — `representatives.house` is already null for exactly
 * those cases, so it doubles as "does a real House-district page exist").
 * `d.district` is `${state}-${rawCode}` where rawCode is a plain number
 * ('2', '23') or 'AL' for at-large; the district-detail route uses the
 * '00'-for-at-large, zero-padded-2-digit convention instead.
 */
function districtPagePath(d: DistrictNexusRow): string | null {
  if (!d.representatives.house) return null;
  const rawCode = d.district.slice(d.state.length + 1);
  const districtNo = rawCode === 'AL' ? '00' : rawCode.padStart(2, '0');
  return `/directory/districts/${encodeURIComponent(d.state)}/${encodeURIComponent(districtNo)}`;
}

/** Short badge labels for the scoring components. Keys are
 *  NEXUS_COMPONENTS (apps/api/src/district-nexus/district-nexus-scoring.ts:36-45);
 *  the server's own `label` is the fallback so an added component still renders. */
const SHORT_COMPONENT_LABEL: Record<string, string> = {
  verifiedFacility: 'Facility',
  verifiedEmployees: 'Employees',
  contractPlaceOfPerformance: 'Contracts',
  grantPlaceOfPerformance: 'Grants',
  supplierOrLocalSpend: 'Supplier',
  partnerBeneficiary: 'Partner',
  policyCommitteeRelevance: 'Policy',
  relationshipContext: 'Target',
};

/** Freshness rails that actually back the numbers in this widget. Ids are
 *  FRESHNESS_RAILS (apps/api/src/district-nexus/district-nexus.service.ts:72-101). */
const WIDGET_FRESHNESS_RAILS = new Set([
  'geocode-facilities',
  'sync-federal-award',
  'sync-federal-assistance-awards',
  'sync-grants',
]);

const V2_DISCLAIMER =
  'Awarded contract and grant figures are federal obligations reported by USAspending; the contract rail covers DoD prime contracts only. Grant opportunities are forecasts, never awarded money. Districts reflect current (119th Congress) boundaries; an award reports the district in effect when it was filed.';

const MAX_TOP_DISTRICTS = 5;

/** "420" when every facility reported, "420+" when some did not, "—" when none did. */
function employeeLabel(f: ClientFacilityFootprint): string {
  if (f.employeeCount == null) return '—';
  const n = f.employeeCount.toLocaleString('en-US');
  return f.facilitiesMissingEmployeeCount > 0 ? `${n}+` : n;
}

/** Path to the WS-B district page. Every v2 district has a resolvable code by
 *  construction (districtKeyFor drops the 90/98/ZZ sentinels), so unlike the
 *  legacy row there is no seat-resolution gate. padStart is defensive: the
 *  contract rail stores the vendor's code verbatim and a 1-char '4' would
 *  otherwise produce /districts/TX/4 for a page that expects '04'. */
function v2DistrictPagePath(d: DistrictNexusDistrictDetail): string {
  const { state, districtNo } = splitDistrictKey(d.districtKey);
  return `/directory/districts/${encodeURIComponent(state)}/${encodeURIComponent(districtNo.padStart(2, '0'))}`;
}

/** Distinct scoring components that actually earned credit, as short badges. */
function evidenceBadges(d: DistrictNexusDistrictDetail): string[] {
  return d.breakdown
    .filter((b) => b.credit > 0)
    .map((b) => SHORT_COMPONENT_LABEL[b.component] ?? b.label);
}

interface NexusGap {
  text: string;
  to?: string;
  linkText?: string;
}

/**
 * WS-H1 flag switch. Two SEPARATE child components rather than one component
 * with conditional queries: each owns its own hooks, so the flag-off path is
 * the pre-existing code byte-for-byte and cannot be broken by v2 work.
 *
 * While the flag is still resolving, render a loading shell that still carries
 * id="district-nexus". Rendering V1 during that window would hit its disabled-
 * query state (TanStack v5: a disabled query has isLoading === false and
 * data === undefined), which falls through to "No federal contractor linked
 * yet" — a false claim flashed on screen. In practice the window is zero:
 * AppShell already primes the same ['intel','feature-flags'] query.
 *
 * A v2 404 means the web flag and the API guard disagree (a
 * CAPIRO_INTERNAL_TENANT_ID skew between services). That is a CONFIGURATION
 * fact, not an outage, so it falls back to the legacy widget rather than
 * showing an error.
 */
export function DistrictNexusSection({ clientId }: DistrictNexusSectionProps) {
  const { enabled, ready } = useIntelFeature('district_nexus_v2');
  const [v2Unavailable, setV2Unavailable] = useState(false);
  const handleUnavailable = useCallback(() => setV2Unavailable(true), []);

  if (!ready) {
    return (
      <section id="district-nexus" className="iv1-section">
        <div className="iv1-sec-head">
          <span className="iv1-sec-num">3</span>
          <h2>District Nexus</h2>
        </div>
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <span>Loading district nexus…</span>
          </div>
        </div>
      </section>
    );
  }

  return enabled && !v2Unavailable ? (
    <DistrictNexusSectionV2 clientId={clientId} onUnavailable={handleUnavailable} />
  ) : (
    <DistrictNexusSectionV1 clientId={clientId} />
  );
}

interface DistrictNexusSectionV2Props extends DistrictNexusSectionProps {
  /** Called when the v2 endpoint 404s, so the parent can fall back to V1. */
  onUnavailable: () => void;
}

function DistrictNexusSectionV2({ clientId, onUnavailable }: DistrictNexusSectionV2Props) {
  const api = useApi();
  const query = useQuery<ClientDistrictNexusV2>({
    queryKey: ['client-district-nexus-v2', clientId],
    queryFn: async () => getClientDistrictNexusV2(api, clientId),
    enabled: !!clientId,
    staleTime: 2 * 60 * 1000,
    // A 404 is a configuration answer, not a transient failure — resolve it in
    // one round trip so the fallback to V1 is immediate.
    retry: false,
  });

  const status = (query.error as { response?: { status?: number } } | null)?.response?.status;
  const is404 = query.isError && status === 404;
  useEffect(() => {
    if (is404) onUnavailable();
  }, [is404, onUnavailable]);

  const data = query.data;

  // Gaps are ADDITIVE, not an exclusive branch: when two rails are both
  // unconfirmed, both facts get said. A user told only about the first would
  // fix it and still see empty numbers.
  const gaps: NexusGap[] = [];
  if (data) {
    const { linkage } = data;
    const fp = data.facilityFootprint;
    if (!linkage.contractingLinked) {
      gaps.push({
        text: 'No federal contractor is confirmed for this client, so DoD prime contract spend cannot be matched.',
        to: '/settings/intelligence-mappings?source=contracting',
        linkText: 'Map a federal contractor →',
      });
    }
    if (!linkage.assistanceLinked) {
      gaps.push({
        text: 'No federal assistance recipient is confirmed for this client, so awarded grants cannot be matched.',
        to: '/settings/intelligence-mappings?source=assistance_recipient',
        linkText: 'Map an assistance recipient →',
      });
    }
    if (linkage.assistanceLinked && linkage.ueiConfirmedCount === 0) {
      gaps.push({
        text: 'The confirmed assistance mapping has no UEI, so grant awards cannot be matched to it.',
        to: '/settings/intelligence-mappings?source=assistance_recipient',
        linkText: 'Review the mapping →',
      });
    }
    if (fp.facilityCount === 0) {
      gaps.push({
        text: 'No client facilities are on file, so facility and employee nexus cannot be shown.',
      });
    }
    if (fp.facilitiesWithoutDistrict > 0) {
      const n = fp.facilitiesWithoutDistrict;
      gaps.push({
        text: `${n} facilit${n === 1 ? 'y has' : 'ies have'} no resolved congressional district — confirm the address on the Facilities tab.`,
      });
    }
    // Only reachable when every rail above is fine — otherwise the real reason
    // has already been said and this would be a second, vaguer version of it.
    if (data.districts.length === 0 && gaps.length === 0) {
      gaps.push({
        text: 'Identifiers are confirmed and facilities are geocoded, but nothing resolved to a district. See the unmapped totals below.',
      });
    }
  }

  // De-duped by code, first occurrence wins: the same warning is emitted once
  // per district and repeating it N times is noise, not N facts.
  const warnings = data
    ? data.warnings.filter((w, i, all) => all.findIndex((x) => x.code === w.code) === i)
    : [];

  const freshnessLine = data
    ? data.freshness
        .filter((f) => WIDGET_FRESHNESS_RAILS.has(f.source))
        .map((f) => {
          // All three are DIFFERENT facts and must stay distinguishable:
          // unknown (no SyncRun at all) vs never synced vs a real date.
          if (f.freshnessUnavailable) return `${f.label}: freshness unknown`;
          if (f.neverSynced) return `${f.label}: never synced`;
          if (f.lastSyncedAt == null) return `${f.label}: freshness unknown`;
          return `${f.label}: ${new Date(f.lastSyncedAt).toLocaleDateString('en-US')}`;
        })
        .join(' · ')
    : '';

  const showGrantLine =
    !!data &&
    (data.awarded.grantObligations != null ||
      data.awarded.grantOutlays != null ||
      data.opportunities.opportunityEstimatedFunding != null);

  const showUnmapped =
    !!data &&
    (data.unmapped.unmappedContractAmount != null || data.unmapped.unmappedGrantAmount != null);

  const errorBlock = (
    <div className="iv1-surface">
      <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
        <b>Couldn&apos;t load district nexus</b>
        <span>Something went wrong fetching this client&apos;s contract spend. Try refreshing.</span>
      </div>
    </div>
  );

  const loadingBlock = (
    <div className="iv1-surface">
      <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
        <span>Loading district nexus…</span>
      </div>
    </div>
  );

  return (
    <section id="district-nexus" className="iv1-section">
      <div className="iv1-sec-head">
        <span className="iv1-sec-num">3</span>
        <h2>District Nexus</h2>
        <span className="iv1-sec-sub">
          Verified footprint, public funding, and representation by district
        </span>
        <Link
          className="iv1-link iv1-sec-action"
          to={`/intelligence/district-nexus?clientId=${encodeURIComponent(clientId)}`}
        >
          View full map →
        </Link>
      </div>

      <YourRepresentativesBlock
        data={query.data?.representativesByFacility}
        loading={query.isLoading}
        error={query.isError}
      />

      {/* A 404 renders the loading shell, not an error: the parent is about to
          swap in V1 and an error frame would flash a failure that isn't one. */}
      {query.isLoading || is404 ? (
        loadingBlock
      ) : query.isError || !data ? (
        errorBlock
      ) : (
        <>
          {/* ── KPI strip. No blended total: contracts and grants are
                different instruments and are never summed. ── */}
          <div className="iv1-dnx-summary">
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{data.districts.length}</div>
              <div className="iv1-dnx-stat-l">Districts</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{formatMoney(data.awarded.contractObligations)}</div>
              <div className="iv1-dnx-stat-l">Contract obligations</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{formatMoney(data.awarded.grantObligations)}</div>
              <div className="iv1-dnx-stat-l">Grant obligations</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{employeeLabel(data.facilityFootprint)}</div>
              <div className="iv1-dnx-stat-l">Employees</div>
            </div>
          </div>

          {/* ── Top districts. Already sorted server-side — do NOT re-sort. ── */}
          {data.districts.length > 0 ? (
            <div className="iv1-surface" style={{ marginTop: 14 }}>
              <div className="iv1-surface-head">
                <h3>Top districts</h3>
                <span className="iv1-surface-sub">
                  highest nexus score first · place-of-performance
                  {data.districts.length > MAX_TOP_DISTRICTS
                    ? ` · showing top ${MAX_TOP_DISTRICTS} of ${data.districts.length}`
                    : ''}
                </span>
              </div>
              <div className="iv1-dnx-list">
                {data.districts.slice(0, MAX_TOP_DISTRICTS).map((d) => {
                  const badges = evidenceBadges(d);
                  return (
                    <div className="iv1-dnx-row" key={d.districtKey}>
                      <div className="iv1-dnx-row-top">
                        <span className="iv1-dnx-district">{d.districtKey}</span>
                        {/* bandOf returns null for a null score — that is
                            "Unscored", NEVER "Minimal". */}
                        <span className="iv1-dnx-band">{bandOf(d.score)?.label ?? 'Unscored'}</span>
                        <span className="iv1-dnx-amt">
                          {formatMoney(d.awarded.contractObligations)}
                        </span>
                      </div>
                      <div className="iv1-dnx-row-sub">
                        {badges.length > 0
                          ? badges.map((b) => (
                              <span className="iv1-dnx-badge" key={b}>
                                {b}
                              </span>
                            ))
                          : 'No scored evidence'}
                        {d.score == null
                          ? ` · coverage ${d.coveragePercent}% — too little evidence to score`
                          : ''}
                      </div>
                      <div
                        className="iv1-dnx-row-sub"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}
                      >
                        <span>Grants {formatMoney(d.awarded.grantObligations)}</span>
                        {d.employeeCount != null ? (
                          <span>
                            {d.employeeCount.toLocaleString('en-US')}
                            {d.employeesUnreported ? '+' : ''} employees
                          </span>
                        ) : null}
                        <Link className="iv1-link" to={v2DistrictPagePath(d)}>
                          View district →
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* ── Honest states. Zero districts gets the full empty surface;
                otherwise the gaps sit under the list so a partially-linked
                client still learns what is missing. ── */}
          {data.districts.length === 0 ? (
            <div className="iv1-surface" style={{ marginTop: 14 }}>
              <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
                <b>No district nexus yet</b>
                <GapsList gaps={gaps} />
              </div>
            </div>
          ) : gaps.length > 0 ? (
            <div className="iv1-dnx-row-sub" style={{ marginTop: 10 }}>
              <b>Gaps</b>
              <GapsList gaps={gaps} />
            </div>
          ) : null}

          {/* ── Grant funding. Obligated and outlayed are separate facts —
                committed vs paid — and are never summed. Opportunity money is
                a forecast and is never counted as awarded; no count is shown
                because none is computable (opportunity rows carry no
                district, so foldDistricts drops them). ── */}
          {showGrantLine ? (
            <div className="iv1-dnx-row-sub" style={{ marginTop: 10 }}>
              Grant obligations {formatMoney(data.awarded.grantObligations)} · outlays{' '}
              {formatMoney(data.awarded.grantOutlays)}
              {data.opportunities.opportunityEstimatedFunding != null
                ? ` · opportunity pipeline ${formatMoney(
                    data.opportunities.opportunityEstimatedFunding,
                  )} (forecast, not awarded)`
                : ''}
            </div>
          ) : null}

          {/* ── Unmapped. Contract and grant amounts stay separate. ── */}
          {showUnmapped ? (
            <div className="iv1-dnx-row-sub">
              Unmapped — contracts {formatMoney(data.unmapped.unmappedContractAmount)} · grants{' '}
              {formatMoney(data.unmapped.unmappedGrantAmount)}. Statewide and multi-district awards
              are reported here rather than attributed to one district.
            </div>
          ) : null}

          {warnings.length > 0 ? (
            <div className="iv1-dnx-row-sub">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {freshnessLine ? (
            <div className="iv1-dnx-disclaimer">Sources — {freshnessLine}</div>
          ) : null}

          <div className="iv1-dnx-disclaimer">{V2_DISCLAIMER}</div>
        </>
      )}
    </section>
  );
}

function GapsList({ gaps }: { gaps: NexusGap[] }) {
  if (gaps.length === 0) return null;
  return (
    <ul style={{ margin: '6px 0 0', paddingLeft: 18, textAlign: 'left' }}>
      {gaps.map((g) => (
        <li key={g.text} style={{ marginBottom: 4 }}>
          {g.text}
          {g.to ? (
            <>
              {' '}
              <Link className="iv1-link" to={g.to}>
                {g.linkText}
              </Link>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DistrictNexusSectionV1({ clientId }: DistrictNexusSectionProps) {
  const api = useApi();
  const query = useQuery<DistrictNexus>({
    queryKey: ['client-district-nexus', clientId],
    queryFn: async () => getClientDistrictNexus(api, clientId),
    enabled: !!clientId,
    staleTime: 2 * 60 * 1000,
  });
  // District Impact Engine (Phase 1 M1.4) — independent of the contract-spend
  // linkage above; a client with no confirmed contractor mapping still has a
  // resolvable representation from its geocoded facilities.
  const repQuery = useQuery<FacilityRepresentation[]>({
    queryKey: ['client-representation', clientId],
    queryFn: async () => getClientRepresentation(api, clientId),
    enabled: !!clientId,
    staleTime: 5 * 60 * 1000,
  });

  const data = query.data;
  const districts = data && data.linked ? data.districts : [];

  return (
    <section id="district-nexus" className="iv1-section">
      <div className="iv1-sec-head">
        <span className="iv1-sec-num">3</span>
        <h2>District Nexus</h2>
        <span className="iv1-sec-sub">Federal contract spend by congressional district</span>
      </div>

      <YourRepresentativesBlock
        data={repQuery.data}
        loading={repQuery.isLoading}
        error={repQuery.isError}
      />

      {query.isLoading ? (
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <span>Loading district nexus…</span>
          </div>
        </div>
      ) : query.isError ? (
        // ── Fetch failed: distinct from "no contractor linked" so the user
        // isn't told to go map a contractor when the real problem is a
        // transient request failure (W2.2).
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <b>Couldn&apos;t load district nexus</b>
            <span>Something went wrong fetching this client&apos;s contract spend. Try refreshing.</span>
          </div>
        </div>
      ) : !data || !data.linked ? (
        // ── Unlinked: no confirmed contractor mapping ──
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <b>No federal contractor linked yet</b>
            <span>
              District nexus shows this client&apos;s federal contract spend by congressional
              district. Confirm a federal-contractor match for this client to populate it.
            </span>
            <Link className="iv1-link" to="/settings/intelligence-mappings?source=contracting">
              Map a federal contractor →
            </Link>
          </div>
        </div>
      ) : districts.length === 0 ? (
        // ── Linked but no resolved districts yet (awards not enriched) ──
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <b>Awards linked, districts resolving</b>
            <span>
              {data.totalAwards.toLocaleString()} award{data.totalAwards === 1 ? '' : 's'} (
              {formatCompact(data.totalAmount)}) matched to{' '}
              {data.contractorNames.join(', ') || 'this client'}, but their congressional
              districts aren&apos;t resolved yet. District enrichment runs continuously —
              check back shortly.
            </span>
          </div>
        </div>
      ) : (
        <>
          {/* ── Roll-up summary ── */}
          <div className="iv1-dnx-summary">
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{data.districtCount}</div>
              <div className="iv1-dnx-stat-l">Districts</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{formatCompact(data.totalAmount)}</div>
              <div className="iv1-dnx-stat-l">Total spend</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{data.totalAwards.toLocaleString()}</div>
              <div className="iv1-dnx-stat-l">Awards</div>
            </div>
            <div className="iv1-dnx-stat">
              <div className="iv1-dnx-stat-n">{formatCompact(data.unmappedAmount)}</div>
              <div className="iv1-dnx-stat-l">Unmapped</div>
            </div>
          </div>

          {/* ── District spend list ── */}
          <div className="iv1-surface" style={{ marginTop: 14 }}>
            <div className="iv1-surface-head">
              <h3>Spend by district</h3>
              <span className="iv1-surface-sub">
                {data.contractorNames.join(', ')} · place-of-performance · highest spend first
              </span>
            </div>
            <div className="iv1-dnx-list">
              {districts.map((d) => (
                <div className="iv1-dnx-row" key={d.district}>
                  <div className="iv1-dnx-row-top">
                    <span className="iv1-dnx-district">{d.district}</span>
                    <span className="iv1-dnx-amt">{usd(d.totalAmount)}</span>
                  </div>
                  <div className="iv1-dnx-row-sub">
                    {d.awardCount} award{d.awardCount === 1 ? '' : 's'}
                    {d.demographics ? (
                      <>
                        {' · '}labor force {num(d.demographics.laborForceSize)}
                        {' · '}median income{' '}
                        {d.demographics.medianHouseholdIncome != null
                          ? `$${num(d.demographics.medianHouseholdIncome)}`
                          : '—'}
                        {' · '}unemployment {pct(d.demographics.unemploymentRate)}
                        {' · '}veterans {pct(d.demographics.percentVeteran)}
                        {d.demographics.dataYear ? ` · ACS ${d.demographics.dataYear}` : ''}
                      </>
                    ) : null}
                  </div>
                  {/* Current rep(s) for THIS spend district — independent of the
                      facility-based "Your representatives" block above; a client
                      can have spend here with no facility in the district. */}
                  <div
                    className="iv1-dnx-row-sub"
                    style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 2 }}
                  >
                    <FederalMemberLine label="House" member={d.representatives.house} />
                    {d.representatives.senate.map((s) => (
                      <FederalMemberLine key={s.bioguideId} label="Senate" member={s} />
                    ))}
                    {districtPagePath(d) ? (
                      <Link className="iv1-link" to={districtPagePath(d)!}>
                        View district →
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="iv1-dnx-disclaimer">{data.disclaimer}</div>
        </>
      )}
    </section>
  );
}

/**
 * District Impact Engine (Phase 1 M1.4) — "Your representatives" block, per
 * facility: federal House + both senators, state upper/lower. Deterministic
 * (PD2) — never a guess. A facility that hasn't geocoded yet shows an
 * explicit "district undetermined" line rather than nothing.
 */
function YourRepresentativesBlock({
  data,
  loading,
  error,
}: {
  data: FacilityRepresentation[] | undefined;
  loading: boolean;
  error: boolean;
}) {
  if (loading) return null;
  // W2.2: an explicit failure must not read as "this client has no
  // facilities" — the two were previously indistinguishable (both rendered
  // nothing).
  if (error) {
    return (
      <div className="iv1-surface" style={{ marginBottom: 14 }}>
        <div className="iv1-empty" style={{ padding: '16px', textAlign: 'center' }}>
          <span>Couldn&apos;t load this client&apos;s representatives. Try refreshing.</span>
        </div>
      </div>
    );
  }
  if (!data || data.length === 0) return null;
  return (
    <div className="iv1-surface" style={{ marginBottom: 14 }}>
      <div className="iv1-surface-head">
        <h3>Your representatives</h3>
        <span className="iv1-surface-sub">
          Federal House + Senate, state upper + lower — resolved from each facility&apos;s
          geocoded district
        </span>
      </div>
      <div className="iv1-dnx-list">
        {data.map(({ facility, representation }) => (
          <div className="iv1-dnx-row" key={facility.id}>
            <div className="iv1-dnx-row-top">
              <span className="iv1-dnx-district">
                {facility.name}
                {facility.city || facility.state
                  ? ` — ${[facility.city, facility.state].filter(Boolean).join(', ')}`
                  : ''}
              </span>
            </div>
            {representation.unresolved ? (
              <div className="iv1-dnx-row-sub">
                {representation.reason === 'no_state'
                  ? 'District undetermined — no state on file for this facility.'
                  : 'District undetermined — confirm the address (Facilities tab).'}
              </div>
            ) : (
              <div className="iv1-dnx-row-sub" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <FederalMemberLine label="House" member={representation.federal.house} />
                {representation.federal.senate.map((s) => (
                  <FederalMemberLine key={s.bioguideId} label="Senate" member={s} />
                ))}
                <StateLegislatorLine label="State Senate" legislator={representation.state.upper} />
                <StateLegislatorLine label="State House" legislator={representation.state.lower} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FederalMemberLine({ label, member }: { label: string; member: FederalMemberSummary | null }) {
  if (!member) return <span>{label}: —</span>;
  return (
    <span>
      {label}:{' '}
      <Link className="iv1-link" to={`/directory?profile=${encodeURIComponent(member.bioguideId)}`}>
        {member.fullName}
      </Link>
      {member.party ? ` (${member.party})` : ''}
    </span>
  );
}

function StateLegislatorLine({
  label,
  legislator,
}: {
  label: string;
  legislator: StateLegislatorSummary | null;
}) {
  if (!legislator) return <span>{label}: —</span>;
  return (
    <span>
      {label}:{' '}
      {legislator.url ? (
        <a className="iv1-link" href={legislator.url} target="_blank" rel="noreferrer">
          {legislator.name}
        </a>
      ) : (
        legislator.name
      )}
      {legislator.party ? ` (${legislator.party})` : ''}
    </span>
  );
}
