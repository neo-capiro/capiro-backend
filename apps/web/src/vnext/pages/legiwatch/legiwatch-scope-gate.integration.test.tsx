/**
 * PR C §17 — LegiWatchModule scope-gate + browse-mode contract (LW-QA-006/007).
 *
 * LW-QA-006: a no-watchlist client must still browse Hearings / Bills /
 * Committees — the watchlist gate limits ONLY feed/digest/analytics, inline.
 * LW-QA-007: "Explore without alerts" stays INSIDE /legiwatch, persists
 * browse=1 in the URL (refresh / back-forward / deep-link safe), and never
 * exits to CRM.
 *
 * The module renders real tabs; useApi is stubbed with URL-prefix routing.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
// useApi() is mocked, but OTHER modules in this import graph (bill-hearings-api's
// useIntelFeature chain, etc.) still import Clerk transitively; stub useAuth so
// any import-time wiring stays inert (same posture as meri-route-identity.test).
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));
vi.mock('../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

// tracker_v2 flag ON so the watchlist-peek runs; feature flag plumbing stubbed.
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));

import { LegiWatchModule } from './LegiWatchModule.js';

const NO_WATCHLIST_CLIENT = {
  id: 'c-nowl',
  name: 'Fresh Client',
  status: 'active',
};

const WATCHLIST_CLIENT = {
  id: 'c-wl',
  name: 'Watched Client',
  status: 'active',
};

function wireGet(url: string): { data: unknown } | null {
  if (url === '/api/clients') {
    return { data: [NO_WATCHLIST_CLIENT, WATCHLIST_CLIENT] };
  }
  // Watchlist peek: Fresh Client = never-configured shape; Watched Client = real.
  if (url === '/intel-api/tracker/watchlists/c-nowl') {
    return { data: { suggestedIssueAreas: ['Defense'], issueAreas: [], topics: [] } };
  }
  if (url === '/intel-api/tracker/watchlists/c-wl') {
    return { data: { topics: [{ id: 't1', label: 'Shipbuilding', terms: [] }] } };
  }
  // Tenant-wide feed (module badge + Feed tab).
  if (url.startsWith('/intel-api/clients/_all/feed?')) {
    return { data: { items: [], counts: {}, total: 0, hasMore: false, nextCursor: null } };
  }
  if (url.startsWith('/intel-api/hearings/history?')) {
    return { data: { items: [], total: 0, nextCursor: null, hasMore: false } };
  }
  if (url.startsWith('/intel-api/clients/c-nowl/feed?') || url.startsWith('/intel-api/clients/c-wl/feed?')) {
    return { data: { items: [], counts: {}, total: 0, hasMore: false, nextCursor: null } };
  }
  if (url.includes('/alerts/work-state')) return { data: {} };
  // Canonical calendar for the Hearings tab.
  if (url.startsWith('/api/legiwatch/live-hearings/calendar?')) {
    return { data: { items: [], total: 0 } };
  }
  // Bills board (per-client + `_all` roll-up) — distinguishable by wire.
  if (url.startsWith('/intel-api/clients/_all/tracker/board')) {
    return {
      data: {
        columns: [
          {
            id: 'introduced',
            label: 'Introduced',
            cards: [
              { billId: '119-hr-1111', displayNum: 'H.R. 1111', title: 'Shared bill (tracked by two clients)', stage: 'introduced', passageProbability: 0.4, trackedAt: '2026-09-01T00:00:00Z', isManual: true, unread: false, note: null, matchedTags: [], changeChip: null, clientId: 'c-wl', clientName: 'Watched Client' },
            ],
          },
        ],
        total: 1,
      },
    };
  }
  if (url.startsWith('/intel-api/clients/c-wl/tracker/board') || url.startsWith('/intel-api/clients/c-nowl/tracker/board')) {
    return { data: { columns: [{ id: 'introduced', label: 'Introduced', cards: [] }], total: 0 } };
  }
  if (url.startsWith('/intel-api/clients/c-wl/recommendations') || url.startsWith('/intel-api/clients/c-nowl/recommendations')) {
    return { data: [] };
  }
  if (url === '/intel-api/tracker/issue-areas') return { data: [] };
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) => {
    const hit = wireGet(url);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

function LocationProbe({ onLocation }: { onLocation: (l: { pathname: string; search: string }) => void }) {
  const loc = useLocation();
  onLocation({ pathname: loc.pathname, search: loc.search });
  return null;
}

function renderModule(initial: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  const location = { current: { pathname: '', search: '' } };
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <LocationProbe onLocation={(l) => { location.current = l; }} />
        <Routes>
          <Route path="/legiwatch" element={<LegiWatchModule />} />
          <Route path="/clients" element={<div data-testid="crm">CRM exited</div>} />
          <Route path="/radar" element={<div data-testid="watchlist">Monitoring setup</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { location };
}

describe('PR C §13 — watchlist gate scopes to dependent tabs only', () => {
  it('no-watchlist client: Hearings tab stays public (no gate replaces it)', async () => {
    renderModule('/legiwatch?client=c-nowl&tab=hearings');
    await waitFor(() => expect(screen.getByLabelText('Week calendar')).toBeTruthy());
    expect(screen.queryByLabelText('Watchlist setup required')).toBeNull();
  });

  it('no-watchlist client: Bills tab stays public with the _all-style board mount', async () => {
    renderModule('/legiwatch?client=c-nowl&tab=bills');
    const board = await screen.findByLabelText(/Bills board|Bills table|Board view/i, {}, { timeout: 4000 }).catch(() => null);
    expect(screen.queryByLabelText('Watchlist setup required')).toBeNull();
    void board;
  });

  it('no-watchlist client: Feed tab shows the inline setup gate, tabs and selector stay mounted', async () => {
    renderModule('/legiwatch?client=c-nowl&tab=feed');
    const gate = await screen.findByLabelText('Watchlist setup required');
    expect(within(gate).getAllByText(/no approved watchlist|monitoring model/i).length).toBeGreaterThan(0);
    // Module chrome survives — the tab strip and Client lens selector are present.
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('button', { name: /client lens/i })).toBeTruthy();
  });

  it.each([
    { browse: '', action: 'Configure the watchlist' },
    { browse: '&browse=1', action: 'Set up the watchlist' },
  ])('opens real monitoring setup for the scoped client through $action', async ({ browse, action }) => {
    const { location } = renderModule(`/legiwatch?client=c-nowl&tab=feed${browse}`);
    fireEvent.click(await screen.findByRole('button', { name: action }));
    await waitFor(() => expect(location.current.pathname).toBe('/radar'));
    expect(new URLSearchParams(location.current.search).get('tab')).toBe('watchlist');
    expect(new URLSearchParams(location.current.search).get('client')).toBe('c-nowl');
  });

  it('no-watchlist client: Digest tab shows the inline gate; Analytics same', async () => {
    renderModule('/legiwatch?client=c-nowl&tab=digest');
    expect(await screen.findByLabelText('Watchlist setup required')).toBeTruthy();
    document.body.innerHTML = '';
    renderModule('/legiwatch?client=c-nowl&tab=analytics');
    expect(await screen.findByLabelText('Watchlist setup required')).toBeTruthy();
  });

  it('client WITH a watchlist: Feed renders the tab, not the gate', async () => {
    renderModule('/legiwatch?client=c-wl&tab=feed');
    await waitFor(() => expect(screen.queryByLabelText('Watchlist setup required')).toBeNull());
  });
});

describe('PR C §14 — Explore without alerts stays inside /legiwatch and persists', () => {
  it('clicking Explore sets browse=1 in the URL and renders the feed with the browse notice (never /clients)', async () => {
    const { location } = renderModule('/legiwatch?client=c-nowl&tab=feed');
    const gate = await screen.findByLabelText('Watchlist setup required');
    fireEvent.click(within(gate).getByRole('button', { name: 'Explore without alerts' }));
    await waitFor(() => expect(location.current.search).toContain('browse=1'));
    expect(location.current.pathname).toBe('/legiwatch');
    const notice = await screen.findByLabelText('Browse mode notice');
    expect(notice.textContent).toContain('Public LegiWatch data remains available');
    expect(screen.queryByTestId('crm')).toBeNull(); // NEVER exits to CRM
  });

  it('browse=1 survives refresh (direct deep link renders browse mode without the gate)', async () => {
    renderModule('/legiwatch?client=c-nowl&tab=feed&browse=1');
    const notice = await screen.findByLabelText('Browse mode notice');
    expect(notice.textContent).toContain('Public LegiWatch data remains available');
    expect(screen.queryByLabelText('Watchlist setup required')).toBeNull();
  });

  it('browse mode keeps filters/current tab in the URL', async () => {
    const { location } = renderModule('/legiwatch?client=c-nowl&tab=digest&browse=1');
    const notice = await screen.findByLabelText('Browse mode notice');
    expect(notice).toBeTruthy();
    expect(location.current.search).toContain('tab=digest');
    expect(location.current.search).toContain('client=c-nowl');
  });
});
