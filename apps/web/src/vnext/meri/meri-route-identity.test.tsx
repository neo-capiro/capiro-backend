import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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
import { useMeriComposerDraft, restoreMeriComposerDraft } from './meri-composer-drafts.js';
import { writeDraftReasoningMode } from './meri-reasoning-state.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';

let queryClient: QueryClient;

/** Renders the real route inside a real QueryClient, and exposes a rerender. */
function renderRoute() {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <VNextMeriWorkspace />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderRoute: () =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <VNextMeriWorkspace />
        </QueryClientProvider>,
      ),
  };
}

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
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/meri/t/thread-a');
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.selectedClientId = null;
    mocks.setSelectedClientId.mockClear();
    mocks.navigate.mockClear();
    mocks.getToken.mockReset();
    mocks.getToken.mockImplementation(async () => 'token');
    mocks.pathname = '/meri/t/thread-a';
    mocks.search = '';
    mocks.shellProps = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    // /api/me answers through the api mock so `useMe()` is the real query.
    mocks.api.get.mockResolvedValue({
      data: { tenant: { name: 'Tenant Under Test' }, features: { meriv3Chat: true } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('an archived deep link offers explicit restore, then reopens its saved messages', async () => {
    let archived = true;
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/clio/conversations')) return ok(archived ? [] : [THREAD_A]);
      if (url.endsWith('/conversations/thread-a')) {
        return ok({ ...THREAD_A, archivedAt: '2026-09-10T10:00:00Z', status: 'archived' });
      }
      if (url.endsWith('/thread-a/restore') && init?.method === 'PATCH') {
        archived = false;
        return ok({ ...THREAD_A, archivedAt: null });
      }
      if (url.endsWith('/thread-a/messages')) {
        return ok([{ id: 'saved-answer', role: 'assistant', body: 'Saved before archive.' }]);
      }
      return undefined;
    });

    renderRoute();
    await screen.findByText('Archived thread');
    expect(screen.getByText(THREAD_A.title)).toBeTruthy();
    expect(mocks.shellProps).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/restore') || url.endsWith('/messages'))).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }));
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/restore') && init?.method === 'PATCH')).toHaveLength(1);
    expect(getChatStateSnapshot()).toMatchObject({
      activeConversationId: 'thread-a', sessionId: 'thread-a',
      messages: [{ id: 'saved-answer', content: 'Saved before archive.' }],
    });
    expect(screen.queryByText('Archived thread')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  test.each([403, 404])('an inaccessible exact lookup (%s) stays generic and offers no restoration', async (status) => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/clio/conversations')) return ok([]);
      if (url.endsWith('/conversations/thread-a')) {
        return Promise.resolve({ ok: false, status, json: async () => ({ title: 'Private title' }) });
      }
      return undefined;
    });
    renderRoute();
    await screen.findByText('This Meri thread is not available in your conversation history.');
    expect(screen.queryByRole('button', { name: 'Restore thread' })).toBeNull();
    expect(screen.queryByText('Private title')).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  test.each([
    { ...THREAD_A, archivedAt: null },
    { ...THREAD_A, id: 'different-thread', archivedAt: '2026-09-10T10:00:00Z' },
  ])('only the exact owned archived row enables recovery (%j)', async (row) => {
    stubFetch((url) => {
      if (url.endsWith('/api/clio/conversations')) return ok([]);
      if (url.endsWith('/conversations/thread-a')) return ok(row);
      return undefined;
    });
    renderRoute();
    await screen.findByText('This Meri thread is not available in your conversation history.');
    expect(screen.queryByRole('button', { name: 'Restore thread' })).toBeNull();
  });

  test('an archived lookup completing under a new identity cannot reveal the prior title', async () => {
    let resolveLookup: ((value: unknown) => void) | null = null;
    stubFetch((url) => {
      if (url.endsWith('/api/clio/conversations')) return ok([]);
      if (url.endsWith('/conversations/thread-a')) {
        if (mocks.impersonatedTenantSlug) return Promise.resolve({ ok: false, status: 404 });
        return new Promise((resolve) => { resolveLookup = resolve; });
      }
      return undefined;
    });
    const view = renderRoute();
    await waitFor(() => expect(resolveLookup).not.toBeNull());
    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      view.rerenderRoute();
    });
    await screen.findByText('This Meri thread is not available in your conversation history.');
    await act(async () => {
      resolveLookup!({ ok: true, json: async () => ({ ...THREAD_A, archivedAt: '2026-09-10T10:00:00Z' }) });
    });
    expect(screen.queryByText(THREAD_A.title)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore thread' })).toBeNull();
    expect(getChatStateSnapshot().messages).toEqual([]);
  });

  test.each(['identity', 'route', 'unmount'])('a %s change while restore awaits auth dispatches no mutation', async (change) => {
    const fetchMock = stubFetch((url) => {
      if (url.endsWith('/api/clio/conversations')) return ok([]);
      if (url.endsWith('/conversations/thread-a')) return ok({ ...THREAD_A, archivedAt: '2026-09-10T10:00:00Z' });
      return undefined;
    });
    const view = renderRoute();
    await screen.findByRole('button', { name: 'Restore thread' });
    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(() => new Promise<string>((resolve) => { releaseToken = () => resolve('token'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }));
    await waitFor(() => expect(releaseToken).not.toBeNull());
    await act(async () => {
      if (change === 'unmount') { view.unmount(); return; }
      if (change === 'identity') mocks.impersonatedTenantSlug = 'tenant-b';
      else {
        mocks.pathname = '/meri/new';
        window.history.replaceState({}, '', mocks.pathname);
      }
      view.rerenderRoute();
    });
    await act(async () => { releaseToken!(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  test('a failed restore retains an explicit retry without claiming success', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/clio/conversations')) return ok([]);
      if (url.endsWith('/conversations/thread-a')) return ok({ ...THREAD_A, archivedAt: '2026-09-10T10:00:00Z' });
      if (url.endsWith('/restore')) return Promise.resolve({ ok: false, status: 403 });
      return undefined;
    });
    renderRoute();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore thread' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('This thread could not be restored. Try again or open Meri.');
    expect((screen.getByRole('button', { name: 'Restore thread' }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.shellProps).toBeNull();
  });

  test('a pending identity cannot probe an archived direct link', async () => {
    mocks.userId = null;
    const fetchMock = stubFetch((url) => url.endsWith('/api/clio/conversations') ? ok([]) : undefined);
    await act(async () => { renderRoute(); });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/conversations/thread-a'))).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Restore thread' })).toBeNull();
  });

  test('entering Meri under the owning identity keeps the app-wide client filter', async () => {
    // The route scopes the first durable thread with this value, so treating an
    // ordinary navigation into Meri as a tenant switch would silently unscope it.
    claimMeriIdentity('org-a:user-a');
    mocks.selectedClientId = 'client-a';
    stubFetch(() => undefined);

    await act(async () => {
      renderRoute();
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
      renderRoute();
    });

    expect(mocks.setSelectedClientId).toHaveBeenCalledWith(null);
    expect(mocks.selectedClientId).toBeNull();
  });

  test('an identity change drops the cached /api/me so no prior tenant is painted', async () => {
    // `useMe()` is keyed ['me'] on an app-wide QueryClient with a 30s staleTime.
    // Without eviction the remounted shell renders the previous tenant's name
    // and feature flags immediately, because cached data means isLoading=false.
    claimMeriIdentity('org-a:user-a');
    stubFetch(() => undefined);
    queryClient.setQueryData(['me'], {
      tenant: { name: 'Tenant A' },
      features: { meriv3Chat: true },
    });

    let rerenderRoute: (() => void) | null = null;
    await act(async () => {
      const view = renderRoute();
      rerenderRoute = view.rerenderRoute;
    });
    expect(queryClient.getQueryData(['me'])).toBeTruthy();

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRoute!();
    });

    // Real cache state, not a spy. The mounted query refetches straight after
    // eviction, so what matters is that tenant A's answer is no longer what
    // ['me'] holds — the shell can never paint "Tenant A" under tenant B.
    const cachedMe = queryClient.getQueryData(['me']) as { tenant?: { name?: string } } | undefined;
    expect(cachedMe?.tenant?.name).not.toBe('Tenant A');
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
      const view = renderRoute();
      rerenderRoute = view.rerenderRoute;
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
      const view = renderRoute();
      rerenderRoute = view.rerenderRoute;
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());

    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = () => resolve('token');
        }),
    );

    const onArchiveThread = mocks.shellProps!.onArchiveThread as (id: string) => Promise<boolean>;
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
      const view = renderRoute();
      rerenderRoute = view.rerenderRoute;
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
      const view = renderRoute();
      rerenderRoute = view.rerenderRoute;
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());

    const onRestoreThread = mocks.shellProps!.onRestoreThread as (id: string) => Promise<boolean>;
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

  test('first Send retains its draft and dispatches no turn when the selected reasoning mode fails to save', async () => {
    claimMeriIdentity('org-a:user-a');
    mocks.pathname = '/meri/new';
    window.history.replaceState({}, '', mocks.pathname);
    writeDraftReasoningMode('deep', 'org-a:user-a');
    restoreMeriComposerDraft('org-a:user-a', null, 'Early client constraint');
    const draft = renderHook(() => useMeriComposerDraft('org-a:user-a', null));
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/clio/conversations') && init?.method === 'POST')
        return ok({ id: 'created-thread' });
      if (url.endsWith('/reasoning-mode')) return Promise.resolve({ ok: false, status: 503 });
      return undefined;
    });
    await act(async () => {
      renderRoute();
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());
    let failure: unknown;
    await act(async () => {
      const restore = draft.result.current.clearForSubmission();
      try {
        await (mocks.shellProps!.controller as MeriChatController).sendMessage(
          'Early client constraint',
        );
      } catch (error) {
        failure = error;
        restore();
      }
    });
    expect(failure).toBeInstanceOf(Error);
    expect(draft.result.current.draft).toBe('Early client constraint');
    expect(getChatStateSnapshot().sessionId).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(0);
  });

  test('a contextual prospect launch creates exactly one prospect-scoped thread without client scope', async () => {
    claimMeriIdentity('org-a:user-a');
    mocks.pathname = '/meri/new';
    mocks.search =
      '?meriPrompt=Prepare+the+grounded+brief&meriProspect=11111111-1111-4111-8111-111111111111';
    window.history.replaceState({}, '', `${mocks.pathname}${mocks.search}`);
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/clio/conversations') && init?.method === 'POST') {
        return ok({ id: 'prospect-thread', title: 'Opportunity brief', clientId: null });
      }
      return undefined;
    });

    await act(async () => {
      renderRoute();
    });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => url.endsWith('/api/clio/conversations') && init?.method === 'POST',
        ),
      ).toHaveLength(1),
    );
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url.endsWith('/api/clio/conversations') && init?.method === 'POST',
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      prospectId: '11111111-1111-4111-8111-111111111111',
      title: 'Opportunity brief',
    });
    expect(JSON.parse(String(createCall?.[1]?.body))).not.toHaveProperty('clientId');
  });

  test('a deferred first turn rejected by HTTP restores the created thread draft after navigation', async () => {
    claimMeriIdentity('org-a:user-a');
    mocks.pathname = '/meri/new';
    window.history.replaceState({}, '', mocks.pathname);
    writeDraftReasoningMode('deep', 'org-a:user-a');
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith('/api/clio/conversations') && init?.method === 'POST')
        return ok({ id: 'created-thread' });
      if (url.endsWith('/stream'))
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Unavailable',
          text: async () => 'Try again',
        });
      return undefined;
    });
    await act(async () => {
      renderRoute();
    });
    await waitFor(() => expect(mocks.shellProps).not.toBeNull());
    await act(async () => {
      await (mocks.shellProps!.controller as MeriChatController).sendMessage(
        'First prompt belongs here',
      );
    });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/stream'))).toHaveLength(1),
    );
    const draft = renderHook(() => useMeriComposerDraft('org-a:user-a', 'created-thread'));
    await waitFor(() => expect(draft.result.current.draft).toBe('First prompt belongs here'));
    expect(getChatStateSnapshot().sessionId).toBe('created-thread');
    expect(mocks.navigate).toHaveBeenCalledWith('/meri/t/created-thread', { replace: true });
    const unusedDraft = renderHook(() => useMeriComposerDraft('org-a:user-a', null));
    expect(unusedDraft.result.current.draft).toBe('');
  });
});
