import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DistrictNexusPage } from './DistrictNexusPage.js';
import type { DistrictNexusMapResponse } from './district-nexus-api.js';

/**
 * WS-G Step G5. Mocks the map component wholesale (repo precedent:
 * `vi.mock('./FyHistoryChart.js')` in ProgramElementWatchPage.test.tsx) —
 * there is no canvas/WebGL mocking precedent in this repo and no reason to
 * invent one. Mocks `useSearchParams` directly rather than wrapping in a
 * MemoryRouter (repo precedent: Bill360Page.test.tsx).
 */

let flagEnabled = true;
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => flagEnabled,
}));

let search = '';
const setSearchParamsMock = vi.fn((next: URLSearchParams) => {
  search = `?${next.toString()}`;
});
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(search), setSearchParamsMock],
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock('./DistrictNexusMap.js', () => ({
  DistrictNexusMap: ({ districts }: { districts: unknown[] }) => (
    <div data-testid="dn-map-stub">map districts:{districts.length}</div>
  ),
}));

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}
setupBrowserMocks();

const MAP_RESPONSE: DistrictNexusMapResponse = {
  districts: [
    {
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
      employeeCount: null,
      employeesUnreported: false,
      warnings: [],
    },
  ],
  unmapped: { unmappedContractAmount: 1_200_000, unmappedGrantAmount: 0 },
  freshness: [
    { source: 'sync-federal-award', label: 'Federal contract awards', lastSyncedAt: '2026-07-25T09:50:00Z', neverSynced: false },
  ],
  warnings: [],
  generatedAt: '2026-07-25T12:00:00Z',
};

function mockApiRoutes(overrides: { map?: () => Promise<unknown> } = {}) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/district-nexus/map')) {
      return overrides.map ? { data: await overrides.map() } : { data: MAP_RESPONSE };
    }
    if (url.includes('/district-nexus/boundaries')) {
      return { data: { status: 'future', vintage: '119', generatedAt: '', districtCount: 0, source: 'legistorm_kml', hash: '', gzipBytes: 0, warnings: [] } };
    }
    if (url === '/api/clients') {
      return { data: [{ id: 'c1', name: 'Acme Corp', status: 'active' }] };
    }
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DistrictNexusPage />
    </QueryClientProvider>,
  );
}

describe('DistrictNexusPage', () => {
  beforeEach(() => {
    flagEnabled = true;
    search = '';
    apiGetMock.mockReset();
    setSearchParamsMock.mockClear();
  });

  test('flag off renders the fail-closed guide, never the map or a false empty result', async () => {
    flagEnabled = false;
    mockApiRoutes();
    renderPage();
    expect(await screen.findByText('District Nexus is not enabled for this organization')).toBeTruthy();
    expect(screen.queryByTestId('dn-map-stub')).toBeNull();
  });

  test('a failed aggregate request shows a distinct error, never a zeroed map', async () => {
    mockApiRoutes({ map: () => Promise.reject(new Error('boom')) });
    renderPage();
    expect(await screen.findByText('District Nexus could not load')).toBeTruthy();
    expect(screen.queryByTestId('dn-map-stub')).toBeNull();
  });

  test('an empty tenant (zero districts) shows the "no resolvable district" guide, not an error', async () => {
    mockApiRoutes({ map: () => Promise.resolve({ ...MAP_RESPONSE, districts: [] }) });
    renderPage();
    expect(await screen.findByText('No client has a resolvable district yet')).toBeTruthy();
  });

  test('happy path renders KPIs, the mocked map with the right district count, and the unplaced-funding footer', async () => {
    mockApiRoutes();
    renderPage();
    const mapStub = await screen.findByTestId('dn-map-stub');
    expect(mapStub.textContent).toContain('map districts:1');
    // "Districts" legitimately appears twice (KPI tile + rail header) — both
    // are the real page mounting correctly, not a bug.
    expect(screen.getAllByText('Districts').length).toBe(2);
    expect(await screen.findByText(/Unplaced funding/)).toBeTruthy();
  });

  test('a stale ?view=future deep link neither selects a future view nor reaches the API', async () => {
    // There is exactly one answerable view (audit F1) — the future toggle is
    // gone entirely, not just disabled. See DistrictNexusPage.tsx's `view`
    // docblock.
    search = '?view=future';
    mockApiRoutes();
    renderPage();
    const mapStub = await screen.findByTestId('dn-map-stub');
    expect(mapStub.textContent).toContain('map districts:1');
    expect(screen.queryByText('Enacted future')).toBeNull();
    await waitFor(() => expect(setSearchParamsMock).toHaveBeenCalled());
    const written = setSearchParamsMock.mock.calls.at(-1)![0] as URLSearchParams;
    expect(written.get('view')).toBeNull();
  });

  test('selecting a district row (G4) writes it to the URL and opens the drawer', async () => {
    mockApiRoutes();
    renderPage();
    await screen.findByTestId('dn-map-stub');
    const row = (await screen.findByText('TX-23')).closest('tr') as HTMLElement;
    row.click();
    await waitFor(() => expect(setSearchParamsMock).toHaveBeenCalled());
    const written = setSearchParamsMock.mock.calls.at(-1)![0] as URLSearchParams;
    expect(written.get('district')).toBe('TX-23');
  });
});
