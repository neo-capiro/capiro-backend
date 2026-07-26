import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Popover, Segmented, Skeleton, Tooltip } from 'antd';
import { ClockCircleOutlined, EnvironmentOutlined, WarningOutlined } from '@ant-design/icons';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeatureEnabled } from '../../../lib/intel-feature-flags.js';
import {
  getDistrictBoundaryManifest,
  getDistrictNexusMap,
  type DistrictNexusMapResponse,
} from './district-nexus-api.js';
import { DistrictNexusMap } from './DistrictNexusMap.js';
import { DistrictNexusFilters, type DistrictNexusFilterState } from './DistrictNexusFilters.js';
import { DistrictNexusTable } from './DistrictNexusTable.js';
import { DistrictNexusDrawer } from './DistrictNexusDrawer.js';
import { formatMoney, formatNumber, type ChoroplethMetric } from './district-nexus-format.js';
import './district-nexus.css';

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
 * WS-G — the firm-wide District Nexus map page (plan §3.2, Workstream G).
 *
 * Route is registered unconditionally in App.tsx; this component owns the
 * `district_nexus_v2` gate (HearingWatchPage precedent —
 * apps/web/src/pages/intelligence/HearingWatchPage.tsx:394).
 *
 * Two deliberate scope narrowings vs. the plan's aspirational §3.2/§7-E1
 * surface, both because GET district-nexus/map (WS-E1, as actually shipped)
 * only accepts `view` / `clientId` / `state` and DistrictNexusDistrictSummary
 * carries no per-type evidence flags or agency breakdown:
 *   - No Nexus-type / Agency / Assistance-Listing / Verification-status
 *     filters (DistrictNexusFilters.tsx docblock has the detail).
 *   - No "Findings" insight panel (the prototype's findings need target data
 *     the map-aggregate response doesn't carry).
 * Both need an E1 response enrichment to close — backend work outside WS-G.
 */
export function DistrictNexusPage() {
  const enabled = useIntelFeatureEnabled('district_nexus_v2');
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = readFilters(searchParams);
  const view: 'current' | 'future' = searchParams.get('view') === 'future' ? 'future' : 'current';
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

  const futureManifest = useQuery({
    queryKey: ['district-nexus', 'boundary-manifest', 'F'],
    queryFn: () => getDistrictBoundaryManifest(api, 'F'),
    retry: false,
    staleTime: 5 * 60_000,
    enabled,
  });
  const futureAvailable = Boolean(futureManifest.data && futureManifest.data.districtCount > 0);
  // A stale deep-link (?view=future) from before the artifact existed, or
  // from after it's removed, must not 400 the whole page — clamp silently.
  const effectiveView: 'current' | 'future' = view === 'future' && futureAvailable ? 'future' : 'current';

  const mapQuery = useQuery<DistrictNexusMapResponse>({
    queryKey: ['district-nexus', 'map', effectiveView, filters.clientId, filters.state],
    queryFn: () =>
      getDistrictNexusMap(api, {
        view: effectiveView,
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
      <div className="dn-root" style={{ padding: '22px 32px 40px', minHeight: '100%' }}>
        <PageHead view={view} futureAvailable={false} onViewChange={() => {}} />
        <div className="dn-guide">
          <div className="dn-gico">
            <EnvironmentOutlined />
          </div>
          <h4>District Nexus is not enabled for this organization</h4>
          <p>
            The <span className="dn-mono">district_nexus_v2</span> flag is off for your tenant. The feature fails
            closed on both the web app and the API — the endpoints return 404 rather than an empty result, so
            nothing here can mislead you into thinking you have no district data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="dn-root" style={{ padding: '22px 32px 40px', minHeight: '100%', gap: 14 }}>
      <TopControls mapData={mapQuery.data} />
      <div className="dn-content">
        <PageHead view={view} futureAvailable={futureAvailable} onViewChange={(v) => patchParams({ view: v === 'current' ? null : v, district: null })} />

        {mapQuery.isPending ? <LoadingSkeleton /> : null}

        {mapQuery.isError ? (
          <div className="dn-guide">
            <div className="dn-gico dn-critical">
              <WarningOutlined />
            </div>
            <h4>District Nexus could not load</h4>
            <p>
              The aggregate request failed. This is an error, not an empty result — Capiro will not show a zeroed
              map that reads like "you have no district footprint."
            </p>
            <div className="dn-row">
              <Button type="primary" onClick={() => mapQuery.refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : null}

        {mapQuery.data && allDistricts.length === 0 ? (
          <div className="dn-guide">
            <div className="dn-gico">
              <EnvironmentOutlined />
            </div>
            <h4>No client has a resolvable district yet</h4>
            <p>
              District Nexus builds on client facilities and confirmed award mappings. Add facility addresses to a
              client, or confirm a contractor / assistance-recipient mapping, and districts appear here.
            </p>
          </div>
        ) : null}

        {mapQuery.data && allDistricts.length > 0 ? (
          <>
            <KpiStrip districts={filteredDistricts} unmapped={mapQuery.data.unmapped} />
            <DistrictNexusFilters
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
            <div className="dn-split">
              <div className="dn-mapcard">
                <DistrictNexusMap
                  districts={filteredDistricts}
                  metric={filters.metric}
                  view={effectiveView}
                  selectedDistrictKey={selectedDistrictKey}
                  onSelectDistrict={(key) => patchParams({ district: key })}
                  showFacilities={showFacilities}
                  onShowFacilitiesChange={(value) => patchParams({ facilities: value ? null : 'off' })}
                  fitToken={filters.clientId}
                />
              </div>
              <div className="dn-rail">
                <div className="dn-lhead">
                  <span className="dn-t">
                    Districts <span className="dn-c">{filteredDistricts.length}</span>
                  </span>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <DistrictNexusTable
                    districts={filteredDistricts}
                    selectedDistrictKey={selectedDistrictKey}
                    onSelectDistrict={(key) => patchParams({ district: key })}
                    compact
                  />
                </div>
                {mapQuery.data.unmapped.unmappedContractAmount || mapQuery.data.unmapped.unmappedGrantAmount ? (
                  <button type="button" className="dn-rfoot">
                    <span style={{ color: 'var(--notable)', display: 'grid', placeItems: 'center' }}>
                      <WarningOutlined />
                    </span>
                    <span className="dn-tt">
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
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <DistrictNexusDrawer
        districtKey={selectedDistrictKey}
        clientId={filters.clientId}
        boundaryVintage={futureManifest.data?.vintage}
        onClose={() => patchParams({ district: null })}
      />
    </div>
  );
}

function PageHead({
  view,
  futureAvailable,
  onViewChange,
}: {
  view: 'current' | 'future';
  futureAvailable: boolean;
  onViewChange: (view: 'current' | 'future') => void;
}) {
  return (
    <div className="dn-pg-head">
      <div>
        <h1 className="dn-pg-title">District Nexus</h1>
        <p className="dn-pg-desc">Verified client footprint, public funding, and representation by congressional district.</p>
      </div>
      <div className="dn-acts">
        <Tooltip title={futureAvailable ? undefined : 'No enacted-future boundary artifact has been built yet.'}>
          <Segmented<'current' | 'future'>
            value={view}
            onChange={onViewChange}
            options={[
              { label: 'Current · 119th', value: 'current' },
              { label: 'Enacted future', value: 'future', disabled: !futureAvailable },
            ]}
          />
        </Tooltip>
      </div>
    </div>
  );
}

function TopControls({ mapData }: { mapData: DistrictNexusMapResponse | undefined }) {
  const warningCount = mapData?.warnings.length ?? 0;
  const freshnessCount = mapData?.freshness.length ?? 0;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      {mapData ? (
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <div style={{ maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="dn-lt">Source freshness — SyncRun watermarks</div>
              {mapData.freshness.map((f) => (
                <div key={f.source} style={{ fontSize: 12.5 }}>
                  <div>{f.label}</div>
                  <div className="dn-mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                    {f.freshnessUnavailable
                      ? 'freshness unknown'
                      : f.neverSynced
                        ? 'never synced'
                        : new Date(f.lastSyncedAt!).toLocaleString('en-US')}
                  </div>
                </div>
              ))}
            </div>
          }
        >
          <Badge count={freshnessCount} size="small" color="blue">
            <Button icon={<ClockCircleOutlined />}>Freshness</Button>
          </Badge>
        </Popover>
      ) : null}
      {mapData && warningCount > 0 ? (
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <div style={{ maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="dn-lt">Data quality — whole footprint</div>
              {mapData.warnings.map((w, i) => (
                <Alert key={i} type="warning" showIcon message={w.message} />
              ))}
            </div>
          }
        >
          <Badge count={warningCount} size="small">
            <Button icon={<WarningOutlined />}>Data quality</Button>
          </Badge>
        </Popover>
      ) : null}
    </div>
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
  const employees = districts.reduce((sum, d) => sum + (d.employeeCount ?? 0), 0);
  const employeesUnreportedCount = districts.filter((d) => d.employeesUnreported).length;
  const contracts = districts.reduce((sum, d) => sum + (d.awarded.contractObligations ?? 0), 0);
  const grants = districts.reduce((sum, d) => sum + (d.awarded.grantObligations ?? 0), 0);
  const outlays = districts.reduce((sum, d) => sum + (d.awarded.grantOutlays ?? 0), 0);
  const opportunityEst = districts.reduce((sum, d) => sum + (d.opportunities.opportunityEstimatedFunding ?? 0), 0);

  return (
    <div className="dn-kpis">
      <div className="dn-kgrp">
        <div className="dn-kpi">
          <div className="dn-k">Districts</div>
          <div className="dn-v">{districts.length}</div>
          <div className="dn-s">
            {states} state{states === 1 ? '' : 's'}
          </div>
        </div>
        <div className="dn-kpi">
          <div className="dn-k">Employees</div>
          <div className="dn-v">{formatNumber(employees || null)}</div>
          <div className="dn-s">
            {employeesUnreportedCount ? (
              <b>
                {employeesUnreportedCount} district{employeesUnreportedCount > 1 ? 's' : ''} not fully reported
              </b>
            ) : (
              'reported where recorded'
            )}
          </div>
        </div>
        <div className="dn-kpi">
          <div className="dn-k">Contracts</div>
          <div className="dn-v">{formatMoney(contracts)}</div>
          <div className="dn-s">
            DoD prime{unmapped.unmappedContractAmount ? <> · <b>{formatMoney(unmapped.unmappedContractAmount)} unplaced</b></> : ''}
          </div>
        </div>
        <div className="dn-kpi">
          <div className="dn-k">Grants</div>
          <div className="dn-v">{formatMoney(grants)}</div>
          <div className="dn-s">
            {formatMoney(outlays)} outlaid
            {unmapped.unmappedGrantAmount ? <> · <b>{formatMoney(unmapped.unmappedGrantAmount)} unplaced</b></> : ''}
          </div>
        </div>
      </div>
      <div className="dn-kgrp dn-opp" title="Opportunities are never added to awarded-dollar totals">
        <div className="dn-kpi">
          <div className="dn-k">Opportunities · not awarded</div>
          <div className="dn-v">{formatMoney(opportunityEst, 0)}</div>
          <div className="dn-s">est. program funding</div>
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="dn-content">
      <div className="dn-kpis">
        <div className="dn-kgrp" style={{ padding: 16 }}>
          <Skeleton active paragraph={{ rows: 1 }} />
        </div>
      </div>
      <div className="dn-split">
        <div className="dn-mapcard">
          <Skeleton.Node active style={{ width: '100%', height: '100%' }} />
        </div>
        <div className="dn-rail" style={{ padding: 14 }}>
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      </div>
    </div>
  );
}
