import {
  formatFacilityDistrict,
  type ClientFacility,
} from '../../../pages/clients/facilities-api.js';
import type {
  BoundaryFeatureCollection,
  DistrictNexusDistrictSummary,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import {
  NO_NEXUS_FILL,
  metricValue,
  rampColorForValue,
  type ChoroplethMetric,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

export type DistrictMapFacilities = Pick<
  ClientFacility,
  'id' | 'name' | 'state' | 'congressionalDistrict' | 'latitude' | 'longitude' | 'employeeCount'
>[];

export interface DistrictMapPointFeature {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    districtKey: string | null;
    radius: number;
    facilityName?: string;
  };
}

export interface DistrictMapPointCollection {
  type: 'FeatureCollection';
  features: DistrictMapPointFeature[];
}

/** National coverage includes placeholder rows with no verified client evidence. */
export function hasClientFootprint(
  district: DistrictNexusDistrictSummary | undefined,
): district is DistrictNexusDistrictSummary {
  return district != null && (district.clientCount > 0 || district.score != null);
}

export function buildStyledBoundaryGeoJson(
  geojson: BoundaryFeatureCollection,
  byKey: ReadonlyMap<string, DistrictNexusDistrictSummary>,
  metric: ChoroplethMetric,
): BoundaryFeatureCollection {
  return {
    ...geojson,
    features: geojson.features.map((feature) => {
      const district = byKey.get(feature.id);
      const hasFootprint = hasClientFootprint(district);
      return {
        ...feature,
        properties: {
          ...feature.properties,
          __districtKey: feature.id,
          __color: hasFootprint
            ? rampColorForValue(metricValue(district, metric), metric)
            : NO_NEXUS_FILL,
          __hasNexus: hasFootprint,
        },
      };
    }),
  };
}

export function buildFacilityPoints(
  facilities: DistrictMapFacilities | undefined,
  geojson: BoundaryFeatureCollection | undefined,
  byKey: ReadonlyMap<string, DistrictNexusDistrictSummary>,
): DistrictMapPointCollection {
  if (facilities !== undefined) {
    return {
      type: 'FeatureCollection',
      features: facilities.flatMap((facility): DistrictMapPointFeature[] => {
        const { latitude, longitude } = facility;
        if (
          latitude == null ||
          longitude == null ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180
        ) {
          return [];
        }
        return [
          {
            type: 'Feature',
            id: facility.id,
            properties: {
              districtKey: formatFacilityDistrict(facility.state, facility.congressionalDistrict),
              facilityName: facility.name,
              radius:
                facility.employeeCount == null
                  ? 6
                  : Math.min(14, 5 + Math.sqrt(Math.max(0, facility.employeeCount)) / 10),
            },
            geometry: { type: 'Point', coordinates: [longitude, latitude] },
          },
        ];
      }),
    };
  }

  if (!geojson) return { type: 'FeatureCollection', features: [] };
  const features = geojson.features.flatMap((feature): DistrictMapPointFeature[] => {
    const district = byKey.get(feature.id);
    if (!district || (district.employeeCount == null && !district.employeesUnreported)) return [];
    return [
      {
        type: 'Feature',
        id: feature.id,
        geometry: { type: 'Point', coordinates: feature.properties.centroid },
        properties: {
          districtKey: feature.id,
          radius: Math.min(13, 4 + Math.sqrt((district.employeeCount ?? 60) / 40)),
        },
      },
    ];
  });
  return { type: 'FeatureCollection', features };
}

export type DistrictMapBounds = [[number, number], [number, number]];

export function computeFootprintBounds(
  geojson: BoundaryFeatureCollection,
  byKey: ReadonlyMap<string, DistrictNexusDistrictSummary>,
  facilityPoints: DistrictMapPointCollection,
  includeFacilityPoints: boolean,
): DistrictMapBounds | null {
  const boxes: Array<[number, number, number, number]> = geojson.features
    .filter((feature) => hasClientFootprint(byKey.get(feature.id)))
    .map((feature) => feature.properties.bbox);

  if (includeFacilityPoints) {
    for (const point of facilityPoints.features) {
      const [longitude, latitude] = point.geometry.coordinates;
      boxes.push([longitude, latitude, longitude, latitude]);
    }
  }
  if (boxes.length === 0) return null;

  const union = boxes.reduce<[number, number, number, number]>(
    (accumulator, box) => [
      Math.min(accumulator[0], box[0]),
      Math.min(accumulator[1], box[1]),
      Math.max(accumulator[2], box[2]),
      Math.max(accumulator[3], box[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  return [
    [union[0], union[1]],
    [union[2], union[3]],
  ];
}

export function districtKeyFromFeature(
  feature:
    | {
        id?: string | number | null;
        properties?: Record<string, unknown> | null;
      }
    | null
    | undefined,
): string | null {
  if (!feature) return null;
  return String(
    feature.properties?.districtKey ?? feature.properties?.__districtKey ?? feature.id ?? '',
  );
}
