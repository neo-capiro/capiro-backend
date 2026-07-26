import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * Gate B phase f (P0-06) — the High-fit board filter.
 *
 * The bug: `highPrio` was derived from the watchlist query, which is `enabled` only
 * when `activePanel === 'config'`. On the Radar Bills surface Configure is a SIBLING
 * tab rendered by a different TrackerSurface instance, so that query never ran there
 * and High-fit filtered out every card. Every test here uses a FRESH QueryClient and
 * never opens Configure — the exact condition that used to break it (audit test-gap
 * item 6, "works without first opening Configure").
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

/** One intel-api board card (the shape adaptBoard consumes). */
function intelCard(over: Record<string, unknown> = {}) {
  return {
    billId: '119-hr-1234',
    displayNum: 'H.R. 1234',
    title: 'Grid modernization act',
    stage: 'introduced',
    passageProbability: 0.2,
    latestActionText: null,
    latestActionDate: null,
    note: null,
    isManual: true,
    unread: false,
    trackedAt: '2026-07-01T00:00:00.000Z',
    matchedTags: ['grid'],
    matchedHighPriorityTopics: ['grid'],
    matchedPosition: 'support',
    changeChip: null,
    ...over,
  };
}

/** One LEGACY (apps/api) board bill — no matchedHighPriorityTopics field at all. */
function legacyBill(over: Record<string, unknown> = {}) {
  return {
    billId: '119-hr-9999',
    displayNum: 'H.R. 9999',
    title: 'Legacy board bill',
    stage: 'introduced',
    probability: 0.2,
    tags: ['grid'],
    isManual: true,
    trackedAt: '2026-07-01T00:00:00.000Z',
    unread: false,
    change: null,
    ...over,
  };
}

function mockGets(opts: {
  trackerV2: boolean;
  cards?: Array<Record<string, unknown>>;
  legacyBills?: Array<Record<string, unknown>>;
  watchlist?: unknown;
}) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/feature-flags')) {
      return { data: opts.trackerV2 ? { tracker_v2: true } : {} };
    }
    if (url.endsWith('/board')) {
      return opts.trackerV2
        ? { data: { columns: [{ id: 'introduced', label: 'Introduced', cards: opts.cards ?? [] }] } }
        : {
            data: {
              columns: [
                {
                  id: 'introduced',
                  label: 'Introduced',
                  count: (opts.legacyBills ?? []).length,
                  bills: opts.legacyBills ?? [],
                },
              ],
              total: (opts.legacyBills ?? []).length,
            },
          };
    }
    if (url.endsWith('/recommendations')) return { data: opts.trackerV2 ? [] : { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.45 } };
    if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
    // Configure-only queries. If High-fit depends on these having run, the test fails.
    if (url.includes('watchlist')) return { data: opts.watchlist ?? { issueAreas: [], tags: [] } };
    return { data: {} };
  });
}

function renderSurface(variant: 'bills' | 'profile') {
  // A FRESH QueryClient per test: no sibling instance can have warmed the
  // watchlist cache, which is the only reason the old derivation ever appeared
  // to work.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <TrackerSurface clientId="client-1" clientName="Acme Corp" variant={variant} />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

async function selectFilter(label: RegExp) {
  const filterBtn = (await screen.findAllByRole('button', { name: /Filter/i }))[0]!;
  filterBtn.click();
  const option = await screen.findByText(label);
  option.click();
}

describe('TrackerSurface — High-fit filter from server data (P0-06)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('f-6.1 variant=bills, fresh cache, Configure never opened → a high-priority card IS visible', async () => {
    mockGets({ trackerV2: true, cards: [intelCard()] });
    renderSurface('bills');

    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
    await selectFilter(/High-fit \(priority tag\)/);

    // Pre-change this rendered ZERO cards: the watchlist query is not enabled on
    // this surface, so `highPrio` was empty and every card was filtered out.
    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
    // The watchlist endpoint was never fetched — the filter does not depend on it.
    expect(apiGetMock.mock.calls.filter(([u]) => String(u).includes('watchlists/'))).toHaveLength(0);
  });

  test('f-6.2 an empty matchedHighPriorityTopics hides the card and shows the "no match" state', async () => {
    mockGets({
      trackerV2: true,
      cards: [intelCard({ matchedHighPriorityTopics: [], matchedPosition: null })],
    });
    renderSurface('bills');

    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
    await selectFilter(/High-fit \(priority tag\)/);

    await waitFor(() => expect(screen.queryByText('H.R. 1234')).toBeNull());
    // Not four "Nothing here" columns — say which filter is hiding them.
    expect(screen.getByText(/No tracked bills match the/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing here')).toBeNull();

    // …and the escape hatch works.
    screen.getByRole('button', { name: /Show all 1/i }).click();
    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
  });

  test('f-6.3 variant=profile behaves identically on a fresh cache', async () => {
    mockGets({ trackerV2: true, cards: [intelCard()] });
    renderSurface('profile');

    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
    await selectFilter(/High-fit \(priority tag\)/);
    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
  });

  test('f-6.4 the LEGACY board (field absent) still works via the watchlist fallback', async () => {
    mockGets({
      trackerV2: false,
      legacyBills: [legacyBill()],
      watchlist: { issueAreas: [], tags: [{ tag: 'grid', priority: 'high', synonyms: [], relatedEntities: [], riskTerms: [], typedTerms: [] }] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Prime the shared cache the way the sibling Configure instance would, since
    // the fallback is the ONLY path for a legacy board and it reads that cache.
    queryClient.setQueryData(['tracker-watchlist', 'client-1'], {
      issueAreas: [],
      tags: [
        {
          tag: 'grid',
          priority: 'high',
          position: 'monitor',
          synonyms: [],
          relatedEntities: [],
          riskTerms: [],
          typedTerms: [],
        },
      ],
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter>
            <TrackerSurface clientId="client-1" clientName="Acme Corp" variant="bills" />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('H.R. 9999')).toBeInTheDocument());
    await selectFilter(/High-fit \(priority tag\)/);
    await waitFor(() => expect(screen.getByText('H.R. 9999')).toBeInTheDocument());
  });

  test('f-6.5 filter=all shows every card regardless of the field', async () => {
    mockGets({
      trackerV2: true,
      cards: [
        intelCard(),
        intelCard({ billId: '119-hr-2', displayNum: 'H.R. 2', matchedHighPriorityTopics: [] }),
      ],
    });
    renderSurface('bills');

    await waitFor(() => expect(screen.getByText('H.R. 1234')).toBeInTheDocument());
    expect(screen.getByText('H.R. 2')).toBeInTheDocument();
  });
});
