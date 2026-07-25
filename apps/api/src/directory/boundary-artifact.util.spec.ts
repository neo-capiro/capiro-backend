import { describe, expect, test } from '@jest/globals';
import {
  artifactKey,
  buildFeature,
  computeBbox,
  computeCentroid,
  grossCentroidMismatch,
  hashArtifact,
  kmlToGeometry,
  manifestKey,
  readCensusDistrictColumn,
  resolveCensusFeatureKey,
  sortFeatures,
  toFeatureCollection,
  unionBbox,
  validateGeometry,
  type BoundaryFeature,
  type PolygonGeometry,
} from './boundary-artifact.util.js';

/** A closed unit square, the simplest valid ring. */
const SQUARE: PolygonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
};

describe('resolveCensusFeatureKey', () => {
  test('reads the vintage off whichever CD<n>FP column the file carries', () => {
    // The column is named after the congress, so it changes every cycle —
    // hardcoding CD119FP would silently break on the next file.
    expect(readCensusDistrictColumn({ CD119FP: '23' })).toEqual({ vintage: '119', value: '23' });
    expect(readCensusDistrictColumn({ CD120FP: '01' })).toEqual({ vintage: '120', value: '01' });
    expect(readCensusDistrictColumn({ STATEFP: '48' })).toBeNull();
  });

  test('maps state FIPS to USPS and zero-pads the district', () => {
    expect(resolveCensusFeatureKey({ STATEFP: '48', CD119FP: '23', NAMELSAD: 'CD 23' })).toEqual({
      state: 'TX',
      districtCode: '23',
      vintage: '119',
      name: 'CD 23',
    });
    expect(resolveCensusFeatureKey({ STATEFP: '48', CD119FP: '07' })?.districtCode).toBe('07');
  });

  test("Census '00' at-large and '98' delegate both land on the facility sentinel", () => {
    // Both must key as '00' or they never join a geocoded at-large facility.
    expect(resolveCensusFeatureKey({ STATEFP: '56', CD119FP: '00' })?.districtCode).toBe('00');
    expect(resolveCensusFeatureKey({ STATEFP: '11', CD119FP: '98' })?.districtCode).toBe('00');
    expect(resolveCensusFeatureKey({ STATEFP: '72', CD119FP: '98' })?.districtCode).toBe('00');
  });

  test("a single-seat state reporting '01' still keys at-large", () => {
    // Apportionment decides at-largeness, not the reported number.
    expect(resolveCensusFeatureKey({ STATEFP: '56', CD119FP: '01' })?.districtCode).toBe('00');
  });

  test('returns null rather than guessing for unusable input', () => {
    expect(resolveCensusFeatureKey({ CD119FP: '23' })).toBeNull(); // no STATEFP
    expect(resolveCensusFeatureKey({ STATEFP: '99', CD119FP: '01' })).toBeNull(); // unknown FIPS
    expect(resolveCensusFeatureKey({ STATEFP: '48' })).toBeNull(); // no CD column
  });
});

describe('validateGeometry', () => {
  test('accepts a well-formed closed polygon', () => {
    expect(validateGeometry(SQUARE)).toEqual([]);
  });

  test('rejects non-polygon geometry types', () => {
    expect(validateGeometry({ type: 'Point', coordinates: [0, 0] })[0]).toMatch(/unsupported/);
    expect(validateGeometry(null)[0]).toMatch(/not an object/);
  });

  test('rejects an unclosed ring', () => {
    const open = {
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]],
    };
    expect(validateGeometry(open).some((p) => /not closed/.test(p))).toBe(true);
  });

  test('rejects a ring with too few positions', () => {
    expect(validateGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })[0]).toMatch(
      /fewer than 4/,
    );
  });

  test('rejects out-of-range and non-finite coordinates', () => {
    const badLat = {
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 999], [0, 2], [0, 0]]],
    };
    expect(validateGeometry(badLat).some((p) => /outside valid lon\/lat/.test(p))).toBe(true);

    const nan = {
      type: 'Polygon',
      coordinates: [[[0, 0], [Number.NaN, 0], [2, 2], [0, 2], [0, 0]]],
    };
    expect(validateGeometry(nan).some((p) => /non-finite/.test(p))).toBe(true);
  });

  test('rejects an empty coordinate array', () => {
    expect(validateGeometry({ type: 'MultiPolygon', coordinates: [] })[0]).toMatch(/no coordinates/);
  });
});

describe('bbox and centroid', () => {
  test('bbox is [west, south, east, north]', () => {
    expect(computeBbox(SQUARE)).toEqual([0, 0, 2, 2]);
  });

  test('centroid of a square is its middle', () => {
    const [x, y] = computeCentroid(SQUARE);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(1);
  });

  test('centroid is area-weighted, not the bbox centre', () => {
    // An L-shape: the bbox centre (1,1) sits in the notch, the area-weighted
    // centroid does not. This is why label anchors use the real centroid.
    const lShape: PolygonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    const [x, y] = computeCentroid(lShape);
    expect(x).toBeCloseTo(0.8333, 3);
    expect(y).toBeCloseTo(0.8333, 3);
  });

  test('degenerate zero-area geometry still yields a centroid', () => {
    const line: PolygonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [0, 0],
        ],
      ],
    };
    const [x, y] = computeCentroid(line);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  test('unionBbox spans every input box', () => {
    expect(
      unionBbox([
        [-10, 0, 0, 5],
        [-2, -8, 12, 1],
      ]),
    ).toEqual([-10, -8, 12, 5]);
  });
});

describe('kmlToGeometry', () => {
  const ring = '0,0,0 2,0,0 2,2,0 0,2,0 0,0,0';

  test('parses a single Placemark polygon and drops elevation', () => {
    const kml = `<kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
    const geom = kmlToGeometry(kml);
    expect(geom?.type).toBe('Polygon');
    expect((geom as PolygonGeometry).coordinates[0]![0]).toEqual([0, 0]);
    expect(validateGeometry(geom)).toEqual([]);
  });

  test('closes an unclosed KML ring so the output is valid GeoJSON', () => {
    const kml = `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>0,0 2,0 2,2 0,2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const geom = kmlToGeometry(kml) as PolygonGeometry;
    const first = geom.coordinates[0]![0];
    const last = geom.coordinates[0]![geom.coordinates[0]!.length - 1];
    expect(first).toEqual(last);
    expect(validateGeometry(geom)).toEqual([]);
  });

  test('multiple polygons become a MultiPolygon', () => {
    const kml = `<kml><Document>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
      <Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>10,10 12,10 12,12 10,12 10,10</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`;
    const geom = kmlToGeometry(kml);
    expect(geom?.type).toBe('MultiPolygon');
    expect((geom as { coordinates: unknown[] }).coordinates).toHaveLength(2);
  });

  test('finds polygons nested in MultiGeometry and Folders', () => {
    const kml = `<kml><Document><Folder><Placemark><MultiGeometry>
      <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </MultiGeometry></Placemark></Folder></Document></kml>`;
    expect(kmlToGeometry(kml)?.type).toBe('Polygon');
  });

  test('preserves innerBoundaryIs rings as holes', () => {
    const kml = `<kml><Placemark><Polygon>
      <outerBoundaryIs><LinearRing><coordinates>0,0 10,0 10,10 0,10 0,0</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>2,2 4,2 4,4 2,4 2,2</coordinates></LinearRing></innerBoundaryIs>
    </Polygon></Placemark></kml>`;
    const geom = kmlToGeometry(kml) as PolygonGeometry;
    expect(geom.coordinates).toHaveLength(2);
  });

  test('returns null for KML with no usable polygon', () => {
    expect(kmlToGeometry('<kml><Document></Document></kml>')).toBeNull();
    expect(
      kmlToGeometry('<kml><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></kml>'),
    ).toBeNull();
    // A hole with no exterior ring is not a polygon.
    expect(
      kmlToGeometry(
        '<kml><Placemark><Polygon><innerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></kml>',
      ),
    ).toBeNull();
  });

  test('does not coerce coordinate strings into numbers', () => {
    // parseTagValue:false guards against fast-xml-parser turning a lone
    // "0,0 ..." string or a zero-padded value into a number.
    const kml = `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    expect(() => kmlToGeometry(kml)).not.toThrow();
  });
});

describe('buildFeature', () => {
  const base = {
    state: 'TX',
    districtCode: '23',
    status: 'C' as const,
    vintage: '119',
    name: 'CD 23',
    legislativeDistrictId: '603-C',
  };

  test('produces a keyed feature carrying bbox and centroid', () => {
    const result = buildFeature({ ...base, geometry: SQUARE });
    expect('feature' in result).toBe(true);
    if (!('feature' in result)) return;
    expect(result.feature.id).toBe('TX-23');
    expect(result.feature.properties.districtCode).toBe('23');
    expect(result.feature.properties.legislativeDistrictId).toBe('603-C');
    expect(result.feature.properties.bbox).toEqual([0, 0, 2, 2]);
  });

  test('reports problems instead of emitting a broken feature', () => {
    const result = buildFeature({ ...base, geometry: { type: 'Point', coordinates: [0, 0] } });
    expect('problems' in result).toBe(true);
  });
});

describe('artifact identity', () => {
  const feature = (state: string, districtCode: string): BoundaryFeature => {
    const built = buildFeature({
      state,
      districtCode,
      status: 'C',
      vintage: '119',
      name: null,
      legislativeDistrictId: null,
      geometry: SQUARE,
    });
    if (!('feature' in built)) throw new Error('fixture must be valid');
    return built.feature;
  };

  test('features sort by state then district, deterministically', () => {
    const sorted = sortFeatures([feature('TX', '23'), feature('CA', '02'), feature('TX', '07')]);
    expect(sorted.map((f) => f.id)).toEqual(['CA-02', 'TX-07', 'TX-23']);
  });

  test('the same feature set hashes identically regardless of input order', () => {
    // This is the property that makes Cache-Control: immutable safe.
    const a = toFeatureCollection([feature('TX', '23'), feature('CA', '02')]);
    const b = toFeatureCollection([feature('CA', '02'), feature('TX', '23')]);
    expect(hashArtifact(JSON.stringify(a))).toBe(hashArtifact(JSON.stringify(b)));
  });

  test('a changed feature set yields a different hash and therefore a different key', () => {
    const a = toFeatureCollection([feature('TX', '23')]);
    const b = toFeatureCollection([feature('TX', '23'), feature('CA', '02')]);
    const ha = hashArtifact(JSON.stringify(a));
    const hb = hashArtifact(JSON.stringify(b));
    expect(ha).not.toBe(hb);
    expect(artifactKey('C', '119', ha)).not.toBe(artifactKey('C', '119', hb));
  });

  test('collection bbox spans all features', () => {
    const collection = toFeatureCollection([feature('TX', '23')]);
    expect(collection.bbox).toEqual([0, 0, 2, 2]);
  });

  test('keys are content-addressed under the status/vintage path', () => {
    expect(artifactKey('C', '119', 'abc')).toBe(
      'district-boundaries/congress/current/119/abc.geojson',
    );
    expect(artifactKey('F', '119', 'abc')).toBe(
      'district-boundaries/congress/future/119/abc.geojson',
    );
    // The manifest is the mutable pointer, so its key carries no hash.
    expect(manifestKey('C')).toBe('district-boundaries/congress/current/manifest.json');
  });
});

describe('grossCentroidMismatch', () => {
  test('tolerates a real redistricting shift', () => {
    expect(grossCentroidMismatch([-98, 30], [-98.4, 30.3]).mismatch).toBe(false);
  });

  test('flags a boundary attached to the wrong district', () => {
    const result = grossCentroidMismatch([-98, 30], [-75, 43]);
    expect(result.mismatch).toBe(true);
    expect(result.distanceDegrees).toBeGreaterThan(5);
  });
});
