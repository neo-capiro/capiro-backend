/**
 * Legacy (folder-tracker flag OFF) BillsTab: the public global corpus search
 * must render and paginate even when the private tracked board fails (e.g. a
 * tenant with hearing_watch but no tracker flags gets a 403 board response).
 * The board error shows inline; it never replaces the page or hides search.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string, opts?: { params?: Record<string, unknown> }) => Promise<{ data: unknown }>>();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string, opts?: { params?: Record<string, unknown> }) => apiGet(url, opts) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));

import { BillsTab } from './BillsTab.js';

const CLIENTS = [{ id: 'c-a', name: 'Alpha Gov', status: 'active' }];

// 51+ corpus rows so the >50 pagination contract is exercised (two pages).
const PAGE1 = {
  rows: Array.from({ length: 50 }, (_, i) => ({
    id: `119-hr-${9000 + i}`,
    number: `H.R. ${9000 + i}`,
    title: `Corpus marker bill ${i}`,
    status: 'Introduced',
    jurisdiction: 'US',
    sessionKey: '119',
    latestAction: null,
    latestActionAt: '2026-09-01',
  })),
  total: 51,
  nextCursor: 'cursor-2',
};
const PAGE2 = {
  rows: [
    {
      id: 'fl-2026x2266-hb27',
      number: 'HB 27',
      title: 'Corpus marker Florida special session',
      status: 'Filed',
      jurisdiction: 'FL',
      sessionKey: '2026x2266',
      latestAction: null,
      latestActionAt: '2026-09-02',
    },
  ],
  total: 51,
  nextCursor: null,
};

function wireGet(
  url: string,
  opts?: { params?: Record<string, unknown> },
): { data: unknown } | Promise<never> | null {
  // Folder-tracker flag OFF → legacy ScopedBillsTab path.
  if (url === '/intel-api/feature-flags') return { data: {} };
  // Private tracked board is forbidden for this tenant — the exact failure
  // that used to hide the entire page behind "Bills board is unavailable".
  if (url.includes('/tracker/board')) return Promise.reject({ response: { status: 403 } });
  if (url.includes('/recommendations')) return { data: [] };
  if (url.endsWith('/legiwatch/bills/corpus-metadata')) {
    return {
      data: {
        jurisdictions: [
          { key: 'US', count: 113 },
          { key: 'FL', count: 4 },
          { key: 'MA', count: 1 },
        ],
        sessions: [],
      },
    };
  }
  if (url.endsWith('/legiwatch/bills/search'))
    return { data: opts?.params?.cursor === 'cursor-2' ? PAGE2 : PAGE1 };
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url, opts) => {
    const hit = wireGet(url, opts);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
});

afterEach(() => {
  cleanup();
});

function renderLegacy(initialEntry = '/legiwatch?tab=bills') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/legiwatch" element={<BillsTab scope="c-a" clients={CLIENTS as never} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Legacy flag-OFF BillsTab — public corpus search survives a 403 board', () => {
  it('renders corpus search + inline board error, paginates past 50, distinct jurisdiction/session', async () => {
    renderLegacy();
    // Search UI is reachable even though the private board 403s.
    const input = await screen.findByRole('searchbox', { name: 'Search all ingested bills' });
    // Board error is inline, not page-replacing.
    expect(await screen.findByText('Bills board is unavailable')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Corpus marker' } });
    expect(await screen.findByText('51 matching bills')).toBeTruthy();
    // Page 1 = 50 rows; the corpus "Load more" is the only pagination button
    // (the board's duplicate control is suppressed while searching).
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Load more bills' }));
    await screen.findByText('HB 27');
    expect(screen.getAllByRole('listitem')).toHaveLength(51);
    // Exhausted: no more pagination controls.
    expect(screen.queryByRole('button', { name: 'Load more bills' })).toBeNull();
    // Distinct jurisdiction/session labels visible.
    expect(screen.getAllByText(/Federal · 119/).length).toBe(50);
    expect(screen.getByText(/FL · 2026x2266/)).toBeTruthy();
    // The board's error stays inline below the results.
    await waitFor(() =>
      expect(screen.getByText('Bills board is unavailable')).toBeTruthy(),
    );
    // Dynamic corpus metadata populated the jurisdiction dropdown.
    const select = screen.getByRole('combobox', { name: 'Corpus jurisdiction' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'US', 'FL', 'MA']);
  });

  it('keeps the corpus search visible while the board is still loading', async () => {
    apiGet.mockImplementation((url, opts) => {
      if (url.includes('/tracker/board')) return new Promise(() => {}); // never resolves
      const hit = wireGet(url, opts);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderLegacy();
    await screen.findByRole('searchbox', { name: 'Search all ingested bills' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search all ingested bills' }), {
      target: { value: 'Corpus marker' },
    });
    expect(await screen.findByText('51 matching bills')).toBeTruthy();
  });
});
