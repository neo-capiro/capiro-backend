import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setChatSession,
} from '../../components/chat/chat-store.js';

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => 'token'),
  api: { post: vi.fn() },
}));

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mocks.getToken }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks.api }));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
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
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    mocks.api.post.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
