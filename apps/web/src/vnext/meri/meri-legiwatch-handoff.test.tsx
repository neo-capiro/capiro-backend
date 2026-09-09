import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  claimMeriIdentity,
  resetChatStoreForTests,
} from '../../components/chat/chat-store.js';
import { VNextMeriWorkspace } from './VNextMeriWorkspace.js';

/**
 * LW-04: the LegiWatch "Ask Meri" handoff.
 *
 * `/meri?source=legiwatch&hearingId=…&client=…` must never hydrate
 * `newestConversation` — that is the original bug, which landed the user in an
 * unrelated thread with portfolio scope. The handoff routes to `/meri/new`,
 * where client scope is applied and the sessionStorage packet is consumed once.
 */

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  orgId: 'org-a' as string | null,
  userId: 'user-a' as string | null,
  impersonatedTenantSlug: null as string | null,
  selectedClientId: null as string | null,
  setSelectedClientId: vi.fn(),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
  navigate: vi.fn(),
  pathname: '/meri',
  search: '',
  shellProps: null as Record<string, unknown> | null,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken, orgId: mocks.orgId, userId: mocks.userId }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: mocks.impersonatedTenantSlug }),
}));
vi.mock('../../state/client-filter.js', () => ({
  useClientFilter: () => ({
    selectedClientId: mocks.selectedClientId,
    setSelectedClientId: mocks.setSelectedClientId,
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: mocks.pathname, search: mocks.search }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('./VNextMeriIntegrations.js', () => ({ VNextMeriIntegrations: () => null }));
vi.mock('./VNextMeriShell.js', () => ({
  VNextMeriShell: (props: Record<string, unknown>) => {
    mocks.shellProps = props;
    return null;
  },
}));

let queryClient: QueryClient;

function renderRoute() {
  return render(
    <QueryClientProvider client={queryClient}>
      <VNextMeriWorkspace />
    </QueryClientProvider>,
  );
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body, text: async () => '' });
}

const NEWEST_THREAD = {
  id: 'newest-thread',
  title: 'Unrelated newest thread',
  clientId: null,
  client: null,
  latestMessage: null,
  updatedAt: '2026-09-09T00:00:00.000Z',
};

/**
 * Full history with a newest thread, so a regression to `newestConversation`
 * visibly hydrates `newest-thread` instead of failing on an empty list.
 */
function stubFetch() {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/clients')) {
      return ok([{ id: 'client-anduril', name: 'Anduril' }]);
    }
    if (url.includes('/api/clio/conversations') && init?.method !== 'POST') {
      if (url.includes('/messages')) return ok([]);
      return ok([NEWEST_THREAD]);
    }
    return ok({});
  });
}

const HANDOFF_QS = '?source=legiwatch&hearingId=hearing-123&client=client-anduril';

function writePacket() {
  sessionStorage.setItem(
    'lw:meri-context',
    JSON.stringify({
      hearingId: 'hearing-123',
      hearingTitle: 'Fauci Hearing',
      packet: { source: 'legiwatch' },
      createdAt: Date.now(),
    }),
  );
}

describe('LW-04 LegiWatch → Meri handoff', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    window.sessionStorage.clear();
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.selectedClientId = null;
    mocks.setSelectedClientId.mockClear();
    mocks.navigate.mockClear();
    mocks.pathname = '/meri';
    mocks.search = '';
    mocks.shellProps = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    mocks.api.get.mockResolvedValue({
      data: { tenant: { name: 'Tenant Under Test' }, features: { meriv3Chat: true } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('handoff params on /meri never hydrate the newest conversation', async () => {
    claimMeriIdentity('org-a:user-a');
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.pathname = '/meri';
    mocks.search = HANDOFF_QS;

    await act(async () => {
      renderRoute();
    });

    // The boot effect redirects the handoff to /meri/new; it never hydrates
    // the newest durable thread.
    expect(
      fetchMock.mock.calls.some(
        ([url]) => String(url).includes('newest-thread') || String(url).includes('/messages'),
      ),
    ).toBe(false);
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalled();
    });
    const redirect = mocks.navigate.mock.calls
      .map(([to]) => String(to))
      .find((to) => to.startsWith('/meri/new'));
    expect(redirect).toBeTruthy();
    expect(redirect).toContain('source=legiwatch');
  });

  test('handoff on /meri/new applies client scope and consumes the packet once', async () => {
    claimMeriIdentity('org-a:user-a');
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    writePacket();
    mocks.pathname = '/meri/new';
    mocks.search = HANDOFF_QS;

    await act(async () => {
      renderRoute();
    });

    await waitFor(() => {
      expect(mocks.setSelectedClientId).toHaveBeenCalledWith('client-anduril');
    });
    // The packet is consumed (removed) exactly once.
    expect(sessionStorage.getItem('lw:meri-context')).toBeNull();

    // Params are stripped after the handoff is honored.
    await waitFor(() => {
      const stripped = mocks.navigate.mock.calls.some(([to]) => {
        if (typeof to !== 'string') {
          const target = to as { pathname?: string; search?: string };
          return (
            target.pathname === '/meri/new' &&
            !(target.search ?? '').includes('source=legiwatch')
          );
        }
        return to.startsWith('/meri/new') && !to.includes('source=legiwatch');
      });
      expect(stripped).toBe(true);
    });
    // And no route error: the handoff succeeded.
    expect(document.querySelector('.vnext-meri__route-error')).toBeNull();
  });

  test('a missing packet with handoff params fails loudly, never silently', async () => {
    claimMeriIdentity('org-a:user-a');
    vi.stubGlobal('fetch', stubFetch());
    // No packet written.
    mocks.pathname = '/meri/new';
    mocks.search = HANDOFF_QS;

    await act(async () => {
      renderRoute();
    });

    await waitFor(() => {
      expect(document.querySelector('.vnext-meri__route-error')).not.toBeNull();
    });
    expect(document.querySelector('.vnext-meri__route-error')?.textContent).toContain(
      'hearing context packet was not found',
    );
  });

  test('an unknown handoff client fails loudly, never silently', async () => {
    claimMeriIdentity('org-a:user-a');
    vi.stubGlobal('fetch', stubFetch());
    writePacket();
    mocks.pathname = '/meri/new';
    mocks.search = '?source=legiwatch&hearingId=hearing-123&client=client-gone';

    await act(async () => {
      renderRoute();
    });

    await waitFor(() => {
      expect(document.querySelector('.vnext-meri__route-error')).not.toBeNull();
    });
    expect(document.querySelector('.vnext-meri__route-error')?.textContent).toContain(
      'not available here',
    );
    // The unknown client was never applied as scope.
    expect(mocks.setSelectedClientId).not.toHaveBeenCalledWith('client-gone');
  });

  test('root route without handoff params keeps the newest-thread behavior', async () => {
    claimMeriIdentity('org-a:user-a');
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    mocks.pathname = '/meri';
    mocks.search = '';

    await act(async () => {
      renderRoute();
    });

    // No-regression: the ordinary root route still hydrates the newest thread.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('newest-thread/messages')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(
        mocks.navigate.mock.calls.some(
          ([to]) => String(to) === '/meri/t/newest-thread',
        ),
      ).toBe(true);
    });
  });
});
