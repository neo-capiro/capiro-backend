import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { TrackerSurface } from './TrackerTab.js';

/**
 * P1-05 (Gate A phase e) — honest per-channel test-alert results. Renders
 * `TrackerSurface` (the component `TrackerTab` thinly wraps) with
 * `variant="watchlist"` so the Configure panel is the initial panel (avoids
 * fragile tab-click navigation to reach it) — same component, same
 * fireTest/pushToast code path `TrackerTab` uses. Mocks at the `use-api.js`
 * level, matching this repo's established convention.
 */

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
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
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
}

const PREFS = {
  triggers: ['newMatch'],
  materiality: 'medium',
  emailEnabled: true,
  emailAddress: 'analyst@example.com',
  emailCadence: 'realtime',
  smsEnabled: false,
  smsPhone: null,
  smsPhoneVerified: false,
  smsCadence: 'realtime',
  quietHoursStart: null,
  quietHoursEnd: null,
  jurisdictions: [],
};

function mockGets() {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.includes('/feature-flags')) return { data: {} }; // tracker_v2 off -> legacy paths
    if (url.endsWith('/alert-prefs')) return { data: PREFS };
    if (url.endsWith('/watchlist')) return { data: { issueAreas: [], tags: [] } };
    if (url.endsWith('/watchlist/seed-suggestions')) return { data: { tags: [], issueAreas: [] } };
    if (url.endsWith('/issue-areas')) return { data: { issueAreas: [] } };
    if (url.endsWith('/board')) return { data: { columns: [], total: 0 } };
    if (url.endsWith('/recommendations')) return { data: { recommendations: [], aboveFloorCount: 0 } };
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

describe('TrackerSurface — honest test-alert results (P1-05)', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
  });

  test('6. a failed channel shows BOTH rows, the word "failed", and the toast carries has-failure', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/test-alert')) {
        return { data: [{ channel: 'in_app', status: 'sent' }, { channel: 'email', status: 'failed' }] };
      }
      return { data: {} };
    });
    renderConfig();

    const sendButton = await screen.findByRole('button', { name: /Send test alert/i });
    sendButton.click();

    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument());
    expect(screen.getByText(/In-app: sent/i)).toBeInTheDocument();
    const toastEl = document.querySelector('.trk-toast.has-failure');
    expect(toastEl).not.toBeNull();
  });

  test('7. a skipped channel shows "skipped" and the reason as the chip title', async () => {
    apiPostMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/test-alert')) {
        return {
          data: [
            { channel: 'in_app', status: 'sent' },
            { channel: 'email', status: 'skipped', detail: 'no email address saved' },
          ],
        };
      }
      return { data: {} };
    });
    renderConfig();

    const sendButton = await screen.findByRole('button', { name: /Send test alert/i });
    sendButton.click();

    await waitFor(() => expect(screen.getByText(/skipped/i)).toBeInTheDocument());
    const chip = screen.getByText(/Email: skipped/i);
    expect(chip).toHaveAttribute('title', 'no email address saved');
  });
});
