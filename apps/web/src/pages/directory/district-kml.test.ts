import { describe, expect, test } from 'vitest';
import { parseKmlToSvgPaths } from './district-kml.js';

const SIMPLE_SQUARE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>-97.0,32.0,0 -96.0,32.0,0 -96.0,33.0,0 -97.0,33.0,0 -97.0,32.0,0</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;

const MULTI_PART_WITH_HOLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <MultiGeometry>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>-97.0,32.0,0 -95.0,32.0,0 -95.0,34.0,0 -97.0,34.0,0 -97.0,32.0,0</coordinates>
            </LinearRing>
          </outerBoundaryIs>
          <innerBoundaryIs>
            <LinearRing>
              <coordinates>-96.5,32.5,0 -96.0,32.5,0 -96.0,33.0,0 -96.5,33.0,0 -96.5,32.5,0</coordinates>
            </LinearRing>
          </innerBoundaryIs>
        </Polygon>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>-90.0,25.0,0 -89.5,25.0,0 -89.5,25.5,0 -90.0,25.5,0 -90.0,25.0,0</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
      </MultiGeometry>
    </Placemark>
  </Document>
</kml>`;

describe('parseKmlToSvgPaths', () => {
  test('returns null for empty/invalid input', () => {
    expect(parseKmlToSvgPaths('')).toBeNull();
    expect(parseKmlToSvgPaths('<kml><Document></Document></kml>')).toBeNull();
  });

  test('parses a single outer-boundary polygon into one SVG path', () => {
    const result = parseKmlToSvgPaths(SIMPLE_SQUARE_KML);
    expect(result).not.toBeNull();
    expect(result!.paths).toHaveLength(1);
    expect(result!.paths[0]).toMatch(/^M .* Z$/);
    expect(result!.viewBox).toMatch(/^0 0 \d+(\.\d+)? \d+(\.\d+)?$/);
  });

  test('parses multi-part geometry into one path per Polygon, holes folded into the same path', () => {
    const result = parseKmlToSvgPaths(MULTI_PART_WITH_HOLE_KML);
    expect(result).not.toBeNull();
    // Two <Polygon> elements -> two path strings.
    expect(result!.paths).toHaveLength(2);
    // The first polygon has both an outer boundary and a hole -> two "M...Z" subpaths in one path string.
    expect(result!.paths[0]!.match(/Z/g)).toHaveLength(2);
    // The second polygon has only an outer boundary -> one subpath.
    expect(result!.paths[1]!.match(/Z/g)).toHaveLength(1);
  });

  test('all projected coordinates land within the viewBox bounds', () => {
    const result = parseKmlToSvgPaths(MULTI_PART_WITH_HOLE_KML)!;
    const [, , w, h] = result.viewBox.split(' ').map(Number);
    const coords = result.paths
      .join(' ')
      .split(/[ML]\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => p !== 'Z')
      .map((p) => p.replace(/\s*Z$/, ''))
      .map((p) => p.split(',').map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(w!);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(h!);
    }
  });
});
