import { lazy, Suspense, type ReactNode } from 'react';
import { Card, CardHead, Pill } from '../portfolio-primitives.js';
import { FacilityVerification } from '../FacilityVerification.js';
import { formatMoney, formatNumber, partyLabel } from '../../../lib/labels.js';
import {
  bandOf,
  type ScoreBand,
} from '../../../../pages/intelligence/district-nexus/district-nexus-format.js';
import type {
  ClientDistrictNexusV2,
  DistrictNexusDistrictDetail,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import type { ClientFacility } from '../../../../pages/clients/facilities-api.js';
import type { RepresentationResult } from '../../../../pages/clients/intelligence-v1/representation-api.js';
import { facilityStatus, type RealDistrictModel } from './district-panel-model.js';

const DistrictNexusMapLibreLazy = lazy(
  () => import('../../../components/district-map/DistrictNexusMapLibre.js'),
);

interface SharedContentProps {
  facilities: ClientFacility[];
  repByFacilityId: Map<string, RepresentationResult>;
  ungeocodedCount: number;
  onSelectDistrict: (districtKey: string) => void;
  notice?: ReactNode;
}

export function V2DistrictPanelContent({
  v2,
  districts,
  effectiveSelected,
  selectedDistrict,
  selectedRepresentative,
  facilities,
  repByFacilityId,
  ungeocodedCount,
  onSelectDistrict,
  notice,
}: SharedContentProps & {
  v2: ClientDistrictNexusV2;
  districts: DistrictNexusDistrictDetail[];
  effectiveSelected: string | null;
  selectedDistrict: DistrictNexusDistrictDetail | null;
  selectedRepresentative: { name: string; party: string | null } | undefined;
}) {
  const selectedBand = selectedDistrict ? bandOf(selectedDistrict.score) : null;

  return (
    <div className="capiro-intel-stack-24">
      {notice}
      <Card>
        <div className="capiro-intel-panel-head">
          <span className="capiro-intel-panel-head-copy">
            <span className="capiro-intel-title-md" style={{ display: 'block' }}>
              District footprint
            </span>
            <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
              Verified client footprint, public funding, and representation by congressional
              district — the same scoring District Nexus uses. Select a district on the map or in
              the list.
            </span>
          </span>
          <Pill tone="gray" dotless>
            {districts.length} district{districts.length === 1 ? '' : 's'} ·{' '}
            {Math.round(v2.coveragePercent)}% coverage
          </Pill>
        </div>
        <div className="cap-pf-map-cols">
          <div className="cap-pf-map-frame">
            <MapSuspense>
              <DistrictNexusMapLibreLazy
                districts={districts}
                facilities={facilities}
                selectedDistrictKey={effectiveSelected}
                onSelectDistrict={onSelectDistrict}
              />
            </MapSuspense>
          </div>
          <div className="capiro-intel-rail-col">
            {districts.map((district) => (
              <V2DistrictRailRow
                key={district.districtKey}
                d={district}
                selected={effectiveSelected === district.districtKey}
                onSelect={() => onSelectDistrict(district.districtKey)}
              />
            ))}
          </div>
        </div>
        {ungeocodedCount > 0 ? (
          <p className="capiro-intel-note" style={{ padding: '14px 24px 18px' }}>
            {ungeocodedCount} location{ungeocodedCount === 1 ? ' needs' : 's need'} an address match
            before appearing on the map. Open Manage facilities to review and resolve the address.
          </p>
        ) : null}
      </Card>

      {selectedDistrict ? (
        <div className="cap-pf-grid-dist">
          <Card>
            <CardHead title="Selected district" />
            <div className="capiro-intel-district-body">
              <div className="capiro-intel-row-wrap">
                <span className="capiro-intel-value-xl">{selectedDistrict.districtKey}</span>
                {selectedBand ? (
                  <Pill
                    tone={
                      selectedBand.id === 'strong'
                        ? 'success'
                        : selectedBand.id === 'moderate'
                          ? 'blue'
                          : 'gray'
                    }
                    size="lg"
                  >
                    {selectedBand.label} nexus · {selectedDistrict.score}
                  </Pill>
                ) : (
                  <Pill tone="gray" size="lg" dotless>
                    Unscored — below the coverage floor
                  </Pill>
                )}
              </div>
              <div className="capiro-intel-eyebrow" style={{ marginTop: 14 }}>
                Federal representative
              </div>
              <div className="capiro-intel-rep-line">
                {selectedRepresentative
                  ? `${selectedRepresentative.name}${partyLabel(selectedRepresentative.party) ? ` (${partyLabel(selectedRepresentative.party)})` : ''} · House`
                  : 'Not yet resolved'}
              </div>
              <div className="capiro-intel-tiles">
                {(
                  [
                    [
                      'Contract obligations',
                      formatMoney(selectedDistrict.awarded.contractObligations),
                    ],
                    ['Grant obligations', formatMoney(selectedDistrict.awarded.grantObligations)],
                    [
                      'Employees',
                      selectedDistrict.employeeCount != null
                        ? formatNumber(selectedDistrict.employeeCount)
                        : selectedDistrict.employeesUnreported
                          ? 'Not reported'
                          : '—',
                    ],
                    ['Evidence coverage', `${Math.round(selectedDistrict.coveragePercent)}%`],
                  ] as const
                ).map(([label, value]) => (
                  <span key={label} className="capiro-intel-tile">
                    <span className="capiro-intel-eyebrow-xs">{label}</span>
                    <span className="capiro-intel-tile-value">{value}</span>
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <FacilitiesRepresentationCard facilities={facilities} repByFacilityId={repByFacilityId} />
        </div>
      ) : null}
    </div>
  );
}

export function DistrictPanelFallbackContent({
  districts,
  effectiveSelected,
  selectedDistrict,
  facilities,
  repByFacilityId,
  ungeocodedCount,
  onSelectDistrict,
  notice,
  representationFailureNotice,
  contractingLinked,
}: SharedContentProps & {
  districts: RealDistrictModel[];
  effectiveSelected: string | null;
  selectedDistrict: RealDistrictModel | null;
  representationFailureNotice?: ReactNode;
  contractingLinked?: boolean;
}) {
  return (
    <div className="capiro-intel-stack-24">
      {notice}
      {representationFailureNotice}
      <Card>
        <div className="capiro-intel-panel-head">
          <span className="capiro-intel-panel-head-copy">
            <span className="capiro-intel-title-md" style={{ display: 'block' }}>
              District footprint
            </span>
            <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
              Real facility locations by congressional district. Federal award activity is
              unavailable when the scored District Nexus source does not answer.
            </span>
          </span>
          <Pill tone="gray" dotless>
            {districts.length} district{districts.length === 1 ? '' : 's'}
          </Pill>
        </div>
        {districts.length === 0 &&
        !facilities.some((facility) => facility.latitude != null && facility.longitude != null) ? (
          <p className="capiro-intel-note" style={{ padding: '0 24px 20px' }}>
            {ungeocodedCount > 0
              ? `${ungeocodedCount} facilit${ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded, so no district can be plotted yet.`
              : 'No facility has resolved to a congressional district yet.'}
          </p>
        ) : (
          <div className="cap-pf-map-cols">
            <div className="cap-pf-map-frame">
              <MapSuspense>
                <DistrictNexusMapLibreLazy
                  facilities={facilities}
                  metric="clients"
                  districts={districts.map((district) => ({
                    districtKey: district.code,
                    state: district.code.split('-')[0]!,
                    districtCode: district.code.split('-')[1]!,
                    name: district.code,
                    status: 'C' as const,
                    clientCount: 1,
                    score: null,
                    coveragePercent: 0,
                    employeeCount: district.employeeCount,
                    employeesUnreported: district.employeeCount == null,
                    warnings: [],
                    awarded: {
                      contractObligations: district.totalAmount,
                      grantObligations: null,
                      grantOutlays: null,
                    },
                    opportunities: {
                      opportunityEstimatedFunding: null,
                      opportunityAwardCeiling: null,
                    },
                  }))}
                  selectedDistrictKey={effectiveSelected}
                  onSelectDistrict={onSelectDistrict}
                />
              </MapSuspense>
            </div>
            <div className="capiro-intel-rail-col">
              {districts.map((district) => (
                <RealDistrictRailRow
                  key={district.code}
                  d={district}
                  selected={effectiveSelected === district.code}
                  onSelect={() => onSelectDistrict(district.code)}
                />
              ))}
            </div>
          </div>
        )}
        {ungeocodedCount > 0 && districts.length > 0 ? (
          <p className="capiro-intel-caption-muted" style={{ margin: 0, padding: '0 24px 18px' }}>
            {ungeocodedCount} more facilit{ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but
            not yet geocoded.
          </p>
        ) : null}
        {contractingLinked !== true ? (
          <p className="capiro-intel-caption-muted" style={{ margin: 0, padding: '0 24px 18px' }}>
            Contract obligations are unavailable in this facility-only view.
          </p>
        ) : null}
      </Card>

      {selectedDistrict ? (
        <div className="cap-pf-grid-dist">
          <Card>
            <CardHead title="Selected district" />
            <div className="capiro-intel-district-body">
              <div className="capiro-intel-row-wrap">
                <span className="capiro-intel-value-xl">{selectedDistrict.code}</span>
                <Pill tone={selectedDistrict.ui} size="lg">
                  Unscored facility view
                </Pill>
              </div>
              <div className="capiro-intel-eyebrow" style={{ marginTop: 14 }}>
                Federal representative
              </div>
              <div className="capiro-intel-rep-line">
                {selectedDistrict.repName
                  ? `${selectedDistrict.repName}${partyLabel(selectedDistrict.repParty) ? ` (${partyLabel(selectedDistrict.repParty)})` : ''} · ${selectedDistrict.repChamber}`
                  : 'Not yet resolved'}
              </div>
              <div className="capiro-intel-tiles">
                {(
                  [
                    ['Facilities', selectedDistrict.facilityNames.join(', ') || '—'],
                    [
                      'Employees',
                      selectedDistrict.employeeCount != null
                        ? formatNumber(selectedDistrict.employeeCount)
                        : 'Needs count',
                    ],
                    [
                      'Federal awards',
                      selectedDistrict.totalAmount != null
                        ? formatMoney(selectedDistrict.totalAmount)
                        : 'Unavailable',
                    ],
                    [
                      'Awards on record',
                      selectedDistrict.awardCount != null
                        ? formatNumber(selectedDistrict.awardCount)
                        : '—',
                    ],
                  ] as const
                ).map(([label, value]) => (
                  <span key={label} className="capiro-intel-tile">
                    <span className="capiro-intel-eyebrow-xs">{label}</span>
                    <span className="capiro-intel-tile-value">{value}</span>
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <FacilitiesRepresentationCard facilities={facilities} repByFacilityId={repByFacilityId} />
        </div>
      ) : (
        <FacilitiesRepresentationCard facilities={facilities} repByFacilityId={repByFacilityId} />
      )}
    </div>
  );
}

function MapSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={<div className="cap-pf-dn-loading" aria-busy="true" aria-label="Loading map" />}
    >
      {children}
    </Suspense>
  );
}

function RealDistrictRailRow({
  d,
  selected,
  onSelect,
}: {
  d: RealDistrictModel;
  selected: boolean;
  onSelect: () => void;
}) {
  const dot = 'var(--capiro-color-text-faint)';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        selected
          ? 'capiro-intel-district-row capiro-intel-district-row--selected'
          : 'capiro-intel-district-row'
      }
    >
      <span className="capiro-intel-district-dot" style={{ background: dot }} />
      <span className="capiro-intel-district-main">
        <span className="capiro-intel-district-top">
          <span className="capiro-intel-district-code">{d.code}</span>
          <span className="capiro-intel-district-tag">
            {d.facilityNames[0]}
            {d.facilityNames.length > 1 ? ` +${d.facilityNames.length - 1}` : ''}
          </span>
        </span>
        <span className="capiro-intel-district-sub">
          {d.totalAmount != null ? formatMoney(d.totalAmount) : 'Awards unavailable'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
    </button>
  );
}

function V2DistrictRailRow({
  d,
  selected,
  onSelect,
}: {
  d: DistrictNexusDistrictDetail;
  selected: boolean;
  onSelect: () => void;
}) {
  const band: ScoreBand | null = bandOf(d.score);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={
        selected
          ? 'capiro-intel-district-row capiro-intel-district-row--selected'
          : 'capiro-intel-district-row'
      }
    >
      <span
        title={band ? `${band.label} nexus` : 'Unscored'}
        className="capiro-intel-district-dot"
        style={{ background: band?.color ?? 'var(--capiro-color-border-control)' }}
      />
      <span className="capiro-intel-district-main">
        <span className="capiro-intel-district-top">
          <span className="capiro-intel-district-code">{d.districtKey}</span>
          <span className="capiro-intel-district-tag">{band ? band.label : 'Unscored'}</span>
        </span>
        <span className="capiro-intel-district-sub">
          {d.awarded.contractObligations != null || d.awarded.grantObligations != null
            ? `${formatMoney(d.awarded.contractObligations)} contracts · ${formatMoney(d.awarded.grantObligations)} grants`
            : 'No confirmed awards'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
      <span className="capiro-intel-district-score">{d.score ?? '—'}</span>
    </button>
  );
}

function FacilitiesRepresentationCard({
  facilities,
  repByFacilityId,
}: {
  facilities: ClientFacility[];
  repByFacilityId: Map<string, RepresentationResult>;
}) {
  return (
    <Card>
      <CardHead title="Facilities & representation" />
      <div>
        {facilities.length === 0 ? (
          <p
            className="capiro-intel-caption-muted"
            style={{ margin: 0, padding: '18px 24px', fontSize: 14 }}
          >
            No facilities recorded.
          </p>
        ) : (
          facilities.map((facility) => {
            const representation = repByFacilityId.get(facility.id);
            const { label, tone } = facilityStatus(facility, representation);
            const repName =
              representation && !representation.unresolved
                ? representation.federal.house?.fullName
                : null;
            return (
              <div key={facility.id} className="capiro-intel-fac-row">
                <div className="capiro-intel-fac-location">
                  <span className="capiro-intel-fac-name">{facility.name}</span>
                  <FacilityVerification facility={facility} />
                </div>
                <div className="capiro-intel-fac-representation">
                  <span className="capiro-intel-fac-emp">
                    {facility.employeeCount != null
                      ? `${formatNumber(facility.employeeCount)} employees`
                      : 'Employee count not reported'}
                  </span>
                  <span className="capiro-intel-fac-rep">
                    U.S. House representative: {repName ?? 'Not resolved'}
                  </span>
                  <Pill tone={tone}>{label}</Pill>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
