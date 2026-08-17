import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetChatStoreForTests } from '../../components/chat/chat-store.js';

/**
 * The thread rail's query-cache boundary.
 *
 * The canonical search key `['meri-conversation-search', q]` is deliberately NOT
 * identity-scoped, so a prior tenant's search results can only be kept out by
 * eviction. The library keys are identity-scoped but their previous-identity
 * entries still sit in an app-wide QueryClient after a switch.
 *
 * This is asserted here rather than through the route because the rail's own
 * correctness must not depend on `key={identityKey}` living in another file.
 */

const mocks = vi.hoisted(() => ({
  orgId: 'org-a' as string | null,
  userId: 'user-a' as string | null,
  impersonatedTenantSlug: null as string | null,
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: mocks.orgId, userId: mocks.userId }),
}));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: mocks.impersonatedTenantSlug }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('./meri-vnext-api.js', () => ({
  listMeriSavedPrompts: vi.fn(async () => []),
  listMeriWorkspaces: vi.fn(async () => []),
  createMeriSavedPrompt: vi.fn(),
  createMeriWorkspace: vi.fn(),
  deleteMeriSavedPrompt: vi.fn(),
  deleteMeriWorkspace: vi.fn(),
  assignMeriConversationWorkspace: vi.fn(),
}));

import { VNextMeriThreadRail } from './VNextMeriThreadRail.js';

const CONTROLLER = {
  isStreaming: false,
  sessionId: null,
} as unknown as Parameters<typeof VNextMeriThreadRail>[0]['controller'];

let queryClient: QueryClient;

function renderRail() {
  const props = {
    controller: CONTROLLER,
    historyError: null,
    onRetryHistory: vi.fn(),
    onNewChat: vi.fn(),
    onOpenIntegrations: vi.fn(),
    onArchiveThread: vi.fn(async () => true),
    onRenameThread: vi.fn(async () => undefined),
    onRestoreThread: vi.fn(async () => true),
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    searchInputRef: { current: null },
  } as unknown as Parameters<typeof VNextMeriThreadRail>[0];

  const view = render(
    <QueryClientProvider client={queryClient}>
      <VNextMeriThreadRail {...props} />
    </QueryClientProvider>,
  );
  return {
    rerenderRail: () =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <VNextMeriThreadRail {...props} />
        </QueryClientProvider>,
      ),
  };
}

function seedForeignCache() {
  queryClient.setQueryData(
    ['meri-conversation-search', 'merger'],
    [{ id: 'thread-a', title: 'Tenant A merger memo', snippet: 'confidential' }],
  );
  queryClient.setQueryData(
    ['meri-vnext', 'tenant-a:user-a', 'saved-prompts'],
    [{ id: 'prompt-a', title: 'Tenant A prompt', body: 'x' }],
  );
  queryClient.setQueryData(
    ['meri-vnext', 'tenant-a:user-a', 'workspaces'],
    [{ id: 'ws-a', name: 'Tenant A workspace' }],
  );
}

describe('vNext Meri thread rail — query cache identity boundary', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    mocks.api.get.mockResolvedValue({ data: [] });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('mounting evicts another identity search and library cache, keyless of the route', async () => {
    // Simulates the route remounting the rail on `key={identityKey}` after a
    // switch: the rail sees a first mount, but the cache is another tenant's.
    seedForeignCache();

    await act(async () => {
      renderRail();
    });

    expect(queryClient.getQueryData(['meri-conversation-search', 'merger'])).toBeUndefined();
    expect(
      queryClient.getQueryData(['meri-vnext', 'tenant-a:user-a', 'saved-prompts']),
    ).toBeUndefined();
    expect(queryClient.getQueryData(['meri-vnext', 'tenant-a:user-a', 'workspaces'])).toBeUndefined();
  });

  test('an in-place identity change evicts the previous identity but keeps the new one', async () => {
    let rerenderRail: (() => void) | null = null;
    await act(async () => {
      rerenderRail = renderRail().rerenderRail;
    });

    seedForeignCache();
    queryClient.setQueryData(
      ['meri-vnext', 'tenant-b:user-a', 'saved-prompts'],
      [{ id: 'prompt-b', title: 'Tenant B prompt', body: 'y' }],
    );

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerenderRail!();
    });

    expect(queryClient.getQueryData(['meri-conversation-search', 'merger'])).toBeUndefined();
    expect(
      queryClient.getQueryData(['meri-vnext', 'tenant-a:user-a', 'saved-prompts']),
    ).toBeUndefined();
    // The predicate must not evict the identity that is now live.
    expect(queryClient.getQueryData(['meri-vnext', 'tenant-b:user-a', 'saved-prompts'])).toEqual([
      { id: 'prompt-b', title: 'Tenant B prompt', body: 'y' },
    ]);
  });
});
