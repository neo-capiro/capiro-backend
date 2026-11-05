import type { GeographicBoundaryVersion, GeographicDistrict } from './geographic-boundary.js';
import { normalizeFacilityDistrictCode } from '../../common/district-code.util.js';
import { US_STATE_FIPS_TO_USPS } from '../../common/us-congressional-districts.js';

export const TIGERWEB_LEGISLATIVE_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer';
// A review policy threshold, not an asserted accuracy radius for either geocoder.
const BOUNDARY_REVIEW_DISTANCE_METERS = 25;
interface Layer {
  id: number;
  name: string;
  parentLayerId?: number;
  type?: string;
}
interface Feature {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}
type FetchJson = <T>(url: string, signal: AbortSignal) => Promise<T>;

/** Discover by official layer/group name; numeric IDs are intentionally never configured. */
export function selectLegislativeLayers(
  layers: Layer[],
  version: GeographicBoundaryVersion,
): Array<Layer & { chamber: GeographicDistrict['chamber'] }> | null {
  const group = layers.find((l) => l.name === version.geometryVersion);
  const names = [
    {
      name: `${version.congress}${version.congress % 10 === 1 && version.congress % 100 !== 11 ? 'st' : version.congress % 10 === 2 && version.congress % 100 !== 12 ? 'nd' : version.congress % 10 === 3 && version.congress % 100 !== 13 ? 'rd' : 'th'} Congressional Districts`,
      chamber: 'house' as const,
    },
    {
      name: `${version.stateLegislativeYear} State Legislative Districts - Lower`,
      chamber: 'state_lower' as const,
    },
    {
      name: `${version.stateLegislativeYear} State Legislative Districts - Upper`,
      chamber: 'state_upper' as const,
    },
  ];
  if (!group) return null;
  const found = names.map(({ name, chamber }) => {
    const layer = layers.find((l) => l.name === name && l.parentLayerId === group.id);
    return layer ? { ...layer, chamber } : null;
  });
  return found.every((l) => l !== null)
    ? (found as Array<Layer & { chamber: GeographicDistrict['chamber'] }>)
    : null;
}

/** ArcGIS returns WGS84 rings; a short local projection suffices for a conservative review threshold. */
export function nearPolygonBoundary(
  latitude: number,
  longitude: number,
  rings: number[][][],
): boolean {
  const xScale = 111_320 * Math.cos((latitude * Math.PI) / 180);
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1]!;
      const [bx, by] = ring[i]!;
      if (![ax, ay, bx, by].every(Number.isFinite)) continue;
      const x = (ax! - longitude) * xScale;
      const y = (ay! - latitude) * 111_320;
      const dx = (bx! - ax!) * xScale;
      const dy = (by! - ay!) * 111_320;
      const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(x + t * dx, y + t * dy) <= BOUNDARY_REVIEW_DISTANCE_METERS) return true;
    }
  }
  return false;
}

export async function resolveOfficialBoundaries(
  latitude: number,
  longitude: number,
  version: GeographicBoundaryVersion,
  signal: AbortSignal,
  fetchJson: FetchJson,
): Promise<{ districts: GeographicDistrict[]; adjacent: boolean; ambiguous: boolean } | null> {
  const catalog = await fetchJson<{ layers?: Layer[]; error?: unknown }>(
    `${TIGERWEB_LEGISLATIVE_URL}?f=json`,
    signal,
  );
  if (catalog.error) throw new Error('Official boundary catalog unavailable');
  const layers = selectLegislativeLayers(catalog.layers ?? [], version);
  if (!layers) return null;
  const districts: GeographicDistrict[] = [];
  let adjacent = false;
  let ambiguous = false;
  for (const layer of layers) {
    const params = new URLSearchParams({
      f: 'json',
      geometry: `${longitude},${latitude}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
    });
    const response = await fetchJson<{ features?: Feature[]; error?: unknown }>(
      `${TIGERWEB_LEGISLATIVE_URL}/${layer.id}/query?${params}`,
      signal,
    );
    if (response.error) throw new Error('Official boundary lookup unavailable');
    const features = response.features ?? [];
    if (features.length > 1) ambiguous = true;
    for (const feature of features) {
      const row = feature.attributes ?? {};
      const stateFips = typeof row.STATE === 'string' ? row.STATE : null;
      const raw =
        layer.chamber === 'house'
          ? (row[`CD${version.congress}`] ?? row.CD ?? row.BASENAME)
          : layer.chamber === 'state_upper'
            ? (row.BASENAME ?? row.SLDU)
            : (row.BASENAME ?? row.SLDL);
      const code =
        layer.chamber === 'house'
          ? normalizeFacilityDistrictCode(US_STATE_FIPS_TO_USPS[stateFips ?? ''], String(raw ?? ''))
          : String(raw ?? '').trim();
      if (!code) continue;
      districts.push({
        chamber: layer.chamber,
        code,
        providerCode: String(
          layer.chamber === 'state_upper'
            ? (row.SLDU ?? raw)
            : layer.chamber === 'state_lower'
              ? (row.SLDL ?? raw)
              : raw,
        ),
        stateFips,
        geoid: typeof row.GEOID === 'string' ? row.GEOID : null,
        congress: layer.chamber === 'house' ? version.congress : null,
        layer: layer.name,
      });
      // Missing geometry cannot prove this point is away from a boundary.
      adjacent ||=
        !feature.geometry?.rings?.length ||
        nearPolygonBoundary(latitude, longitude, feature.geometry.rings);
    }
  }
  if (!districts.some((d) => d.chamber === 'house')) return null;
  return { districts, adjacent, ambiguous };
}
