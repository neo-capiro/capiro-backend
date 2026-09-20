import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClientFacility } from '../../../pages/clients/facilities-api.js';
import { useQuery } from '@tanstack/react-query';
import {
  Map as MaplibreMap,
  Source,
  Layer,
  type MapLayerMouseEvent,
  type MapRef,
} from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useApi } from '../../../lib/use-api.js';
import { mapStyleUrl, mapStyleAttribution } from '../../../env.js';
import {
  getDistrictBoundaryGeoJson,
  getDistrictBoundaryManifest,
  type BoundaryFeatureCollection,
  type DistrictNexusDistrictSummary,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import {
  CHOROPLETH_RAMP,
  METRIC_SCALES,
  NO_NEXUS_FILL,
  type ChoroplethMetric,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import {
  buildFacilityPoints,
  buildStyledBoundaryGeoJson,
  computeFootprintBounds,
  districtKeyFromFeature,
  hasClientFootprint,
} from './district-map-model.js';
import './district-map.css';

/**
 * The SHARED vNext district map: MapLibre choropleth over the key-free Census
 * boundary artifact, carrying the same map key and details as the canonical
 * District Nexus module (`pages/intelligence/district-nexus`): the six-step
 * nexus-strength ramp with its scale ticks, the "No verified nexus" swatch,
 * the hover card (district key + score), the AK/HI/PR jump controls, and the
 * Boundaries/Census attribution line.
 *
 * Two vNext surfaces consume it:
 *  - the Client CRM Intelligence tab (its original home, PR #1034) — default
 *    props reproduce that usage exactly: 'nexus' metric, fit-to-footprint on
 *    load, an internal Facilities toggle, plain note fallbacks;
 *  - the native District Nexus page (`vnext/pages/district-nexus`), which
 *    passes a metric, URL-controlled facilities state, footprint-vs-CONUS fit
 *    semantics, and its own unavailable/loading fallbacks.
 *
 * Always loaded via `React.lazy` so the WebGL engine stays out of eager
 * chunks (see `bundle-boundaries.test.ts` for why that matters). Query keys
 * for the boundary manifest/geojson are identical to the canonical page's, so
 * the ~5MB artifact is fetched once per session across every surface.
 *
 * Presentation is antd-free; chrome is plain elements styled by
 * `district-map.css` (`.cap-pf-dn-*` — class names kept from the component's
 * client-crm origin so that surface's visuals are byte-identical).
 */

// Bounds are [lng, lat] pairs (MapLibre order), converted from the
// prototype's Leaflet [lat, lng] fit targets.
const CONUS_BOUNDS: [[number, number], [number, number]] = [
  [-125.2, 24.4],
  [-66.8, 49.6],
];
const REGION_BOUNDS: Record<'AK' | 'HI' | 'PR', [[number, number], [number, number]]> = {
  AK: [
    [-170, 51],
    [-129, 71.5],
  ],
  HI: [
    [-160.4, 18.6],
    [-154.6, 22.4],
  ],
  PR: [
    [-67.4, 17.8],
    [-65.2, 18.6],
  ],
};

let webglSupportCache: boolean | null = null;

function supportsWebGL(): boolean {
  if (webglSupportCache != null) return webglSupportCache;
  try {
    const canvas = document.createElement('canvas');
    webglSupportCache = Boolean(
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl'),
    );
  } catch {
    webglSupportCache = false;
  }
  return webglSupportCache;
}

export type DistrictMapUnavailableReason = 'webgl' | 'artifact';

export interface DistrictNexusMapLibreProps {
  districts: DistrictNexusDistrictSummary[];
  /** Tenant-scoped saved locations. Omitted on the aggregate district view. */
  facilities?: Pick<
    ClientFacility,
    'id' | 'name' | 'state' | 'congressionalDistrict' | 'latitude' | 'longitude' | 'employeeCount'
  >[];
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
  /** Choropleth colour metric. Defaults to nexus strength. */
  metric?: ChoroplethMetric;
  /** Boundary vintage. Only 'current' has an artifact today ('future' 400s —
   * see DistrictNexusMapQuery in district-nexus-api.ts). */
  view?: 'current' | 'future';
  onHoverDistrict?: (districtKey: string | null) => void;
  /** Controlled facilities-layer state. When BOTH this and
   * `onShowFacilitiesChange` are provided the component never manages its own
   * state; when omitted, an internal toggle (default on) drives the layer. */
  showFacilities?: boolean;
  onShowFacilitiesChange?: (value: boolean) => void;
  /**
   * 'footprint' (default): fit the districts' footprint once loaded — the
   * client-profile behavior, where the district set IS the client's footprint.
   * `{ token }`: the District Nexus page behavior — footprint when the token
   * is truthy (a client filter is applied), CONUS otherwise; refits whenever
   * the token changes. The token value is opaque; only identity matters.
   */
  fit?: 'footprint' | { token: string | null };
  /** Custom unavailable state (WebGL off / artifact missing / render error).
   * The default is a plain note; the District Nexus page substitutes a
   * warning banner plus its district table (§8.6 — never a blank canvas). */
  renderUnavailable?: (reason: DistrictMapUnavailableReason) => ReactNode;
  /** Custom loading state while the manifest/geojson queries are pending. */
  loadingFallback?: ReactNode;
  /** Custom node for the top-right control group (e.g. a layers popover).
   * Suppresses the built-in Facilities toggle button. */
  layersSlot?: ReactNode;
}

export function DistrictNexusMapLibre({
  districts,
  facilities,
  selectedDistrictKey,
  onSelectDistrict,
  metric = 'nexus',
  view = 'current',
  onHoverDistrict,
  showFacilities: showFacilitiesProp,
  onShowFacilitiesChange,
  fit = 'footprint',
  renderUnavailable,
  loadingFallback,
  layersSlot,
}: DistrictNexusMapLibreProps) {
  const api = useApi();
  const mapRef = useRef<MapRef | null>(null);
  const [hover, setHover] = useState<{
    key: string;
    x: number;
    y: number;
    facilityName?: string;
  } | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [internalShowFacilities, setInternalShowFacilities] = useState(true);
  const webglOk = useMemo(supportsWebGL, []);
  const statusParam = view === 'future' ? 'F' : 'C';

  const facilitiesControlled = showFacilitiesProp != null;
  const showFacilities = facilitiesControlled ? showFacilitiesProp : internalShowFacilities;
  const setShowFacilities = (value: boolean) => {
    if (facilitiesControlled) onShowFacilitiesChange?.(value);
    else setInternalShowFacilities(value);
  };

  const manifest = useQuery({
    queryKey: ['district-nexus', 'boundary-manifest', statusParam],
    queryFn: () => getDistrictBoundaryManifest(api, statusParam),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: webglOk,
  });
  const geojson = useQuery<BoundaryFeatureCollection>({
    queryKey: ['district-nexus', 'boundary-geojson', statusParam],
    queryFn: () => getDistrictBoundaryGeoJson(api, statusParam),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: webglOk,
  });

  const byKey = useMemo(() => new Map(districts.map((d) => [d.districtKey, d])), [districts]);

  const styledGeojson = useMemo<BoundaryFeatureCollection | null>(
    () => (geojson.data ? buildStyledBoundaryGeoJson(geojson.data, byKey, metric) : null),
    [geojson.data, byKey, metric],
  );

  /**
   * Client profiles supply saved coordinates, including locations without an
   * employee count or resolved district. The firm aggregate view instead uses
   * district centers and labels that layer explicitly as district aggregates.
   */
  const facilityPoints = useMemo(
    () => buildFacilityPoints(facilities, geojson.data, byKey),
    [facilities, geojson.data, byKey],
  );

  const fitToFootprint = useCallback(() => {
    const map = mapRef.current;
    if (!map || !geojson.data) return;
    const bounds = computeFootprintBounds(
      geojson.data,
      byKey,
      facilityPoints,
      facilities !== undefined,
    );
    if (!bounds) {
      map.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false });
      return;
    }
    map.fitBounds(bounds, { padding: 48, maxZoom: 6.5, animate: false });
  }, [geojson.data, byKey, facilities, facilityPoints]);

  // Re-fit whenever the map finishes loading, the artifact arrives, or (in
  // token mode) the caller's fit token changes: footprint when a client scope
  // exists, CONUS otherwise. In 'footprint' mode the token is a constant
  // undefined, so this fires exactly like the original client-profile effect.
  const fitToken = typeof fit === 'object' ? fit.token : undefined;
  useEffect(() => {
    if (!loaded || !mapRef.current || !geojson.data) return;
    if (typeof fit === 'object' && !fit.token) {
      mapRef.current.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false });
      return;
    }
    fitToFootprint();
  }, [fitToken, loaded, fitToFootprint]);

  // Selected-district outline via feature-state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    districts.forEach((d) => {
      map.setFeatureState(
        { source: 'pfdn-districts', id: d.districtKey },
        { selected: d.districtKey === selectedDistrictKey },
      );
    });
  }, [selectedDistrictKey, districts, loaded]);

  if (!webglOk || geojson.isError || renderError) {
    const reason: DistrictMapUnavailableReason = !webglOk ? 'webgl' : 'artifact';
    if (renderUnavailable) return <>{renderUnavailable(reason)}</>;
    return (
      <div className="cap-pf-dn-fail" role="note">
        <b>Boundary map unavailable.</b>{' '}
        {reason === 'webgl'
          ? 'WebGL is unavailable in this browser session.'
          : 'The boundary artifact could not be loaded.'}{' '}
        The district list beside the map carries every number shown here.
      </div>
    );
  }

  if (geojson.isPending || manifest.isPending) {
    if (loadingFallback) return <>{loadingFallback}</>;
    return (
      <div
        className="cap-pf-dn-loading"
        aria-busy="true"
        aria-label="Loading district boundaries"
      />
    );
  }

  const hoveredDistrict = hover ? byKey.get(hover.key) : undefined;
  const scale = METRIC_SCALES[metric];

  return (
    <div className="cap-pf-dn-root">
      <MaplibreMap
        ref={mapRef}
        mapStyle={mapStyleUrl}
        initialViewState={{ bounds: CONUS_BOUNDS, fitBoundsOptions: { padding: 24 } }}
        interactiveLayerIds={[
          'pfdn-district-fill',
          ...(showFacilities && facilityPoints.features.length ? ['pfdn-facility-points'] : []),
        ]}
        cursor={hover ? 'pointer' : 'grab'}
        onLoad={() => setLoaded(true)}
        onError={() => setRenderError(true)}
        onMouseMove={(e: MapLayerMouseEvent) => {
          const feature = e.features?.[0];
          if (!feature) {
            if (hover) setHover(null);
            onHoverDistrict?.(null);
            return;
          }
          const key = districtKeyFromFeature(feature) ?? '';
          setHover({
            key,
            x: e.point.x,
            y: e.point.y,
            facilityName: feature.properties?.facilityName,
          });
          onHoverDistrict?.(key);
        }}
        onMouseLeave={() => {
          setHover(null);
          onHoverDistrict?.(null);
        }}
        onClick={(e: MapLayerMouseEvent) => {
          const key = districtKeyFromFeature(e.features?.[0]);
          // Any boundary is selectable — zero-nexus seats open the public-intel
          // drawer. Requiring byKey hid the entire non-footprint map.
          if (key) onSelectDistrict(key);
        }}
      >
        {styledGeojson ? (
          <Source id="pfdn-districts" type="geojson" data={styledGeojson} promoteId="__districtKey">
            <Layer
              id="pfdn-district-fill"
              type="fill"
              paint={{ 'fill-color': ['get', '__color'], 'fill-opacity': 0.96 }}
            />
            <Layer
              id="pfdn-district-outline"
              type="line"
              paint={{
                'line-color': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false],
                  '#1a3f9f',
                  '#12306e',
                ],
                'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.6, 0.6],
                'line-opacity': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false],
                  1,
                  0.42,
                ],
              }}
            />
          </Source>
        ) : null}
        {showFacilities && facilityPoints.features.length ? (
          <Source id="pfdn-facilities" type="geojson" data={facilityPoints}>
            <Layer
              id="pfdn-facility-points"
              type="circle"
              paint={{
                'circle-radius': ['get', 'radius'],
                'circle-color': '#ffffff',
                'circle-stroke-color': '#1a3f9f',
                'circle-stroke-width': 2,
              }}
            />
          </Source>
        ) : null}
      </MaplibreMap>

      {hover ? (
        <div
          className="cap-pf-dn-hovcard"
          style={{ left: Math.max(4, hover.x + 14), top: Math.max(4, hover.y + 14) }}
        >
          <div className="cap-pf-dn-hk">{hover.facilityName ?? hover.key}</div>
          {hover.facilityName ? <div>{hover.key || 'District not resolved'}</div> : null}
          <div className="cap-pf-dn-hr">
            <span>Nexus</span>
            <b>
              {hasClientFootprint(hoveredDistrict)
                ? (hoveredDistrict.score ?? 'unscored')
                : 'no verified footprint'}
            </b>
          </div>
        </div>
      ) : null}

      <div className="cap-pf-dn-ctl cap-pf-dn-tl">
        <button type="button" onClick={fitToFootprint}>
          Fit footprint
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false })}
        >
          CONUS
        </button>
        {(['AK', 'HI', 'PR'] as const).map((region) => (
          <button
            key={region}
            type="button"
            onClick={() =>
              mapRef.current?.fitBounds(REGION_BOUNDS[region], { padding: 20, animate: false })
            }
          >
            {region}
          </button>
        ))}
      </div>
      <div className="cap-pf-dn-ctl cap-pf-dn-tr">
        <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          −
        </button>
        {layersSlot ??
          (facilityPoints.features.length ? (
            <button
              type="button"
              aria-pressed={showFacilities}
              title={
                facilities
                  ? 'Saved facility locations'
                  : 'Districts with client facilities · sized by employees'
              }
              onClick={() => setShowFacilities(!showFacilities)}
            >
              Facilities
            </button>
          ) : null)}
      </div>

      <div className="cap-pf-dn-legend">
        <div className="cap-pf-dn-lt">{scale.label}</div>
        <div className="cap-pf-dn-ramp">
          {CHOROPLETH_RAMP.map((color) => (
            <i key={color} style={{ background: color }} />
          ))}
        </div>
        <div className="cap-pf-dn-sc">
          {scale.ticks.map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
        <div className="cap-pf-dn-ex">
          <span className="cap-pf-dn-sw" style={{ background: NO_NEXUS_FILL }} />
          No verified nexus
        </div>
        {showFacilities ? (
          <div className="cap-pf-dn-ex">
            <span
              className="cap-pf-dn-sw"
              style={{ borderRadius: '50%', background: '#fff', border: '2px solid #1a3f9f' }}
            />
            {facilities
              ? `${facilityPoints.features.length} mapped location${facilityPoints.features.length === 1 ? '' : 's'}`
              : 'Districts with client facilities · sized by employees'}
          </div>
        ) : null}
      </div>
      <div className="cap-pf-dn-attrib">
        Boundaries · {mapStyleAttribution} · U.S. Census Bureau
        {manifest.data ? `, ${manifest.data.vintage}th Congress` : ''}
      </div>
    </div>
  );
}

export default DistrictNexusMapLibre;
