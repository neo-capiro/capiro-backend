import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerFeedPanel } from './TrackerFeedPanel.js';
import type { FeedItem } from './intel-feed-api.js';

/**
 * Gate E phase c (P1-18) — the feed's flat item list virtualizes once a
 * loaded page exceeds 100 items (c-2). Mirrors TrackerTab.boardviews.test.tsx's
 * approach: jsdom performs no real layout, so this asserts the bounded-DOM
 * claim and the keyboard-reachability affordance, not that specific
 * off-screen text is visible (that's the browser walk, §5.3).
 */

const apiGetMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));
vi.mock('../../bills/bill-target.js', () => ({ useBillTarget: () => (billId: string) => `/bills/${billId}` }));

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

function feedItem(i: number): FeedItem {
  return {
    id: `a${i}`,
    clientId: 'client-1',
    clientName: 'Acme Corp',
    sourceType: 'bill',
    kind: 'bill_change',
    severity: 'notable',
    materiality: 'medium',
    score: 0.5,
    clientImpact: null,
    urgency: null,
    title: `Alert ${i}`,
    whyItMatters: null,
    tag: null,
    evidence: {},
    createdAt: new Date(2026, 6, 1, 0, 0, i).toISOString(),
    status: 'new',
    actions: { inReport: false, talkingPoints: 0 },
    recommendedActions: [],
    workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
  } as unknown as FeedItem;
}

function renderPanel(count: number) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/feed')) {
      return {
        data: {
          items: Array.from({ length: count }, (_, i) => feedItem(i)),
          nextCursor: null,
          hasMore: false,
          counts: { bill: count },
          severityCounts: { notable: count },
        },
      };
    }
    return { data: {} };
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <TrackerFeedPanel clientId="client-1" clientName="Acme Corp" />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('Feed virtualization (Gate E phase c, P1-18)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('120 items (over the 100 threshold): virtualized wrapper mounts, DOM nodes are bounded', async () => {
    renderPanel(120);
    await waitFor(() => expect(document.querySelector('.feed-virtual')).not.toBeNull());
    expect(document.querySelectorAll('.acard').length).toBeLessThan(120);
  });

  test('the virtualized region is a real scrollable, focusable, labeled group', async () => {
    renderPanel(120);
    await waitFor(() => expect(document.querySelector('.feed-virtual')).not.toBeNull());
    const scroller = document.querySelector('.feed-virtual')!;
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('role')).toBe('group');
    expect(scroller.getAttribute('aria-label')).toMatch(/120 alerts/i);
  });

  test('60 items (under the threshold): renders normally, no virtualized wrapper', async () => {
    renderPanel(60);
    await waitFor(() => expect(document.querySelectorAll('.acard').length).toBe(60));
    expect(document.querySelector('.feed-virtual')).toBeNull();
  });
});
