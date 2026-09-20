/**
 * PR C §15/§17 — BillsTab `_all` tenant roll-up contract (LW-QA-012).
 *
 * "All clients" must mount the real `_all` board (tenant roll-up with
 * client attribution + (clientId,billId) dedupe) — never silently read the
 * first client. Recommendations have no tenant-wide contract → hidden with
 * an honest notice. Bill 360 never receives `_all` as a UUID client.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const { drawerProps } = vi.hoisted(() => ({ drawerProps: vi.fn() }));
// Any transitive Clerk import stays inert (see the sibling scope-gate test).
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));
vi.mock('./Bill360Drawer.js', () => ({
  Bill360Drawer: (props: { clientId: string; onOpenFull: () => void }) => {
    drawerProps(props);
    return (
      <div role="dialog">
        <button type="button" onClick={props.onOpenFull}>
          Open full page
        </button>
      </div>
    );
  },
}));

import { BillsTab } from './BillsTab.js';

const CLIENTS = [
  { id: 'c-a', name: 'Alpha Gov', status: 'active' },
  { id: 'c-b', name: 'Beta Advocacy', status: 'active' },
];

// A shared bill tracked by BOTH clients must appear ONCE on the _all board
// (server dedupes by (clientId,billId) tracking rows into one card + client list)
// — modeled here by the single card the roll-up returns for the pair.
const ROLLUP = {
  columns: [
    {
      id: 'introduced',
      label: 'Introduced',
      cards: [
        {
          billId: '119-hr-9001', displayNum: 'H.R. 9001', title: 'Shipbuilding Reform Act',
          stage: 'introduced', passageProbability: 0.55, trackedAt: '2026-09-01T00:00:00Z',
          isManual: true, unread: false, note: null, matchedTags: ['shipbuilding'],
          changeChip: null, jurisdiction: 'US',
          clientId: 'c-a', clientName: 'Alpha Gov',
        },
        {
          billId: '119-s-700', displayNum: 'S. 700', title: 'State broadband act',
          stage: 'introduced', passageProbability: 0.3, trackedAt: '2026-09-02T00:00:00Z',
          isManual: true, unread: false, note: null, matchedTags: [],
          changeChip: null, jurisdiction: 'CA',
          clientId: 'c-b', clientName: 'Beta Advocacy',
        },
      ],
    },
  ],
  total: 2,
};

function wireGet(url: string): { data: unknown } | null {
  if (url.startsWith('/intel-api/clients/_all/tracker/board')) return { data: ROLLUP };
  if (url.startsWith('/intel-api/clients/c-a/tracker/board') || url.startsWith('/intel-api/clients/c-b/tracker/board')) {
    const firstCard = ROLLUP.columns[0]?.cards[0];
    return { data: { columns: [{ id: 'introduced', label: 'Introduced', cards: firstCard ? [firstCard] : [] }], total: firstCard ? 1 : 0 } };
  }
  if (url.includes('/recommendations')) return { data: [] };
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  drawerProps.mockReset();
  apiGet.mockImplementation((url: string) => {
    const hit = wireGet(url);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

afterEach(() => {
  cleanup();
});

function renderBills(scope: string, initialEntry = '/legiwatch?tab=bills') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/legiwatch" element={<BillsTab scope={scope} clients={CLIENTS as never} />} />
          <Route path="/bills/:billId" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PR C §15 — Bills All-clients = real tenant roll-up', () => {
  it('restores URL controls (deep link) and passes server filters to the board', async () => {
    renderBills('', '/legiwatch?tab=bills&billView=table&billChanged7=1&billActive=1&billSort=relevance');
    await screen.findByText('H.R. 9001');
    expect(screen.getByRole('tab', { name: 'Table' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Changed in 7 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(apiGet.mock.calls.some(([url]) => url.includes('changedWithinDays=7') && url.includes('activeOnly=true'))).toBe(true);
  });

  it('loads later pages and preserves separate client tracking rows without duplicate page rows', async () => {
    const first = ROLLUP.columns[0]!.cards[0]!;
    apiGet.mockImplementation(async (url) => ({ data: url.includes('cursor=page-2')
      ? { columns: [{ id: 'introduced', label: 'Introduced', cards: [first, { ...first, clientId: 'c-b', clientName: 'Beta Advocacy' }] }], total: 2, hasMore: false }
      : { columns: [{ id: 'introduced', label: 'Introduced', cards: [first] }], total: 2, hasMore: true, nextCursor: 'page-2' } }));
    renderBills('');
    await screen.findByText('H.R. 9001');
    fireEvent.click(screen.getByRole('button', { name: 'Load more bills' }));
    await screen.findByText('Beta Advocacy');
    expect(screen.getAllByText('H.R. 9001')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more bills' })).toBeNull();
    expect(apiGet.mock.calls.some(([url]) => url.includes('cursor=page-2'))).toBe(true);
  });

  it('applies high-fit consistently after switching from cards to table', async () => {
    apiGet.mockResolvedValue({ data: {
      ...ROLLUP,
      columns: [{ ...ROLLUP.columns[0], cards: ROLLUP.columns[0]!.cards.map((c, i) => ({ ...c, matchedHighPriorityTopics: i === 0 ? ['shipbuilding'] : [] })) }],
    } });
    renderBills('');
    await screen.findByText('H.R. 9001');
    fireEvent.click(screen.getByRole('button', { name: 'High fit' }));
    expect(screen.queryByText('S. 700')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.getByText('H.R. 9001')).toBeTruthy();
    expect(screen.queryByText('S. 700')).toBeNull();
  });

  it('shows enacted status instead of a passage forecast for the API display label', async () => {
    apiGet.mockResolvedValue({ data: { columns: [{ id: 'enacted', label: 'Enacted', cards: [{ ...ROLLUP.columns[0]!.cards[0], stage: 'enacted', canonicalStatus: 'Became law' }] }], total: 1 } });
    renderBills('');
    await screen.findByText('BECAME LAW');
    expect(screen.queryByText('55%')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.getByText('BECAME LAW')).toBeTruthy();
    expect(screen.queryByText('55%')).toBeNull();
  });

  it('empty scope calls the `_all` board route (not the first client)', async () => {
    renderBills('');
    await screen.findByText('H.R. 9001');
    const calledUrls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.startsWith('/intel-api/clients/_all/tracker/board'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/intel-api/clients/c-a/tracker/board'))).toBe(false);
    expect(calledUrls.some((u) => u.startsWith('/intel-api/clients/c-b/tracker/board'))).toBe(false);
  });

  it('shared bill renders once with client attribution; federal/state counts correct', async () => {
    renderBills('');
    await screen.findByText('H.R. 9001');
    expect(screen.getByText('S. 700')).toBeTruthy();
    // The roll-up wire already dedupes; each bill appears exactly once.
    expect(screen.getAllByText('H.R. 9001').length).toBe(1);
    expect(screen.getAllByText('S. 700').length).toBe(1);
    // Client names are visible in the all-clients scope.
    expect(screen.getByText('Alpha Gov')).toBeTruthy();
    expect(screen.getByText('Beta Advocacy')).toBeTruthy();
    // Footer counts: 2 tracked, 1 federal, 1 state.
    const footer = screen.getByText(/2 tracked · 1 federal · 1 state/);
    expect(footer).toBeTruthy();
  });

  it('recommendations are hidden in _all with the honest notice; per-client scope still calls the endpoint', async () => {
    renderBills('');
    await screen.findByText('H.R. 9001');
    expect(screen.getByLabelText('Recommendations unavailable in all-clients scope').textContent)
      .toContain('Select a client to see tailored recommendations');
    const allUrls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(allUrls.some((u) => u.startsWith('/intel-api/clients/_all/recommendations'))).toBe(false);

    document.body.innerHTML = '';
    apiGet.mockClear();
    renderBills('c-a');
    await screen.findByText('H.R. 9001');
    expect(apiGet.mock.calls.some((c) => (c[0] as string).startsWith('/intel-api/clients/c-a/recommendations'))).toBe(true);
  });

  it('specific client scope keeps working and does NOT hit the _all route', async () => {
    renderBills('c-a');
    await screen.findByText('H.R. 9001');
    const urls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith('/intel-api/clients/c-a/tracker/board'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/intel-api/clients/_all/tracker/board'))).toBe(false);
  });

  it('Bill 360 drawer in _all receives global scope, never a literal _all client id', async () => {
    renderBills('');
    const card = await screen.findByText('H.R. 9001');
    fireEvent.click(card);
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });
    expect(drawerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ billId: '119-hr-9001', clientId: '' }),
    );
  });

  it.each([
    { scope: '', expected: '/bills/119-hr-9001' },
    { scope: 'c-a', expected: '/bills/119-hr-9001?client=c-a' },
  ])(
    'opens the full Bill 360 page with the correct client scope: $expected',
    async ({ scope, expected }) => {
      renderBills(scope);
      fireEvent.click(await screen.findByText('H.R. 9001'));
      fireEvent.click(await screen.findByRole('button', { name: 'Open full page' }));
      expect(await screen.findByTestId('location')).toHaveTextContent(expected);
    },
  );
});
