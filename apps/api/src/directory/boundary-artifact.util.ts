/**
 * WS-D — pure logic for building browser-safe district boundary artifacts.
 *
 * Lives in `src/` rather than beside the script that drives it because
 * `apps/api/tsconfig.json` EXCLUDES `scripts/**`: anything under `scripts/` is
 * never type-checked by `pnpm typecheck`, only incidentally by ts-jest when a
 * spec imports it. The geometry/validation logic is the part most worth having
 * type-checked and unit-tested, so it lives here and
 * `scripts/build-district-boundary-artifacts.ts` stays thin I/O.
 *
 * Two source rails converge on ONE output format:
 *  - current map ('C'): Census cartographic national shapefile -> GeoJSON
 *  - future map ('F'):  LegiStorm KML, re-hosted in OUR S3 (never the vendor
 *    URL, which embeds our API key in its path)
 *
 * Every feature is keyed by the facility-style district code so map features
 * join directly to the facility / award / spend rails.
 */

import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { toFacilityDistrictCode } from '../common/district-code.util.js';
import { US_STATE_FIPS_TO_USPS } from '../common/us-congressional-districts.js';

/** Longitude/latitude pair. Elevation, if present in the source, is dropped. */
export type Position = [number, number];

export interface PolygonGeometry {
  type: 'Polygon';
  /** Ring 0 is the exterior ring; any further rings are holes. */
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

export type BoundaryGeometry = PolygonGeometry | MultiPolygonGeometry;

/** `[west, south, east, north]` — the GeoJSON bbox member order. */
export type Bbox = [number, number, number, number];

export interface BoundaryFeature {
  type: 'Feature';
  /** Stable feature id: `<STATE>-<facility district code>`, e.g. `TX-23`, `WY-00`. */
  id: string;
  geometry: BoundaryGeometry;
  properties: {
    state: string;
    /** Facility-style: 2-char zero-padded, '00' at-large. */
    districtCode: string;
    /** 'C' current | 'F' future (enacted, not yet effective). */
    status: 'C' | 'F';
    /** Census vintage ('119') or the LegiStorm district id for a future row. */
    vintage: string;
    /** `LegislativeDistrict.id` when this feature was matched to one, else null. */
    legislativeDistrictId: string | null;
    name: string | null;
    bbox: Bbox;
    centroid: Position;
  };
}

export interface BoundaryFeatureCollection {
  type: 'FeatureCollection';
  bbox: Bbox;
  features: BoundaryFeature[];
}

export type BoundarySource = 'census_cartographic_500k' | 'legistorm_kml';

export interface BoundaryManifest {
  status: 'current' | 'future';
  vintage: string;
  generatedAt: string;
  districtCount: number;
  source: BoundarySource;
  hash: string;
  /** S3 key of the artifact this manifest points at. */
  artifactKey: string;
  /** Byte length of the gzipped artifact, so the API can set Content-Length. */
  gzipBytes: number;
  warnings: string[];
}

/** Raw Census cartographic CD shapefile properties we rely on. */
export interface CensusCdProperties {
  STATEFP?: string;
  GEOID?: string;
  NAMELSAD?: string;
  [key: string]: unknown;
}

/**
 * Census names the district-number column after the congress it describes
 * (`CD119FP` for the 119th, `CD118FP` before it), so the vintage cannot be
 * hardcoded — read it off whichever `CD<n>FP` key the file actually carries.
 * Returns null when no such column exists, which means the file is not a
 * congressional-district file at all.
 */
export function readCensusDistrictColumn(
  props: CensusCdProperties,
): { vintage: string; value: string } | null {
  for (const key of Object.keys(props)) {
    const m = /^CD(\d{3})FP$/.exec(key);
    if (!m) continue;
    const value = props[key];
    if (typeof value !== 'string') continue;
    return { vintage: m[1]!, value };
  }
  return null;
}

/**
 * Resolve a Census CD feature to `{ state, districtCode }` in facility style.
 *
 * Census encodes at-large as '00' and a non-voting delegate as '98'; both must
 * land on the facility at-large sentinel '00'. Rather than special-casing them
 * here, the value goes through `toFacilityDistrictCode`, which derives
 * at-largeness from apportionment — so a single-seat jurisdiction resolves to
 * '00' whatever number the file reports.
 *
 * Returns null (caller warns and skips) when the state FIPS is outside the
 * House-apportioned jurisdictions or the district number is unusable.
 */
export function resolveCensusFeatureKey(
  props: CensusCdProperties,
): { state: string; districtCode: string; vintage: string; name: string | null } | null {
  const stateFp = typeof props.STATEFP === 'string' ? props.STATEFP : null;
  if (!stateFp) return null;
  const state = US_STATE_FIPS_TO_USPS[stateFp];
  if (!state) return null;

  const column = readCensusDistrictColumn(props);
  if (!column) return null;

  // '00' (at-large) and '98' (delegate) are not district ORDINALS, so they
  // cannot go through the numeric path — map them straight to the sentinel.
  const districtCode =
    column.value === '00' || column.value === '98'
      ? '00'
      : toFacilityDistrictCode(state, column.value);
  if (!districtCode) return null;

  return {
    state,
    districtCode,
    vintage: column.vintage,
    name: typeof props.NAMELSAD === 'string' ? props.NAMELSAD : null,
  };
}

/**
 * Reject anything that would render as a broken or dangerous map feature.
 * Returns a list of human-readable problems — empty means the geometry is
 * usable. Callers skip invalid features and surface the reasons as warnings
 * rather than failing the whole build, so one bad district can't block a
 * national artifact.
 */
export function validateGeometry(geometry: unknown): string[] {
  const problems: string[] = [];
  if (typeof geometry !== 'object' || geometry === null) return ['geometry is not an object'];

  const geom = geometry as { type?: unknown; coordinates?: unknown };
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
    return [`unsupported geometry type ${String(geom.type)} (expected Polygon or MultiPolygon)`];
  }
  if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
    return [`${geom.type} has no coordinates`];
  }

  const rings: unknown[] =
    geom.type === 'Polygon'
      ? (geom.coordinates as unknown[])
      : (geom.coordinates as unknown[][]).flat();

  let positionCount = 0;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      problems.push('a ring has fewer than 4 positions (a closed ring needs at least 4)');
      continue;
    }
    for (const pos of ring) {
      if (!Array.isArray(pos) || pos.length < 2) {
        problems.push('a position is not a [lon, lat] pair');
        break;
      }
      const [lon, lat] = pos as [unknown, unknown];
      if (typeof lon !== 'number' || typeof lat !== 'number' || !isFinite(lon) || !isFinite(lat)) {
        problems.push('a position has a non-finite coordinate');
        break;
      }
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        problems.push(`a position is outside valid lon/lat range (${lon}, ${lat})`);
        break;
      }
      positionCount += 1;
    }
    const first = (ring as Position[])[0];
    const last = (ring as Position[])[ring.length - 1];
    if (
      first &&
      last &&
      Array.isArray(first) &&
      Array.isArray(last) &&
      (first[0] !== last[0] || first[1] !== last[1])
    ) {
      problems.push('a ring is not closed (first position != last position)');
    }
  }
  if (positionCount === 0) problems.push('geometry has no usable positions');
  return problems;
}

/** Every position in a Polygon/MultiPolygon, exterior rings and holes alike. */
function allPositions(geometry: BoundaryGeometry): Position[] {
  return geometry.type === 'Polygon'
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2);
}

/** Bounding box of a validated geometry. */
export function computeBbox(geometry: BoundaryGeometry): Bbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of allPositions(geometry)) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

/**
 * Area-weighted centroid of the exterior rings (the standard polygon centroid,
 * via the shoelace formula), which for a district is a far better label anchor
 * than a bbox centre — bbox centres fall outside crescent-shaped districts.
 *
 * Holes are ignored: they shift a label anchor only marginally and are not
 * worth the signed-area bookkeeping here. Degenerate (zero-area) geometry
 * falls back to the mean of its positions so a centroid always exists.
 */
export function computeCentroid(geometry: BoundaryGeometry): Position {
  const exteriorRings: Position[][] =
    geometry.type === 'Polygon'
      ? geometry.coordinates.slice(0, 1)
      : geometry.coordinates.map((poly) => poly[0]!).filter(Boolean);

  let areaSum = 0;
  let cxSum = 0;
  let cySum = 0;
  for (const ring of exteriorRings) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[i + 1]!;
      const cross = x0 * y1 - x1 * y0;
      areaSum += cross;
      cxSum += (x0 + x1) * cross;
      cySum += (y0 + y1) * cross;
    }
  }

  if (areaSum === 0) {
    const positions = allPositions(geometry);
    const n = positions.length || 1;
    const sum = positions.reduce<[number, number]>(
      (acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat],
      [0, 0],
    );
    return [sum[0] / n, sum[1] / n];
  }
  // areaSum here is twice the signed area; the centroid divisor is 6*A = 3*areaSum.
  return [cxSum / (3 * areaSum), cySum / (3 * areaSum)];
}

/** Union bbox across features — the collection-level bbox member. */
export function unionBbox(boxes: Bbox[]): Bbox {
  return boxes.reduce<Bbox>(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

/**
 * Parse a KML document into a single Polygon/MultiPolygon geometry.
 *
 * Uses `fast-xml-parser`, already an api dependency, rather than adding
 * `@tmcw/togeojson` — which needs a browser DOM shim under Node and would pull
 * in a second XML stack for one document shape we fully control. LegiStorm
 * district KML is a flat set of `<Placemark>`s; every `<Polygon>` found
 * anywhere in the document is collected, so `<MultiGeometry>` needs no special
 * handling. `<innerBoundaryIs>` rings are preserved as holes.
 *
 * Coordinates are `lon,lat[,elevation]` whitespace-separated; elevation is
 * dropped. Returns null when the document contains no usable polygon.
 */
export function kmlToGeometry(kmlText: string): BoundaryGeometry | null {
  const parser = new XMLParser({
    ignoreAttributes: true,
    // Never coerce: "01" must not become 1, and a lone coordinate string must
    // not be parsed as a number.
    parseTagValue: false,
    trimValues: true,
  });
  const doc: unknown = parser.parse(kmlText);

  const polygons: Position[][][] = [];

  const parseRing = (raw: unknown): Position[] | null => {
    if (typeof raw !== 'string') return null;
    const positions: Position[] = [];
    for (const token of raw.trim().split(/\s+/)) {
      if (!token) continue;
      const parts = token.split(',');
      if (parts.length < 2) continue;
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!isFinite(lon) || !isFinite(lat)) continue;
      positions.push([lon, lat]);
    }
    if (positions.length < 3) return null;
    // KML rings are usually closed already; close them if not, so the output
    // satisfies the GeoJSON ring rule that validateGeometry enforces.
    const first = positions[0]!;
    const last = positions[positions.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) positions.push([first[0], first[1]]);
    return positions;
  };

  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

  const collectPolygon = (poly: unknown): void => {
    if (typeof poly !== 'object' || poly === null) return;
    const p = poly as Record<string, unknown>;
    const rings: Position[][] = [];

    for (const outer of asArray(p.outerBoundaryIs)) {
      const linear = (outer as Record<string, unknown> | null)?.LinearRing;
      for (const lr of asArray(linear)) {
        const ring = parseRing((lr as Record<string, unknown> | null)?.coordinates);
        if (ring) rings.push(ring);
      }
    }
    if (rings.length === 0) return; // a hole without an exterior ring is unusable
    for (const inner of asArray(p.innerBoundaryIs)) {
      const linear = (inner as Record<string, unknown> | null)?.LinearRing;
      for (const lr of asArray(linear)) {
        const ring = parseRing((lr as Record<string, unknown> | null)?.coordinates);
        if (ring) rings.push(ring);
      }
    }
    polygons.push(rings);
  };

  // Walk the whole parsed tree for `Polygon` nodes — robust to Document/Folder
  // nesting and MultiGeometry without encoding a specific document shape.
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Polygon') {
        for (const poly of asArray(value)) collectPolygon(poly);
        continue;
      }
      walk(value);
    }
  };
  walk(doc);

  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0]! };
  return { type: 'MultiPolygon', coordinates: polygons };
}

/**
 * Assemble a validated feature. Returns either the feature or the reasons it
 * could not be built, so the caller can report precisely which districts were
 * dropped instead of silently shipping a short artifact.
 */
export function buildFeature(input: {
  state: string;
  districtCode: string;
  status: 'C' | 'F';
  vintage: string;
  name: string | null;
  legislativeDistrictId: string | null;
  geometry: unknown;
}): { feature: BoundaryFeature } | { problems: string[] } {
  const problems = validateGeometry(input.geometry);
  if (problems.length > 0) return { problems };
  const geometry = input.geometry as BoundaryGeometry;
  const bbox = computeBbox(geometry);
  const centroid = computeCentroid(geometry);
  return {
    feature: {
      type: 'Feature',
      id: `${input.state}-${input.districtCode}`,
      geometry,
      properties: {
        state: input.state,
        districtCode: input.districtCode,
        status: input.status,
        vintage: input.vintage,
        legislativeDistrictId: input.legislativeDistrictId,
        name: input.name,
        bbox,
        centroid,
      },
    },
  };
}

/**
 * Order features deterministically (state, then district) so the same input
 * always hashes to the same artifact key — which is what makes the
 * `immutable` cache header and hash-based change detection honest.
 */
export function sortFeatures(features: BoundaryFeature[]): BoundaryFeature[] {
  return [...features].sort((a, b) => {
    const s = a.properties.state.localeCompare(b.properties.state);
    return s !== 0 ? s : a.properties.districtCode.localeCompare(b.properties.districtCode);
  });
}

export function toFeatureCollection(features: BoundaryFeature[]): BoundaryFeatureCollection {
  const sorted = sortFeatures(features);
  return {
    type: 'FeatureCollection',
    bbox: unionBbox(sorted.map((f) => f.properties.bbox)),
    features: sorted,
  };
}

/** Content hash of the serialized artifact — the identity of an immutable object. */
export function hashArtifact(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32);
}

/** `'C'`/`'F'` -> the manifest's human-facing status word. */
export function statusWord(status: 'C' | 'F'): 'current' | 'future' {
  return status === 'C' ? 'current' : 'future';
}

/**
 * Immutable, content-addressed artifact key. The hash in the path is what
 * permits `Cache-Control: immutable` — a changed boundary set yields a
 * different key rather than mutating an object clients may have cached.
 */
export function artifactKey(status: 'C' | 'F', vintage: string, hash: string): string {
  return `district-boundaries/congress/${statusWord(status)}/${vintage}/${hash}.geojson`;
}

/**
 * Stable key for the pointer document. Unlike the artifact, this one IS
 * overwritten in place — it is how a client discovers the current hash, so it
 * must be at a predictable location and must not be cached hard.
 */
export function manifestKey(status: 'C' | 'F'): string {
  return `district-boundaries/congress/${statusWord(status)}/manifest.json`;
}

/**
 * Turn a parsed Census cartographic CD FeatureCollection into keyed boundary
 * features, reporting every dropped feature rather than silently shortening
 * the artifact — a national map that is quietly missing districts is the
 * failure mode most likely to go unnoticed.
 *
 * `legislativeDistrictIdFor` lets the caller attach the matching
 * `LegislativeDistrict.id` (looked up by state+code) without this function
 * needing database access.
 */
export function buildCollectionFromCensus(
  rawFeatures: Array<{ properties?: unknown; geometry?: unknown }>,
  options: {
    legislativeDistrictIdFor?: (state: string, districtCode: string) => string | null;
    onlyStates?: ReadonlySet<string>;
  } = {},
): { features: BoundaryFeature[]; vintage: string | null; warnings: string[] } {
  const features: BoundaryFeature[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let vintage: string | null = null;

  for (const raw of rawFeatures) {
    const props = (raw.properties ?? {}) as CensusCdProperties;
    const key = resolveCensusFeatureKey(props);
    if (!key) {
      warnings.push(
        `skipped a feature with unresolvable identity (STATEFP=${String(props.STATEFP)}, GEOID=${String(props.GEOID)})`,
      );
      continue;
    }
    if (options.onlyStates && !options.onlyStates.has(key.state)) continue;
    vintage ??= key.vintage;

    const id = `${key.state}-${key.districtCode}`;
    if (seen.has(id)) {
      // Two features keying the same district means one of them is wrong —
      // never merge them, because we cannot tell which boundary is real.
      warnings.push(`duplicate district key ${id} — kept the first, dropped a later feature`);
      continue;
    }

    const built = buildFeature({
      state: key.state,
      districtCode: key.districtCode,
      status: 'C',
      vintage: key.vintage,
      name: key.name,
      legislativeDistrictId:
        options.legislativeDistrictIdFor?.(key.state, key.districtCode) ?? null,
      geometry: raw.geometry,
    });
    if ('problems' in built) {
      warnings.push(`skipped ${id}: ${built.problems.join('; ')}`);
      continue;
    }
    seen.add(id);
    features.push(built.feature);
  }

  return { features, vintage, warnings };
}

/**
 * Cross-check a future (LegiStorm) boundary against the current (Census) one
 * for the same district. A redistricting boundary legitimately differs, so
 * this only flags GROSS mismatches — a centroid that has moved implausibly far
 * usually means the KML was attached to the wrong district, not that a map
 * changed. Distance is in degrees, which is adequate for a sanity check.
 */
export function grossCentroidMismatch(
  a: Position,
  b: Position,
  toleranceDegrees = 5,
): { mismatch: boolean; distanceDegrees: number } {
  const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { mismatch: distance > toleranceDegrees, distanceDegrees: distance };
}
