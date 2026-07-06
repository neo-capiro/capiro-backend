import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    // L2b all-clients board roll-up: client-labelled cards across the tenant.
    if (url.endsWith('/_all/tracker/board')) {
      return {
        data: {
          columns: [
            { id: 'introduced', label: 'Introduced', cards: [] },
            {
              id: 'committee',
              label: 'In committee',
              cards: [
                {
                  billId: 'hr-1',
                  displayNum: 'H.R. 1',
                  title: 'Test Roll-up Act',
                  passageProbability: 80,
                  unread: false,
                  matchedTags: [],
                  changeChip: null,
                  hearingCount: 0,
                  clientId: 'c1',
                  clientName: 'Acme Aerospace',
                },
              ],
            },
          ],
        },
      };
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
    window.localStorage.clear();
    // Default to the returning-user state so the first-run orientation modal
    // (L5) doesn't auto-open and collide with tab-label assertions. The intro
    // itself is covered by its own test below.
    window.localStorage.setItem('legiwatch-intro-seen-v1', '1');
    setupBrowserMocks();
  });

  test('defaults to the Feed tab; when tracker_v2 is off, shows the not-enabled state', async () => {
    mockApi({});
    renderRadar('/radar');

    expect(screen.getByText('LegiWatch')).toBeInTheDocument();
    // All four tabs render regardless of flags.
    for (const label of ['Feed', 'Bills', 'Hearings', 'Configure']) {
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
    // the ClientGate picker prompt. The empty-state copy is the global variant
    // (LegiWatch v2 calm re-skin).
    await waitFor(() =>
      expect(
        screen.getByText(/a hearing hits any client’s watchlist, it lands here/i),
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

    // LegiWatch v2 (L3): lands on the schedule; the watch history is "My Sessions".
    await waitFor(() => expect(screen.getByText('My Sessions')).toBeInTheDocument());
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('All hearings')).toBeInTheDocument();
    // P5: the hearing term-watchlist CRUD was absorbed into the unified editor on
    // the LegiWatch Configure tab — the Hearings surface no longer has its own view.
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

    // LegiWatch v2 (L2): the Bills tab stacks "Recommended by Meri" above "Your
    // board" (no Board|Recs sub-nav toggle) — both section headers are present.
    await waitFor(() => expect(screen.getByText('Your board')).toBeInTheDocument());
    expect(screen.getByText(/Recommended by Meri/)).toBeInTheDocument();
    // "Configure" names the outer LegiWatch tab (renamed from "Watchlist").
    expect(screen.getByText('Configure')).toBeInTheDocument();
    // Calm re-skin board-empty guide copy.
    await waitFor(() => expect(screen.getByText(/Your board is empty/i)).toBeInTheDocument());
  });

  test('L5: first-run orientation auto-opens, dismiss persists, and a "How it works" control exists', async () => {
    // First run: no seen-flag → the orientation auto-opens.
    window.localStorage.removeItem('legiwatch-intro-seen-v1');
    mockApi({});
    renderRadar('/radar');

    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    // The permanent reopen control is present in the top bar.
    expect(screen.getByRole('button', { name: /How it works/i })).toBeInTheDocument();
    // Dismiss ("Got it") persists the per-user seen-flag so it won't reappear.
    fireEvent.click(screen.getByRole('button', { name: /Got it/i }));
    await waitFor(() =>
      expect(window.localStorage.getItem('legiwatch-intro-seen-v1')).toBe('1'),
    );
  });

  test('L2b: Bills at all-clients (tracker_v2 on) shows the tenant board roll-up with client labels', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=bills');

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    expect(screen.getByText('Test Roll-up Act')).toBeInTheDocument();
    // Each card is labelled with its client (U4 roll-up).
    expect(screen.getByText('Acme Aerospace')).toBeInTheDocument();
    // It fetches the tenant-wide board, not a per-client one.
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) => String(args[0]).includes('/_all/tracker/board')),
    ).toBe(true);
  });

  test('L2b: Bills at all-clients without tracker_v2 falls back to the client-gate', async () => {
    mockApi({});
    renderRadar('/radar?tab=bills');

    await waitFor(() =>
      expect(screen.getByText(/Select a client to view its bill board/i)).toBeInTheDocument(),
    );
  });

  test('L5: returning user (seen-flag set) does not see the orientation on load', async () => {
    window.localStorage.setItem('legiwatch-intro-seen-v1', '1');
    mockApi({});
    renderRadar('/radar');

    await waitFor(() => expect(screen.getByText('LegiWatch')).toBeInTheDocument());
    expect(screen.queryByText('What LegiWatch does')).not.toBeInTheDocument();
  });
});
