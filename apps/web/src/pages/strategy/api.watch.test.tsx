/*
 * Phase 4 §9 items 9 + 13 — Watch mutation cache behavior, against the REAL
 * api.ts hooks (not mocked) and a real QueryClient, so this actually proves
 * the invalidation/cache-write contract rather than asserting a mock was
 * configured correctly. Only the axios-like transport (useApi) is faked.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { WatchAcceptResult, WatchReviewState } from './types.js';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({ get, post }) }));

import {
  useAcceptAllWatchProposals,
  useAcceptWatchProposal,
  useDismissWatchProposal,
} from './api.js';

const STRATEGY_ID = 'strat-1';

const watchState = (over: Partial<WatchReviewState> = {}): WatchReviewState => ({
  strategyId: STRATEGY_ID,
  headVersionId: 'v2',
  mission: { id: 'm1', state: 'active', cadence: 'weekly', lastRunAt: null, nextRunAt: null },
  pendingCount: 0,
  proposals: [],
  lastRecheck: { state: 'complete', elapsedMs: 3, unchanged: [], updated: [], dropped: [] },
  ...over,
});

const acceptResult = (over: Partial<WatchAcceptResult> = {}): WatchAcceptResult => ({
  strategy: { id: STRATEGY_ID } as unknown as WatchAcceptResult['strategy'],
  state: watchState(),
  recheck: { state: 'complete', elapsedMs: 3, unchanged: [], updated: [], dropped: [] },
  ...over,
});

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('useAcceptWatchProposal — cache writes (Phase 4 §9.9)', () => {
  test('a successful accept writes BOTH the strategy detail and the watch state directly into cache', async () => {
    const qc = makeClient();
    const result = acceptResult();
    post.mockResolvedValueOnce({ data: result });

    const { result: hook } = renderHook(() => useAcceptWatchProposal(STRATEGY_ID), { wrapper: wrapper(qc) });
    await act(async () => {
      hook.current.mutate('cs-1');
    });
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));

    expect(post).toHaveBeenCalledWith('/strategy-api/agents/watch/proposals/cs-1/accept');
    expect(qc.getQueryData(['strategy', 'strategy', STRATEGY_ID])).toEqual(result.strategy);
    expect(qc.getQueryData(['strategy', 'watch-state', STRATEGY_ID])).toEqual(result.state);
  });

  test('invalidates strategy list, change-sets, missions, versions/history, and the STRATEGY conversation thread', async () => {
    const qc = makeClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    post.mockResolvedValueOnce({ data: acceptResult() });

    const { result: hook } = renderHook(() => useAcceptWatchProposal(STRATEGY_ID), { wrapper: wrapper(qc) });
    await act(async () => {
      hook.current.mutate('cs-1');
    });
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(invalidatedKeys).toContainEqual(['strategy', 'strategies']);
    expect(invalidatedKeys).toContainEqual(['strategy', 'change-sets']);
    expect(invalidatedKeys).toContainEqual(['strategy', 'missions']);
    expect(invalidatedKeys).toContainEqual(['strategy', 'versions', STRATEGY_ID]);
    // conversationKey(strategyId, null) — the watch_applied confirmation lands
    // on the STRATEGY thread (nodeId: null), never a step thread.
    expect(invalidatedKeys).toContainEqual(['strategy', 'conversation', STRATEGY_ID, 'strategy']);
    expect(invalidatedKeys).toContainEqual(['strategy', 'watch-pending-counts']);
  });
});

describe('useAcceptAllWatchProposals — one call, one invalidation pass (Phase 4 §9.13)', () => {
  test('sends the exact proposal ids and the expectedVersionId in a single POST', async () => {
    const qc = makeClient();
    post.mockResolvedValueOnce({ data: acceptResult() });

    const { result: hook } = renderHook(() => useAcceptAllWatchProposals(STRATEGY_ID), { wrapper: wrapper(qc) });
    await act(async () => {
      hook.current.mutate({ expectedVersionId: 'v2', proposalIds: ['cs-1', 'cs-2'] });
    });
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      `/strategy-api/agents/watch/strategies/${STRATEGY_ID}/accept-all`,
      { expectedVersionId: 'v2', proposalIds: ['cs-1', 'cs-2'] },
    );
  });
});

describe('useDismissWatchProposal — permanent removal (Phase 4 §9.14)', () => {
  test('the returned state (without the dismissed card) replaces the cached watch state', async () => {
    const qc = makeClient();
    qc.setQueryData(
      ['strategy', 'watch-state', STRATEGY_ID],
      watchState({
        pendingCount: 1,
        proposals: [
          {
            id: 'cs-1',
            watchKey: 'k1',
            strategyVersionId: 'v2',
            sourceLabel: 'Dependency check',
            sourceDate: null,
            badges: [],
            title: 'x',
            proposal: 'y',
            impact: 'z',
            why: 'w',
            risk: 'low',
            recheckStatus: null,
          },
        ],
      }),
    );
    const after = watchState({ pendingCount: 0, proposals: [] });
    post.mockResolvedValueOnce({ data: after });

    const { result: hook } = renderHook(() => useDismissWatchProposal(STRATEGY_ID), { wrapper: wrapper(qc) });
    await act(async () => {
      hook.current.mutate('cs-1');
    });
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));

    expect(qc.getQueryData(['strategy', 'watch-state', STRATEGY_ID])).toEqual(after);
  });
});
