import { CapiroPopover } from '../../components/menus/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { DistrictNexusMapLibre } from '../../components/district-map/DistrictNexusMapLibre.js';
import type { DistrictNexusDistrictSummary } from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import type { ChoroplethMetric } from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import { DistrictNexusTableVNext } from './DistrictNexusTableVNext.js';
import { DnxLayersIcon, DnxWarningIcon } from './icons.js';

interface Props {
  districts: DistrictNexusDistrictSummary[];
  metric: ChoroplethMetric;
  view: 'current' | 'future';
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
  showFacilities: boolean;
  onShowFacilitiesChange: (value: boolean) => void;
  /** Changes trigger a fit-to-footprint (or CONUS when null); the value
   * itself is opaque, only identity/change matters. */
  fitToken: string | null;
}

/**
 * vNext port of the canonical DistrictNexusMap (WS-G Step G3): the shared
 * GPU-rendered MapLibre choropleth (components/district-map) dressed with this
 * page's behaviors — URL-controlled facilities layer behind a layers popover,
 * footprint-vs-CONUS fit driven by the client filter, and the §8.6 fallback:
 * DistrictNexusTableVNext, never a blank canvas, when the artifact is missing
 * or WebGL is unavailable — both real, reachable states today.
 */
export function DistrictNexusMapVNext({
  districts,
  metric,
  view,
  selectedDistrictKey,
  onSelectDistrict,
  showFacilities,
  onShowFacilitiesChange,
  fitToken,
}: Props) {
  return (
    <DistrictNexusMapLibre
      districts={districts}
      metric={metric}
      view={view}
      selectedDistrictKey={selectedDistrictKey}
      onSelectDistrict={onSelectDistrict}
      showFacilities={showFacilities}
      onShowFacilitiesChange={onShowFacilitiesChange}
      fit={{ token: fitToken }}
      layersSlot={
        <span className="dnx-layers">
          <CapiroPopover
            label="Map layers"
            trigger={
              <>
                <DnxLayersIcon />
                <span className="dnx-vh">Map layers</span>
              </>
            }
          >
            <label className="dnx-check">
              <input
                type="checkbox"
                checked={showFacilities}
                onChange={(e) => onShowFacilitiesChange(e.target.checked)}
              />
              Districts with client facilities
            </label>
          </CapiroPopover>
        </span>
      }
      renderUnavailable={(reason) => (
        <div className="dnx-boundary-fail">
          <div className="dnx-hint dnx-notable dnx-hint-flush">
            <span className="dnx-hico">
              <DnxWarningIcon />
            </span>
            <div>
              <b>Boundary map unavailable.</b>{' '}
              {reason === 'webgl'
                ? 'WebGL is unavailable in this browser session.'
                : 'The boundary artifact could not be loaded.'}{' '}
              Every number, filter and district below is unaffected — the map is a view of this data, not its source.
            </div>
          </div>
          <div className="dnx-fail-table">
            <DistrictNexusTableVNext
              districts={districts}
              selectedDistrictKey={selectedDistrictKey}
              onSelectDistrict={onSelectDistrict}
              compact
            />
          </div>
        </div>
      )}
      loadingFallback={
        <div className="dnx-map-loading" aria-busy="true" aria-label="Loading district boundaries">
          <CapiroSkeleton width="100%" height={420} />
        </div>
      }
    />
  );
}
