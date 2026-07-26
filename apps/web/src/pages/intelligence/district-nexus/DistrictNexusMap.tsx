import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Checkbox, Popover, Skeleton } from 'antd';
import { MinusOutlined, PlusOutlined, WarningOutlined, GroupOutlined } from '@ant-design/icons';
import { Map as MaplibreMap, Source, Layer, type MapLayerMouseEvent, type MapRef } from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useApi } from '../../../lib/use-api.js';
import { mapStyleUrl, mapStyleAttribution } from '../../../env.js';
import {
  getDistrictBoundaryGeoJson,
  getDistrictBoundaryManifest,
  type BoundaryFeatureCollection,
  type DistrictNexusDistrictSummary,
} from './district-nexus-api.js';
import {
  CHOROPLETH_RAMP,
  METRIC_SCALES,
  NO_NEXUS_FILL,
  metricValue,
  rampColorForValue,
  type ChoroplethMetric,
} from './district-nexus-format.js';
import { DistrictNexusTable } from './DistrictNexusTable.js';

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
      canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'),
    );
  } catch {
    webglSupportCache = false;
  }
  return webglSupportCache;
}

interface Props {
  districts: DistrictNexusDistrictSummary[];
  metric: ChoroplethMetric;
  view: 'current' | 'future';
  selectedDistrictKey: string | null;
  onSelectDistrict: (districtKey: string) => void;
  onHoverDistrict?: (districtKey: string | null) => void;
  showFacilities: boolean;
  onShowFacilitiesChange: (value: boolean) => void;
  /** Changes trigger a fit-to-footprint (or CONUS when null); the value
   * itself is opaque, only identity/change matters. */
  fitToken: string | null;
}

/**
 * WS-G Step G3 — the modern map. GPU-rendered MapLibre choropleth over the
 * key-free boundary artifact (WS-D). Falls back to DistrictNexusTable, never
 * a blank canvas, when the artifact is missing or WebGL is unavailable
 * (§8.6) — both real, reachable states today: no artifact has been built in
 * this environment yet, and WebGL can legitimately be off in a browser.
 */
export function DistrictNexusMap({
  districts,
  metric,
  view,
  selectedDistrictKey,
  onSelectDistrict,
  onHoverDistrict,
  showFacilities,
  onShowFacilitiesChange,
  fitToken,
}: Props) {
  const api = useApi();
  const mapRef = useRef<MapRef | null>(null);
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const [renderError, setRenderError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const webglOk = useMemo(supportsWebGL, []);
  const statusParam = view === 'future' ? 'F' : 'C';

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

  const styledGeojson = useMemo<BoundaryFeatureCollection | null>(() => {
    if (!geojson.data) return null;
    return {
      ...geojson.data,
      features: geojson.data.features.map((feature) => {
        const district = byKey.get(feature.id);
        const color = district ? rampColorForValue(metricValue(district, metric), metric) : NO_NEXUS_FILL;
        return {
          ...feature,
          properties: { ...feature.properties, __color: color, __hasNexus: Boolean(district) },
        };
      }),
    };
  }, [geojson.data, byKey, metric]);

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

  // Re-fit whenever the map finishes loading, or the caller's fit token
  // changes (client filter change): footprint when a client is selected
  // (fitToken set), CONUS otherwise.
  useEffect(() => {
    if (!loaded || !mapRef.current || !geojson.data) return;
    if (fitToken) fitToFootprint();
    else mapRef.current.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitToken, loaded, geojson.data]);

  // Selected-district outline via feature-state.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    districts.forEach((d) => {
      map.setFeatureState({ source: 'dn-districts', id: d.districtKey }, { selected: d.districtKey === selectedDistrictKey });
    });
  }, [selectedDistrictKey, districts, loaded]);

  if (!webglOk || geojson.isError || renderError) {
    return (
      <div className="dn-boundary-fail">
        <div className="dn-hint dn-notable" style={{ borderRadius: 0, borderLeft: 0, borderRight: 0, borderTop: 0 }}>
          <span className="dn-hico">
            <WarningOutlined />
          </span>
          <div>
            <b>Boundary map unavailable.</b>{' '}
            {!webglOk
              ? 'WebGL is unavailable in this browser session.'
              : 'The boundary artifact could not be loaded.'}{' '}
            Every number, filter and district below is unaffected — the map is a view of this data, not its source.
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          <DistrictNexusTable districts={districts} selectedDistrictKey={selectedDistrictKey} onSelectDistrict={onSelectDistrict} compact />
        </div>
      </div>
    );
  }

  if (geojson.isPending || manifest.isPending) {
    return <Skeleton.Node active style={{ width: '100%', height: '100%' }} />;
  }

  const hoveredDistrict = hover ? byKey.get(hover.key) : undefined;
  const scale = METRIC_SCALES[metric];

  return (
    <>
      <MaplibreMap
        ref={mapRef}
        mapStyle={mapStyleUrl}
        initialViewState={{ bounds: CONUS_BOUNDS, fitBoundsOptions: { padding: 24 } }}
        interactiveLayerIds={['dn-district-fill']}
        cursor={hover ? 'pointer' : 'grab'}
        onLoad={() => setLoaded(true)}
        onError={() => setRenderError(true)}
        onMouseMove={(e: MapLayerMouseEvent) => {
          const feature = e.features?.[0];
          if (!feature?.id) {
            if (hover) setHover(null);
            onHoverDistrict?.(null);
            return;
          }
          const key = String(feature.id);
          setHover({ key, x: e.point.x, y: e.point.y });
          onHoverDistrict?.(key);
        }}
        onMouseLeave={() => {
          setHover(null);
          onHoverDistrict?.(null);
        }}
        onClick={(e: MapLayerMouseEvent) => {
          const feature = e.features?.[0];
          const key = feature?.id != null ? String(feature.id) : null;
          if (key && byKey.has(key)) onSelectDistrict(key);
        }}
      >
        {styledGeojson ? (
          // No promoteId: every feature already carries a top-level GeoJSON
          // `id` ("TX-23" etc., identical to DistrictKey) which MapLibre uses
          // natively for feature-state — promoting a properties field here
          // would desync setFeatureState calls keyed by districtKey.
          <Source id="dn-districts" type="geojson" data={styledGeojson}>
            <Layer
              id="dn-district-fill"
              type="fill"
              paint={{ 'fill-color': ['get', '__color'], 'fill-opacity': 0.96 }}
            />
            <Layer
              id="dn-district-outline"
              type="line"
              paint={{
                'line-color': [
                  'case',
                  ['boolean', ['feature-state', 'selected'], false],
                  '#1a3f9f',
                  '#12306e',
                ],
                'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.6, 0.6],
                'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0.42],
              }}
            />
          </Source>
        ) : null}
        {showFacilities && facilityPoints.features.length ? (
          <Source id="dn-facilities" type="geojson" data={facilityPoints}>
            <Layer
              id="dn-facility-points"
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
        <div className="dn-hovcard" style={{ left: Math.max(4, hover!.x + 14), top: Math.max(4, hover!.y + 14) }}>
          <div className="dn-hk">{hoveredDistrict.districtKey}</div>
          <div className="dn-hr">
            <span>Nexus</span>
            <b>{hoveredDistrict.score ?? 'unscored'}</b>
          </div>
        </div>
      ) : null}

      <div className="dn-mctl dn-tl">
        <div className="dn-jump">
          <button type="button" onClick={fitToFootprint}>
            Fit footprint
          </button>
          <button type="button" onClick={() => mapRef.current?.fitBounds(CONUS_BOUNDS, { padding: 24, animate: false })}>
            CONUS
          </button>
          {(['AK', 'HI', 'PR'] as const).map((region) => (
            <button key={region} type="button" onClick={() => mapRef.current?.fitBounds(REGION_BOUNDS[region], { padding: 20, animate: false })}>
              {region}
            </button>
          ))}
        </div>
      </div>
      <div className="dn-mctl dn-tr">
        <div className="dn-mgrp">
          <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
            <PlusOutlined />
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
            <MinusOutlined />
          </button>
        </div>
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <Checkbox checked={showFacilities} onChange={(e) => onShowFacilitiesChange(e.target.checked)}>
              Client facilities
            </Checkbox>
          }
        >
          <button type="button" className="dn-mbtn" aria-label="Map layers">
            <GroupOutlined />
          </button>
        </Popover>
      </div>
      <div className="dn-mctl dn-br">
        <div className="dn-legend">
          <div className="dn-lt">{scale.label}</div>
          <div className="dn-ramp">
            {CHOROPLETH_RAMP.map((color) => (
              <i key={color} style={{ background: color }} />
            ))}
          </div>
          <div className="dn-sc">
            {scale.ticks.map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
          </div>
          <div className="dn-ex">
            <div className="dn-ex-row">
              <span className="dn-sw" style={{ background: NO_NEXUS_FILL }} />
              No verified nexus
            </div>
            {showFacilities ? (
              <div className="dn-ex-row">
                <span className="dn-sw" style={{ borderRadius: '50%', width: 11, background: '#fff', border: '2px solid #1a3f9f' }} />
                Client facilities (district centroid)
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="dn-attrib">
        Boundaries · {mapStyleAttribution} · U.S. Census Bureau
        {manifest.data ? `, ${manifest.data.vintage}th Congress` : ''}
      </div>
    </>
  );
}
