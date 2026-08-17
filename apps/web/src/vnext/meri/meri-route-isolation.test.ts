import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  appendChatMessage,
  claimMeriIdentity,
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setAlerts,
  setChatSession,
  setConversations,
  setStreaming,
} from '../../components/chat/chat-store.js';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  orgId: 'org-a' as string | null,
  userId: 'user-a' as string | null,
  impersonatedTenantSlug: null as string | null,
  api: { post: vi.fn() },
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
  useClientFilter: () => ({ selectedClientId: null }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/meri/t/thread-a' }),
}));

import { useMeriChatController } from '../../components/chat/useMeriChatController.js';

describe('Meri route isolation', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    claimMeriIdentity('org-a:user-a');
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    mocks.api.post.mockReset();
    // Tests that gate the token with mockImplementationOnce must not leak an
    // unconsumed one-shot into the next test.
    mocks.getToken.mockReset();
    mocks.getToken.mockImplementation(async () => 'token');
  });

  afterEach(() => {
    mocks.orgId = 'org-a';
    mocks.userId = 'user-a';
    mocks.impersonatedTenantSlug = null;
    vi.unstubAllGlobals();
  });

  test('identity switch clears shared tenant A transcript and controller-local state before paint', async () => {
    setConversations([
      {
        id: 'thread-a',
        title: 'Tenant A thread',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);
    appendChatMessage({
      id: 'message-a',
      role: 'assistant',
      content: 'Tenant A only',
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    setAlerts([
      { id: 'alert-a', status: 'pending', title: 'Tenant A briefing', body: 'Tenant A only' },
    ] as unknown as Parameters<typeof setAlerts>[0]);
    setStreaming(true);

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: null,
      activeConversationId: null,
      messages: [],
      conversations: [],
      alerts: [],
      isStreaming: false,
    });
    expect(result.current.clients).toEqual([]);
    expect(result.current.pendingApprovals).toEqual([]);
    expect(result.current.researchOffers).toEqual({});
  });

  test('identity switch makes a delayed archive completion leave the new session intact', async () => {
    let resolveArchive: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/clio/conversations/thread-a/archive')) {
          return new Promise((resolve) => {
            resolveArchive = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    setConversations([
      {
        id: 'thread-a',
        title: 'Tenant A thread',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    const archive = result.current.archiveConversation();
    await waitFor(() => expect(resolveArchive).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });
    // Let the identity layout effect finish before the new identity's bootstrap
    // publishes its durable thread. The next act represents that bootstrap.
    await act(async () => {
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      setConversations([
        {
          id: 'thread-b',
          title: 'Tenant B thread',
          clientId: null,
          client: null,
          latestMessage: null,
          updatedAt: '2026-08-17T00:00:00.000Z',
        },
      ]);
    });
    await act(async () => {
      resolveArchive!({ ok: true, json: async () => ({}) });
      await archive;
    });

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-b',
      activeConversationId: 'thread-b',
      conversations: [expect.objectContaining({ id: 'thread-b' })],
    });
  });

  test('identity switch makes a delayed client-scope PATCH leave the new session intact', async () => {
    let resolveScopePatch: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/clio/conversations/thread-a')) {
          return new Promise((resolve) => {
            resolveScopePatch = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    setConversations([
      {
        id: 'thread-a',
        title: 'Tenant A thread',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    let scopeChange: Promise<void> | null = null;
    await act(async () => {
      scopeChange = result.current.changeSessionClient('tenant-a-client');
    });
    await waitFor(() => expect(resolveScopePatch).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });
    await act(async () => {
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      setConversations([
        {
          id: 'thread-b',
          title: 'Tenant B thread',
          clientId: null,
          client: null,
          latestMessage: null,
          updatedAt: '2026-08-17T00:00:00.000Z',
        },
      ]);
    });
    await act(async () => {
      resolveScopePatch!({
        ok: true,
        json: async () => ({
          id: 'thread-a',
          title: 'Tenant A thread',
          clientId: 'tenant-a-client',
          client: { id: 'tenant-a-client', name: 'Tenant A Client' },
          updatedAt: '2026-08-17T00:00:01.000Z',
        }),
      });
      await scopeChange!;
    });

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-b',
      activeConversationId: 'thread-b',
      conversations: [expect.objectContaining({ id: 'thread-b' })],
    });
    expect(result.current.persistedClientId).toBeNull();
  });

  test('identity switch makes a delayed session creation leave the new session intact', async () => {
    let resolveCreation: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/clio/conversations')) {
          return new Promise((resolve) => {
            resolveCreation = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    let creation: Promise<void> | null = null;
    await act(async () => {
      creation = result.current.handleNewSession();
    });
    await waitFor(() => expect(resolveCreation).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });
    await act(async () => {
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      setConversations([
        {
          id: 'thread-b',
          title: 'Tenant B thread',
          clientId: null,
          client: null,
          latestMessage: null,
          updatedAt: '2026-08-17T00:00:00.000Z',
        },
      ]);
    });
    await act(async () => {
      resolveCreation!({
        ok: true,
        json: async () => ({
          id: 'thread-a-created',
          title: 'Tenant A thread',
          clientId: null,
          updatedAt: '2026-08-17T00:00:00.000Z',
        }),
      });
      await creation!;
    });

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-b',
      activeConversationId: 'thread-b',
      conversations: [expect.objectContaining({ id: 'thread-b' })],
    });
  });

  // NOTE: the recovery effect keys on `sessionId`, which the identity claim
  // nulls, so its cancellation reaches the stale response before the identity
  // fence does. This asserts the end-to-end guarantee, not that one fence.
  test('no prior-identity approval cards survive an identity switch', async () => {
    let resolveRecovery: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/api/clio/action-proposals?conversationId=thread-a')) {
          return new Promise((resolve) => {
            resolveRecovery = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await waitFor(() => expect(resolveRecovery).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });
    await act(async () => {
      setChatSession('thread-b');
      setActiveConversation('thread-b');
    });

    // Approval cards authorize real server-side actions against tenant A's
    // records. Recovering them under tenant B would offer to execute them.
    // Two independent guards must hold for this: the identity fence in the
    // recovery effect, and the session-scoped cancellation the store clear
    // triggers. The assertion is on the behaviour, not on which one fires.
    await act(async () => {
      resolveRecovery!({
        ok: true,
        json: async () => [
          {
            proposalId: 'proposal-a',
            status: 'proposed',
            summary: 'Tenant A action',
            actions: [],
          },
        ],
      });
    });

    expect(result.current.pendingApprovals).toEqual([]);
  });

  test('identity switch during token acquisition never dispatches the prior archive', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: true, json: async () => ({}) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setConversations([
      {
        id: 'thread-a',
        title: 'Tenant A thread',
        clientId: null,
        client: null,
        latestMessage: null,
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    // Let the mount-time token calls settle so the gate below belongs to the
    // archive request and nothing else.
    await act(async () => {});

    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = () => resolve('token');
        }),
    );

    let archive: Promise<boolean> | null = null;
    await act(async () => {
      archive = result.current.archiveConversation();
    });
    await waitFor(() => expect(releaseToken).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });

    let archived: boolean | null = null;
    await act(async () => {
      releaseToken!();
      archived = await archive!;
    });

    // The token that resolved belongs to tenant B. Sending tenant A's archive
    // with it is a cross-identity write, not merely a stale UI update.
    expect(archived).toBe(false);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/archive')),
    ).toHaveLength(0);
  });

  test('identity switch during token acquisition never dispatches the prior conversation creation', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: true, json: async () => ({}) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await act(async () => {});

    let releaseToken: (() => void) | null = null;
    mocks.getToken.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = () => resolve('token');
        }),
    );

    let creation: Promise<void> | null = null;
    await act(async () => {
      creation = result.current.handleNewSession();
    });
    await waitFor(() => expect(releaseToken).not.toBeNull());

    await act(async () => {
      mocks.impersonatedTenantSlug = 'tenant-b';
      rerender();
    });
    await act(async () => {
      releaseToken!();
      await creation!;
    });

    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/api/clio/conversations') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(0);
    expect(getChatStateSnapshot()).toMatchObject({ sessionId: null, activeConversationId: null });
  });

  test('mounting a second surface under the already-claimed identity keeps its live turn', async () => {
    // The identity boundary is an ownership change, not a mount. A remount that
    // finds the store already owned by this same identity must not abort the
    // stream or discard the turn state the first surface is still showing.
    setStreaming(true);

    renderHook(() => useMeriChatController({ selectedClientName: null }));

    expect(getChatStateSnapshot()).toMatchObject({
      sessionId: 'thread-a',
      activeConversationId: 'thread-a',
      isStreaming: true,
    });
  });

  test('route transition clears staged attachments before another thread can send', async () => {
    mocks.api.post.mockResolvedValue({
      data: {
        id: 'attachment-a',
        filename: 'client-a.pdf',
        kind: 'document',
        status: 'parsed',
        reason: null,
      },
    });

    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    const files = { 0: new File(['client A'], 'client-a.pdf', { type: 'application/pdf' }), length: 1 } as unknown as FileList;

    await act(async () => {
      result.current.handleAttachFiles(files);
    });
    await waitFor(() => expect(result.current.stagedAttachments).toHaveLength(1));

    await act(async () => {
      result.current.discardRouteState();
    });

    expect(result.current.stagedAttachments).toHaveLength(0);
    expect(getChatStateSnapshot().isStreaming).toBe(false);
  });

  test('navigation away from a record-free draft stops work but keeps its staged file', async () => {
    mocks.api.post.mockResolvedValue({
      data: {
        id: 'attachment-draft',
        filename: 'draft.pdf',
        kind: 'document',
        status: 'parsed',
        reason: null,
      },
    });
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    const files = { 0: new File(['draft'], 'draft.pdf', { type: 'application/pdf' }), length: 1 } as unknown as FileList;

    await act(async () => {
      result.current.handleAttachFiles(files);
    });
    await waitFor(() => expect(result.current.stagedAttachments).toHaveLength(1));

    await act(async () => {
      result.current.invalidateRouteStream();
    });

    expect(result.current.stagedAttachments).toHaveLength(1);
    expect(getChatStateSnapshot().isStreaming).toBe(false);
  });

  test('route transition ignores delayed deep-research session creation', async () => {
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    let resolveCreation: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/api/clio/research')) {
        return new Promise((resolve) => {
          resolveCreation = resolve;
        });
      }
      return Promise.resolve({ ok: true, body: null, text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      result.current.setResearchMode(true);
    });
    await act(async () => {
      void result.current.sendMessage('research thread A');
      await Promise.resolve();
    });
    await waitFor(() => expect(resolveCreation).not.toBeNull());

    await act(async () => {
      result.current.invalidateRouteStream();
      resolveCreation!({ ok: true, json: async () => ({ id: 'research-a' }) });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/research/research-a/'))).toBe(false),
    );
    expect(getChatStateSnapshot().isStreaming).toBe(false);
  });

  test('late approval result cannot restore an old thread card after route invalidation', async () => {
    let resolveApproval: ((value: unknown) => void) | null = null;
    const heldProposal = {
      type: 'pending_approval',
      proposalId: 'proposal-a',
      status: 'proposed',
      tool: 'create_client',
      preview: {
        label: 'Create client',
        riskTier: null,
        leavesFirm: false,
        reversible: true,
        fields: {},
        counts: {},
        reason: 'test',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
      reason: 'test',
      riskTier: null,
      policyCode: null,
      ruleId: null,
      policy: {
        source: 'test',
        mode: 'enforce',
        packKey: 'test',
        packVersion: '1',
        binding: 'test',
        decisionHash: 'test',
        contextHash: 'test',
        decision: 'hold',
        jurisdiction: 'test',
        channel: 'test',
        recipientType: null,
      },
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify(heldProposal)}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/stream')) {
        return Promise.resolve({ ok: true, body: stream, text: async () => '' });
      }
      if (url.includes('/action-proposals/proposal-a/approve')) {
        return new Promise((resolve) => {
          resolveApproval = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await act(async () => {
      await result.current.sendMessage('create a client');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    await act(async () => {
      void result.current.handleApprovePending('proposal-a');
      await Promise.resolve();
    });
    await waitFor(() => expect(resolveApproval).not.toBeNull());

    await act(async () => {
      result.current.discardRouteState();
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      await Promise.resolve();
      resolveApproval!({
        ok: true,
        json: async () => ({ ...heldProposal, status: 'succeeded', resultSummary: 'created' }),
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.pendingApprovals).toEqual([]));
  });

  test('route transition aborts an in-flight stream and rejects its late SSE event', async () => {
    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    const request = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => request.abort());
      return Promise.resolve({ ok: true, body: stream, text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      void result.current.sendMessage('stream in thread A');
      await Promise.resolve();
    });
    await waitFor(() => expect(getChatStateSnapshot().isStreaming).toBe(true));

    await act(async () => {
      result.current.discardRouteState();
      streamController!.enqueue(
        new TextEncoder().encode('data: {"type":"start","intent":"old-thread"}\\n\\n'),
      );
      streamController!.close();
      await Promise.resolve();
    });

    expect(request.signal.aborted).toBe(true);
    expect(getChatStateSnapshot().isStreaming).toBe(false);
    expect(result.current.orchestratorIntent).toBeNull();
  });
});
