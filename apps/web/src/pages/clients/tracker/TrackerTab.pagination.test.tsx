import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * Gate E phase a (P1-18) — web-side board pagination. a-8 cases 9 and 10:
 * Load-more appends without duplicating and renders the withheld count; a
 * legacy (pre-Gate-E) board response with no hasMore/total renders with no
 * Load-more and no crash. Plus a wiring check that the filter toggles reach
 * the request as query params.
 */

const apiGetMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
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
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
}

function intelCard(over: Record<string, unknown> = {}) {
  return {
    billId: '119-hr-1',
    displayNum: 'H.R. 1',
    title: 'Bill one',
    stage: 'introduced',
    passageProbability: 0.2,
    latestActionText: null,
    latestActionDate: null,
    note: null,
    isManual: true,
    unread: false,
    trackedAt: '2026-07-01T00:00:00.000Z',
    matchedTags: [],
    matchedHighPriorityTopics: [],
    matchedPosition: null,
    changeChip: null,
    ...over,
  };
}
function legacyBill(over: Record<string, unknown> = {}) {
  return {
    billId: '119-hr-9999',
    displayNum: 'H.R. 9999',
    title: 'Legacy board bill',
    stage: 'introduced',
    probability: 0.2,
    tags: [],
    isManual: true,
    trackedAt: '2026-07-01T00:00:00.000Z',
    unread: false,
    change: null,
    ...over,
  };
}

function renderSurface() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <TrackerSurface clientId="client-1" clientName="Acme Corp" variant="bills" />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('TrackerSurface board pagination (Gate E phase a, P1-18)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('a-8.9: Load more appends page 2 without duplicating page 1, and the withheld count renders', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { data: { role: 'capiro_admin' } };
      if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
      if (url.includes('/tracker/board')) {
        const onPage2 = url.includes('cursor=');
        return {
          data: onPage2
            ? {
                columns: [{ id: 'introduced', label: 'Introduced', cards: [intelCard({ billId: '119-hr-2', displayNum: 'H.R. 2' })] }],
                total: 2,
                hasMore: false,
                nextCursor: null,
                withheld: 0,
              }
            : {
                columns: [{ id: 'introduced', label: 'Introduced', cards: [intelCard()] }],
                total: 2,
                hasMore: true,
                nextCursor: 'CURSOR-1',
                withheld: 1,
              },
        };
      }
      if (url.endsWith('/recommendations')) return { data: [] };
      if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
      if (url.includes('watchlist')) return { data: { issueAreas: [], tags: [] } };
      return { data: {} };
    });
    renderSurface();

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    expect(screen.getByText(/2 tracked/)).toBeInTheDocument();
    expect(screen.getByText(/showing 1/)).toBeInTheDocument();

    const loadMore = screen.getByRole('button', { name: /Load more/i });
    loadMore.click();

    await waitFor(() => expect(screen.getByText('H.R. 2')).toBeInTheDocument());
    expect(screen.getAllByText('H.R. 1')).toHaveLength(1); // no duplication
    await waitFor(() => expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull());
  });

  test('a-8.10: a legacy board response with no hasMore/total renders with no Load-more and no crash', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { data: { role: 'capiro_admin' } };
      if (url.includes('/feature-flags')) return { data: {} }; // trackerV2 off
      if (url.endsWith('/board')) {
        return {
          data: {
            columns: [{ id: 'introduced', label: 'Introduced', count: 1, bills: [legacyBill()] }],
            total: 1,
          },
        };
      }
      if (url.endsWith('/recommendations')) return { data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.45 } };
      if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
      if (url.includes('watchlist')) return { data: { issueAreas: [], tags: [] } };
      return { data: {} };
    });
    renderSurface();

    await waitFor(() => expect(screen.getByText('H.R. 9999')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
    expect(screen.getByText(/1 tracked/)).toBeInTheDocument();
  });

  test('the "Changed in last 7 days" toggle reaches the request as changedWithinDays=7', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { data: { role: 'capiro_admin' } };
      if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
      if (url.includes('/tracker/board')) {
        return {
          data: {
            columns: [{ id: 'introduced', label: 'Introduced', cards: [intelCard()] }],
            total: 1,
            hasMore: false,
            nextCursor: null,
            withheld: 0,
          },
        };
      }
      if (url.endsWith('/recommendations')) return { data: [] };
      if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
      if (url.includes('watchlist')) return { data: { issueAreas: [], tags: [] } };
      return { data: {} };
    });
    renderSurface();

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    screen.getByRole('button', { name: /Changed in last 7 days/i }).click();

    await waitFor(() =>
      expect(
        apiGetMock.mock.calls.some(([u]) => String(u).includes('changedWithinDays=7')),
      ).toBe(true),
    );
  });
});
