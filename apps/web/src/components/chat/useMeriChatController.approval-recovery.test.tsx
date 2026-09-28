import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const getToken = vi.fn(async () => 'test-token');
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken, orgId: 'org-1', userId: 'user-1' }),
}));
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: async () => ({ data: [] }), post: async () => ({ data: {} }) }),
}));
vi.mock('../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));

import { useMeriChatController, type PendingApproval } from './useMeriChatController.js';
import { resetChatStoreForTests, setChatSession } from './chat-store.js';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function proposal(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    proposalId: 'proposal-1',
    status: 'proposed',
    tool: 'send_email',
    preview: {
      label: 'Send follow-up email',
      riskTier: 'restricted',
      leavesFirm: true,
      reversible: false,
      fields: { to: 'staff@example.gov', subject: 'Follow-up' },
      counts: { recipients: 1 },
      reason: 'External communication requires approval.',
    },
    expiresAt: '2026-10-01T00:00:00.000Z',
    reason: 'External communication requires approval.',
    riskTier: 'restricted',
    policyCode: 'external_send',
    policy: {
      source: 'static',
      mode: 'warn',
      packKey: 'approval-pack',
      packVersion: '1',
      binding: 'binding',
      decisionHash: 'decision',
      contextHash: 'context',
      decision: 'WARN',
      jurisdiction: 'federal',
      channel: 'email',
      recipientType: 'external',
    },
    attemptCount: 0,
    resultSummary: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...over,
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Meri approval status recovery', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setChatSession('conversation-1');
    getToken.mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('keeps a confirmed non-execution failure visible and retryable', async () => {
    let row = proposal();
    let approvals = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/approve')) {
        approvals += 1;
        if (approvals === 1) return new Response('Disposable provider unavailable', { status: 503 });
        row = proposal({
          status: 'succeeded',
          attemptCount: 1,
          resultSummary: { messageId: 'mail-1' },
          updatedAt: '2026-09-28T00:01:00.000Z',
        });
        return json(row, 201);
      }
      if (url.includes('/action-proposals?')) return json([row]);
      return json([]);
    }));

    const view = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(view.result.current.pendingApprovals[0]?.status).toBe('proposed'));
    await act(async () => view.result.current.handleApprovePending('proposal-1'));

    expect(view.result.current.pendingApprovals[0]).toMatchObject({
      status: 'proposed',
      approvalRecovery: { state: 'safe_failure' },
    });
    expect(view.result.current.pendingApprovals[0]?.approvalRecovery?.message).toContain('HTTP 503');

    await act(async () => view.result.current.handleApprovePending('proposal-1'));
    expect(view.result.current.pendingApprovals[0]?.status).toBe('succeeded');
    expect(approvals).toBe(2);
  });

  test('lost acknowledgment reconciles durable success and never sends twice, including after reload', async () => {
    let row = proposal();
    let approvals = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/approve')) {
        approvals += 1;
        row = proposal({
          status: 'succeeded',
          attemptCount: 1,
          resultSummary: { messageId: 'mail-1' },
          updatedAt: '2026-09-28T00:01:00.000Z',
        });
        throw new TypeError('connection reset after commit');
      }
      if (url.includes('/action-proposals?')) return json([row]);
      return json([]);
    }));

    const first = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(first.result.current.pendingApprovals[0]?.status).toBe('proposed'));
    await act(async () => first.result.current.handleApprovePending('proposal-1'));
    expect(first.result.current.pendingApprovals[0]?.status).toBe('succeeded');
    await act(async () => first.result.current.handleApprovePending('proposal-1'));
    expect(approvals).toBe(1);
    first.unmount();

    const reloaded = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(reloaded.result.current.pendingApprovals[0]?.status).toBe('succeeded'));
    await act(async () => reloaded.result.current.handleApprovePending('proposal-1'));
    expect(approvals).toBe(1);
  });

  test('keeps executing honest, blocks a second approval, and recovers the terminal receipt', async () => {
    let row = proposal();
    let approvals = 0;
    let listReads = 0;
    let finishPoll!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/approve')) {
        approvals += 1;
        row = proposal({ status: 'executing', attemptCount: 1, updatedAt: '2026-09-28T00:01:00.000Z' });
        throw new TypeError('acknowledgment lost');
      }
      if (url.includes('/action-proposals?')) {
        listReads += 1;
        if (listReads <= 2) return json([row]);
        return new Promise<Response>((resolve) => { finishPoll = resolve; });
      }
      return json([]);
    }));

    const view = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(view.result.current.pendingApprovals[0]?.status).toBe('proposed'));
    await act(async () => view.result.current.handleApprovePending('proposal-1'));
    expect(view.result.current.pendingApprovals[0]?.status).toBe('executing');
    await act(async () => view.result.current.handleApprovePending('proposal-1'));
    expect(approvals).toBe(1);
    await waitFor(() => expect(finishPoll).toBeTypeOf('function'));

    row = proposal({
      status: 'succeeded',
      attemptCount: 1,
      resultSummary: { messageId: 'mail-1' },
      updatedAt: '2026-09-28T00:02:00.000Z',
    });
    await act(async () => finishPoll(json([row])));
    await waitFor(() => expect(view.result.current.pendingApprovals[0]?.status).toBe('succeeded'));
    expect(approvals).toBe(1);
  });

  test('same-tick double approval dispatches one request', async () => {
    let release!: (response: Response) => void;
    let approvals = 0;
    let row = proposal();
    const succeeded = proposal({
      status: 'succeeded',
      attemptCount: 1,
      updatedAt: '2026-09-28T00:01:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/approve')) {
        approvals += 1;
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      if (url.includes('/action-proposals?')) return json([row]);
      return json([]);
    }));

    const view = renderHook(() => useMeriChatController({ selectedClientName: null }), { wrapper });
    await waitFor(() => expect(view.result.current.pendingApprovals).toHaveLength(1));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = view.result.current.handleApprovePending('proposal-1');
      second = view.result.current.handleApprovePending('proposal-1');
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => {
      row = succeeded;
      release(json(succeeded, 201));
      await Promise.all([first, second]);
    });

    expect(approvals).toBe(1);
    expect(view.result.current.pendingApprovals[0]?.status).toBe('succeeded');
  });
});
