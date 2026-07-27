import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { HearingWatchPanel } from './HearingWatchPage.js';
import { hearingCapability, CAPABILITY_LABEL, type HearingCapability } from './HearingWatchPage.js';
import type { UpcomingHearing } from '../../lib/hearing-watch-api.js';

/**
 * Gate E phase d (P2-13, P2-14) — hearing archive pagination via a growing
 * OFFSET (not limit — the backend clamps limit to 100,
 * upcoming-hearings.service.ts:75, so a growing-limit pattern would silently
 * stop working past two pages), and capability-aware hearing actions.
 */

const apiGetMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock, post: vi.fn() }) }));
vi.mock('../../lib/intel-feature-flags.js', () => ({ useIntelFeatureEnabled: () => true }));

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

function mockBrowse(totalCount: number) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/upcoming-hearings/browse')) {
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const limit = Number(params.get('limit') ?? '50');
      const offset = Number(params.get('offset') ?? '0');
      const n = Math.max(0, Math.min(limit, totalCount - offset));
      const items = Array.from({ length: n }, (_, i) => ({
        id: `h-${offset + i}`,
        title: `Hearing ${offset + i}`,
        committee: 'Senate Energy',
        chamber: 'Senate',
        scheduledAt: '2026-01-01',
        type: 'hearing',
        url: null,
      }));
      return { data: { items, total: totalCount } };
    }
    if (url.includes('upcoming-hearings')) return { data: [] };
    return { data: [] };
  });
}

function renderArchive() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <HearingWatchPanel />
      </AntApp>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
}

describe('HearingWatchPage archive pagination (Gate E phase d, P2-13)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('d-7.1: total 120, 50 loaded -> "Load 50 more"; clicking advances the offset to 50', async () => {
    mockBrowse(120);
    renderArchive();

    await waitFor(() => expect(screen.getByText('Hearing 0')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Load 50 more/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load 50 more/i }));
    await waitFor(() => expect(screen.getByText('Hearing 50')).toBeInTheDocument());
    // page 1's rows are still there — appended, not replaced.
    expect(screen.getByText('Hearing 0')).toBeInTheDocument();
  });

  test('d-7.2: total 60, 50 loaded -> the button reads "Load 10 more"', async () => {
    mockBrowse(60);
    renderArchive();
    await waitFor(() => expect(screen.getByText('Hearing 0')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Load 10 more/i })).toBeInTheDocument();
  });

  test('d-7.3: total equals loaded rows -> no Load-more button', async () => {
    mockBrowse(50);
    renderArchive();
    await waitFor(() => expect(screen.getByText('Hearing 0')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Load .* more/i })).toBeNull();
  });

  test('d-7.4: changing the search query resets the depth (back to offset 0)', async () => {
    mockBrowse(120);
    renderArchive();
    await waitFor(() => expect(screen.getByText('Hearing 0')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Load 50 more/i }));
    await waitFor(() => expect(screen.getByText('Hearing 50')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('Search hearings…'), { target: { value: 'energy' } });

    // Page 2's rows are gone — depth reset to a fresh offset-0 fetch.
    await waitFor(() => expect(screen.queryByText('Hearing 50')).toBeNull());
  });

  test('d-7.5: the button is disabled and reads "Loading…" while the next page fetches', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url.includes('/upcoming-hearings/browse')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const offset = Number(params.get('offset') ?? '0');
        // A small REAL delay for page 2+ gives the test a window to observe
        // the in-flight state — more robust under React's batching than a
        // manually-resolved Promise held open indefinitely.
        if (offset > 0) await new Promise((r) => setTimeout(r, 30));
        const items = Array.from({ length: offset > 0 ? 0 : 50 }, (_, i) => ({
          id: `h-${offset + i}`,
          title: `Hearing ${offset + i}`,
          committee: 'Senate',
          chamber: 'Senate',
          scheduledAt: '2026-01-01',
          type: 'hearing',
          url: null,
        }));
        return { data: { items, total: 80 } };
      }
      return { data: [] };
    });
    renderArchive();
    await waitFor(() => expect(screen.getByText('Hearing 0')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Load 30 more/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Loading…/i })).toBeDisabled());
  });
});

describe('hearingCapability (Gate E phase d, P2-14)', () => {
  function hearing(over: Partial<UpcomingHearing> = {}): UpcomingHearing {
    return {
      id: 'h1',
      title: 'Armed Services Hearing',
      committee: 'Armed Services',
      chamber: 'Senate',
      scheduledAt: '2026-08-01',
      ...over,
    };
  }

  test('a normal row (no postponed/cancelled prefix) is "available"', () => {
    expect(hearingCapability(hearing())).toBe<HearingCapability>('available');
  });

  test('a [Postponed] row is "unavailable"', () => {
    expect(hearingCapability(hearing({ title: '[Postponed] Armed Services Hearing' }))).toBe<HearingCapability>(
      'unavailable',
    );
  });

  test('a [Cancelled] row is "unavailable"', () => {
    expect(hearingCapability(hearing({ title: '[Cancelled] Armed Services Hearing' }))).toBe<HearingCapability>(
      'unavailable',
    );
  });

  test('a [Rescheduled] row is still "available" — the event still occurs', () => {
    expect(hearingCapability(hearing({ title: '[Rescheduled] Armed Services Hearing' }))).toBe<HearingCapability>(
      'available',
    );
  });

  test('CAPABILITY_LABEL never contains the string "Watch live"', () => {
    expect(Object.values(CAPABILITY_LABEL).join(' ')).not.toMatch(/watch live/i);
  });
});

describe('HearingWatchPage row rendering (Gate E phase d, P2-14 lock)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
  });

  test('the string "Watch live" never appears, even for an upcoming row with no url', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/upcoming-hearings') {
        return {
          data: [
            {
              id: 'h1',
              title: 'Upcoming hearing with no source yet',
              committee: 'Senate Energy',
              chamber: 'Senate',
              scheduledAt: '2026-08-01',
              type: 'hearing',
              url: null,
            },
          ],
        };
      }
      return { data: [] };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <HearingWatchPanel />
        </AntApp>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText('Upcoming hearing with no source yet')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/watch live/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Set up transcription/i })).toBeInTheDocument();
  });

  test('a postponed row renders disabled TEXT, never a clickable button', async () => {
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/intel-api/upcoming-hearings') {
        return {
          data: [
            {
              id: 'h1',
              title: '[Postponed] Armed Services Hearing',
              committee: 'Armed Services',
              chamber: 'Senate',
              scheduledAt: '2026-08-01',
              type: 'hearing',
              url: null,
            },
          ],
        };
      }
      return { data: [] };
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <HearingWatchPanel />
        </AntApp>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Recording unavailable')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Recording unavailable/i })).toBeNull();
  });
});
