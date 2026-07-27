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

function intelCard(i: number, overrides: Partial<{ trackedBy: string | null }> = {}) {
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
    trackedBy: null,
    ...overrides,
  };
}

function mockBoard(count: number, cards?: ReturnType<typeof intelCard>[]) {
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
              cards: cards ?? Array.from({ length: count }, (_, i) => intelCard(i)),
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
    // MP-15 / Gate H phase d: the board owner column's roster (Clerk-id keyed,
    // NOT the admin-gated /tenant-admin/team).
    if (url.endsWith('/tenant-members')) {
      return { data: [{ id: 'u1', clerkUserId: 'clerk-42', email: 'dana@acme.test', name: 'Dana Reyes' }] };
    }
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

/** MP-15 / Gate H phase d: board table Owner column. */
describe('Board Table view — Owner column (MP-15 / Gate H phase d)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('renders 5 headers including Owner, and resolves a tracked bill\'s owner by name', async () => {
    mockBoard(3, [
      intelCard(0, { trackedBy: 'clerk-42' }),
      intelCard(1, { trackedBy: null }),
      intelCard(2, { trackedBy: 'clerk-removed' }),
    ]);
    renderSurface();
    await waitFor(() => expect(screen.getByText('H.R. 0')).toBeInTheDocument());
    screen.getByRole('button', { name: /^Table$/i }).click();
    await waitFor(() => expect(document.querySelector('table.board-table')).not.toBeNull());

    const headers = Array.from(document.querySelectorAll('table.board-table thead th')).map(
      (th) => th.textContent,
    );
    expect(headers).toHaveLength(5);
    expect(headers.some((h) => h?.includes('Owner'))).toBe(true);

    await waitFor(() => expect(screen.getByText('Dana Reyes')).toBeInTheDocument());
    // Edge case 4: never tracked / null trackedBy.
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    // Edge case 5: a Clerk id with no matching roster row (removed member).
    expect(screen.getByText('Former member')).toBeInTheDocument();
  });

  test('an empty table still spans all 5 columns', async () => {
    // A wholly empty board short-circuits to TrackerSurface's own "Your board
    // is empty" state before BoardTableView ever mounts — this exercises
    // BoardTableView's own zero-rows branch directly instead.
    apiGetMock.mockImplementation(async (url: string) =>
      url.endsWith('/tenant-members') ? { data: [] } : { data: {} },
    );
    const { BoardTableView } = await import('./tracker-components.js');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <BoardTableView columns={[]} issueSet={new Set()} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    const emptyCell = await screen.findByText('No tracked bills.');
    expect(emptyCell.closest('td')?.getAttribute('colspan')).toBe('5');
  });
});
