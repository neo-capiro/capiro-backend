import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DistrictNexusMapLibre } from './DistrictNexusMapLibre.js';
import type {
  BoundaryFeatureCollection,
  DistrictNexusDistrictSummary,
} from '../../../pages/intelligence/district-nexus/district-nexus-api.js';
import {
  NO_NEXUS_FILL,
  metricValue,
  rampColorForValue,
} from '../../../pages/intelligence/district-nexus/district-nexus-format.js';

/**
 * Behavior tests for the shared district map, written after live QA found the
 * DN page's map fitting the wrong viewport with no visible polygons
 * (2026-08-18). jsdom cannot execute MapLibre, so `@vis.gl/react-maplibre` is
 * mocked to CAPTURE what the component tells the engine — which is exactly
 * the contract that broke silently before:
 *  - the camera-fit calls (CONUS vs footprint union, per `fit` mode);
 *  - the sources/layers actually mounted (choropleth polygons, facility
 *    points) and the per-feature `__color` the fill layer reads.
 */

const { fitBoundsMock, setFeatureStateMock } = vi.hoisted(() => ({
  fitBoundsMock: vi.fn(),
  setFeatureStateMock: vi.fn(),
}));

vi.mock('@vis.gl/react-maplibre', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const Map = React.forwardRef(function MockMap(props: any, ref: React.Ref<unknown>) {
    React.useImperativeHandle(ref, () => ({
      fitBounds: fitBoundsMock,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      setFeatureState: setFeatureStateMock,
    }));
    React.useEffect(() => {
      props.onLoad?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement('div', { 'data-testid': 'mock-maplibre' }, props.children);
  });
  const Source = (props: any) =>
    React.createElement(
      'div',
      {
        'data-testid': `source-${props.id}`,
        'data-features': JSON.stringify(
          (props.data?.features ?? []).map((f: any) => ({ id: f.id, color: f.properties?.__color })),
        ),
      },
      props.children,
    );
  const Layer = (props: any) => React.createElement('div', { 'data-testid': `layer-${props.id}` });
  return { Map, Source, Layer };
});

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

// supportsWebGL() probes a real canvas context, which jsdom does not
// implement. Stub it truthy BEFORE the first render — the module caches the
// first probe for the process lifetime. (The webgl-off fallback path is
// covered in DistrictNexusMapVNext.unavailable.test.tsx, where no stub exists
// and the probe legitimately fails.)
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;

function feature(id: string, bbox: [number, number, number, number], name: string) {
  const [w, s, e, n] = bbox;
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
      name,
      bbox,
      centroid: [(w + e) / 2, (s + n) / 2] as [number, number],
    },
  };
}

/** TX-23 and CA-12 have nexus; WY-00 exists in the artifact but not in the
 * district set — its fill must be the distinct "no verified nexus" color. */
const GEOJSON: BoundaryFeatureCollection = {
  type: 'FeatureCollection',
  bbox: [-125.2, 24.4, -66.8, 49.6],
  features: [
    feature('TX-23', [-101.5, 28.9, -98.2, 31.2], 'Texas 23rd'),
    feature('CA-12', [-122.6, 37.6, -122.3, 37.9], 'California 12th'),
    feature('WY-00', [-111.1, 40.9, -104.1, 45.0], 'Wyoming at large'),
  ],
};

const MANIFEST = {
  status: 'current',
  vintage: '119',
  generatedAt: '2026-08-01T00:00:00Z',
  districtCount: 3,
  source: 'census_cartographic_500k',
  hash: 'h',
  gzipBytes: 1,
  warnings: [],
};

function district(overrides: Partial<DistrictNexusDistrictSummary>): DistrictNexusDistrictSummary {
  return {
    districtKey: 'TX-23',
    state: 'TX',
    districtCode: '23',
    status: 'C',
    name: 'Texas 23rd',
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

const DISTRICTS = [
  district({}),
  district({ districtKey: 'CA-12', state: 'CA', districtCode: '12', name: 'California 12th', score: 88, employeeCount: null, employeesUnreported: true }),
];

const CONUS: [[number, number], [number, number]] = [
  [-125.2, 24.4],
  [-66.8, 49.6],
];
/** Union of the TX-23 and CA-12 feature bboxes — [[west, south], [east, north]]. */
const FOOTPRINT_UNION: [[number, number], [number, number]] = [
  [-122.6, 28.9],
  [-98.2, 37.9],
];

function renderMap(props: Partial<Parameters<typeof DistrictNexusMapLibre>[0]> = {}) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/geojson')) return { data: GEOJSON };
    if (url.includes('/boundaries')) return { data: MANIFEST };
    throw new Error(`unexpected GET ${url}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DistrictNexusMapLibre
        districts={DISTRICTS}
        selectedDistrictKey={null}
        onSelectDistrict={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function sourceFeatures(testId: string): Array<{ id: string; color: string }> {
  return JSON.parse(screen.getByTestId(testId).getAttribute('data-features')!);
}

beforeEach(() => {
  apiGetMock.mockReset();
  fitBoundsMock.mockClear();
  setFeatureStateMock.mockClear();
});

describe('camera fit — the viewport the user actually lands on', () => {
  test("default 'footprint' mode (client-crm) fits the districts' bbox union once loaded", async () => {
    renderMap();
    await waitFor(() => expect(fitBoundsMock).toHaveBeenCalled());
    expect(fitBoundsMock).toHaveBeenCalledWith(FOOTPRINT_UNION, { padding: 48, maxZoom: 6.5, animate: false });
  });

  test('token mode with NO client scope fits CONUS — never a stray footprint or world view', async () => {
    renderMap({ fit: { token: null } });
    await waitFor(() => expect(fitBoundsMock).toHaveBeenCalled());
    expect(fitBoundsMock).toHaveBeenCalledWith(CONUS, { padding: 24, animate: false });
    expect(fitBoundsMock).not.toHaveBeenCalledWith(FOOTPRINT_UNION, expect.anything());
  });

  test('token mode WITH a client scope fits the footprint union', async () => {
    renderMap({ fit: { token: 'client-1' } });
    await waitFor(() => expect(fitBoundsMock).toHaveBeenCalled());
    expect(fitBoundsMock).toHaveBeenCalledWith(FOOTPRINT_UNION, { padding: 48, maxZoom: 6.5, animate: false });
  });

  test('the "Fit footprint" control refits the same union on demand', async () => {
    renderMap({ fit: { token: null } });
    await waitFor(() => expect(fitBoundsMock).toHaveBeenCalled());
    fitBoundsMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Fit footprint' }));
    expect(fitBoundsMock).toHaveBeenCalledWith(FOOTPRINT_UNION, { padding: 48, maxZoom: 6.5, animate: false });
  });
});

describe('layer presence — what actually reaches the GL engine', () => {
  test('mounts the district source with fill + outline layers, coloring matched districts by metric and unmatched ones as no-nexus', async () => {
    renderMap();
    await screen.findByTestId('source-pfdn-districts');
    expect(screen.getByTestId('layer-pfdn-district-fill')).toBeTruthy();
    expect(screen.getByTestId('layer-pfdn-district-outline')).toBeTruthy();

    const byId = Object.fromEntries(sourceFeatures('source-pfdn-districts').map((f) => [f.id, f.color]));
    expect(byId['TX-23']).toBe(rampColorForValue(metricValue(DISTRICTS[0]!, 'nexus'), 'nexus'));
    expect(byId['CA-12']).toBe(rampColorForValue(metricValue(DISTRICTS[1]!, 'nexus'), 'nexus'));
    // A district with no nexus under current filters must be visually
    // distinct from the ramp's lowest step — "no data" never reads as "low".
    expect(byId['WY-00']).toBe(NO_NEXUS_FILL);
    // Sanity: the two scored districts land on different ramp steps.
    expect(byId['TX-23']).not.toBe(byId['CA-12']);
  });

  test('the metric prop recolors the choropleth (clients scale, not nexus)', async () => {
    renderMap({ metric: 'clients' });
    await screen.findByTestId('source-pfdn-districts');
    const byId = Object.fromEntries(sourceFeatures('source-pfdn-districts').map((f) => [f.id, f.color]));
    expect(byId['TX-23']).toBe(rampColorForValue(metricValue(DISTRICTS[0]!, 'clients'), 'clients'));
    expect(screen.getByText('Clients with nexus')).toBeTruthy(); // legend follows the scale
  });

  test('controlled facilities layer: present when on, absent when off', async () => {
    const { unmount } = renderMap({ showFacilities: true, onShowFacilitiesChange: vi.fn() });
    await screen.findByTestId('source-pfdn-facilities');
    expect(screen.getByTestId('layer-pfdn-facility-points')).toBeTruthy();
    // One centroid marker per district with employee signal (TX-23 + CA-12).
    expect(sourceFeatures('source-pfdn-facilities')).toHaveLength(2);
    unmount();

    renderMap({ showFacilities: false, onShowFacilitiesChange: vi.fn() });
    await screen.findByTestId('source-pfdn-districts');
    expect(screen.queryByTestId('source-pfdn-facilities')).toBeNull();
  });

  test('uncontrolled default (client-crm): facilities start off and the built-in toggle turns them on', async () => {
    renderMap();
    await screen.findByTestId('source-pfdn-districts');
    expect(screen.queryByTestId('source-pfdn-facilities')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Facilities' }));
    expect(await screen.findByTestId('source-pfdn-facilities')).toBeTruthy();
  });

  test('a layersSlot replaces the built-in Facilities toggle', async () => {
    renderMap({
      showFacilities: true,
      onShowFacilitiesChange: vi.fn(),
      layersSlot: <span data-testid="custom-layers-slot" />,
    });
    await screen.findByTestId('source-pfdn-districts');
    expect(screen.getByTestId('custom-layers-slot')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Facilities' })).toBeNull();
  });

  test('selection is pushed to the engine via feature-state on the district source', async () => {
    renderMap({ selectedDistrictKey: 'CA-12' });
    await waitFor(() => expect(setFeatureStateMock).toHaveBeenCalled());
    expect(setFeatureStateMock).toHaveBeenCalledWith(
      { source: 'pfdn-districts', id: 'CA-12' },
      { selected: true },
    );
    expect(setFeatureStateMock).toHaveBeenCalledWith(
      { source: 'pfdn-districts', id: 'TX-23' },
      { selected: false },
    );
  });
});
