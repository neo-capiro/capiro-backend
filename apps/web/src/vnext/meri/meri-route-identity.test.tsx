import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  claimMeriIdentity,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setChatSession,
  setConversations,
} from '../../components/chat/chat-store.js';

/**
 * Rendered-route coverage for the vNext Meri identity boundary.
 *
 * `VNextMeriWorkspace` owns the clear/reload decision for the route, so the
 * behaviour below cannot be asserted from the controller or from the pure
 * guards. The shell is stubbed to a callback probe: the route's own effects,
 * bootstrap, and rail mutations stay real, without pulling in the whole vNext
 * component tree.
 */

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  orgId: 'org-a' as string | null,
  userId: 'user-a' as string | null,
  impersonatedTenantSlug: null as string | null,
  selectedClientId: null as string | null,
  setSelectedClientId: vi.fn((id: string | null) => {
    mocks.selectedClientId = id;
  }),
  api: { post: vi.fn(), get: vi.fn(), patch: vi.fn() },
  navigate: vi.fn(),
  pathname: '/meri/t/thread-a',
  shellProps: null as Record<string, unknown> | null,
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken, orgId: mocks.orgId, userId: mocks.userId }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../lib/me.js', () => ({ useMe: () => ({ data: null }) }));
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
  useLocation: () => ({ pathname: mocks.pathname, search: '' }),
  useNavigate: () => mocks.navigate,
}));
vi.mock('./VNextMeriIntegrations.js', () => ({
  VNextMeriIntegrations: () => null,
}));
vi.mock('./VNextMeriShell.js', () => ({
  VNextMeriShell: (props: Record<string, unknown>) => {
    mocks.shellProps = props;
    return null;
  },
}));

import { VNextMeriWorkspace } from './VNextMeriWorkspace.js';

const THREAD_A = {
  id: 'thread-a',
  title: 'Tenant A thread',
  clientId: null,
  client: null,
  latestMessage: null,
  updatedAt: '2026-08-17T00:00:00.000Z',
};

function ok(body: unknown) {
  return Promise.resolve({ ok: true, json: async () => body, text: async () => '' });
}

/**
 * Serves the route bootstrap (client roster, history, hydration) so the shell
 * actually mounts. `handler` overrides any single endpoint for the test at hand.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const override = handler(url, init);
    if (override !== undefined) return override as Promise<unknown>;
    if (url.endsWith('/api/clients')) return ok([]);
    if (url.endsWith('/api/clio/conversations') && init?.method !== 'POST') {
      // Tenant B's history genuinely does not contain tenant A's thread, so a
      // reload under the new identity cannot mask a failure to clear.
      return ok(mocks.impersonatedTenantSlug ? [] : [THREAD_A]);
    }
    if (url.includes('/messages')) return ok([]);
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('vNext Meri route identity boundary', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.selectedClientId = null;
    mocks.setSelectedClientId.mockClear();
    mocks.navigate.mockClear();
    mocks.getToken.mockReset();
    mocks.getToken.mockImplementation(async () => 'token');
    mocks.pathname = '/meri/t/thread-a';
    mocks.shellProps = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('entering Meri under the owning identity keeps the app-wide client filter', async () => {
    // The route scopes the first durable thread with this value, so treating an
    // ordinary navigation into Meri as a tenant switch would silently unscope it.
    claimMeriIdentity('org-a:user-a');
    mocks.selectedClientId = 'client-a';
    stubFetch(() => undefined);

    await act(async () => {
      render(<VNextMeriWorkspace />);
    });

    expect(mocks.setSelectedClientId).not.toHaveBeenCalled();
    expect(mocks.selectedClientId).toBe('client-a');
  });

  test('entering Meri while the store belongs to another identity clears the filter', async () => {
    // Impersonation started on a different surface: this route is the first
    // vNext paint under the new identity and must not inherit A's client.
    claimMeriIdentity('tenant-a:user-a');
    mocks.selectedClientId = 'client-a';
    stubFetch(() => undefined);

    await act(async () => {
      render(<VNextMeriWorkspace />);
    });

    expect(mocks.setSelectedClientId).toHaveBeenCalledWith(null);
    expect(mocks.selectedClientId).toBeNull();
  });

  test('an in-place identity switch clears the shared transcript and the client filter', async () => {
    claimMeriIdentity('org-a:user-a');
    mocks.selectedClientId = 'client-a';
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    setConversations([THREAD_A]);
    stubFetch(() => undefined);

    let rerenderRoute: (() => void) | null = null;
    await act(async () => {
      const view = render(<VNextMeriWorkspace />);
      rerenderRoute = () => view.rerender(<VNextMeriWorkspace />);
    });

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRoute!();
    });

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: null,
      activeConversationId: null,
      conversations: [],
      messages: [],
    });
    expect(mocks.selectedClientId).toBeNull();
  });

  test('identity switch during token acquisition never dispatches the rail archive', async () => {
    claimMeriIdentity('org-a:user-a');
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    setConversations([THREAD_A]);
    const fetchMock = stubFetch(() => undefined);

    let rerenderRoute: (() => void) | null = null;
    await act(async () => {
      const view = render(<VNextMeriWorkspace />);
      rerenderRoute = () => view.rerender(<VNextMeriWorkspace />);
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());

    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = () => resolve('token');
        }),
    );

    const onArchiveThread = mocks.shellProps!.onArchiveThread as (
      id: string,
    ) => Promise<boolean>;
    let archive: Promise<boolean> | null = null;
    await act(async () => {
      archive = onArchiveThread('thread-a');
    });
    await waitFor(() => expect(releaseToken).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRoute!();
    });

    let archived: boolean | null = null;
    await act(async () => {
      releaseToken!();
      archived = await archive!;
    });

    // The resolved token authenticates tenant B. Archiving tenant A's thread
    // with it is a cross-identity write, and the rail must not offer undo.
    expect(archived).toBe(false);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/archive'))).toHaveLength(
      0,
    );
  });

  test('identity switch during token acquisition never dispatches the rail rename', async () => {
    claimMeriIdentity('org-a:user-a');
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    setConversations([THREAD_A]);
    const fetchMock = stubFetch(() => undefined);

    let rerenderRoute: (() => void) | null = null;
    await act(async () => {
      const view = render(<VNextMeriWorkspace />);
      rerenderRoute = () => view.rerender(<VNextMeriWorkspace />);
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());

    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = () => resolve('token');
        }),
    );

    const onRenameThread = mocks.shellProps!.onRenameThread as (
      id: string,
      title: string,
    ) => Promise<void>;
    let rename: Promise<void> | null = null;
    await act(async () => {
      rename = onRenameThread('thread-a', 'Renamed by tenant A');
    });
    await waitFor(() => expect(releaseToken).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRoute!();
    });
    await act(async () => {
      releaseToken!();
      await rename!;
    });

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/api/clio/conversations/thread-a') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      ),
    ).toHaveLength(0);
  });

  test('a delayed rail restore from the prior identity does not refresh the new history', async () => {
    claimMeriIdentity('org-a:user-a');
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    setConversations([THREAD_A]);

    let resolveRestore: ((value: unknown) => void) | null = null;
    stubFetch((url) => {
      if (url.includes('/restore')) {
        return new Promise((resolve) => {
          resolveRestore = resolve;
        });
      }
      return undefined;
    });

    let rerenderRoute: (() => void) | null = null;
    await act(async () => {
      const view = render(<VNextMeriWorkspace />);
      rerenderRoute = () => view.rerender(<VNextMeriWorkspace />);
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());

    const onRestoreThread = mocks.shellProps!.onRestoreThread as (
      id: string,
    ) => Promise<boolean>;
    let restore: Promise<boolean> | null = null;
    await act(async () => {
      restore = onRestoreThread('thread-a');
    });
    await waitFor(() => expect(resolveRestore).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRoute!();
    });

    let restored: boolean | null = null;
    await act(async () => {
      resolveRestore!({ ok: true, json: async () => ({}) });
      restored = await restore!;
    });

    // False tells the rail the request outlived its identity: no undo toast, no
    // re-insertion of tenant A's row, and no history reload under tenant B.
    expect(restored).toBe(false);
    expect(getChatStateSnapshot().conversations).toEqual([]);
  });
});
