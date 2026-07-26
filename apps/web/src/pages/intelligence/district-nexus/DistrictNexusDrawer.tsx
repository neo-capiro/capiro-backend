import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Alert, Button, Collapse, Drawer, Skeleton, Tag } from 'antd';
import { InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import {
  getDistrictNexusDistrictDetail,
  type DataQualityWarning,
  type DistrictNexusDistrictDetailResponse,
  type EvidenceVerificationStatus,
  type FederalMemberSummary,
  type NexusScoreBreakdown,
  type TopAward,
} from './district-nexus-api.js';
import {
  bandOf,
  directoryDistrictPath,
  formatMoney,
  formatNumber,
  splitDistrictKey,
} from './district-nexus-format.js';

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
 * WS-G district drawer. Renders exactly what GET
 * district-nexus/districts/:state/:district (WS-E2) returns — no invented
 * sections. Two things the plan's §3.2 spec and the visual prototype both
 * call for are deliberately absent because the shipped response has no data
 * for them:
 *   - Grant opportunities as a list (only aggregate estimated/ceiling money
 *     exists on this response; there is no per-opportunity field).
 *   - Targets and relationship context (no `targets` field on the response
 *     at all).
 * Both are noted in the WS-G report as backend gaps, not UI omissions.
 */
export function DistrictNexusDrawer({ districtKey, clientId, boundaryVintage, onClose }: Props) {
  const api = useApi();
  const { state, districtNo } = districtKey ? splitDistrictKey(districtKey) : { state: '', districtNo: '' };

  const detail = useQuery<DistrictNexusDistrictDetailResponse>({
    queryKey: ['district-nexus', 'detail', state, districtNo, clientId],
    queryFn: () => getDistrictNexusDistrictDetail(api, state, districtNo, { clientId: clientId ?? undefined }),
    enabled: Boolean(districtKey),
  });

  const d = detail.data;
  const band = d ? bandOf(d.score) : null;

  return (
    <Drawer
      open={Boolean(districtKey)}
      onClose={onClose}
      width={620}
      destroyOnClose
      // Render inline rather than porting to document.body: this drawer's
      // content uses the district-nexus.css custom properties scoped to
      // .dn-root, which only cascade to DOM descendants — a body-level
      // portal would sit outside that scope and lose every token.
      getContainer={false}
      title={
        districtKey ? (
          <div>
            <div className="dn-dr-kicker">Congressional district</div>
            <div className="dn-dr-l1">
              <h2>{districtKey}</h2>
              {d?.name ? <span className="dn-dr-nmx">{d.name}</span> : null}
            </div>
          </div>
        ) : null
      }
    >
      {detail.isPending ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
      {detail.isError ? (
        <Alert
          type="error"
          showIcon
          message="District Nexus could not load"
          description="This is an error, not an empty result."
        />
      ) : null}
      {d ? (
        <>
          <div className="dn-dr-l2">
            {band ? (
              <Tag color={d.score! >= 60 ? 'blue' : 'default'}>
                {band.label} nexus · {d.score}
              </Tag>
            ) : (
              <Tag>Unscored · below coverage floor</Tag>
            )}
            <Tag>Coverage {d.coveragePercent}%</Tag>
            <Tag>Boundary: {d.status === 'F' ? 'future' : 'current'}{boundaryVintage ? `, ${boundaryVintage}th` : ''}</Tag>
          </div>
          <div className="dn-dr-l3">
            <Link to={directoryDistrictPath(districtKey ?? '')}>
              <Button size="small">Open district page →</Button>
            </Link>
          </div>

          <div className="dn-sec" style={{ paddingTop: 16 }}>
            {d.warnings.map((w, i) => (
              <WarningHint key={i} warning={w} />
            ))}
            {!d.boundaryAvailable ? (
              <div className="dn-hint dn-info">
                <span className="dn-hico">
                  <InfoCircleOutlined />
                </span>
                <div>
                  <b>No boundary artifact covers this district yet.</b> Every figure below is unaffected — this
                  is about the map's geometry, not this district's data.
                </div>
              </div>
            ) : null}
          </div>

          <Collapse
            ghost
            defaultActiveKey={['score', 'representation', 'clients', 'contracts', 'grants']}
            items={[
              {
                key: 'score',
                label: <SectionLabel title="Why this score" meta={`${d.score ?? '—'} / 100`} />,
                children: <ScoreBreakdown breakdown={d.breakdown} coveragePercent={d.coveragePercent} />,
              },
              {
                key: 'representation',
                label: <SectionLabel title="Representation" meta="" />,
                children: <RepresentationSection representatives={d.representatives} />,
              },
              {
                key: 'clients',
                label: (
                  <SectionLabel title="Clients in this district" meta={`${d.clients.length} · ${d.facilities.length} facilities`} />
                ),
                children: <ClientsSection clients={d.clients} facilities={d.facilities} />,
              },
              {
                key: 'contracts',
                label: (
                  <SectionLabel
                    title="Federal contract awards"
                    meta={`${formatMoney(d.awarded.contractObligations)} · DoD prime`}
                  />
                ),
                children: <AwardsSection awards={d.topContractAwards} emptyText="No contract obligations placed in this district." />,
              },
              {
                key: 'grants',
                label: <SectionLabel title="Awarded federal assistance" meta={formatMoney(d.awarded.grantObligations)} />,
                children: (
                  <>
                    <dl className="dn-kv" style={{ marginBottom: 12 }}>
                      <dt>Obligations</dt>
                      <dd className="dn-num">{formatMoney(d.awarded.grantObligations)}</dd>
                      <dt>Outlays</dt>
                      <dd className="dn-num">
                        {formatMoney(d.awarded.grantOutlays)} <span className="dn-muted">(never summed with obligations)</span>
                      </dd>
                    </dl>
                    <AwardsSection awards={d.topGrantAwards} emptyText="No awarded assistance placed in this district." />
                  </>
                ),
              },
              {
                key: 'opportunities',
                label: <SectionLabel title="Grant opportunities" meta="not awarded" />,
                children: (
                  <>
                    <div className="dn-hint" style={{ marginBottom: 10 }}>
                      <span className="dn-hico">
                        <InfoCircleOutlined />
                      </span>
                      <div>
                        Opportunities are <b>not awarded money</b> and are never counted in the totals above.
                      </div>
                    </div>
                    <dl className="dn-kv">
                      <dt>Estimated program funding</dt>
                      <dd className="dn-num">{formatMoney(d.opportunities.opportunityEstimatedFunding)}</dd>
                      <dt>Award ceiling</dt>
                      <dd className="dn-num">{formatMoney(d.opportunities.opportunityAwardCeiling)}</dd>
                    </dl>
                    <div className="dn-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                      Individual opportunity listings aren't available in this view yet — see the Grant
                      Opportunities source in Data Explorer.
                    </div>
                  </>
                ),
              },
              {
                key: 'demographics',
                label: <SectionLabel title="District demographics" meta={d.demographics ? `ACS 5-year ${d.demographics.dataYear}` : 'unavailable'} />,
                children: <DemographicsSection demographics={d.demographics} />,
              },
              {
                key: 'evidence',
                label: <SectionLabel title="Evidence and sources" meta={`${d.evidence.length} records`} />,
                children: <EvidenceSection evidence={d.evidence} freshness={d.freshness} />,
              },
            ]}
          />
        </>
      ) : null}
    </Drawer>
  );
}

function SectionLabel({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="dn-sec-head" style={{ marginBottom: 0 }}>
      <span className="dn-st">{title}</span>
      {meta ? <span className="dn-sm">{meta}</span> : null}
    </div>
  );
}

function WarningHint({ warning }: { warning: DataQualityWarning }) {
  const info = warning.code === 'opportunity_only';
  return (
    <div className={`dn-hint ${info ? 'dn-info' : 'dn-notable'}`}>
      <span className="dn-hico">
        <WarningOutlined />
      </span>
      <div>{warning.message}</div>
    </div>
  );
}

function ScoreBreakdown({ breakdown, coveragePercent }: { breakdown: NexusScoreBreakdown[]; coveragePercent: number }) {
  const unmeasured = breakdown.filter((b) => b.credit === 0).map((b) => b.label.toLowerCase());
  return (
    <div className="dn-bkd">
      {breakdown.map((b) => {
        const color = COMPONENT_COLORS[b.component] ?? 'var(--accent)';
        return (
          <div key={b.component} className={`dn-br${b.credit ? '' : ' dn-zero'}`}>
            <div className="dn-bl">
              <span className="dn-sw" style={{ background: b.credit ? color : '#e2ddd2' }} />
              <span className="dn-nm" title={b.rationale}>
                {b.label}
              </span>
            </div>
            <div className="dn-bw">
              <i style={{ width: `${b.weight ? (b.credit / b.weight) * 100 : 0}%`, background: color }} />
            </div>
            <div className="dn-bv">
              {Math.round(b.credit)}/{b.weight}
            </div>
          </div>
        );
      })}
      <div className="dn-hint" style={{ marginTop: 12 }}>
        <span className="dn-hico">
          <InfoCircleOutlined />
        </span>
        <div>
          <b>{coveragePercent}% evidence coverage.</b> {100 - coveragePercent} points of the model have no data
          submitted for this district — that is a gap, not a verified zero.
          {unmeasured.length ? ` Unmeasured: ${unmeasured.join(', ')}.` : ''}
        </div>
      </div>
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
      <div className="dn-hint dn-info">
        <span className="dn-hico">
          <InfoCircleOutlined />
        </span>
        <div>This district code does not resolve to a single House seat (statewide, delegate, or undefined geography).</div>
      </div>
    );
  }
  return (
    <>
      {representatives.house ? (
        <MemberRow member={representatives.house} role="U.S. House" />
      ) : (
        <div className="dn-muted" style={{ fontSize: 12.5, padding: '9px 0' }}>
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
    <div className="dn-mem">
      <span className={`dn-pty ${party}`}>{party}</span>
      <div>
        <div className="dn-nm">{member.fullName}</div>
        <div className="dn-ro">{role}</div>
      </div>
      <div className="dn-rt">
        <Link className="dn-link-btn" to={`/directory/members/${member.bioguideId}`}>
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
      <div className="dn-hint">
        <span className="dn-hico">
          <InfoCircleOutlined />
        </span>
        <div>No client facility here. The nexus rests entirely on award geography, which is weaker evidence than a physical site.</div>
      </div>
    );
  }
  return (
    <div className="dn-tblwrap">
      <table className="dn-htable">
        <thead>
          <tr>
            <th>Client</th>
            <th className="dn-right">Facilities</th>
            <th className="dn-right">Employees</th>
            <th className="dn-right">Contracts</th>
            <th className="dn-right">Grants</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const clientFacilities = facilities.filter((f) => f.clientId === c.clientId);
            return (
              <tr key={c.clientId}>
                <td>
                  <b style={{ fontWeight: 600 }}>{c.clientName}</b>
                  {clientFacilities.length ? (
                    <div className="dn-sub">{clientFacilities.map((f) => f.name).join(', ')}</div>
                  ) : null}
                </td>
                <td className="dn-right">{c.facilityCount}</td>
                <td className="dn-right">{c.employeeCount == null ? 'not reported' : formatNumber(c.employeeCount)}</td>
                <td className="dn-right dn-num">{formatMoney(c.awarded.contractObligations)}</td>
                <td className="dn-right dn-num">{formatMoney(c.awarded.grantObligations)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AwardsSection({ awards, emptyText }: { awards: TopAward[]; emptyText: string }) {
  if (!awards.length) {
    return <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{emptyText}</div>;
  }
  return (
    <div className="dn-tblwrap">
      <table className="dn-htable">
        <thead>
          <tr>
            <th>Award</th>
            <th className="dn-right">Amount</th>
            <th>Awarded</th>
          </tr>
        </thead>
        <tbody>
          {awards.map((a) => (
            <tr key={a.id}>
              <td>
                {a.externalUrl ? (
                  <a href={a.externalUrl} target="_blank" rel="noreferrer" className="dn-mono" style={{ fontSize: 11.5 }}>
                    {a.label}
                  </a>
                ) : (
                  <span className="dn-mono" style={{ fontSize: 11.5 }}>
                    {a.label}
                  </span>
                )}
                {a.counterparty ? <div className="dn-sub">{a.counterparty}</div> : null}
              </td>
              <td className="dn-right dn-num">{formatMoney(a.amount)}</td>
              <td className="dn-sub">{a.awardedAt ? new Date(a.awardedAt).toLocaleDateString('en-US') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemographicsSection({ demographics }: { demographics: DistrictNexusDistrictDetailResponse['demographics'] }) {
  if (!demographics) {
    return <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>No demographic data available for this district.</div>;
  }
  return (
    <dl className="dn-kv">
      <dt>Population</dt>
      <dd className="dn-num">{formatNumber(demographics.totalPopulation)}</dd>
      <dt>Median household income</dt>
      <dd className="dn-num">{demographics.medianHouseholdIncome == null ? '—' : `$${formatNumber(demographics.medianHouseholdIncome)}`}</dd>
      <dt>Veterans</dt>
      <dd className="dn-num">{formatNumber(demographics.percentVeteran)}</dd>
      <dt>Vintage</dt>
      <dd>
        {demographics.dataYear} ACS 5-year · {demographics.congress}th Congress geography
      </dd>
    </dl>
  );
}

/** `place_of_performance` -> `Place of performance`. */
function humanizeToken(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Verification tiers, rendered honestly (plan §7-E4 / §8.2). `inferred` is
 * called out in the warning colour rather than shown as a neutral peer of the
 * verified tiers — it means "matched by name, not by a verified identifier",
 * which is exactly the claim the plan insists must never read as confirmed.
 */
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
        <div className="dn-tblwrap">
          <table className="dn-htable">
            <thead>
              <tr>
                <th>Evidence</th>
                <th>Basis</th>
                <th className="dn-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((e, i) => {
                const verification = VERIFICATION_LABEL[e.verificationStatus];
                return (
                  <tr key={e.sourceRecordId ?? `${e.component}-${i}`}>
                    <td>
                      {e.label}
                      <div className="dn-sub">{humanizeToken(e.sourceType)}</div>
                    </td>
                    <td>
                      {humanizeToken(e.geographyBasis)}
                      <div
                        className="dn-sub"
                        style={verification.muted ? { color: 'var(--notable)' } : undefined}
                      >
                        {verification.text}
                      </div>
                    </td>
                    <td className="dn-right dn-num">{formatMoney(e.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>No evidence records for this district.</div>
      )}
      {freshness.length ? (
        <div className="dn-prov">
          {freshness.map((f) => (
            <span key={f.source}>
              <b>{f.label}</b>{' '}
              {f.freshnessUnavailable ? 'unknown' : f.neverSynced ? 'never synced' : new Date(f.lastSyncedAt!).toLocaleDateString('en-US')}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
