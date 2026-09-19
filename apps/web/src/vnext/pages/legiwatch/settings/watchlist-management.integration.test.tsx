// Load the actual lazy editor before timed interactions; no component is mocked.
import './WatchlistSetup.js';
import { App as AntApp } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => api }));
vi.mock('../../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' }, isLoading: false }),
}));
vi.mock('../../../../lib/intel-feature-flags.js', async (original) => ({
  ...(await original<typeof import('../../../../lib/intel-feature-flags.js')>()),
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, userId: 'u-1', orgId: 'tenant-1' }),
}));

import { isVNextLegiWatchPath, VNextLegiWatchRoutes } from '../VNextLegiWatchRoutes.js';

const clients = [
  { id: 'client-A', name: 'Alpha', status: 'active' },
  { id: 'client-B', name: 'Beta', status: 'active' },
];
let watchlists: Record<string, { issueAreas: string[]; topics: unknown[] }>;
let failWatchlist = false;

beforeEach(() => {
  vi.clearAllMocks();
  failWatchlist = false;
  watchlists = {
    'client-A': { issueAreas: [], topics: [] },
    'client-B': { issueAreas: [], topics: [] },
  };
  api.get.mockImplementation(async (url: string) => {
    if (url === '/api/clients') return { data: clients };
    if (url.startsWith('/api/me')) return { data: { user: { legiwatchPrefs: {} } } };
    if (url.endsWith('/alert-prefs')) return { data: { triggers: [], materiality: 'medium' } };
    if (url.endsWith('/compiled')) return { data: { termSurfaces: {} } };
    if (url.endsWith('/seed-suggestions')) return { data: { tags: [], issueAreas: [] } };
    if (url === '/intel-api/tracker/issue-areas')
      return { data: { issueAreas: ['Defense', 'Health'] } };
    const match = url.match(/^\/intel-api\/tracker\/watchlists\/(client-[AB])$/);
    if (match) {
      if (failWatchlist) throw new Error('Watchlist unavailable');
      return { data: structuredClone(watchlists[match[1]!]) };
    }
    if (url.endsWith('/tracker/summary')) return { data: { boardCount: 0, unread: 0 } };
    if (url.endsWith('/recommendations')) return { data: [] };
    if (url.includes('/tracker/board')) return { data: { columns: [], total: 0 } };
    if (url.includes('/feed?'))
      return { data: { items: [], counts: {}, workStateCounts: {}, total: 0, hasMore: false } };
    if (url.includes('/calendar?')) return { data: { items: [], total: 0 } };
    if (url.includes('/history?')) return { data: { items: [], total: 0 } };
    if (url.includes('/coverage')) return { data: { committees: [] } };
    throw new Error(`Unexpected GET ${url}`);
  });
  api.put.mockImplementation(async (url: string, body: unknown) => {
    const match = url.match(/^\/intel-api\/tracker\/watchlists\/(client-[AB])$/);
    if (match) {
      watchlists[match[1]!] = structuredClone(body as (typeof watchlists)[string]);
      return { data: structuredClone(body) };
    }
    throw new Error(`Unexpected PUT ${url}`);
  });
});

afterEach(cleanup);

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
        {location.hash}
      </output>
      <button onClick={() => navigate(-1)}>Browser back</button>
    </>
  );
}

function mount(initial: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <MemoryRouter initialEntries={[initial]}>
          <VNextLegiWatchRoutes />
          <LocationProbe />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
  return qc;
}

describe('LW-07 real watchlist management routes', () => {
  it.each(['watchlist', 'watchlists'])(
    'legacy /radar?tab=%s preserves client and opens the canonical editable configuration',
    async (tab) => {
      expect(isVNextLegiWatchPath('/radar')).toBe(true);
      mount(`/radar?tab=${tab}&client=client-A&retained=yes#targeting`);
      const setup = await screen.findByLabelText('Client watchlist setup', {}, { timeout: 5000 });
      expect(screen.getByTestId('location')).toHaveTextContent(
        `/legiwatch?tab=${tab}&client=client-A&retained=yes#targeting`,
      );
      expect(await within(setup).findByRole('button', { name: 'Defense' })).toBeEnabled();
      expect(screen.getByLabelText('Client for watchlist setup')).toHaveValue('client-A');
      expect(screen.queryByLabelText('Week calendar')).not.toBeInTheDocument();
    },
  );

  it('Settings setup opens a different view, saves through the canonical client PUT and survives remount', async () => {
    const qc = mount('/legiwatch?tab=settings&client=client-A');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open watchlist / monitoring setup' }),
    );
    const setup = await screen.findByLabelText('Client watchlist setup', {}, { timeout: 5000 });
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/legiwatch?tab=settings&sub=watchlist&client=client-A',
    );
    // The same cache used by the module's gate must be invalidated after save.
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    fireEvent.click(await within(setup).findByRole('button', { name: 'Defense' }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        '/intel-api/tracker/watchlists/client-A',
        expect.objectContaining({ issueAreas: ['Defense'] }),
      ),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['lw-vnext', 'watchlist-peek', 'client-A'],
      }),
    );
    expect(api.put.mock.calls.some(([url]) => String(url).includes('/watch-presets'))).toBe(false);
    await waitFor(() =>
      expect(qc.getQueryData(['lw-vnext', 'watchlist-peek', 'client-A'])).toMatchObject({
        issueAreas: ['Defense'],
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: /^Feed/ }));
    expect(screen.queryByLabelText('Watchlist setup required')).not.toBeInTheDocument();
    cleanup();
    mount('/legiwatch?tab=settings&sub=watchlist&client=client-A');
    expect(await screen.findByRole('button', { name: 'Defense' })).toHaveClass('on');
  });

  it.each(['', '&client=missing'])(
    'does not silently select or edit another client for unscoped/unavailable links %s',
    async (scope) => {
      mount(`/legiwatch?tab=watchlist${scope}`);
      const select = await screen.findByLabelText('Client for watchlist setup');
      expect(select).toHaveValue('');
      expect(screen.queryByRole('button', { name: 'Defense' })).not.toBeInTheDocument();
      fireEvent.change(select, { target: { value: 'client-B' } });
      expect(await screen.findByRole('button', { name: 'Defense' })).toBeEnabled();
      expect(screen.getByTestId('location')).toHaveTextContent('client=client-B');
      expect(api.put).not.toHaveBeenCalled();
    },
  );

  it('a failed watchlist read never creates an empty editable replacement; retry recovers', async () => {
    failWatchlist = true;
    mount('/legiwatch?tab=settings&sub=watchlist&client=client-A');
    expect(await screen.findByText(/Configuration could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Defense' })).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
    failWatchlist = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry configuration' }));
    expect(await screen.findByRole('button', { name: 'Defense' })).toBeEnabled();
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'unknown inherited-property tab %s safely renders Hearings',
    async (tab) => {
      mount(`/legiwatch?tab=${tab}`);
      expect(
        await screen.findByRole('heading', { name: 'Hearings', level: 1 }),
      ).toBeInTheDocument();
    },
  );

});
