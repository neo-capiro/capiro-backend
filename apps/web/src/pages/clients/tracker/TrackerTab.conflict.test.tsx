import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * Gate B phase e (P1-02) — a 409 from the versioned watchlist PUT. Targeting is
 * SHARED firm-wide, so when another analyst saves first this surface must say so
 * and refetch THEIR version, never silently overwrite it and never auto-merge.
 *
 * Renders `TrackerSurface` with `variant="watchlist"` (Configure is the initial
 * panel) and mocks at the `use-api.js` level — this repo's convention, matching
 * TrackerTab.testalert.test.tsx.
 */

const apiGetMock = vi.fn();
const apiPutMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: vi.fn(),
    put: apiPutMock,
    patch: vi.fn(),
    delete: vi.fn(),
  }),
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

const PREFS = {
  triggers: ['newMatch'],
  materiality: 'medium',
  emailEnabled: false,
  emailAddress: null,
  emailCadence: 'realtime',
  smsEnabled: false,
  smsPhone: null,
  smsPhoneVerified: false,
  smsCadence: 'realtime',
  quietHoursStart: null,
  quietHoursEnd: null,
  jurisdictions: [],
};

/** intel-api watchlist shape (tracker_v2 ON — the versioned path). */
function intelWatchlist(version: number, topicLabel: string) {
  return {
    clientId: 'client-1',
    issueAreas: [],
    jurisdictions: [],
    version,
    updatedBy: null,
    updatedAt: '2026-07-26T13:41:00.000Z',
    topics: [
      { label: topicLabel, issueArea: null, position: 'monitor', priority: 'med', terms: [] },
    ],
  };
}

let watchlistFetches = 0;

function mockGets() {
  apiGetMock.mockImplementation(async (url: string) => {
    // tracker_v2 ON -> the intel (versioned) paths.
    if (url.includes('/feature-flags')) return { data: { tracker_v2: true } };
    // P1-02: targeting edits are admin-only, so the surface reads /me for the role.
    if (url === '/api/me') return { data: { role: 'capiro_admin' } };
    if (url.endsWith('/alert-prefs')) return { data: PREFS };
    if (url.includes('/tracker/watchlists/') && url.endsWith('/compiled')) {
      return { data: { termSurfaces: {} } };
    }
    if (url.includes('/tracker/watchlists/') && url.endsWith('/seed-suggestions')) {
      return { data: { tags: [], issueAreas: [] } };
    }
    if (url.includes('/tracker/watchlists/')) {
      watchlistFetches += 1;
      // The refetch after the conflict returns the OTHER analyst's version.
      return {
        data:
          watchlistFetches === 1
            ? intelWatchlist(1, 'mine')
            : intelWatchlist(2, 'theirs'),
      };
    }
    if (url.endsWith('/issue-areas')) return { data: { issueAreas: ['Energy'] } };
    if (url.endsWith('/board')) return { data: { columns: [] } };
    if (url.endsWith('/recommendations')) return { data: [] };
    return { data: {} };
  });
}

function renderConfig() {
  setupBrowserMocks();
  mockGets();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter>
          <TrackerSurface clientId="client-1" clientName="Acme Corp" variant="watchlist" />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

describe('TrackerSurface — watchlist version conflict (P1-02)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPutMock.mockReset();
    watchlistFetches = 0;
  });

  test('e-10.9 a 409 WATCHLIST_VERSION_CONFLICT shows the message and refetches the other version', async () => {
    apiPutMock.mockRejectedValue({
      response: {
        status: 409,
        data: {
          code: 'WATCHLIST_VERSION_CONFLICT',
          message:
            'This client’s targeting was changed by someone else. Reload to see their changes before saving yours.',
          currentVersion: 2,
        },
      },
    });
    renderConfig();

    // Make a real edit so the debounced autosave fires the versioned PUT.
    const energy = await screen.findByRole('button', { name: 'Energy' });
    energy.click();

    await waitFor(() => expect(apiPutMock).toHaveBeenCalled());
    // The PUT carried the version the editor had read.
    expect(apiPutMock.mock.calls[0]![1]).toMatchObject({ expectedVersion: 1 });

    // The conflict is stated, not swallowed into a generic toast.
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('changed by someone else'),
    );
    // …and the query was invalidated, so the other analyst's version is refetched.
    await waitFor(() => expect(watchlistFetches).toBeGreaterThan(1));
    // The phase-c resync then adopts it (the tag row head shows the name), so the
    // editor stops showing targeting that is no longer what is persisted.
    await waitFor(() => expect(screen.getByText('theirs')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText('mine')).toBeNull();
  });

  test('a non-409 failure falls back to the generic save-failed state with a Retry', async () => {
    apiPutMock.mockRejectedValue({ response: { status: 500, data: {} } });
    renderConfig();

    const energy = await screen.findByRole('button', { name: 'Energy' });
    energy.click();

    await waitFor(() => expect(apiPutMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector('.wl-savestate')!.textContent).toContain('Save failed'),
    );
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });
});
