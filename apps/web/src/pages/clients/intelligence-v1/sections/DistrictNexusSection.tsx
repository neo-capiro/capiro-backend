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
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { formatCompact } from '../mappers.js';
import { getClientDistrictNexus, type DistrictNexus } from '../district-nexus-api.js';
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

export function DistrictNexusSection({ clientId }: DistrictNexusSectionProps) {
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

      <YourRepresentativesBlock data={repQuery.data} loading={repQuery.isLoading} />

      {query.isLoading ? (
        <div className="iv1-surface">
          <div className="iv1-empty" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <span>Loading district nexus…</span>
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
}: {
  data: FacilityRepresentation[] | undefined;
  loading: boolean;
}) {
  if (loading) return null;
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
