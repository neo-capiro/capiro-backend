/*
 * Session client scope — the drawer must never show a client the SERVER does not
 * have on the conversation.
 *
 * Reported live 2026-07-29: a user in a session "assigned" to one client got
 * answers about other clients. The browser half of that was two defects:
 *
 *  1. the scope selector fell back to the global client filter when the
 *     conversation had no client, so it DISPLAYED a client the API had never
 *     been told about; and
 *  2. picking a client was local state only — it reached the server exclusively
 *     via a separate save button, and a conversation-list refresh silently
 *     reverted the unsaved pick.
 *
 * Every Meri turn scopes itself from clio_conversations.client_id, so an
 * unsaved pick meant a session that looked client-scoped while every tool ran
 * across the whole firm.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';

// Every mocked hook returns a STABLE reference. A fresh object per render makes
// authHeaders a new identity each time, which re-fires the client-list effect on
// every render — an unbounded loop that OOMs the worker rather than failing.
const stable = vi.hoisted(() => ({
  auth: { getToken: async () => 'tok' },
  api: {},
  impersonation: { actAsTenantSlug: null },
  location: { pathname: '/dashboard' },
}));

vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'http://api.test' } }));
vi.mock('./SessionRail.js', () => ({ SessionRail: () => <div data-testid="rail" /> }));
// useLocation is the only react-router import anywhere in the chat tree.
vi.mock('react-router-dom', () => ({ useLocation: () => stable.location }));
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => stable.auth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => stable.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => stable.impersonation,
}));

import { MeriLegacyDrawer } from './ChatDrawer.js';
import { createMeriVisualController } from './MeriOverlay.visual-fixture.js';
import { useMeriChatController } from './useMeriChatController.js';
import {
  resetChatStoreForTests,
  setActiveConversation,
  upsertConversation,
  setChatOpen,
  setChatSession,
} from './chat-store.js';
import { setGlobalClientFilter } from '../../state/client-filter.js';

const CONVERSATION = 'conv-1';
const C2 = 'c2';
const MAVEN = 'maven';

/**
 * Open the drawer on an EXISTING unscoped conversation. `setChatSession` matters:
 * without a session id the drawer creates one on open, which would replace the
 * row under test. The client list only loads while the drawer is open, and
 * `selectedClientValue` only resolves ids present in that list — so the scope
 * assertions below are only meaningful with the drawer open.
 */
function openOnUnscopedConversation(): void {
  upsertConversation({
    id: CONVERSATION,
    title: 'Chat session',
    clientId: null,
    client: null,
    latestMessage: null,
    updatedAt: '2026-07-29T00:00:00.000Z',
  });
  setChatSession(CONVERSATION);
  setActiveConversation(CONVERSATION);
  setChatOpen(true);
}

describe('client scope selector — a pick reaches the server, not just local state', () => {
  beforeEach(() => {
    resetChatStoreForTests();
  });

  test('the docked (embedded) selector persists the change', async () => {
    const controller = createMeriVisualController();
    const changeSessionClient = vi.fn(async () => undefined);
    const { container } = render(
      <MeriLegacyDrawer
        controller={{ ...controller, changeSessionClient }}
        embedded
        showSessionRail={false}
      />,
    );

    const trigger = container.querySelector('button.meri-scope-trigger');
    expect(trigger).toBeTruthy();
    // The fixture's session is scoped to C2, so that is what the trigger shows.
    expect(trigger!.textContent).toContain('C2 Strategies');
    fireEvent.click(trigger!);
    fireEvent.click(screen.getByRole('option', { name: /Maven Advocacy Partners/ }));

    expect(changeSessionClient).toHaveBeenCalledWith(MAVEN);
  });

  test('the legacy selector persists the change, and "General" clears the scope', () => {
    const controller = createMeriVisualController();
    const changeSessionClient = vi.fn(async () => undefined);
    const { container } = render(
      <MeriLegacyDrawer
        controller={{ ...controller, changeSessionClient }}
        showSessionRail={false}
      />,
    );

    const select = container.querySelector('select.chat-session-select');
    expect(select).toBeTruthy();
    fireEvent.change(select!, { target: { value: MAVEN } });
    expect(changeSessionClient).toHaveBeenLastCalledWith(MAVEN);

    fireEvent.change(select!, { target: { value: '' } });
    expect(changeSessionClient).toHaveBeenLastCalledWith('');
  });
});

/**
 * Mount the hook and flush its mount effects INSIDE act. The client-list fetch
 * settles in a microtask right after mount; flushing it here keeps the suite
 * output free of act() warnings that would otherwise bury a real failure.
 */
async function mountController() {
  const rendered = renderHook(() => useMeriChatController({ selectedClientName: null }));
  await act(async () => {});
  return rendered;
}

describe('useMeriChatController — displayed scope is the conversation row, nothing else', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetChatStoreForTests();
    setGlobalClientFilter(null);
    fetchMock.mockReset();
    // The drawer opens a session and loads the client list on mount; answer both
    // benignly so each test only exercises the scope path.
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith('/api/clients')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: C2, name: 'C2 Strategies' },
            { id: MAVEN, name: 'Maven Advocacy Partners' },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setGlobalClientFilter(null);
  });

  test('a conversation with NO client shows General even when a global client filter is set', async () => {
    // The exact shape of the live bug: something else on the page had set the
    // global filter, and the selector rendered it as though it were the
    // session's scope.
    setGlobalClientFilter(C2);
    openOnUnscopedConversation();

    const { result } = await mountController();
    // Client list loaded, so a stale filter WOULD resolve to an id here.
    await waitFor(() => expect(result.current.clients.length).toBe(2));
    expect(result.current.selectedClientValue).toBe('');
  });

  test('a conversation WITH a client shows that client', async () => {
    openOnUnscopedConversation();
    upsertConversation({
      id: CONVERSATION,
      title: 'Chat session',
      clientId: MAVEN,
      client: { id: MAVEN, name: 'Maven Advocacy Partners' },
      latestMessage: null,
      updatedAt: '2026-07-29T00:00:00.000Z',
    });

    const { result } = await mountController();
    await waitFor(() => expect(result.current.selectedClientValue).toBe(MAVEN));
  });

  test('changeSessionClient PATCHes the conversation and keeps the row in sync', async () => {
    openOnUnscopedConversation();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/clients')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: C2, name: 'C2 Strategies' },
            { id: MAVEN, name: 'Maven Advocacy Partners' },
          ],
        });
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: CONVERSATION,
            title: 'Chat session',
            clientId: C2,
            client: { id: C2, name: 'C2 Strategies' },
            latestMessage: null,
            updatedAt: '2026-07-29T01:00:00.000Z',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'new' }), text: async () => '' });
    });

    const { result } = await mountController();
    await waitFor(() => expect(result.current.clients.length).toBe(2));

    await act(async () => {
      await result.current.changeSessionClient(C2);
    });

    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(String(patch![0])).toContain(`/api/clio/conversations/${CONVERSATION}`);
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ clientId: C2 });
    await waitFor(() => expect(result.current.selectedClientValue).toBe(C2));
    expect(result.current.metaError).toBeNull();
  });

  test('a failed PATCH snaps the selector back — never display an unsaved scope', async () => {
    openOnUnscopedConversation();

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/clients')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: C2, name: 'C2 Strategies' },
            { id: MAVEN, name: 'Maven Advocacy Partners' },
          ],
        });
      }
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'boom' });
      }
      return Promise.resolve({ ok: true, json: async () => ({ id: 'new' }), text: async () => '' });
    });

    const { result } = await mountController();
    await waitFor(() => expect(result.current.clients.length).toBe(2));

    await act(async () => {
      await result.current.changeSessionClient(C2);
    });

    expect(result.current.selectedClientValue).toBe('');
    expect(result.current.metaError).toContain('Could not change the client scope');
  });
});
