/**
 * LW-QA-020 — the LegiWatch Feed nav badge.
 *
 * The badge was `moduleItems.length`: the row count of the FIRST page of a hard
 * 25-row query the module never pages, so it silently saturated at 25 and read
 * as a count. It must be the server's exact Active-queue count for the default
 * view — the same number the Feed tab's own "Active queue" row shows — and it
 * must show NOTHING rather than a fabricated 0 when that count is unavailable.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem, FeedResponse } from '../../../pages/clients/tracker/intel-feed-api.js';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, getToken: async () => 'test-token', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url), post: (url: string, body?: unknown) => apiPost(url, body) }),
}));
vi.mock('../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ ready: true, enabled: true }),
}));

import { LegiWatchModule } from './LegiWatchModule.js';

/** FEED_PAGE_SIZE rows — the cap the old badge mistook for a count. */
const PAGE_ROWS = 25;

function item(i: number): FeedItem {
  return {
    id: `a${i}`,
    clientId: 'client-A',
    clientName: 'Client A',
    sourceType: 'bill',
    severity: 'notable',
    materiality: 'medium',
    score: 1,
    title: `Alert ${i}`,
    whyItMatters: null,
    recommendedAction: null,
    evidence: {},
    status: 'new',
    createdAt: '2026-09-01T00:00:00.000Z',
    workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
  } as FeedItem;
}

/** One full page of a MULTI-page result set — the case the old badge got wrong. */
function feedResponse(workStateCounts: FeedResponse['workStateCounts']): FeedResponse {
  return {
    items: Array.from({ length: PAGE_ROWS }, (_, i) => item(i)),
    nextCursor: 'cursor-2',
    hasMore: true,
    counts: { bill: PAGE_ROWS },
    total: 65,
    ...(workStateCounts ? { workStateCounts } : {}),
  };
}

/** 40 + 10 + 5 + 5 = 60 active; snoozed/dismissed are excluded by the default view. */
const COUNTS_60: FeedResponse['workStateCounts'] = {
  new: 40,
  in_review: 10,
  assigned: 5,
  actioned: 5,
  snoozed: 3,
  dismissed: 2,
};

let feed: FeedResponse;

beforeEach(() => {
  feed = feedResponse(COUNTS_60);
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation((url: string) => {
    if (url === '/api/clients') return Promise.resolve({ data: [] });
    if (url.startsWith('/intel-api/clients/_all/feed?')) return Promise.resolve({ data: feed });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderModule() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/legiwatch?tab=feed']}>
        <Routes>
          <Route path="/legiwatch" element={<LegiWatchModule />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function feedTab(): HTMLElement {
  const tab = screen.getAllByRole('tab').find((t) => t.textContent?.startsWith('Feed'));
  if (!tab) throw new Error('Feed tab not rendered');
  return tab;
}

describe('LW-QA-020 — the Feed badge is the exact server count', () => {
  it('reads the server Active-queue count, not the loaded page size', async () => {
    renderModule();
    await waitFor(() => expect(feedTab().querySelector('.lw-tab__count')?.textContent).toBe('60'));
    // The bug's fingerprint: the page cap, on a result set that has more pages.
    expect(feedTab().querySelector('.lw-tab__count')?.textContent).not.toBe(String(PAGE_ROWS));
  });

  it('the header pill reports the same exact count', async () => {
    renderModule();
    expect(await screen.findByText('LIVE · 60 ACTIVE')).toBeTruthy();
  });

  it("matches the Feed tab's own Active queue row for the same response", async () => {
    renderModule();
    const bucket = await screen.findByRole('button', { name: /Active queue/ });
    await waitFor(() => expect(bucket.textContent).toContain('60'));
    expect(feedTab().querySelector('.lw-tab__count')?.textContent).toBe(
      bucket.querySelector('.lw-rail__count')?.textContent,
    );
  });

  it('shows NO badge and no fabricated 0 when the server omits the counts', async () => {
    feed = feedResponse(undefined);
    renderModule();
    // Wait for the feed to have resolved: the rows are on screen.
    expect(await screen.findByText('Alert 0')).toBeTruthy();
    expect(feedTab().querySelector('.lw-tab__count')).toBeNull();
    expect(screen.queryByText(/0 ACTIVE/)).toBeNull();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('keeps the 999+ clamp for a very large queue', async () => {
    feed = feedResponse({ new: 1200, in_review: 0, assigned: 0, actioned: 0, snoozed: 0, dismissed: 0 });
    renderModule();
    await waitFor(() =>
      expect(feedTab().querySelector('.lw-tab__count')?.textContent).toBe('999+'),
    );
    expect(await screen.findByText('LIVE · 1200 ACTIVE')).toBeTruthy();
  });
});
