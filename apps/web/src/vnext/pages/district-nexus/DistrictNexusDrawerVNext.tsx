import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CapiroDrawer } from '../../components/overlays/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { useApi } from '../../../lib/use-api.js';
import {
  getDistrictNexusDistrictDetail,
  getDistrictStrategicRelevance,
  type DataQualityWarning,
  type DistrictNexusDistrictDetailResponse,
  type DistrictStrategicRelevanceResponse,
  type EvidenceVerificationStatus,
  type FederalMemberSummary,
  type NexusScoreBreakdown,
  type StrategicRelevanceScore,
  type StrategicScoreBreakdown,
  type TopAward,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import {
  bandOf,
  directoryDistrictPath,
  formatMoney,
  formatNumber,
  splitDistrictKey,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import { DistrictFederalMarketPanelVNext } from './DistrictFederalMarketPanelVNext.js';
import { DistrictPriorityIntelligencePanelVNext } from './DistrictPriorityIntelligencePanelVNext.js';
import { DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE } from '../../../pages/intelligence/district-nexus/priority-intelligence-api.js';
import { DnxChevronDownIcon, DnxInfoIcon, DnxWarningIcon } from './icons.js';
import { useIntelFeatureEnabled } from '../../../lib/intel-feature-flags.js';

export const DISTRICT_NEXUS_STRATEGIC_FEATURE = 'district_nexus_strategic_relevance';

const COMPONENT_COLORS: Record<string, string> = {
  facility: '#1a3f9f',
  employee: '#2a57ce',
  contract: '#5b7ed6',
  grant: '#8ea9e4',
  supplier: '#b9caee',
  partner: '#2e6b43',
  policy: '#6a2eb5',
  relationship: '#a26913',
};

interface Props {
  districtKey: string | null;
  clientId: string | null;
  boundaryVintage?: string;
  onClose: () => void;
}

/**
 * vNext port of the canonical DistrictNexusDrawer. District detail stays
 * evidence-first and progressively disclosed. The map is the scan surface;
 * this drawer is where one district is interpreted. Shared federal-market
 * context lives here so the main map does not grow a second, competing
 * dashboard below it.
 */
export function DistrictNexusDrawerVNext({
  districtKey,
  clientId,
  boundaryVintage,
  onClose,
}: Props) {
  const api = useApi();
  const strategicEnabled = useIntelFeatureEnabled(DISTRICT_NEXUS_STRATEGIC_FEATURE);
  const priorityEnabled = useIntelFeatureEnabled(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE);
  const { state, districtNo } = districtKey
    ? splitDistrictKey(districtKey)
    : { state: '', districtNo: '' };

  const detail = useQuery<DistrictNexusDistrictDetailResponse>({
    queryKey: ['district-nexus', 'detail', state, districtNo, clientId],
    queryFn: () =>
      getDistrictNexusDistrictDetail(api, state, districtNo, { clientId: clientId ?? undefined }),
    enabled: Boolean(districtKey),
  });

  const strategic = useQuery<DistrictStrategicRelevanceResponse>({
    queryKey: ['district-nexus', 'strategic', state, districtNo, clientId],
    queryFn: () => getDistrictStrategicRelevance(api, state, districtNo, clientId!),
    enabled: Boolean(districtKey && clientId && strategicEnabled),
    retry: false,
  });

  const d = detail.data;
  const band = d ? bandOf(d.score) : null;
  const s = strategic.data?.strategic ?? null;
  const sBand = s ? bandOf(s.score) : null;

  return (
    <CapiroDrawer open={Boolean(districtKey)} title={districtKey ?? ''} onClose={onClose}>
      <div className="dnx-drawer-body">
        <div className="dnx-dr-kicker">Congressional district</div>
        {detail.isPending ? (
          <div className="dnx-skel-rows" aria-busy="true" style={{ marginTop: 14 }}>
            <CapiroSkeleton height={16} width="55%" />
            <CapiroSkeleton height={14} />
            <CapiroSkeleton height={14} />
            <CapiroSkeleton height={14} width="80%" />
            <CapiroSkeleton height={14} />
            <CapiroSkeleton height={14} width="66%" />
            <CapiroSkeleton height={14} />
            <CapiroSkeleton height={14} width="72%" />
          </div>
        ) : null}
        {detail.isError ? (
          <CapiroErrorState
            title="District Nexus could not load"
            description="This is an error, not an empty result."
          />
        ) : null}
        {d ? (
          <>
            {d.name ? <div className="dnx-dr-nmx">{d.name}</div> : null}
            <div className="dnx-dr-l2">
              {band ? (
                <CapiroBadge tone={d.score! >= 60 ? 'info' : 'neutral'}>
                  {band.label} nexus · {d.score}
                </CapiroBadge>
              ) : (
                <CapiroBadge tone="neutral">Unscored nexus · below coverage floor</CapiroBadge>
              )}
              <CapiroBadge tone="neutral">Nexus coverage {d.coveragePercent}%</CapiroBadge>
              {strategicEnabled && clientId ? (
                sBand ? (
                  <CapiroBadge tone={s!.score! >= 60 ? 'info' : 'neutral'}>
                    {sBand.label} strategic · {s!.score}
                  </CapiroBadge>
                ) : strategic.isPending ? (
                  <CapiroBadge tone="neutral">Strategic…</CapiroBadge>
                ) : strategic.isError ? (
                  <CapiroBadge tone="neutral">Strategic unavailable</CapiroBadge>
                ) : s ? (
                  <CapiroBadge tone="neutral">
                    Unscored strategic · below coverage floor
                  </CapiroBadge>
                ) : null
              ) : null}
              <CapiroBadge tone="neutral">
                Boundary: current{boundaryVintage ? `, ${boundaryVintage}th` : ''}
              </CapiroBadge>
            </div>
            <div className="dnx-dr-l3">
              <Link to={directoryDistrictPath(districtKey ?? '')}>
                <CapiroButton size="compact">Open district page →</CapiroButton>
              </Link>
            </div>

            {d.warnings.length || !d.boundaryAvailable ? (
              <div className="dnx-dr-hints">
                {d.warnings.map((w, i) => (
                  <WarningHint key={i} warning={w} />
                ))}
                {!d.boundaryAvailable ? (
                  <div className="dnx-hint dnx-info">
                    <span className="dnx-hico">
                      <DnxInfoIcon />
                    </span>
                    <div>
                      <b>No boundary artifact covers this district yet.</b> Every figure below is
                      unaffected — this is about the map&apos;s geometry, not this district&apos;s
                      data.
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <DnxSection title="Why this score" meta={`${d.score ?? '—'} / 100 nexus`} defaultOpen>
              <ScoreBreakdown breakdown={d.breakdown} coveragePercent={d.coveragePercent} />
            </DnxSection>
            {strategicEnabled && clientId ? (
              <DnxSection
                title="Why this district matters"
                meta={
                  s
                    ? `${s.score ?? 'Unscored'} strategic · ${s.coveragePercent}% cov`
                    : strategic.isPending
                      ? 'loading'
                      : strategic.isError
                        ? 'unavailable'
                        : '—'
                }
                defaultOpen
              >
                {strategic.isPending ? (
                  <div className="dnx-skel-rows" aria-busy="true">
                    <CapiroSkeleton height={14} />
                    <CapiroSkeleton height={14} width="80%" />
                    <CapiroSkeleton height={14} width="66%" />
                  </div>
                ) : null}
                {strategic.isError ? (
                  <div className="dnx-muted" style={{ fontSize: 12.5 }}>
                    Strategic Relevance could not load for this client. Nexus Strength above is
                    unaffected.
                  </div>
                ) : null}
                {s ? <StrategicSection strategic={s} /> : null}
                {!clientId ? (
                  <div className="dnx-muted" style={{ fontSize: 12.5 }}>
                    Select a client to compute Strategic Relevance.
                  </div>
                ) : null}
              </DnxSection>
            ) : null}
            <DnxSection
              title="Federal market context"
              meta="contracts · subawards · future"
              defaultOpen
            >
              {districtKey ? (
                <DistrictFederalMarketPanelVNext clientId={clientId} districtKey={districtKey} />
              ) : null}
            </DnxSection>
            {priorityEnabled ? (
              <DnxSection
                title="Federal & local priorities"
                meta="CPF/CDS · GSA · sector · changes"
              >
                {districtKey ? (
                  <DistrictPriorityIntelligencePanelVNext
                    clientId={clientId}
                    districtKey={districtKey}
                  />
                ) : null}
              </DnxSection>
            ) : null}
            <DnxSection title="Representation" meta="">
              <RepresentationSection representatives={d.representatives} />
            </DnxSection>
            <DnxSection
              title="Clients in this district"
              meta={`${d.clients.length} · ${d.facilities.length} facilities`}
            >
              <ClientsSection clients={d.clients} facilities={d.facilities} />
            </DnxSection>
            <DnxSection
              title="Federal contract awards"
              meta={`${formatMoney(d.awarded.contractObligations)} · DoD prime`}
            >
              {d.clientScoped ? (
                <>
                  <div className="dnx-list-label">This client&apos;s contract awards</div>
                  <AwardsSection
                    awards={d.clientContractAwards}
                    emptyText="No contract award matched to this client's confirmed contractor names in this district."
                  />
                  <div className="dnx-list-label dnx-list-label-muted">
                    All public contract awards in this district
                  </div>
                </>
              ) : null}
              <AwardsSection
                awards={d.topContractAwards}
                emptyText="No contract obligations placed in this district."
              />
            </DnxSection>
            <DnxSection
              title="Awarded federal assistance"
              meta={formatMoney(d.awarded.grantObligations)}
            >
              <dl className="dnx-kv" style={{ marginBottom: 12 }}>
                <dt>Obligations</dt>
                <dd className="dnx-num">{formatMoney(d.awarded.grantObligations)}</dd>
                <dt>Outlays</dt>
                <dd className="dnx-num">
                  {formatMoney(d.awarded.grantOutlays)}{' '}
                  <span className="dnx-muted">(never summed with obligations)</span>
                </dd>
              </dl>
              {d.clientScoped ? (
                <>
                  <div className="dnx-list-label">This client&apos;s assistance awards</div>
                  <AwardsSection
                    awards={d.clientGrantAwards}
                    emptyText="No assistance award matched to this client's confirmed recipient identifiers in this district."
                  />
                  <div className="dnx-list-label dnx-list-label-muted">
                    All public assistance awards in this district
                  </div>
                </>
              ) : null}
              <AwardsSection
                awards={d.topGrantAwards}
                emptyText="No awarded assistance placed in this district."
              />
            </DnxSection>
            <DnxSection title="Grant opportunities" meta="not awarded">
              <div className="dnx-hint" style={{ marginBottom: 10 }}>
                <span className="dnx-hico">
                  <DnxInfoIcon />
                </span>
                <div>
                  Opportunities are <b>not awarded money</b> and are never counted in the totals
                  above.
                </div>
              </div>
              <dl className="dnx-kv">
                <dt>Estimated program funding</dt>
                <dd className="dnx-num">
                  {formatMoney(d.opportunities.opportunityEstimatedFunding)}
                </dd>
                <dt>Award ceiling</dt>
                <dd className="dnx-num">{formatMoney(d.opportunities.opportunityAwardCeiling)}</dd>
              </dl>
              <div className="dnx-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                Individual opportunity listings aren&apos;t available in this view yet — see Funding
                Opportunities for client qualification.
              </div>
            </DnxSection>
            <DnxSection
              title="District demographics"
              meta={d.demographics ? `ACS 5-year ${d.demographics.dataYear}` : 'unavailable'}
            >
              <DemographicsSection demographics={d.demographics} />
            </DnxSection>
            <DnxSection title="Evidence and sources" meta={`${d.evidence.length} records`}>
              <EvidenceSection evidence={d.evidence} freshness={d.freshness} />
            </DnxSection>
          </>
        ) : null}
      </div>
    </CapiroDrawer>
  );
}

/** Progressive-disclosure section — the vNext stand-in for the canonical
 * drawer's ghost Collapse items. Same defaults: score + market open. */
function DnxSection({
  title,
  meta,
  defaultOpen,
  children,
}: {
  title: string;
  meta: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <section className="dnx-sec">
      <button
        type="button"
        className="dnx-sec-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dnx-st">{title}</span>
        {meta ? <span className="dnx-sm">{meta}</span> : null}
        <DnxChevronDownIcon className={`dnx-cv${open ? ' dnx-cv-open' : ''}`} />
      </button>
      {open ? <div className="dnx-sec-body">{children}</div> : null}
    </section>
  );
}

function WarningHint({ warning }: { warning: DataQualityWarning }) {
  const info = warning.code === 'opportunity_only';
  return (
    <div className={`dnx-hint ${info ? 'dnx-info' : 'dnx-notable'}`}>
      <span className="dnx-hico">
        <DnxWarningIcon />
      </span>
      <div>{warning.message}</div>
    </div>
  );
}

function ScoreBreakdown({
  breakdown,
  coveragePercent,
}: {
  breakdown: NexusScoreBreakdown[];
  coveragePercent: number;
}) {
  const unmeasured = breakdown.filter((b) => b.credit === 0).map((b) => b.label.toLowerCase());
  return (
    <div className="dnx-bkd">
      {breakdown.map((b) => {
        const color = COMPONENT_COLORS[b.component] ?? 'var(--uui-brand-solid)';
        return (
          <div key={b.component} className={`dnx-br${b.credit ? '' : ' dnx-zero'}`}>
            <div className="dnx-bl">
              <span
                className="dnx-sw"
                style={{ background: b.credit ? color : 'var(--uui-gray-200)' }}
              />
              <span className="dnx-nm" title={b.rationale}>
                {b.label}
              </span>
            </div>
            <div className="dnx-bw">
              <i
                style={{
                  width: `${b.weight ? (b.credit / b.weight) * 100 : 0}%`,
                  background: color,
                }}
              />
            </div>
            <div className="dnx-bv">
              {Math.round(b.credit)}/{b.weight}
            </div>
          </div>
        );
      })}
      <div className="dnx-hint" style={{ marginTop: 12 }}>
        <span className="dnx-hico">
          <DnxInfoIcon />
        </span>
        <div>
          <b>{coveragePercent}% evidence coverage.</b> {100 - coveragePercent} points of the model
          have no data submitted for this district — that is a gap, not a verified zero.
          {unmeasured.length ? ` Unmeasured: ${unmeasured.join(', ')}.` : ''}
        </div>
      </div>
    </div>
  );
}

/**
 * Strategic Relevance is a SEPARATE score from Nexus Strength.
 * Null credit must never render as 0; missing/unavailable stay labeled.
 */
function StrategicSection({ strategic }: { strategic: StrategicRelevanceScore }) {
  const band = bandOf(strategic.score);
  const missing = strategic.breakdown.filter(
    (b) => b.status === 'missing' || b.status === 'unavailable',
  );
  return (
    <div className="dnx-strategic">
      <div className="dnx-dr-l2" style={{ marginBottom: 12 }}>
        {band ? (
          <CapiroBadge tone={strategic.score! >= 60 ? 'info' : 'neutral'}>
            Strategic · {band.label} · {strategic.score}
          </CapiroBadge>
        ) : (
          <CapiroBadge tone="neutral">Strategic · Unscored (not “low”)</CapiroBadge>
        )}
        <CapiroBadge tone="neutral">Coverage {strategic.coveragePercent}%</CapiroBadge>
        <CapiroBadge tone="neutral">{strategic.scoreVersion}</CapiroBadge>
      </div>

      {strategic.strongestDrivers.length ? (
        <div style={{ marginBottom: 12 }}>
          <div className="dnx-list-label">Strongest drivers</div>
          <ul className="dnx-muted" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            {strategic.strongestDrivers.map((d) => (
              <li key={d.component}>
                {d.label}
                {d.credit != null ? ` · ${Math.round(d.credit)}/${d.weight}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="dnx-bkd">
        {strategic.breakdown.map((b: StrategicScoreBreakdown) => {
          const scored = b.credit != null && b.credit > 0;
          const color = 'var(--uui-brand-solid)';
          const display =
            b.credit == null
              ? b.status === 'unavailable'
                ? 'n/a'
                : '—'
              : String(Math.round(b.credit));
          return (
            <div key={b.component} className={`dnx-br${scored ? '' : ' dnx-zero'}`}>
              <div className="dnx-bl">
                <span
                  className="dnx-sw"
                  style={{ background: scored ? color : 'var(--uui-gray-200)' }}
                />
                <span className="dnx-nm" title={b.rationale}>
                  {b.label}
                  {b.status === 'missing' ? ' · missing' : ''}
                  {b.status === 'unavailable' ? ' · unavailable' : ''}
                </span>
              </div>
              <div className="dnx-bw">
                <i
                  style={{
                    width: `${b.weight && b.credit != null ? (b.credit / b.weight) * 100 : 0}%`,
                    background: color,
                  }}
                />
              </div>
              <div className="dnx-bv">
                {display}/{b.weight}
              </div>
            </div>
          );
        })}
      </div>

      {missing.length ? (
        <div className="dnx-hint dnx-info" style={{ marginTop: 12 }}>
          <span className="dnx-hico">
            <DnxInfoIcon />
          </span>
          <div>
            <b>Missing / unavailable signals (not zeros):</b>{' '}
            {missing.map((m) => m.label).join('; ')}.
          </div>
        </div>
      ) : null}

      {strategic.conflicts.length ? (
        <div style={{ marginTop: 10 }}>
          {strategic.conflicts.map((c, i) => (
            <div key={i} className="dnx-hint dnx-notable" style={{ marginBottom: 6 }}>
              <span className="dnx-hico">
                <DnxWarningIcon />
              </span>
              <div>{c.message}</div>
            </div>
          ))}
        </div>
      ) : null}

      {strategic.evidence.length ? (
        <div style={{ marginTop: 12 }}>
          <div className="dnx-list-label">Contributing evidence</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            {strategic.evidence.slice(0, 12).map((e, i) => (
              <li key={`${e.sourceRecordId ?? e.label}-${i}`}>
                <b>{e.label}</b> — {e.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="dnx-muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          No structured strategic evidence rows for this district yet.
        </div>
      )}
    </div>
  );
}

function RepresentationSection({
  representatives,
}: {
  representatives: DistrictNexusDistrictDetailResponse['representatives'];
}) {
  if (!representatives) {
    return (
      <div className="dnx-hint dnx-info">
        <span className="dnx-hico">
          <DnxInfoIcon />
        </span>
        <div>
          This district code does not resolve to a single House seat (statewide, delegate, or
          undefined geography).
        </div>
      </div>
    );
  }
  return (
    <>
      {representatives.house ? (
        <MemberRow member={representatives.house} role="U.S. House" />
      ) : (
        <div className="dnx-muted" style={{ fontSize: 12.5, padding: '9px 0' }}>
          No House member on file for this district.
        </div>
      )}
      {representatives.senate.map((m) => (
        <MemberRow key={m.bioguideId} member={m} role="U.S. Senate" />
      ))}
    </>
  );
}

function MemberRow({ member, role }: { member: FederalMemberSummary; role: string }) {
  const party = member.party ?? '—';
  return (
    <div className="dnx-mem">
      <span className={`dnx-pty ${party}`}>{party}</span>
      <div>
        <div className="dnx-mem-nm">{member.fullName}</div>
        <div className="dnx-mem-ro">{role}</div>
      </div>
      <div className="dnx-mem-rt">
        <Link className="dnx-link-btn" to={`/directory/members/${member.bioguideId}`}>
          Profile →
        </Link>
      </div>
    </div>
  );
}

function ClientsSection({
  clients,
  facilities,
}: {
  clients: DistrictNexusDistrictDetailResponse['clients'];
  facilities: DistrictNexusDistrictDetailResponse['facilities'];
}) {
  if (!clients.length) {
    return (
      <div className="dnx-hint">
        <span className="dnx-hico">
          <DnxInfoIcon />
        </span>
        <div>
          No client has nexus in this district — no facility, no matched award, and no reviewed
          relationship.
        </div>
      </div>
    );
  }
  return (
    <CapiroTableWrap className="dnx-htablewrap">
      <CapiroTable className="dnx-htable">
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Client</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Facilities</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Employees</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Contracts</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Grants</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {clients.map((c) => {
            const clientFacilities = facilities.filter((f) => f.clientId === c.clientId);
            return (
              <tr key={c.clientId}>
                <CapiroTableCell>
                  <b style={{ fontWeight: 600 }}>{c.clientName}</b>
                  {clientFacilities.length ? (
                    <div className="dnx-sub">{clientFacilities.map((f) => f.name).join(', ')}</div>
                  ) : null}
                </CapiroTableCell>
                <CapiroTableCell className="dnx-right">{c.facilityCount}</CapiroTableCell>
                <CapiroTableCell className="dnx-right">
                  {c.employeeCount == null ? 'not reported' : formatNumber(c.employeeCount)}
                </CapiroTableCell>
                <CapiroTableCell className="dnx-right dnx-num">
                  {formatMoney(c.awarded.contractObligations)}
                </CapiroTableCell>
                <CapiroTableCell className="dnx-right dnx-num">
                  {formatMoney(c.awarded.grantObligations)}
                </CapiroTableCell>
              </tr>
            );
          })}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

function AwardsSection({ awards, emptyText }: { awards: TopAward[]; emptyText: string }) {
  if (!awards.length) {
    return (
      <div style={{ fontSize: 12.5 }} className="dnx-muted">
        {emptyText}
      </div>
    );
  }
  return (
    <CapiroTableWrap className="dnx-htablewrap">
      <CapiroTable className="dnx-htable">
        <CapiroTableHead>
          <tr>
            <CapiroTableHeaderCell>Award</CapiroTableHeaderCell>
            <CapiroTableHeaderCell className="dnx-right">Amount</CapiroTableHeaderCell>
            <CapiroTableHeaderCell>Awarded</CapiroTableHeaderCell>
          </tr>
        </CapiroTableHead>
        <CapiroTableBody>
          {awards.map((a) => (
            <tr key={a.id}>
              <CapiroTableCell>
                {a.externalUrl ? (
                  <a
                    href={a.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="dnx-mono"
                    style={{ fontSize: 11.5 }}
                  >
                    {a.label}
                  </a>
                ) : (
                  <span className="dnx-mono" style={{ fontSize: 11.5 }}>
                    {a.label}
                  </span>
                )}
                {a.counterparty ? <div className="dnx-sub">{a.counterparty}</div> : null}
              </CapiroTableCell>
              <CapiroTableCell className="dnx-right dnx-num">
                {formatMoney(a.amount)}
              </CapiroTableCell>
              <CapiroTableCell className="dnx-sub">
                {a.awardedAt ? new Date(a.awardedAt).toLocaleDateString('en-US') : '—'}
              </CapiroTableCell>
            </tr>
          ))}
        </CapiroTableBody>
      </CapiroTable>
    </CapiroTableWrap>
  );
}

function DemographicsSection({
  demographics,
}: {
  demographics: DistrictNexusDistrictDetailResponse['demographics'];
}) {
  if (!demographics) {
    return (
      <div style={{ fontSize: 12.5 }} className="dnx-muted">
        No demographic data available for this district.
      </div>
    );
  }
  return (
    <dl className="dnx-kv">
      <dt>Population</dt>
      <dd className="dnx-num">{formatNumber(demographics.totalPopulation)}</dd>
      <dt>Median household income</dt>
      <dd className="dnx-num">
        {demographics.medianHouseholdIncome == null
          ? '—'
          : `$${formatNumber(demographics.medianHouseholdIncome)}`}
      </dd>
      <dt>Veterans</dt>
      <dd className="dnx-num">{formatNumber(demographics.percentVeteran)}</dd>
      <dt>Vintage</dt>
      <dd>
        {demographics.dataYear} ACS 5-year · {demographics.congress}th Congress geography
      </dd>
    </dl>
  );
}

function humanizeToken(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const VERIFICATION_LABEL: Record<EvidenceVerificationStatus, { text: string; muted: boolean }> = {
  source_verified: { text: 'Source verified', muted: false },
  geocode_verified: { text: 'Geocode verified', muted: false },
  user_provided: { text: 'Client provided', muted: true },
  inferred: { text: 'Name match only', muted: true },
};

function EvidenceSection({
  evidence,
  freshness,
}: {
  evidence: DistrictNexusDistrictDetailResponse['evidence'];
  freshness: DistrictNexusDistrictDetailResponse['freshness'];
}) {
  return (
    <>
      {evidence.length ? (
        <CapiroTableWrap className="dnx-htablewrap">
          <CapiroTable className="dnx-htable">
            <CapiroTableHead>
              <tr>
                <CapiroTableHeaderCell>Evidence</CapiroTableHeaderCell>
                <CapiroTableHeaderCell>Basis</CapiroTableHeaderCell>
                <CapiroTableHeaderCell className="dnx-right">Amount</CapiroTableHeaderCell>
              </tr>
            </CapiroTableHead>
            <CapiroTableBody>
              {evidence.map((e, i) => {
                const verification = VERIFICATION_LABEL[e.verificationStatus];
                return (
                  <tr key={e.sourceRecordId ?? `${e.component}-${i}`}>
                    <CapiroTableCell>
                      {e.label}
                      <div className="dnx-sub">{humanizeToken(e.sourceType)}</div>
                    </CapiroTableCell>
                    <CapiroTableCell>
                      {humanizeToken(e.geographyBasis)}
                      <div className={`dnx-sub${verification.muted ? ' dnx-sub-notable' : ''}`}>
                        {verification.text}
                      </div>
                    </CapiroTableCell>
                    <CapiroTableCell className="dnx-right dnx-num">
                      {formatMoney(e.amount)}
                    </CapiroTableCell>
                  </tr>
                );
              })}
            </CapiroTableBody>
          </CapiroTable>
        </CapiroTableWrap>
      ) : (
        <div style={{ fontSize: 12.5 }} className="dnx-muted">
          No evidence records for this district.
        </div>
      )}
      {freshness.length ? (
        <div className="dnx-prov">
          {freshness.map((f) => (
            <span key={f.source}>
              <b>{f.label}</b>{' '}
              {f.freshnessUnavailable
                ? 'unknown'
                : f.neverSynced
                  ? 'never synced'
                  : new Date(f.lastSyncedAt!).toLocaleDateString('en-US')}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
