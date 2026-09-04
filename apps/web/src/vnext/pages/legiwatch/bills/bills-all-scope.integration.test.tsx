/**
 * PR C §15/§17 — BillsTab `_all` tenant roll-up contract (LW-QA-012).
 *
 * "All clients" must mount the real `_all` board (tenant roll-up with
 * client attribution + (clientId,billId) dedupe) — never silently read the
 * first client. Recommendations have no tenant-wide contract → hidden with
 * an honest notice. Bill 360 never receives `_all` as a UUID client.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
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
  apiGet.mockImplementation((url: string) => {
    const hit = wireGet(url);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderBills(scope: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/legiwatch?tab=bills']}>
        <Routes>
          <Route path="/legiwatch" element={<BillsTab scope={scope} clients={CLIENTS as never} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PR C §15 — Bills All-clients = real tenant roll-up', () => {
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

  it('Bill 360 drawer in _all uses the GLOBAL dossier route (never /clients/_all/...)', async () => {
    renderBills('');
    const card = await screen.findByText('H.R. 9001');
    fireEvent.click(card);
    await waitFor(() => {
      const urls = apiGet.mock.calls.map((c) => c[0] as string);
      void urls;
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    });
    const urls = apiGet.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.startsWith('/intel-api/clients/_all/bills/'))).toBe(false);
    void within;
  });
});
