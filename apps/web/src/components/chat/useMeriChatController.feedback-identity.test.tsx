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
import { act, renderHook, waitFor } from '@testing-library/react';
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

  test('retains actual provider effort and partial status after reconciling the message id', async () => {
    installFetchMock({
      streamEvents: [
        {
          type: 'runtime',
          telemetry: {
            requestedReasoningEffort: 'max',
            effectiveReasoningEffort: 'high',
            reasoningFallbackReasons: ['max_unsupported'],
            partial: false,
          },
        },
        { type: 'text', text: 'Partial result.' },
        {
          type: 'done',
          messageId: 'actual-runtime-id',
          partial: true,
          finishReason: 'max_output_tokens',
          telemetry: {
            requestedReasoningEffort: 'max',
            effectiveReasoningEffort: 'high',
            reasoningFallbackReasons: ['max_unsupported'],
            partial: true,
          },
        },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Research this.');
    });
    expect(
      result.current.messages.find((message) => message.id === 'actual-runtime-id')?.runtimeStatus,
    ).toMatchObject({ effectiveEffort: 'high', adjusted: true, partial: true });
  });

  test('marks streamed text incomplete when the transport ends before a done frame', async () => {
    installFetchMock({ streamEvents: [{ type: 'text', text: 'Interrupted result.' }] });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      await result.current.sendMessage('Research this.');
    });
    expect(
      result.current.messages.find((message) => message.role === 'assistant')?.runtimeStatus,
    ).toMatchObject({ partial: true, stopped: false });
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

  test('research plans and reports reconcile persisted ids before immediate feedback or export', async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const feedbackUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/research')) {
          createBodies.push(JSON.parse(String(init?.body)));
          return okJson({ id: 'research-1' });
        }
        if (url.endsWith('/research/research-1/plan/stream'))
          return sseResponse([
            { type: 'title', title: 'Client briefing' },
            { type: 'plan', plan: ['Check sources'] },
            { type: 'clarify', questions: [] },
            { type: 'done', messageId: 'persisted-plan-1' },
          ]);
        if (url.endsWith('/research/research-1/stream'))
          return sseResponse([
            {
              type: 'report',
              artifactId: 'artifact-1',
              messageId: 'persisted-report-1',
              body: 'Client-specific findings.',
            },
            { type: 'done' },
          ]);
        if (url.includes('/feedback')) feedbackUrls.push(url);
        return okJson([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    act(() => result.current.setResearchMode(true));
    await act(async () => {
      await result.current.sendMessage('Prepare a sourced briefing.');
    });
    expect(createBodies[0]).toMatchObject({ conversationId: 'conversation-1', attachmentIds: [] });
    expect(createBodies[0]).not.toHaveProperty('reasoningMode'); // existing thread uses its server preference
    expect(
      result.current.messages.find((message) => message.id === 'persisted-plan-1'),
    ).toBeTruthy();
    expect(
      result.current.messages.find((message) => message.id === 'persisted-report-1')?.content,
    ).toBe('Client-specific findings.');
    expect(result.current.researchReports['persisted-report-1']).toBe('research-1');
    await act(async () => {
      await result.current.submitFeedback('persisted-report-1', { rating: 'up' });
    });
    expect(feedbackUrls[0]).toContain('/messages/persisted-report-1/feedback');
  });

  test('stopping during planning clears research state and the next request starts a fresh session', async () => {
    let creates = 0;
    const clarifyCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/research')) return okJson({ id: `research-${++creates}` });
        if (url.endsWith('/research/research-1/plan/stream'))
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Stopped', 'AbortError')),
              { once: true },
            );
          });
        if (url.endsWith('/research/research-2/plan/stream'))
          return sseResponse([
            { type: 'title', title: 'Fresh plan' },
            { type: 'plan', plan: ['Review'] },
            { type: 'clarify', questions: ['Which deadline?'] },
            { type: 'done', messageId: 'fresh-plan' },
          ]);
        if (url.endsWith('/clarify')) clarifyCalls.push(url);
        return okJson([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    act(() => result.current.setResearchMode(true));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.sendMessage('First research.');
    });
    await waitFor(() => expect(result.current.isResearchStreaming).toBe(true));
    act(() => result.current.handleStop());
    await act(async () => {
      await pending;
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isResearchStreaming).toBe(false);
    expect(result.current.researchSessionRef.current).toBeNull();
    await act(async () => {
      await result.current.sendMessage('Start over.');
    });
    expect(creates).toBe(2);
    expect(clarifyCalls).toEqual([]);
    expect(result.current.researchSessionRef.current).toBe('research-2');
    expect(result.current.researchAwaitingAnswers).toBe(true);
  });

  test('a delayed cancelled plan cannot clear the next conversation’s research state', async () => {
    let creates = 0;
    let rejectOld!: (reason: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/research')) return okJson({ id: `research-${++creates}` });
        if (url.endsWith('/research/research-1/plan/stream'))
          return new Promise<Response>((_resolve, reject) => {
            rejectOld = reject;
          });
        if (url.endsWith('/research/research-2/plan/stream'))
          return sseResponse([
            { type: 'title', title: 'New conversation plan' },
            { type: 'plan', plan: ['Review'] },
            { type: 'clarify', questions: ['Which fiscal year?'] },
            { type: 'done', messageId: 'new-plan' },
          ]);
        return okJson([]);
      }),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    act(() => result.current.setResearchMode(true));
    let oldPending!: Promise<boolean>;
    act(() => {
      oldPending = result.current.sendMessage('Old research.');
    });
    await waitFor(() => expect(result.current.isResearchStreaming).toBe(true));
    act(() => {
      result.current.discardRouteState();
      setChatSession('conversation-2');
    });
    await act(async () => {
      await result.current.sendMessage('New research.');
    });
    expect(result.current.researchSessionRef.current).toBe('research-2');
    await act(async () => {
      rejectOld(new DOMException('Old route stopped', 'AbortError'));
      await oldPending;
    });
    expect(result.current.researchSessionRef.current).toBe('research-2');
    expect(result.current.researchAwaitingAnswers).toBe(true);
    expect(result.current.researchQuestions).toEqual(['Which fiscal year?']);
  });
});

describe('Meri canonical work receipt and send acceptance', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setChatSession('conversation-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('rejects explicit pre-dispatch SSE failures so the composer can restore its draft', async () => {
    installFetchMock({
      streamEvents: [
        {
          type: 'error',
          accepted: false,
          message: 'Runtime is not configured. No turn was accepted.',
        },
        { type: 'done' },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Keep this unsent prompt')).toBe(false);
    });
    expect(result.current.isStreaming).toBe(false);
    expect(
      result.current.messages.find((message) => message.role === 'assistant')?.content,
    ).toContain('No turn was accepted.');
  });

  test('consumes a provider error followed by done, preserving canonical identity, partial status and work', async () => {
    const { feedbackCalls } = installFetchMock({
      streamEvents: [
        { type: 'start', intent: 'client_brief', tier: 'deep' },
        { type: 'tool_call', tool: 'search_memory', label: 'Client memory' },
        {
          type: 'sources',
          sources: [
            { tool: 'search_memory', summary: 'Found three approved facts', confidence: 'high' },
          ],
        },
        { type: 'error', message: 'The provider could not finish.' },
        {
          type: 'done',
          messageId: 'canonical-provider-error',
          partial: true,
          finishReason: 'error',
        },
      ],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Prepare my brief')).toBe(true);
    });
    const message = result.current.messages.find((item) => item.id === 'canonical-provider-error');
    expect(message).toMatchObject({
      content: 'Error: The provider could not finish.',
      runtimeStatus: { partial: true },
      trustSteps: [
        {
          tool: 'search_memory',
          label: 'Client memory',
          status: 'done',
          detail: 'Found three approved facts',
        },
      ],
    });
    await act(async () => {
      await result.current.submitFeedback(message!.id, { rating: 'down' });
    });
    expect(feedbackCalls[0]?.url).toContain('/messages/canonical-provider-error/feedback');
  });

  test('an error without done keeps the accepted request consumed and labels its message partial', async () => {
    installFetchMock({
      streamEvents: [{ type: 'error', message: 'The provider connection ended.' }],
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Accepted request')).toBe(true);
    });
    expect(
      result.current.messages.find((message) => message.role === 'assistant')?.runtimeStatus
        ?.partial,
    ).toBe(true);
    expect(result.current.isStreaming).toBe(false);
  });

  test('keeps tool evidence on its canonical message after the next prompt clears live state', async () => {
    const first = [
      { type: 'start', intent: 'client_brief', tier: 'deep' },
      { type: 'plan', steps: ['Read approved client evidence'] },
      { type: 'tool_call', tool: 'search_memory', label: 'Client memory' },
      {
        type: 'sources',
        sources: [
          {
            tool: 'search_memory',
            label: 'Client memory',
            summary: 'Three approved facts',
            count: 3,
            confidence: 'high',
          },
        ],
      },
      { type: 'thinking', text: 'Private provider reasoning must be discarded' },
      { type: 'text', text: 'A grounded client brief.' },
      { type: 'done', messageId: 'canonical-first' },
    ];
    let turn = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/stream')
          ? sseResponse(
              turn++ === 0
                ? first
                : [
                    { type: 'start', intent: 'general', tier: 'fast' },
                    { type: 'text', text: 'Follow-up answer.' },
                    { type: 'done', messageId: 'canonical-next' },
                  ],
            )
          : okJson([]),
      ),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Prepare a brief')).toBe(true);
    });
    const firstMessage = result.current.messages.find((m) => m.id === 'canonical-first');
    expect(firstMessage).toMatchObject({
      orchestratorIntent: 'client_brief',
      orchestratorTier: 'deep',
      planSteps: ['Read approved client evidence'],
      trustSteps: [
        {
          tool: 'search_memory',
          label: 'Client memory',
          status: 'done',
          detail: 'Three approved facts',
          count: 3,
          confidence: 'high',
        },
      ],
    });
    expect(JSON.stringify(firstMessage)).not.toContain('Private provider');
    await act(async () => {
      expect(await result.current.sendMessage('Thanks')).toBe(true);
    });
    expect(result.current.trustSteps).toEqual([]);
    expect(result.current.messages.find((m) => m.id === 'canonical-first')).toEqual(firstMessage);
    expect(result.current.messages.find((m) => m.id === 'canonical-next')?.trustSteps).toEqual([]);
  });

  test('rejects an unsuccessful HTTP dispatch so the composer can restore its draft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/stream')
          ? new Response('Unavailable', { status: 503 })
          : okJson([]),
      ),
    );
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Do not lose this draft')).toBe(false);
    });
    expect(result.current.isStreaming).toBe(false);
  });

  test('keeps an accepted but interrupted response consumed to avoid resending its prompt', async () => {
    installFetchMock({ streamEvents: [{ type: 'text', text: 'Partial answer.' }] });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });
    await act(async () => {
      expect(await result.current.sendMessage('Accepted request')).toBe(true);
    });
    expect(
      result.current.messages.find((m) => m.role === 'assistant')?.runtimeStatus?.partial,
    ).toBe(true);
  });
});
