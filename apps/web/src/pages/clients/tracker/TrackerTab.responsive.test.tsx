import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * Gate E phase b (P2-11, b-3) — below 768px the inline Filter/Sort/Add-bill
 * row collapses behind a single Filters button opening a dialog. jsdom does
 * not evaluate media queries, so BOTH the inline row and the Filters trigger
 * are always in the DOM (tracker.css toggles which is VISIBLE); this asserts
 * the dialog reuses the real controls, not a second implementation.
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
}

describe('TrackerSurface — mobile Filters drawer (P2-11 b-3)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/me') return { data: { role: 'capiro_admin' } };
      if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
      if (url.includes('/tracker/board')) {
        return {
          data: {
            columns: [{ id: 'introduced', label: 'Introduced', cards: [] }],
            total: 0,
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
  });

  test('the Filters button opens a dialog containing the same controls as the desktop row', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter>
            <TrackerSurface clientId="client-1" clientName="Acme Corp" variant="bills" />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );

    // The 'bills' variant stacks Recommendations above Board, each with its
    // own ResponsiveControls/Filters button — find the BOARD section's one
    // by its dialog's accessible name (Modal's `label` prop) rather than by
    // array position, which would be fragile against layout reordering.
    const filtersButtons = await screen.findAllByRole('button', { name: /^Filters$/i });
    expect(filtersButtons.length).toBeGreaterThan(0);
    for (const btn of filtersButtons) btn.click();

    const dialog = await screen.findByRole('dialog', { name: /Board filters/i });
    // The Board section's Sort dropdown ("Sort loaded bills", P1-18's a-7
    // relabel) is one of the desktop controls — it must be reachable inside
    // the opened dialog too, since ResponsiveControls renders the SAME
    // element by reference, not a second copy.
    expect(within(dialog).getByText(/Sort loaded bills/i)).toBeInTheDocument();
  });
});
