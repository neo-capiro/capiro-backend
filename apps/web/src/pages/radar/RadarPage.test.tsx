import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { RadarPage } from './RadarPage.js';

const apiGetMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
  }),
}));

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

/** URL-keyed API stub; `flags` controls /intel-api/feature-flags. */
function mockApi(flags: Record<string, boolean>) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/intel-api/feature-flags') return { data: flags };
    if (url === '/api/clients') {
      return { data: [{ id: 'c1', name: 'Acme Aerospace', status: 'active' }] };
    }
    if (url === '/intel-api/hearings') return { data: [] };
    if (url === '/intel-api/upcoming-hearings') return { data: [] };
    if (url.startsWith('/intel-api/upcoming-hearings/browse')) {
      return { data: { items: [], total: 0 } };
    }
    if (url.endsWith('/tracker/board')) return { data: { columns: [], total: 0 } };
    if (url.endsWith('/tracker/recommendations')) {
      return { data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } };
    }
    // P11 global cross-client roll-up + per-client feed (empty by default).
    if (url.includes('/_all/feed') || url.includes('/feed')) {
      return { data: { items: [], nextCursor: null, hasMore: false, counts: {} } };
    }
    if (url === '/api/intelligence/issue-areas') return { data: { issueAreas: [] } };
    // Watchlist (P6 cold-start check + Configure panel). Default: configured
    // (so Feed/Bills render the panel, not the guided first-run state).
    if (url.endsWith('/tracker/watchlist')) {
      return { data: { issueAreas: ['Defense'], tags: [] } };
    }
    if (url.endsWith('/tracker/alert-prefs')) {
      return { data: { triggers: [], materiality: 'medium', emailEnabled: false } };
    }
    if (url.endsWith('/tracker/watchlist/seed-suggestions')) {
      return { data: { tags: [], issueAreas: [] } };
    }
    return { data: [] };
  });
}

function renderRadar(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/radar" element={<RadarPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('RadarPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    window.sessionStorage.clear();
    setupBrowserMocks();
  });

  test('defaults to the Feed tab; when tracker_v2 is off, shows the not-enabled state', async () => {
    mockApi({});
    renderRadar('/radar');

    expect(screen.getByText('Radar')).toBeInTheDocument();
    // All four tabs render regardless of flags.
    for (const label of ['Feed', 'Bills', 'Hearings', 'Watchlist']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // P11: the Feed no longer prompts for a client at global altitude; without
    // tracker_v2 it falls to the "not enabled" Empty (no client picker gate).
    await waitFor(() =>
      expect(
        screen.getByText(/unified alert feed is not enabled for this workspace/i),
      ).toBeInTheDocument(),
    );
  });

  test('P11: Feed at global altitude (no client, tracker_v2 on) renders the cross-client roll-up', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar');

    // No client selected → the tenant-wide feed panel renders (empty here), NOT
    // the ClientGate picker prompt. The empty-state copy is the global variant.
    await waitFor(() =>
      expect(
        screen.getByText(/alerts across all your clients will appear here/i),
      ).toBeInTheDocument(),
    );
    // It must hit the tenant-wide roll-up endpoint, not a per-client feed.
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) => String(args[0]).includes('/clients/_all/feed')),
    ).toBe(true);
  });

  test('hearings tab is global (no client) and no longer carries a Watchlists view (absorbed by P5)', async () => {
    mockApi({ hearing_watch: true });
    renderRadar('/radar?tab=hearings');

    await waitFor(() => expect(screen.getByText('Hearing sessions')).toBeInTheDocument());
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('All hearings')).toBeInTheDocument();
    // P5: the hearing term-watchlist CRUD was absorbed into the unified editor on
    // the Radar Watchlist tab — the Hearings surface no longer has its own view.
    expect(screen.queryByText('Watchlists')).not.toBeInTheDocument();
  });

  test('hearings tab respects the hearing_watch flag', async () => {
    mockApi({});
    renderRadar('/radar?tab=hearings');

    await waitFor(() =>
      expect(
        screen.getByText(/Hearing Watch is not enabled for this workspace/i),
      ).toBeInTheDocument(),
    );
  });

  test('bills tab renders the Board/Recs surface for the selected client', async () => {
    mockApi({});
    renderRadar('/radar?tab=bills&client=c1');

    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument());
    expect(screen.getByText(/Recommendations/)).toBeInTheDocument();
    // Bills variant hides the profile-only Configure/Feed sub-nav entries.
    expect(screen.queryByText('Configure')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/No bills on the board yet/i)).toBeInTheDocument(),
    );
  });
});
