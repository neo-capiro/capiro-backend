/**
 * Phase 27 post-launch P1: rating a freshly-streamed Meri message used to post
 * the client-generated optimistic id (assigned before the server persists
 * anything) instead of the real `clio_messages.id` — the feedback endpoint
 * can't resolve that id, 400s, and the rating + downstream LearningSignal /
 * quality-telemetry capture are silently lost. Reloading (which re-fetches
 * messages by their real ids) "fixed" it, which is why this only bit
 * immediate feedback, never feedback on an already-persisted message.
 *
 * These tests exercise the real `useMeriChatController` hook end to end
 * against a synthetic SSE stream to prove the race is closed: the assistant
 * placeholder's id is reconciled to the server's `done`-frame `messageId`
 * before the stream resolves, so feedback submitted immediately afterward —
 * with no refetch in between — targets the canonical id.
 */
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Every mocked hook below must return REFERENTIALLY STABLE values across
// renders. useMeriChatController threads getToken/api through several
// useCallback/useEffect dependency arrays (authHeaders, the action-proposals
// recovery effect, ...); a fresh function/object identity on every call — the
// obvious naive mock — makes those effects see a "changed" dependency on
// every render and re-fire forever, flooding fetch and hanging the test on
// an infinite render loop instead of failing fast.
const stableGetToken = async () => 'test-token';
const stableAuth = { getToken: stableGetToken, orgId: 'org-1', userId: 'user-1' };
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => stableAuth,
}));
const stableApi = {
  get: async () => ({ data: [] }),
  post: async () => ({ data: {} }),
};
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => stableApi,
}));
const stableImpersonation = { actAsTenantSlug: null };
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => stableImpersonation,
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));

import { useMeriChatController } from './useMeriChatController.js';
import {
  appendChatMessage,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setChatSession,
} from './chat-store.js';

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function okJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

interface FetchMockOptions {
  /** The SSE frames returned for the /stream call. */
  streamEvents: Array<Record<string, unknown>>;
}

/** Routes every fetch by URL substring; records /feedback calls for assertion. */
function installFetchMock({ streamEvents }: FetchMockOptions) {
  const feedbackCalls: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/stream')) return sseResponse(streamEvents);
    if (url.includes('/feedback')) {
      feedbackCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      return new Response(null, { status: 200 });
    }
    // Everything else (alerts, conversations, history, etc.) — inert default.
    return okJson([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, feedbackCalls };
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('useMeriChatController — Meri feedback identity reconciliation', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setChatSession('conversation-1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('a freshly streamed assistant message receives the canonical persisted id, and immediate thumbs-up targets it', async () => {
    const { feedbackCalls } = installFetchMock({
      streamEvents: [
        { type: 'text', text: 'The bill has 12 cosponsors.' },
        { type: 'done', messageId: 'server-msg-42' },
      ],
    });

    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });

    await act(async () => {
      await result.current.sendMessage('How many cosponsors?');
    });

    expect(result.current.isStreaming).toBe(false);

    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant');
    expect(assistantMessage?.id).toBe('server-msg-42');
    // The optimistic id must not survive anywhere in the reconciled message.
    expect(assistantMessage?.id).not.toMatch(/^\d+[a-z0-9]*-[a-z0-9]+$/);

    // Feedback clicked immediately after stream completion — no refetch, no
    // reload — using whatever id the UI currently shows for the message.
    await act(async () => {
      await result.current.submitFeedback(assistantMessage!.id, { rating: 'up' });
    });

    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0]!.url).toContain('/messages/server-msg-42/feedback');
    expect(feedbackCalls[0]!.body).toMatchObject({ rating: 'up' });
  });

  test('immediate thumbs-down with a reason code succeeds against the canonical id', async () => {
    const { feedbackCalls } = installFetchMock({
      streamEvents: [
        { type: 'text', text: 'Answer.' },
        { type: 'done', messageId: 'server-msg-99' },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Question');
    });
    expect(result.current.isStreaming).toBe(false);
    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant')!;

    await act(async () => {
      await result.current.submitFeedback(assistantMessage.id, {
        rating: 'down',
        reasons: ['outdated'],
      });
    });

    expect(feedbackCalls[0]!.url).toContain('server-msg-99');
    expect(feedbackCalls[0]!.body).toMatchObject({ rating: 'down', reasons: ['outdated'] });
  });

  test('immediate feedback with a free-text note succeeds against the canonical id', async () => {
    const { feedbackCalls } = installFetchMock({
      streamEvents: [
        { type: 'text', text: 'Answer.' },
        { type: 'done', messageId: 'server-msg-7' },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Question');
    });
    expect(result.current.isStreaming).toBe(false);
    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant')!;

    await act(async () => {
      await result.current.submitFeedback(assistantMessage.id, {
        rating: 'up',
        note: 'Client prefers weekly congressional updates.',
      });
    });

    expect(feedbackCalls[0]!.url).toContain('server-msg-7');
    expect(feedbackCalls[0]!.body).toMatchObject({
      note: 'Client prefers weekly congressional updates.',
    });
  });

  test('feedback on a message already carrying its real id (post-refresh) is unaffected by reconciliation', async () => {
    const { feedbackCalls } = installFetchMock({ streamEvents: [] });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    // Simulate a page reload: history hydration appends messages already
    // carrying their real, persisted ids — no optimistic id ever existed.
    act(() => {
      appendChatMessage({
        id: 'server-msg-old-1',
        role: 'assistant',
        content: 'From history.',
        createdAt: new Date('2026-08-20T00:00:00.000Z'),
      });
    });

    await act(async () => {
      await result.current.submitFeedback('server-msg-old-1', { rating: 'up' });
    });

    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0]!.url).toContain('server-msg-old-1');
  });

  test('a done frame with no messageId (nothing persisted) leaves the optimistic id in place rather than fabricating one', async () => {
    installFetchMock({
      streamEvents: [{ type: 'done' }],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Question');
    });
    expect(result.current.isStreaming).toBe(false);
    const assistantMessage = result.current.messages.find((m) => m.role === 'assistant');
    // Still the client-generated optimistic id — no crash, no corruption.
    expect(assistantMessage?.id).toBeTruthy();
    expect(getChatStateSnapshot().messages).toHaveLength(2);
  });

  test('reconciling to the canonical id does not duplicate or corrupt the message list', async () => {
    installFetchMock({
      streamEvents: [
        { type: 'text', text: 'Answer.' },
        { type: 'done', messageId: 'server-msg-idempotent-1' },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Question');
    });
    expect(result.current.isStreaming).toBe(false);

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.filter((m) => m.id === 'server-msg-idempotent-1')).toHaveLength(
      1,
    );
  });
});
