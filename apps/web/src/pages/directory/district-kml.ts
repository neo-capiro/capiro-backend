/**
 * Dependency-free KML boundary parsing for a lightweight shape preview.
 * We only need a static silhouette (no basemap, no pan/zoom), so this skips
 * pulling in a full mapping library (Leaflet, etc.) — the boundary is just
 * a set of Polygon/LinearRing coordinate lists, which a plain DOMParser +
 * SVG path can render directly.
 */

export interface KmlBoundary {
  /** One SVG path `d` string per KML <Polygon> (holes via evenodd fill-rule). */
  paths: string[];
  /** SVG viewBox that fits every polygon with a small margin. */
  viewBox: string;
}

function parseCoordinates(text: string): Array<[number, number]> {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((triplet) => {
      const [lon, lat] = triplet.split(',').map(Number);
      return [lon ?? 0, lat ?? 0] as [number, number];
    });
}

function ringCoordinates(ring: Element): Array<[number, number]> {
  const coords = ring.getElementsByTagName('coordinates')[0];
  return coords?.textContent ? parseCoordinates(coords.textContent) : [];
}

/**
 * Parses every <Polygon> in the KML (outer + inner/hole boundaries), applies
 * an equirectangular projection with a cos(meanLatitude) longitude-scale
 * correction (districts are small enough that this reads as the right shape,
 * without needing a real map projection), and returns SVG path data scaled
 * to fit `viewBox`. Returns null if the document has no renderable polygon.
 */
export function parseKmlToSvgPaths(kmlText: string): KmlBoundary | null {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;

  const polygons = Array.from(doc.getElementsByTagName('Polygon'));
  if (polygons.length === 0) return null;

  const rings = polygons.map((polygon) => {
    const outer = polygon.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('LinearRing')[0];
    const inners = Array.from(polygon.getElementsByTagName('innerBoundaryIs')).map(
      (b) => b.getElementsByTagName('LinearRing')[0],
    );
    return {
      outer: outer ? ringCoordinates(outer) : [],
      inners: inners.filter((r): r is Element => r !== undefined).map(ringCoordinates),
    };
  });

  const allPoints = rings.flatMap((r) => [...r.outer, ...r.inners.flat()]);
  if (allPoints.length === 0) return null;

  const lons = allPoints.map((p) => p[0]);
  const lats = allPoints.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const meanLat = (minLat + maxLat) / 2;
  const lonScale = Math.cos((meanLat * Math.PI) / 180);

  const width = Math.max((maxLon - minLon) * lonScale, 1e-6);
  const height = Math.max(maxLat - minLat, 1e-6);
  const targetSize = 300;
  const scale = targetSize / Math.max(width, height);
  const margin = targetSize * 0.05;

  const project = ([lon, lat]: [number, number]): [number, number] => [
    (lon - minLon) * lonScale * scale + margin,
    (maxLat - lat) * scale + margin, // flip Y — SVG grows downward, latitude grows upward
  ];

  const ringPath = (points: Array<[number, number]>): string => {
    if (points.length === 0) return '';
    const projected = points.map(project);
    const [first, ...rest] = projected;
    return `M ${first![0]},${first![1]} ${rest.map(([x, y]) => `L ${x},${y}`).join(' ')} Z`;
  };

  const paths = rings
    .map((r) => [ringPath(r.outer), ...r.inners.map(ringPath)].filter(Boolean).join(' '))
    .filter(Boolean);

  if (paths.length === 0) return null;

  const size = targetSize + margin * 2;
  return { paths, viewBox: `0 0 ${size} ${size}` };
}
