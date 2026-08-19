import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { CapiroPopover, CapiroTooltip } from '../../components/menus/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../../lib/intel-feature-flags.js';
import {
  getDistrictBoundaryManifest,
  getDistrictNexusMap,
  type DistrictNexusMapResponse,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import { formatMoney, formatNumber, type ChoroplethMetric } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import { DistrictNexusMapVNext } from './DistrictNexusMapVNext.js';
import { DistrictNexusFiltersVNext, type DistrictNexusFilterState } from './DistrictNexusFiltersVNext.js';
import { DistrictNexusTableVNext } from './DistrictNexusTableVNext.js';
import { DistrictNexusDrawerVNext } from './DistrictNexusDrawerVNext.js';
import { DnxClockIcon, DnxWarningIcon } from './icons.js';
import './district-nexus-vnext.css';

const METRIC_VALUES: ChoroplethMetric[] = ['nexus', 'contracts', 'grants', 'employees', 'clients', 'coverage'];

function readFilters(searchParams: URLSearchParams): DistrictNexusFilterState {
  const metric = searchParams.get('metric');
  return {
    clientId: searchParams.get('clientId'),
    state: searchParams.get('state'),
    metric: METRIC_VALUES.includes(metric as ChoroplethMetric) ? (metric as ChoroplethMetric) : 'nexus',
    minAmount: Number(searchParams.get('minAmount')) || 0,
  };
}

/**
 * vNext port of the canonical DistrictNexusPage (WS-G — the firm-wide
 * District Nexus map page, plan §3.2). Identical endpoints, query keys,
 * filters, URL contract (?clientId/state/metric/minAmount/district/
 * facilities) and honest-state rules; presentation is native vNext
 * (Untitled UI tokens + Capiro primitives).
 *
 * The map remains a scan surface. One district's deeper federal-market
 * context lives in DistrictNexusDrawerVNext, keeping the default screen calm
 * and avoiding a second dashboard below the map.
 */
export function DistrictNexusPageVNext() {
  const enabled = useIntelFeatureEnabled('district_nexus_v2');
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = readFilters(searchParams);
  const view = 'current' as const;
  const selectedDistrictKey = searchParams.get('district');
  const showFacilities = searchParams.get('facilities') !== 'off';

  function patchParams(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '' || value === '0') next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }

  useEffect(() => {
    if (searchParams.get('view') != null) patchParams({ view: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get('view')]);

  const currentManifest = useQuery({
    queryKey: ['district-nexus', 'boundary-manifest', 'C'],
    queryFn: () => getDistrictBoundaryManifest(api, 'C'),
    retry: false,
    staleTime: 5 * 60_000,
    enabled,
  });

  const mapQuery = useQuery<DistrictNexusMapResponse>({
    queryKey: ['district-nexus', 'map', 'current', filters.clientId, filters.state],
    queryFn: () =>
      getDistrictNexusMap(api, {
        view: 'current',
        clientId: filters.clientId ?? undefined,
        state: filters.state ?? undefined,
      }),
    enabled,
    retry: false,
  });

  const allDistricts = mapQuery.data?.districts ?? [];
  const filteredDistricts = useMemo(
    () =>
      allDistricts.filter(
        (d) => (d.awarded.contractObligations ?? 0) + (d.awarded.grantObligations ?? 0) >= filters.minAmount,
      ),
    [allDistricts, filters.minAmount],
  );

  if (!enabled) {
    return (
      <div className="dnx">
        <PageHero mapData={undefined} />
        <div className="dnx-canvas">
          <div className="dnx-guide">
            <CapiroEmptyState
              title="District Nexus is not enabled for this organization"
              description="The district_nexus_v2 flag is off for your tenant. The feature fails closed on both the web app and the API — the endpoints return 404 rather than an empty result, so nothing here can mislead you into thinking you have no district data."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dnx">
      <PageHero mapData={mapQuery.data} />
      <div className="dnx-canvas">
        {mapQuery.isPending ? <LoadingSkeleton /> : null}

        {mapQuery.isError ? (
          <div className="dnx-guide">
            <CapiroErrorState
              title="District Nexus could not load"
              description={
                'The aggregate request failed. This is an error, not an empty result — Capiro will not show a zeroed map that reads like "you have no district footprint."'
              }
              onRetry={() => void mapQuery.refetch()}
              retryLabel="Retry"
            />
          </div>
        ) : null}

        {mapQuery.data && allDistricts.length === 0 ? (
          <div className="dnx-guide">
            <CapiroEmptyState
              title="No client has a resolvable district yet"
              description="District Nexus builds on client facilities and confirmed award mappings. Add facility addresses to a client, or confirm a contractor / assistance-recipient mapping, and districts appear here."
            />
          </div>
        ) : null}

        {mapQuery.data && allDistricts.length > 0 ? (
          <>
            <KpiStrip districts={filteredDistricts} unmapped={mapQuery.data.unmapped} />
            <DistrictNexusFiltersVNext
              value={filters}
              onChange={(next) =>
                patchParams({
                  clientId: next.clientId,
                  state: next.state,
                  metric: next.metric === 'nexus' ? null : next.metric,
                  minAmount: next.minAmount ? String(next.minAmount) : null,
                })
              }
              resultCount={filteredDistricts.length}
            />
            <div className="dnx-split">
              <div className="dnx-mapcard">
                <DistrictNexusMapVNext
                  districts={filteredDistricts}
                  metric={filters.metric}
                  view={view}
                  selectedDistrictKey={selectedDistrictKey}
                  onSelectDistrict={(key) => patchParams({ district: key })}
                  showFacilities={showFacilities}
                  onShowFacilitiesChange={(value) => patchParams({ facilities: value ? null : 'off' })}
                  fitToken={filters.clientId}
                />
              </div>
              <div className="dnx-rail">
                <div className="dnx-lhead">
                  <span className="dnx-lt">
                    Districts <span className="dnx-lc">{filteredDistricts.length}</span>
                  </span>
                </div>
                <div className="dnx-rail-scroll">
                  <DistrictNexusTableVNext
                    districts={filteredDistricts}
                    selectedDistrictKey={selectedDistrictKey}
                    onSelectDistrict={(key) => patchParams({ district: key })}
                    compact
                  />
                </div>
                {mapQuery.data.unmapped.unmappedContractAmount || mapQuery.data.unmapped.unmappedGrantAmount ? (
                  <div className="dnx-rfoot">
                    <span className="dnx-rfoot-ico">
                      <DnxWarningIcon />
                    </span>
                    <span className="dnx-rfoot-tt">
                      Unplaced funding{' '}
                      <b>
                        {formatMoney(
                          (mapQuery.data.unmapped.unmappedContractAmount ?? 0) +
                            (mapQuery.data.unmapped.unmappedGrantAmount ?? 0),
                        )}
                      </b>{' '}
                      · {formatMoney(mapQuery.data.unmapped.unmappedContractAmount)} contracts,{' '}
                      {formatMoney(mapQuery.data.unmapped.unmappedGrantAmount)} grants
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <DistrictNexusDrawerVNext
        districtKey={selectedDistrictKey}
        clientId={filters.clientId}
        boundaryVintage={currentManifest.data?.vintage}
        onClose={() => patchParams({ district: null })}
      />
    </div>
  );
}

function PageHero({ mapData }: { mapData: DistrictNexusMapResponse | undefined }) {
  return (
    <div className="dnx-hero">
      <div className="dnx-hero-copy">
        <h1 className="dnx-title">District Nexus</h1>
        <p className="dnx-desc">Verified client footprint, public funding, and representation by congressional district.</p>
      </div>
      <div className="dnx-acts">
        <TopControls mapData={mapData} />
        <CapiroTooltip content="Award geography is reported against current districts, so a future-boundary view cannot be produced without re-attributing money that was never reported that way.">
          <CapiroBadge tone="info" dot>
            Current · 119th Congress
          </CapiroBadge>
        </CapiroTooltip>
      </div>
    </div>
  );
}

function TopControls({ mapData }: { mapData: DistrictNexusMapResponse | undefined }) {
  const warningCount = mapData?.warnings.length ?? 0;
  const freshnessCount = mapData?.freshness.length ?? 0;
  return (
    <>
      {mapData ? (
        <CapiroPopover
          label="Source freshness"
          trigger={
            <>
              <DnxClockIcon />
              Freshness
              <CapiroBadge tone="info">{freshnessCount}</CapiroBadge>
            </>
          }
        >
          <div className="dnx-pop">
            <div className="dnx-pop-title">Source freshness — SyncRun watermarks</div>
            {mapData.freshness.map((f) => (
              <div key={f.source} className="dnx-pop-row">
                <div>{f.label}</div>
                <div className="dnx-mono dnx-pop-sub">
                  {f.freshnessUnavailable
                    ? 'freshness unknown'
                    : f.neverSynced
                      ? 'never synced'
                      : new Date(f.lastSyncedAt!).toLocaleString('en-US')}
                </div>
              </div>
            ))}
          </div>
        </CapiroPopover>
      ) : null}
      {mapData && warningCount > 0 ? (
        <CapiroPopover
          label="Data quality"
          trigger={
            <>
              <DnxWarningIcon />
              Data quality
              <CapiroBadge tone="warning">{warningCount}</CapiroBadge>
            </>
          }
        >
          <div className="dnx-pop">
            <div className="dnx-pop-title">Data quality — whole footprint</div>
            {mapData.warnings.map((w, i) => (
              <div key={i} className="dnx-hint dnx-notable">
                <span className="dnx-hico">
                  <DnxWarningIcon />
                </span>
                <div>{w.message}</div>
              </div>
            ))}
          </div>
        </CapiroPopover>
      ) : null}
    </>
  );
}

function KpiStrip({
  districts,
  unmapped,
}: {
  districts: DistrictNexusMapResponse['districts'];
  unmapped: DistrictNexusMapResponse['unmapped'];
}) {
  const states = new Set(districts.map((d) => d.state)).size;

  const sumOrNull = (pick: (d: DistrictNexusMapResponse['districts'][number]) => number | null) => {
    let total = 0;
    let sawValue = false;
    for (const d of districts) {
      const v = pick(d);
      if (v == null) continue;
      total += v;
      sawValue = true;
    }
    return sawValue ? total : null;
  };

  const employees = sumOrNull((d) => d.employeeCount);
  const employeesUnreportedCount = districts.filter((d) => d.employeesUnreported).length;
  const contracts = sumOrNull((d) => d.awarded.contractObligations);
  const grants = sumOrNull((d) => d.awarded.grantObligations);
  const outlays = sumOrNull((d) => d.awarded.grantOutlays);

  return (
    <div className="dnx-kpis">
      <div className="dnx-kgrp">
        <div className="dnx-kpi">
          <div className="dnx-k">Districts</div>
          <div className="dnx-v">{districts.length}</div>
          <div className="dnx-s">
            {states} state{states === 1 ? '' : 's'}
          </div>
        </div>
        <div className="dnx-kpi">
          <div className="dnx-k">Employees</div>
          <div className="dnx-v">{formatNumber(employees)}</div>
          <div className="dnx-s">
            {employeesUnreportedCount ? (
              <b>
                {employeesUnreportedCount} district{employeesUnreportedCount > 1 ? 's' : ''} not fully reported
              </b>
            ) : (
              'reported where recorded'
            )}
          </div>
        </div>
        <div className="dnx-kpi">
          <div className="dnx-k">Contracts</div>
          <div className="dnx-v">{formatMoney(contracts)}</div>
          <div className="dnx-s">
            DoD prime{unmapped.unmappedContractAmount ? <> · <b>{formatMoney(unmapped.unmappedContractAmount)} unplaced</b></> : ''}
          </div>
        </div>
        <div className="dnx-kpi">
          <div className="dnx-k">Grants</div>
          <div className="dnx-v">{formatMoney(grants)}</div>
          <div className="dnx-s">
            {formatMoney(outlays)} outlaid
            {unmapped.unmappedGrantAmount ? <> · <b>{formatMoney(unmapped.unmappedGrantAmount)} unplaced</b></> : ''}
          </div>
        </div>
      </div>
      <div className="dnx-kgrp dnx-opp" title="Opportunities are never added to awarded-dollar totals">
        <div className="dnx-kpi">
          <div className="dnx-k">Opportunities · not awarded</div>
          <div className="dnx-v">—</div>
          <div className="dnx-s">per-client only · see a client profile</div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="dnx-loading" aria-busy="true">
      <div className="dnx-kpis">
        <div className="dnx-kgrp dnx-kgrp-loading">
          <CapiroSkeleton height={18} width="34%" />
          <CapiroSkeleton height={14} width="55%" />
        </div>
      </div>
      <div className="dnx-split">
        <div className="dnx-mapcard dnx-mapcard-loading">
          <CapiroSkeleton width="100%" height={420} />
        </div>
        <div className="dnx-rail dnx-rail-loading">
          {Array.from({ length: 8 }, (_, i) => (
            <CapiroSkeleton key={i} height={14} width={i % 2 ? '82%' : '100%'} />
          ))}
        </div>
      </div>
    </div>
  );
}
