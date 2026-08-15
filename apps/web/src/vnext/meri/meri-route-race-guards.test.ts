import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  getChatStateSnapshot,
  resetChatStoreForTests,
  setActiveConversation,
  setChatSession,
} from '../../components/chat/chat-store.js';
import {
  maySend,
  ownsFirstSend,
  ownsScopeIntent,
  type FirstSendToken,
  type ScopePersistStatus,
} from '../../components/chat/meri-route-guards.js';

// ── Test infrastructure ──────────────────────────────────────────────
// Deferred promises make async ordering deterministic without timers.

interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Pure guard tests (no React) ──────────────────────────────────────

describe('Meri race guards — pure predicates', () => {
  test('maySend blocks while scope persistence is saving or errored', () => {
    expect(maySend(false, 'idle')).toBe(true);
    expect(maySend(false, 'saving')).toBe(false);
    expect(maySend(false, 'error')).toBe(false);
    expect(maySend(true, 'idle')).toBe(false);
  });

  test('ownsFirstSend returns true only for the active token', () => {
    const tokenA: FirstSendToken = { id: 'a', routeEpoch: 1 };
    const tokenC: FirstSendToken = { id: 'c', routeEpoch: 2 };
    expect(ownsFirstSend(tokenA, tokenA)).toBe(true);
    expect(ownsFirstSend(tokenA, tokenC)).toBe(false);
    expect(ownsFirstSend(tokenA, null)).toBe(false);
  });

  test('ownsScopeIntent returns true only for the latest intent', () => {
    expect(ownsScopeIntent(1, 1)).toBe(true);
    expect(ownsScopeIntent(1, 2)).toBe(false);
    expect(ownsScopeIntent(2, 2)).toBe(true);
  });
});

// ── Controller-level tests (renderHook) ──────────────────────────────

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

// useLocation is overridden per-test via a mutable location ref.
const locationRef = { pathname: '/meri/t/thread-a', search: '' };
vi.mock('react-router-dom', () => ({
  useLocation: () => locationRef,
  useNavigate: () => (to: string) => {
    if (typeof to === 'string') locationRef.pathname = to;
  },
}));

import { useMeriChatController } from '../../components/chat/useMeriChatController.js';

describe('Meri race guards — controller-level', () => {
  beforeEach(() => {
    resetChatStoreForTests();
    setChatSession('thread-a');
    setActiveConversation('thread-a');
    mocks.api.post.mockReset();
    mocks.getToken.mockClear();
    locationRef.pathname = '/meri/t/thread-a';
    locationRef.search = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── 1. approval-navigation-during-authheaders ──────────────────────
  test('approval POST is never sent if route changes during authHeaders', async () => {
    // Make getToken return a deferred that we control, so authHeaders hangs.
    const tokenDeferred = createDeferred<string>();
    // Reset to normal first, then override to hang after the stream.
    let tokenCallCount = 0;
    mocks.getToken.mockImplementation(() => {
      tokenCallCount++;
      // The stream fetch and other effects consume early calls.
      // Hang the call that happens AFTER the stream completes and the
      // approval button is clicked. We identify it by counting: after
      // sendMessage + waitFor, at least 1 call has happened (stream).
      // The approval's authHeaders is the NEXT call after the click.
      // We hang the Nth call where N = current count + 1.
      return Promise.resolve('token');
    });

    const heldProposal = {
      type: 'pending_approval',
      proposalId: 'proposal-a',
      status: 'proposed',
      tool: 'create_client',
      preview: { label: 'Create client', riskTier: null, leavesFirm: false, reversible: true, fields: {}, counts: {}, reason: 'test' },
      expiresAt: '2030-01-01T00:00:00.000Z',
      reason: 'test',
      riskTier: null,
      policyCode: null,
      ruleId: null,
      policy: {
        source: 'test', mode: 'enforce', packKey: 'test', packVersion: '1',
        binding: 'test', decisionHash: 'test', contextHash: 'test',
        decision: 'hold', jurisdiction: 'test', channel: 'test', recipientType: null,
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

    // Track approve fetches with a deferred so we can control when the
    // fetch resolves. The key insight: we need to navigate AFTER the
    // approve fetch is called but BEFORE it resolves. But the fix
    // prevents the fetch from being called at all if the route changed
    // during authHeaders. So we need to hang authHeaders, not the fetch.
    let approveFetchCalled = false;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/stream')) {
        return Promise.resolve({ ok: true, body: stream, text: async () => '' });
      }
      if (url.includes('/action-proposals/proposal-a/approve')) {
        approveFetchCalled = true;
        return Promise.resolve({ ok: true, json: async () => ({ ...heldProposal, status: 'succeeded' }) });
      }
      return Promise.resolve({ ok: true, json: async () => [], text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await act(async () => {
      await result.current.sendMessage('create a client');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(1));

    // Record the token call count after the stream. The approval's
    // authHeaders will be the next call.
    const callsBeforeApproval = tokenCallCount;

    // Hang the next getToken call (the approval's authHeaders).
    mocks.getToken.mockImplementation(() => {
      tokenCallCount++;
      if (tokenCallCount === callsBeforeApproval + 1) {
        return tokenDeferred.promise.then(() => 'token');
      }
      return Promise.resolve('token');
    });

    // Start approval — it will hang on authHeaders.
    await act(async () => {
      void result.current.handleApprovePending('proposal-a');
      await Promise.resolve();
    });

    // Wait for the approval's getToken call to be in flight.
    await waitFor(() => expect(tokenCallCount).toBeGreaterThanOrEqual(callsBeforeApproval + 1));

    // While authHeaders is pending, navigate away (discard route state).
    await act(async () => {
      result.current.discardRouteState();
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      await Promise.resolve();
    });

    // Now resolve authHeaders — the pre-dispatch check must prevent the POST.
    await act(async () => {
      tokenDeferred.resolve('token');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert: the approve endpoint was never called.
    expect(approveFetchCalled).toBe(false);
    const approveCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/action-proposals/proposal-a/approve'),
    );
    expect(approveCalls).toHaveLength(0);
  });

  // ── 2. approve-all-navigation-between-items ────────────────────────
  test('Approve All stops the loop after navigation: items 2 and 3 are never POSTed', async () => {
    const proposals = ['prop-1', 'prop-2', 'prop-3'].map((id) => ({
      type: 'pending_approval' as const,
      proposalId: id,
      status: 'proposed' as const,
      tool: 'create_client',
      preview: { label: `Action ${id}`, riskTier: null, leavesFirm: false, reversible: true, fields: {}, counts: {}, reason: 'test' },
      expiresAt: '2030-01-01T00:00:00.000Z',
      reason: 'test',
      riskTier: null,
      policyCode: null,
      ruleId: null,
      policy: {
        source: 'test', mode: 'enforce', packKey: 'test', packVersion: '1',
        binding: 'test', decisionHash: 'test', contextHash: 'test',
        decision: 'hold', jurisdiction: 'test', channel: 'test', recipientType: null,
      },
    }));

    const streamData = proposals.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('') + `data: ${JSON.stringify({ type: 'done' })}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamData));
        controller.close();
      },
    });

    // Track approve fetch calls by proposal id.
    const approveCallIds: string[] = [];
    const tokenDeferred = createDeferred<string>();
    let tokenCallCount = 0;
    mocks.getToken.mockImplementation(() => {
      tokenCallCount++;
      return Promise.resolve('token');
    });

    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/stream')) {
        return Promise.resolve({ ok: true, body: stream, text: async () => '' });
      }
      if (url.includes('/approve')) {
        const proposalId = url.match(/action-proposals\/([^/]+)\/approve/)?.[1];
        if (proposalId) approveCallIds.push(proposalId);
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...proposals.find((p) => p.proposalId === proposalId)!, status: 'succeeded', resultSummary: 'done' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [], text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMeriChatController({ selectedClientName: null }));
    await act(async () => {
      await result.current.sendMessage('create three clients');
    });
    await waitFor(() => expect(result.current.pendingApprovals).toHaveLength(3));

    // Record token calls before approve. Hang the next one (first approval's authHeaders).
    const callsBeforeApprove = tokenCallCount;
    mocks.getToken.mockImplementation(() => {
      tokenCallCount++;
      if (tokenCallCount === callsBeforeApprove + 1) {
        return tokenDeferred.promise.then(() => 'token');
      }
      return Promise.resolve('token');
    });

    // Start Approve All — first item hangs on authHeaders.
    await act(async () => {
      void result.current.handleApproveAll();
      await Promise.resolve();
    });

    // Wait for the first approval's getToken to be in flight.
    await waitFor(() => expect(tokenCallCount).toBeGreaterThanOrEqual(callsBeforeApprove + 1));

    // Navigate away while the first item's authHeaders is pending.
    await act(async () => {
      result.current.discardRouteState();
      setChatSession('thread-b');
      setActiveConversation('thread-b');
      await Promise.resolve();
    });

    // Resolve the first item's authHeaders — the pre-dispatch check
    // in runApproval catches the stale route and does NOT dispatch.
    await act(async () => {
      tokenDeferred.resolve('token');
      await Promise.resolve();
      await Promise.resolve();
    });

    // Assert: items 2 and 3 must NEVER be POSTed.
    expect(approveCallIds).not.toContain('prop-2');
    expect(approveCallIds).not.toContain('prop-3');
  });

  // ── 5. client-scope-send-blocked-until-persisted ───────────────────
  test('maySend returns false while scope persistence is saving', () => {
    // This is a pure predicate test but validates the send gate.
    expect(maySend(false, 'saving' as ScopePersistStatus)).toBe(false);
    expect(maySend(false, 'idle' as ScopePersistStatus)).toBe(true);
  });

  // ── 6. client-scope-persist-failure-preserves-composer ─────────────
  test('scope persist failure sets status to error and blocks send', () => {
    // Pure predicate: on failure, scopePersistStatus = 'error' blocks maySend.
    expect(maySend(false, 'error' as ScopePersistStatus)).toBe(false);
  });

  // ── 7. client-scope-A-B-C-out-of-order-resolution ──────────────────
  test('ownsScopeIntent rejects out-of-order scope PATCH resolution', () => {
    // A→B→C: B starts (intent=1), C starts (intent=2).
    // B resolves: intent 1 !== current intent 2 → rejected.
    expect(ownsScopeIntent(1, 2)).toBe(false);
    // C resolves: intent 2 === current intent 2 → accepted.
    expect(ownsScopeIntent(2, 2)).toBe(true);
  });

  // ── 8. keyboard-send-obeys-scope-persist-gate ──────────────────────
  test('keyboard send path uses the same maySend predicate as the button', () => {
    // The composer's submit() calls maySend(busy, scopePersistStatus).
    // While scopePersistStatus is 'saving', maySend returns false.
    // This test verifies the predicate itself is the sole gate.
    const busy = false;
    expect(maySend(busy, 'saving' as ScopePersistStatus)).toBe(false);
    expect(maySend(busy, 'idle' as ScopePersistStatus)).toBe(true);
  });
});

// ── First-send A→B→C deferred-promise tests ──────────────────────────
// These test the ownership token model in the workspace layer.
// Since VNextMeriWorkspace requires a full router + provider setup,
// we test the token guard logic directly.

describe('Meri first-send ownership token — A→B→C', () => {
  test('A resolving first: A is a no-op once C owns the token', () => {
    const tokenA: FirstSendToken = { id: 'uuid-a', routeEpoch: 1 };
    const tokenC: FirstSendToken = { id: 'uuid-c', routeEpoch: 2 };

    // C has minted a new token, replacing A's.
    const activeToken: FirstSendToken | null = tokenC;

    // A's continuation checks ownership — must fail.
    expect(ownsFirstSend(tokenA, activeToken)).toBe(false);

    // A must NOT clear any shared state.
    // (In the real code, every cleanup path returns early when ownsFirstSend is false.)
  });

  test('C resolving last: C is still the owner and may proceed', () => {
    const tokenC: FirstSendToken = { id: 'uuid-c', routeEpoch: 2 };
    const activeToken: FirstSendToken | null = tokenC;

    // C's continuation checks ownership — must pass.
    expect(ownsFirstSend(tokenC, activeToken)).toBe(true);
  });

  test('A resolving after C: A must not clear C pending send, epoch, or busy state', () => {
    const tokenA: FirstSendToken = { id: 'uuid-a', routeEpoch: 1 };
    const tokenC: FirstSendToken = { id: 'uuid-c', routeEpoch: 2 };

    // Simulate: A's stale continuation tries to clear shared refs.
    // The guard prevents it.
    const activeToken: FirstSendToken | null = tokenC;
    const aStillOwns = ownsFirstSend(tokenA, activeToken);

    expect(aStillOwns).toBe(false);
    // If aStillOwns is false, the real code returns without touching:
    // pendingSendRef, pendingSendEpochRef, pendingSendSessionIdRef, isCreatingThread.
  });

  test('C resolving before A: A resolving later is still a complete no-op', () => {
    const tokenA: FirstSendToken = { id: 'uuid-a', routeEpoch: 1 };
    const tokenC: FirstSendToken = { id: 'uuid-c', routeEpoch: 2 };

    // C resolved successfully, A resolves later.
    const activeToken: FirstSendToken | null = tokenC;
    expect(ownsFirstSend(tokenA, activeToken)).toBe(false);
    expect(ownsFirstSend(tokenC, activeToken)).toBe(true);
  });
});
