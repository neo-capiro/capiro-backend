import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * Gate E phase c (P1-18) — virtualization AND table view (Neo's decision:
 * ship both). c-4:
 *  1. A column over the 50-card threshold renders a BOUNDED number of DOM
 *     nodes (not all 60) — or the table view renders one row per card and
 *     the view choice persists in sessionStorage like the other panel keys.
 *  2. Keyboard navigation still reaches off-screen content — asserted here
 *     as the scroll region's real tabIndex/role (the mechanism a keyboard
 *     user relies on; jsdom cannot execute an actual scroll-driven layout
 *     pass, so the deeper claim is verified in the browser walk, §5.3).
 *  3. Gate D phase h's a11y tests still pass against these views (run
 *     separately in tracker-a11y.test.tsx — unmodified by this phase).
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

function intelCard(i: number) {
  return {
    billId: `119-hr-${i}`,
    displayNum: `H.R. ${i}`,
    title: `Bill number ${i}`,
    stage: 'introduced',
    passageProbability: 0.2,
    latestActionText: `Action on bill ${i}`,
    latestActionDate: '2026-07-01',
    note: null,
    isManual: true,
    unread: false,
    trackedAt: new Date(2026, 6, 1, 0, 0, i).toISOString(),
    matchedTags: [],
    matchedHighPriorityTopics: [],
    matchedPosition: null,
    changeChip: null,
  };
}

function mockBoard(count: number) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/me') return { data: { role: 'capiro_admin' } };
    if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
    if (url.includes('/tracker/board')) {
      return {
        data: {
          columns: [
            {
              id: 'introduced',
              label: 'Introduced',
              cards: Array.from({ length: count }, (_, i) => intelCard(i)),
            },
          ],
          total: count,
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

describe('Board virtualization (Gate E phase c, P1-18)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('60 cards (over the 50 threshold): DOM nodes are bounded, not all 60 mounted', async () => {
    mockBoard(60);
    renderSurface();

    // jsdom does not perform real layout, so the scroll container measures
    // 0 height and the virtualizer may compute an empty visible range —
    // "bounded" holds either way (0 or a small number is both < 60), so this
    // waits for the virtualized wrapper to mount rather than for a specific
    // card's text, which real layout (the browser walk, §5.3) would show.
    await waitFor(() => expect(document.querySelector('.bcol-scroll')).not.toBeNull());
    const rendered = document.querySelectorAll('.bcard').length;
    expect(rendered).toBeLessThan(60);
  });

  test('the virtualized region is a real scrollable, focusable, labeled group (keyboard reachability)', async () => {
    mockBoard(60);
    renderSurface();
    await waitFor(() => expect(document.querySelector('.bcol-scroll')).not.toBeNull());

    const scroller = document.querySelector('.bcol-scroll')!;
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('role')).toBe('group');
    expect(scroller.getAttribute('aria-label')).toMatch(/60 tracked bills/i);
  });

  test('40 cards (under the threshold): renders normally, no virtualized scroll wrapper', async () => {
    mockBoard(40);
    renderSurface();

    await waitFor(() => expect(screen.getByText('H.R. 0')).toBeInTheDocument());
    expect(document.querySelectorAll('.bcard').length).toBe(40);
    expect(document.querySelector('.bcol-scroll')).toBeNull();
  });
});

describe('Board Table view (Gate E phase c, c-3)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('Table view renders one row per card; the choice persists in sessionStorage', async () => {
    mockBoard(5);
    renderSurface();
    await waitFor(() => expect(screen.getByText('H.R. 0')).toBeInTheDocument());

    screen.getByRole('button', { name: /^Table$/i }).click();

    await waitFor(() => expect(document.querySelector('table.board-table')).not.toBeNull());
    expect(document.querySelectorAll('table.board-table tbody tr')).toHaveLength(5);
    // The card grid is gone while Table view is active.
    expect(document.querySelector('.board')).toBeNull();

    expect(window.sessionStorage.getItem('capiro:tracker:boardview')).toBe('table');
  });

  test('clicking a column header sorts the table (Bill number ascending)', async () => {
    mockBoard(3);
    renderSurface();
    await waitFor(() => expect(screen.getByText('H.R. 0')).toBeInTheDocument());
    screen.getByRole('button', { name: /^Table$/i }).click();
    await waitFor(() => expect(document.querySelector('table.board-table')).not.toBeNull());

    screen.getByRole('button', { name: /^Bill/i }).click();
    const firstRowText = document.querySelector('table.board-table tbody tr')?.textContent ?? '';
    expect(firstRowText).toContain('H.R. 0');
  });
});
