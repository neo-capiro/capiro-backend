import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProgramElementFinderPage } from './ProgramElementFinderPage.js';
import type { ProgramElementListItem } from './types.js';

const apiGetMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: vi.fn(),
  }),
}));

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'standard_user' } }),
}));

const SUMMARY = {
  tracked: 1,
  withData: 1,
  watched: 0,
  latestRequestFy: 2027,
  totalRequest: 215.3,
  latestEnactedFy: 2025,
  totalEnacted: 297.7,
  avgDeltaPct: 4.9,
  openMarkups: 0,
  trend: [
    { fy: 2022, total: 258 },
    { fy: 2023, total: 273 },
    { fy: 2024, total: 281 },
  ],
  byService: [{ service: 'ARMY', count: 1 }],
};

function setupApi(rows: Partial<ProgramElementListItem>[]) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/program-elements/summary')) {
      return { data: SUMMARY };
    }
    if (url.includes('/api/intelligence/changes')) {
      return { data: [] };
    }
    // BL-1: capability taxonomy (empty = hero hidden, finder shows seed note).
    if (url.includes('/api/budget-lines/capabilities')) {
      return { data: { data: [] } };
    }
    // Default: the list endpoint.
    return { data: { data: rows, total: rows.length, page: 1, limit: 50 } };
  });
}

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProgramElementFinderPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramElementFinderPage', () => {
  beforeEach(() => {
    setupBrowserMocks();
    apiGetMock.mockReset();
  });

  test('renders matching program elements', async () => {
    setupApi([
      {
        peCode: '0603270A',
        title: 'Army Electronic Warfare Technology',
        service: 'ARMY',
        budgetActivity: '03',
        appropriationType: 'RDTE',
        status: 'active',
        lastSyncedAt: '2026-05-01T00:00:00.000Z',
        latestRequest: 215.3,
        latestRequestFy: 2027,
        latestEnacted: 297.7,
        latestEnactedFy: 2025,
        deltaPct: 19,
        spark: [258, 273, 281, 298, 233, 215],
        billCount: 2,
        watched: false,
        signalType: 'mark_vs_request',
        signalScore: 0.8,
      },
    ]);

    renderPage();

    await waitFor(() => expect(screen.getByText('0603270A')).toBeInTheDocument());
    expect(screen.getByText('Army Electronic Warfare Technology')).toBeInTheDocument();
  });

  test('passes the search term to the list endpoint', async () => {
    setupApi([]);

    renderPage();

    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Search code or title/i), {
      target: { value: 'electronic warfare' },
    });

    await waitFor(() => {
      const listCall = apiGetMock.mock.calls
        .filter((call) => call[0] === '/api/program-elements')
        .at(-1);
      expect(listCall?.[1]?.params?.q).toBe('electronic warfare');
    });
  });

  test('shows an empty state when nothing matches', async () => {
    setupApi([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No program elements matched your search')).toBeInTheDocument();
    });
  });
});
