import { describe, expect, test } from 'vitest';
import type {
  BoundaryFeatureCollection,
  DistrictNexusDistrictSummary,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import {
  NO_NEXUS_FILL,
  metricValue,
  rampColorForValue,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';
import {
  buildFacilityPoints,
  buildStyledBoundaryGeoJson,
  computeFootprintBounds,
  districtKeyFromFeature,
} from './district-map-model.js';

function boundaryFeature(id: string, bbox: [number, number, number, number]) {
  const [west, south, east, north] = bbox;
  return {
    type: 'Feature' as const,
    id,
    geometry: { type: 'Polygon' as const, coordinates: [] as number[][][] },
    properties: {
      state: id.split('-')[0]!,
      districtCode: id.split('-')[1]!,
      status: 'C' as const,
      vintage: '119',
      legislativeDistrictId: null,
      name: id,
      bbox,
      centroid: [(west + east) / 2, (south + north) / 2] as [number, number],
    },
  };
}

const GEOJSON: BoundaryFeatureCollection = {
  type: 'FeatureCollection',
  bbox: [-125, 24, -66, 50],
  features: [
    boundaryFeature('TX-23', [-101.5, 28.9, -98.2, 31.2]),
    boundaryFeature('CA-12', [-122.6, 37.6, -122.3, 37.9]),
    boundaryFeature('WY-00', [-111.1, 40.9, -104.1, 45]),
  ],
};

function district(overrides: Partial<DistrictNexusDistrictSummary>): DistrictNexusDistrictSummary {
  return {
    districtKey: 'TX-23',
    state: 'TX',
    districtCode: '23',
    status: 'C',
    name: 'TX-23',
    awarded: { contractObligations: 4_800_000, grantObligations: 0, grantOutlays: 0 },
    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
    clientCount: 1,
    score: 42,
    coveragePercent: 55,
    employeeCount: 120,
    employeesUnreported: false,
    warnings: [],
    ...overrides,
  };
}

const REAL = district({});
const PLACEHOLDER = district({
  districtKey: 'WY-00',
  state: 'WY',
  districtCode: '00',
  clientCount: 0,
  score: null,
  employeeCount: null,
  employeesUnreported: false,
  awarded: { contractObligations: null, grantObligations: null, grantOutlays: null },
});
const BY_KEY = new Map([
  [REAL.districtKey, REAL],
  [PLACEHOLDER.districtKey, PLACEHOLDER],
]);

describe('district map pure model', () => {
  test('styles verified footprint with the selected metric and placeholders with no-nexus fill', () => {
    const styled = buildStyledBoundaryGeoJson(GEOJSON, BY_KEY, 'contracts');
    const byId = Object.fromEntries(
      styled.features.map((feature) => [feature.id, feature.properties]),
    );

    expect(byId['TX-23']).toMatchObject({
      __districtKey: 'TX-23',
      __hasNexus: true,
      __color: rampColorForValue(metricValue(REAL, 'contracts'), 'contracts'),
    });
    expect(byId['WY-00']).toMatchObject({
      __districtKey: 'WY-00',
      __hasNexus: false,
      __color: NO_NEXUS_FILL,
    });
    expect(byId['CA-12']).toMatchObject({
      __districtKey: 'CA-12',
      __hasNexus: false,
      __color: NO_NEXUS_FILL,
    });
  });

  test('builds saved-coordinate points without substituting invalid locations or district centroids', () => {
    const points = buildFacilityPoints(
      [
        {
          id: 'hq',
          name: 'HQ',
          state: 'TX',
          congressionalDistrict: '23',
          latitude: 30,
          longitude: -100,
          employeeCount: null,
        },
        {
          id: 'remote',
          name: 'Remote',
          state: null,
          congressionalDistrict: null,
          latitude: 47,
          longitude: -120,
          employeeCount: 400,
        },
        {
          id: 'invalid',
          name: 'Invalid',
          state: 'TX',
          congressionalDistrict: '23',
          latitude: 100,
          longitude: -100,
          employeeCount: 10,
        },
      ],
      GEOJSON,
      BY_KEY,
    );

    expect(points.features.map((feature) => feature.geometry.coordinates)).toEqual([
      [-100, 30],
      [-120, 47],
    ]);
    expect(points.features[0]?.properties).toMatchObject({
      districtKey: 'TX-23',
      facilityName: 'HQ',
      radius: 6,
    });
  });

  test('builds aggregate centroid points only for districts with employee signal', () => {
    const points = buildFacilityPoints(undefined, GEOJSON, BY_KEY);

    expect(points.features).toHaveLength(1);
    expect(points.features[0]).toMatchObject({
      id: 'TX-23',
      geometry: { coordinates: GEOJSON.features[0]!.properties.centroid },
      properties: { districtKey: 'TX-23' },
    });
  });

  test('computes a footprint union from verified districts and saved points while excluding placeholders', () => {
    const points = buildFacilityPoints(
      [
        {
          id: 'west',
          name: 'West',
          state: null,
          congressionalDistrict: null,
          latitude: 47,
          longitude: -120,
          employeeCount: null,
        },
      ],
      GEOJSON,
      BY_KEY,
    );

    expect(computeFootprintBounds(GEOJSON, BY_KEY, points, true)).toEqual([
      [-120, 28.9],
      [-98.2, 47],
    ]);
    expect(
      computeFootprintBounds(GEOJSON, new Map([['WY-00', PLACEHOLDER]]), points, false),
    ).toBeNull();
  });

  test('extracts the same district-key precedence from facility, boundary, and id-only features', () => {
    expect(
      districtKeyFromFeature({
        id: 'ID-00',
        properties: { districtKey: 'WA-07', __districtKey: 'CA-12' },
      }),
    ).toBe('WA-07');
    expect(districtKeyFromFeature({ id: 'ID-00', properties: { __districtKey: 'CA-12' } })).toBe(
      'CA-12',
    );
    expect(districtKeyFromFeature({ id: 'ID-00', properties: {} })).toBe('ID-00');
    expect(districtKeyFromFeature(undefined)).toBeNull();
  });
});
