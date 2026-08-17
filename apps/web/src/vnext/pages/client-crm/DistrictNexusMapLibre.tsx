import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Map as MaplibreMap, Source, Layer, type MapLayerMouseEvent, type MapRef } from '@vis.gl/react-maplibre';
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
  metricValue,
  rampColorForValue,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

/**
 * The client profile's district map, carrying the SAME map key and details as
 * the canonical District Nexus module (`pages/intelligence/district-nexus`):
 * MapLibre choropleth over the key-free Census boundary artifact, the
 * six-step nexus-strength ramp with its scale ticks, the "No verified nexus"
 * swatch, the hover card (district key + score), the AK/HI/PR jump controls,
 * and the Boundaries/Census attribution line.
 *
 * Loaded via `React.lazy` from the Intelligence tab so the WebGL engine stays
 * out of the client-crm chunk for users who never open the District subtab
 * (see `bundle-boundaries.test.ts` for why that matters). Query keys for the
 * boundary manifest/geojson are identical to the canonical page's, so the
 * ~5MB artifact is fetched once per session across both surfaces.
 *
 * Presentation is antd-free: the vNext shell owns this chunk, so the chrome is
 * plain elements styled in `portfolio-proto.css` (`.cap-pf-dn-*`).
 */

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
      canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'),
    );
  } catch {
    webglSupportCache = false;
  }
  return webglSupportCache;
}

export interface DistrictNexusMapLibreProps {
  districts: DistrictNexusDistrictSummary[];
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
}

const METRIC = 'nexus' as const;

export function DistrictNexusMapLibre({ districts, selectedDistrictKey, onSelectDistrict }: DistrictNexusMapLibreProps) {
  const api = useApi();
  const mapRef = useRef<MapRef | null>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showFacilities, setShowFacilities] = useState(false);
  const webglOk = useMemo(supportsWebGL, []);

  const manifest = useQuery({
    queryKey: ['district-nexus', 'boundary-manifest', 'C'],
    queryFn: () => getDistrictBoundaryManifest(api, 'C'),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: webglOk,
  });
  const geojson = useQuery<BoundaryFeatureCollection>({
    queryKey: ['district-nexus', 'boundary-geojson', 'C'],
    queryFn: () => getDistrictBoundaryGeoJson(api, 'C'),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: webglOk,
  });

  const byKey = useMemo(() => new Map(districts.map((d) => [d.districtKey, d])), [districts]);

  const styledGeojson = useMemo<BoundaryFeatureCollection | null>(() => {
    if (!geojson.data) return null;
    return {
      ...geojson.data,
      features: geojson.data.features.map((feature) => {
        const district = byKey.get(feature.id);
        const color = district ? rampColorForValue(metricValue(district, METRIC), METRIC) : NO_NEXUS_FILL;
        return {
          ...feature,
          properties: { ...feature.properties, __color: color, __hasNexus: Boolean(district) },
        };
      }),
    };
  }, [geojson.data, byKey]);

  // One marker per district at the boundary centroid, sized by aggregate
  // employee count — deliberately NOT a facility-precision claim (see the
  // canonical map's comment on why).
  const facilityPoints = useMemo(() => {
    if (!geojson.data) return { type: 'FeatureCollection' as const, features: [] };
    const features = geojson.data.features
      .map((feature) => {
        const district = byKey.get(feature.id);
        if (!district || (district.employeeCount == null && !district.employeesUnreported)) return null;
        const radius = Math.min(13, 4 + Math.sqrt((district.employeeCount ?? 60) / 40));
        return {
          type: 'Feature' as const,
          id: feature.id,
          geometry: { type: 'Point' as const, coordinates: feature.properties.centroid },
          properties: { districtKey: feature.id, radius },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f != null);
    return { type: 'FeatureCollection' as const, features };
  }, [geojson.data, byKey]);

  const fitToFootprint = () => {
    const map = mapRef.current;
    if (!map || !geojson.data) return;
    const boxes = geojson.data.features.filter((f) => byKey.has(f.id)).map((f) => f.properties.bbox);
    if (!boxes.length) {
      map.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false });
      return;
    }
    const union = boxes.reduce<[number, number, number, number]>(
      (acc, b) => [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    map.fitBounds(
      [
        [union[0], union[1]],
        [union[2], union[3]],
      ],
      { padding: 48, maxZoom: 6.5, animate: false },
    );
  };

  // Fit the client's footprint once everything is ready.
  useEffect(() => {
    if (!loaded || !mapRef.current || !geojson.data) return;
    fitToFootprint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, geojson.data]);

  // Selected-district outline via feature-state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    districts.forEach((d) => {
      map.setFeatureState({ source: 'pfdn-districts', id: d.districtKey }, { selected: d.districtKey === selectedDistrictKey });
    });
  }, [selectedDistrictKey, districts, loaded]);

  if (!webglOk || geojson.isError || renderError) {
    return (
      <div className="cap-pf-dn-fail" role="note">
        <b>Boundary map unavailable.</b>{' '}
        {!webglOk ? 'WebGL is unavailable in this browser session.' : 'The boundary artifact could not be loaded.'}{' '}
        The district list beside the map carries every number shown here.
      </div>
    );
  }

  if (geojson.isPending || manifest.isPending) {
    return <div className="cap-pf-dn-loading" aria-busy="true" aria-label="Loading district boundaries" />;
  }

  const hoveredDistrict = hover ? byKey.get(hover.key) : undefined;
  const scale = METRIC_SCALES[METRIC];

  return (
    <div className="cap-pf-dn-root">
      <MaplibreMap
        ref={mapRef}
        mapStyle={mapStyleUrl}
        initialViewState={{ bounds: CONUS_BOUNDS, fitBoundsOptions: { padding: 24 } }}
        interactiveLayerIds={['pfdn-district-fill']}
        cursor={hover ? 'pointer' : 'grab'}
        onLoad={() => setLoaded(true)}
        onError={() => setRenderError(true)}
        onMouseMove={(e: MapLayerMouseEvent) => {
          const feature = e.features?.[0];
          if (!feature?.id) {
            if (hover) setHover(null);
            return;
          }
          const key = String(feature.id);
          setHover({ key, x: e.point.x, y: e.point.y });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e: MapLayerMouseEvent) => {
          const feature = e.features?.[0];
          const key = feature?.id != null ? String(feature.id) : null;
          if (key && byKey.has(key)) onSelectDistrict(key);
        }}
      >
        {styledGeojson ? (
          // No promoteId: features carry a top-level GeoJSON `id` ("TX-23")
          // which MapLibre uses natively for feature-state.
          <Source id="pfdn-districts" type="geojson" data={styledGeojson}>
            <Layer id="pfdn-district-fill" type="fill" paint={{ 'fill-color': ['get', '__color'], 'fill-opacity': 0.96 }} />
            <Layer
              id="pfdn-district-outline"
              type="line"
              paint={{
                'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#1a3f9f', '#12306e'],
                'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.6, 0.6],
                'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.42],
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

      {hoveredDistrict ? (
        <div className="cap-pf-dn-hovcard" style={{ left: Math.max(4, hover!.x + 14), top: Math.max(4, hover!.y + 14) }}>
          <div className="cap-pf-dn-hk">{hoveredDistrict.districtKey}</div>
          <div className="cap-pf-dn-hr">
            <span>Nexus</span>
            <b>{hoveredDistrict.score ?? 'unscored'}</b>
          </div>
        </div>
      ) : null}

      <div className="cap-pf-dn-ctl cap-pf-dn-tl">
        <button type="button" onClick={fitToFootprint}>
          Fit footprint
        </button>
        <button type="button" onClick={() => mapRef.current?.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false })}>
          CONUS
        </button>
        {(['AK', 'HI', 'PR'] as const).map((region) => (
          <button
            key={region}
            type="button"
            onClick={() => mapRef.current?.fitBounds(REGION_BOUNDS[region], { padding: 20, animate: false })}
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
        {facilityPoints.features.length ? (
          <button
            type="button"
            aria-pressed={showFacilities}
            title="Districts with client facilities · sized by employees"
            onClick={() => setShowFacilities((v) => !v)}
          >
            Facilities
          </button>
        ) : null}
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
            <span className="cap-pf-dn-sw" style={{ borderRadius: '50%', background: '#fff', border: '2px solid #1a3f9f' }} />
            Districts with client facilities · sized by employees
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
