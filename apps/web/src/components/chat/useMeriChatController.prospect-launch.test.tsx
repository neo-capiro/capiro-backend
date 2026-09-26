/**
 * Phase 4 — prospect-scoped Meri conversation creation contract.
 *
 * Covers the one-time pending prospect id in useMeriChatController:
 * - POST /api/clio/conversations includes prospectId exactly once
 * - a later ordinary new chat does NOT reuse the id
 * - the contextual prompt is sent into the conversation created for the launch
 * - existing ordinary chat creation (clientId body) is unchanged
 */
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const stableGetToken = vi.fn(async () => 'test-token');
const stableAuth = { getToken: stableGetToken, orgId: 'org-1', userId: 'user-1' };
const stableApi = { get: async () => ({ data: [] }), post: async () => ({ data: {} }) };
const stableImpersonation = { actAsTenantSlug: null };
vi.mock('@clerk/clerk-react', () => ({ useAuth: () => stableAuth }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => stableApi }));
vi.mock('../../state/impersonation.js', () => ({ useImpersonation: () => stableImpersonation }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));

import { requestMeriContextPrompt } from './meri-prompt.js';
import { getChatStateSnapshot, resetChatStoreForTests, setChatOpen } from './chat-store.js';
import { useMeriChatController } from './useMeriChatController.js';

const PROSPECT_UUID = '22222222-2222-4222-8222-222222222222';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (stream) => {
        controller = stream;
      },
    }),
    { status: 200 },
  );
  return {
    response,
    emit: (...events: Array<Record<string, unknown>>) => {
      controller.enqueue(
        new TextEncoder().encode(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        ),
      );
    },
    close: () => controller.close(),
  };
}

function completeTurn(text: string) {
  const stream = controlledStream();
  stream.emit(
    { type: 'start', intent: 'lookup', tier: 'fast' },
    { type: 'text', text },
    { type: 'done', messageId: 'assistant-1' },
  );
  stream.close();
  return stream.response;
}

interface CreateCall extends Record<string, unknown> {}

describe('prospect-scoped Meri conversation creation', () => {
  let createCalls: CreateCall[];
  let streamUrls: string[];

  function routeFetch(stream: () => Response) {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/stream')) {
        streamUrls.push(url);
        return stream();
      }
      if (url.endsWith('/api/clio/conversations') && init?.method === 'POST') {
        createCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'conv-1', title: 'Opportunity brief' }), {
          status: 200,
        });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  beforeEach(() => {
    resetChatStoreForTests();
    createCalls = [];
    streamUrls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetChatStoreForTests();
  });

  test('prospect launch creates ONE prospect-scoped conversation and sends the prompt into it', async () => {
    let turns = 0;
    routeFetch(() => {
      turns++;
      return completeTurn('Brief drafted.');
    });
    renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });

    await act(async () => {
      // The real launch path: reset + open + controller-owned one-shot scope.
      requestMeriContextPrompt({ prompt: 'Prepare the brief.', prospectId: PROSPECT_UUID });
    });

    await waitFor(() => expect(turns).toBe(1));
    // Exactly one conversation was created, carrying ONLY prospectId + title.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!).toEqual({
      prospectId: PROSPECT_UUID,
      title: 'Opportunity brief',
    });
    // The bounded prompt was streamed as a turn in that conversation.
    expect(streamUrls[0]).toContain('/conversations/');
    // No external outreach/send endpoint was touched.
    expect(
      [...createCalls.map((c) => JSON.stringify(c.body)), ...streamUrls].join(' '),
    ).not.toMatch(/outreach|\/send/i);
  });

  test('a later ordinary new chat does not reuse the consumed prospect id', async () => {
    routeFetch(() => completeTurn('ok'));
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });

    await act(async () => {
      requestMeriContextPrompt({ prompt: 'Prepare the brief.', prospectId: PROSPECT_UUID });
    });
    await waitFor(() => expect(createCalls).toHaveLength(1));

    // The user starts a manual new session afterwards.
    await act(async () => {
      await result.current.handleNewSession();
    });
    await waitFor(() => expect(createCalls).toHaveLength(2));
    // The ordinary chat body is the unchanged legacy shape: NO prospectId.
    expect(createCalls[1]!).toEqual({ clientId: undefined, title: 'Chat session' });
    expect('prospectId' in createCalls[1]!).toBe(false);
  });

  test('manual new session supersedes an in-flight prospect creation without reusing its id', async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/stream')) return completeTurn('ok');
      if (url.endsWith('/api/clio/conversations') && init?.method === 'POST') {
        createCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (createCalls.length === 1) {
          return await new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return new Response(JSON.stringify({ id: 'conv-2', title: 'Chat session' }), {
          status: 200,
        });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }), {
      wrapper,
    });

    act(() => {
      requestMeriContextPrompt({ prompt: 'Prepare the brief.', prospectId: PROSPECT_UUID });
    });
    await waitFor(() => expect(createCalls).toHaveLength(1));
    await act(async () => {
      await result.current.handleNewSession();
    });
    await waitFor(() => expect(createCalls).toHaveLength(2));
    expect(createCalls[0]).toEqual({ prospectId: PROSPECT_UUID, title: 'Opportunity brief' });
    expect(createCalls[1]).toEqual({ clientId: undefined, title: 'Chat session' });

    resolveFirst(
      new Response(JSON.stringify({ id: 'conv-old', title: 'Opportunity brief' }), {
        status: 200,
      }),
    );
    await waitFor(() => expect(getChatStateSnapshot().sessionId).toBe('conv-2'));
  });

  test('existing ordinary creation keeps the clientId body', async () => {
    routeFetch(() => completeTurn('ok'));
    renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await act(async () => {
      setChatOpen(true);
    });
    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]!).toEqual({ clientId: undefined, title: 'Chat session' });
    expect('prospectId' in createCalls[0]!).toBe(false);
  });
});
