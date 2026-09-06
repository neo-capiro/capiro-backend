import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const stableGetToken = vi.fn(async () => 'test-token');
const stableAuth = { getToken: stableGetToken, orgId: 'org-1', userId: 'user-1' };
const stableApi = { get: async () => ({ data: [] }), post: async () => ({ data: {} }) };
const stableImpersonation = { actAsTenantSlug: null };
const notices = { success: vi.fn(), error: vi.fn() };
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => stableAuth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => stableApi }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => stableImpersonation }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../vnext/components/feedback/toast.js', () => ({ useCapiroToast: () => notices }));
vi.mock('../../vnext/meri/meri-icons.js', () => ({ MeriIcon: () => null }));
vi.mock('../../vnext/meri/VNextMeriMessage.js', () => ({ VNextMeriMessage: () => null }));
vi.mock('../../vnext/meri/VNextMeriComposer.js', () => ({ VNextMeriComposer: () => null }));
vi.mock('../../vnext/meri/VNextMeriReasoningControl.js', () => ({
  VNextMeriReasoningControl: () => null,
}));
vi.mock('../../vnext/meri/MeriApprovalNotice.js', () => ({ MeriApprovalNotice: () => null }));
vi.mock('../../vnext/meri/MeriStartWork.js', () => ({ MeriStartWork: () => null }));

import { VNextMeriConversation } from '../../vnext/meri/VNextMeriConversation.js';
import { useMeriChatController, type MeriChatController } from './useMeriChatController.js';
import {
  appendChatMessage,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setChatSession,
  setConversations,
  type MeriConversation,
} from './chat-store.js';

const row = (id: string, title: string, clientId = 'client-a'): MeriConversation => ({
  id,
  title,
  clientId,
  client: { id: clientId, name: clientId },
  updatedAt: '2026-09-06T12:00:00Z',
  latestMessage: null,
});
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let controller: MeriChatController;
function Harness() {
  controller = useMeriChatController({ selectedClientName: null });
  return (
    <VNextMeriConversation
      controller={controller}
      greetingName="Neo"
      tenantName="Capiro"
      onOpenIntegrations={() => {}}
      onOpenMemory={() => {}}
      threadRailCollapsed={false}
      onExpandThreadRail={() => {}}
      onOpenSourceDetail={() => {}}
      onOpenTurnInspector={() => {}}
      onOpenApprovals={() => {}}
    />
  );
}
function mount() {
  return render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
}
function rename(title = 'Updated brief') {
  fireEvent.click(screen.getByRole('button', { name: 'Thread actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rename thread' }), {
    target: { value: title },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}
function installFetch(patch: (url: string, body: Record<string, unknown>) => Promise<Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, body });
        return patch(url, body);
      }
      return ok([]);
    }),
  );
  return calls;
}

describe('thread-header rename persistence', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    stableGetToken.mockReset().mockResolvedValue('test-token');
    setConversations([
      row('thread-a', 'Original brief'),
      row('thread-b', 'Second thread', 'client-b'),
    ]);
    setActiveConversation('thread-a');
    setChatSession('thread-a');
    appendChatMessage({
      id: 'message-a',
      role: 'user',
      content: 'Prepare my brief',
      createdAt: new Date('2026-09-06T12:00:00Z'),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('sends the explicit new title and only reports success after PATCH, then reopens with the saved title', async () => {
    const response = deferred<Response>();
    const calls = installFetch(async () => response.promise);
    let view!: ReturnType<typeof mount>;
    await act(async () => {
      view = mount();
    });
    rename('  Updated brief  ');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: 'https://api.test/api/clio/conversations/thread-a',
      body: { title: 'Updated brief' },
    });
    expect(notices.success).not.toHaveBeenCalled();
    expect(getChatStateSnapshot().conversations[0]?.title).toBe('Original brief');
    await act(async () => response.resolve(ok(row('thread-a', 'Updated brief'))));
    await waitFor(() => expect(notices.success).toHaveBeenCalledWith('Thread renamed.'));
    expect(screen.getByText('Updated brief')).toBeInTheDocument();
    view.unmount();
    // Rehydrate as a reload does, from the durable row returned by the server.
    act(() => setConversations([row('thread-a', 'Updated brief')]));
    await act(async () => {
      mount();
    });
    expect(screen.getByText('Updated brief')).toBeInTheDocument();
  });

  test('failure retains the saved title, preserves the edit for retry, and never emits success', async () => {
    installFetch(async () => new Response('Rename unavailable', { status: 503 }));
    mount();
    rename();
    await waitFor(() =>
      expect(notices.error).toHaveBeenCalledWith('The thread could not be renamed.'),
    );
    expect(notices.success).not.toHaveBeenCalled();
    expect(controller.sessionTitle).toBe('Original brief');
    expect(getChatStateSnapshot().conversations[0]?.title).toBe('Original brief');
    expect(screen.getByRole('textbox', { name: 'Rename thread' })).toHaveValue('Updated brief');
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  test.each([row('wrong-thread', 'Updated brief'), row('thread-a', 'Original brief')])(
    'a response that does not confirm the requested title does not report success (%j)',
    async (response) => {
      installFetch(async () => ok(response));
      mount();
      rename();
      await waitFor(() => expect(notices.error).toHaveBeenCalled());
      expect(notices.success).not.toHaveBeenCalled();
      expect(controller.sessionTitle).toBe('Original brief');
    },
  );

  test('switching threads while PATCH is pending suppresses the old toast and leaves the new header and scope intact', async () => {
    const response = deferred<Response>();
    const calls = installFetch(async () => response.promise);
    mount();
    rename();
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => {
      setActiveConversation('thread-b');
      setChatSession('thread-b');
    });
    expect(screen.queryByRole('textbox', { name: 'Rename thread' })).not.toBeInTheDocument();
    await act(async () => response.resolve(ok(row('thread-a', 'Updated brief'))));
    expect(screen.getByText('Second thread')).toBeInTheDocument();
    expect(controller.persistedClientId).toBe('client-b');
    expect(controller.isSavingMeta).toBe(false);
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).not.toHaveBeenCalled();
  });

  test('a thread switch while authentication is pending prevents the stale PATCH from being dispatched', async () => {
    const token = deferred<string>();
    const calls = installFetch(async () => ok(row('thread-a', 'Updated brief')));
    mount();
    stableGetToken.mockImplementationOnce(() => token.promise);
    rename();
    act(() => {
      setActiveConversation('thread-b');
      setChatSession('thread-b');
    });
    await act(async () => token.resolve('test-token'));
    expect(calls).toHaveLength(0);
    expect(screen.getByText('Second thread')).toBeInTheDocument();
    expect(notices.success).not.toHaveBeenCalled();
  });

  test.each(['title-first', 'scope-first'])(
    'concurrent rename and scope save preserve both fields (%s)',
    async (order) => {
      const titleResponse = deferred<Response>();
      const scopeResponse = deferred<Response>();
      const calls = installFetch(async (_url, body) =>
        'title' in body ? titleResponse.promise : scopeResponse.promise,
      );
      mount();
      rename();
      await waitFor(() => expect(calls).toHaveLength(1));
      let scopePromise!: Promise<void>;
      act(() => {
        scopePromise = controller.changeSessionClient('client-c');
      });
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]?.body).toEqual({ clientId: 'client-c' });
      if (order === 'title-first') {
        await act(async () =>
          titleResponse.resolve(ok(row('thread-a', 'Updated brief', 'client-a'))),
        );
        expect(controller.scopePersistStatus).toBe('saving');
        expect(controller.isSavingMeta).toBe(true);
        await act(async () => {
          scopeResponse.resolve(ok(row('thread-a', 'Original brief', 'client-c')));
          await scopePromise;
        });
      } else {
        await act(async () => {
          scopeResponse.resolve(ok(row('thread-a', 'Original brief', 'client-c')));
          await scopePromise;
        });
        expect(controller.isSavingMeta).toBe(true);
        await act(async () =>
          titleResponse.resolve(ok(row('thread-a', 'Updated brief', 'client-a'))),
        );
      }
      expect(
        getChatStateSnapshot().conversations.find((item) => item.id === 'thread-a'),
      ).toMatchObject({ title: 'Updated brief', clientId: 'client-c' });
      expect(controller.sessionTitle).toBe('Updated brief');
      expect(controller.persistedClientId).toBe('client-c');
      expect(controller.isSavingMeta).toBe(false);
    },
  );

  test('legacy no-argument save still persists the title edited in the drawer', async () => {
    const calls = installFetch(async (_url, body) => ok(row('thread-a', String(body.title))));
    mount();
    act(() => controller.setSessionTitle('Drawer title'));
    let saved = false;
    await act(async () => {
      saved = await controller.saveConversationMeta();
    });
    expect(saved).toBe(true);
    expect(calls[0]?.body).toEqual({ title: 'Drawer title' });
    expect(controller.sessionTitle).toBe('Drawer title');
  });
});
