/**
 * LW-QA-019 — the All-clients work-state mutation, against the REAL hook and a
 * real QueryClient. Only the axios-like transport is faked.
 *
 * Two things shipped broken and are locked here:
 *  1. The All-clients scope posts to the explicit tenant-wide token '_all'.
 *     It must stay '_all' (the server now has real handlers for it) and must
 *     never be swapped for some arbitrary client's UUID.
 *  2. The hook's doc comment promised "optimistic, with rollback" but had
 *     neither onMutate nor onError, so a failure left the row showing its old
 *     state with nothing on screen. The snapshot/restore below is that promise
 *     made real — and it deliberately leaves `workStateCounts` alone, so a
 *     count moves exactly once, on the server's refetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { FeedResponse } from '../../../../pages/clients/tracker/intel-feed-api.js';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get, post }) }));

import { useLwWorkState } from './api.js';

/** The real cache key for the All-clients default view (§3.3). */
const TENANT_KEY = ['intel-feed', '_all', 'all', 'date', 'default'] as const;

function feedPage(): FeedResponse {
  return {
    items: [
      {
        id: 'a1',
        clientId: 'client-A',
        sourceType: 'bill',
        severity: 'notable',
        materiality: 'medium',
        score: 1,
        title: 'Alert one',
        whyItMatters: null,
        recommendedAction: null,
        evidence: {},
        status: 'new',
        createdAt: '2026-09-01T00:00:00.000Z',
        workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
      },
      {
        id: 'a2',
        clientId: 'client-B',
        sourceType: 'hearing',
        severity: 'info',
        materiality: 'low',
        score: 1,
        title: 'Alert two',
        whyItMatters: null,
        recommendedAction: null,
        evidence: {},
        status: 'new',
        createdAt: '2026-09-01T00:00:00.000Z',
        workState: { state: 'new', assignedTo: null, snoozedUntil: null, note: null },
      },
    ] as FeedResponse['items'],
    nextCursor: null,
    hasMore: false,
    counts: { bill: 1, hearing: 1 },
    total: 2,
    workStateCounts: { new: 2, in_review: 0, assigned: 0, actioned: 0, snoozed: 0, dismissed: 0 },
  };
}

function seed(qc: QueryClient) {
  qc.setQueryData<InfiniteData<FeedResponse>>(TENANT_KEY, {
    pages: [feedPage()],
    pageParams: [null],
  });
}

function stateOf(qc: QueryClient, alertId: string): string | undefined {
  const data = qc.getQueryData<InfiniteData<FeedResponse>>(TENANT_KEY);
  return data?.pages[0]?.items.find((i) => i.id === alertId)?.workState?.state;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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

describe('useLwWorkState — the All-clients route token', () => {
  it("posts a single triage to the explicit '_all' path, not a client UUID", async () => {
    const qc = makeClient();
    post.mockResolvedValueOnce({ data: { ok: true } });
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1'], state: 'actioned' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(post).toHaveBeenCalledWith('/intel-api/clients/_all/alerts/a1/work-state', {
      state: 'actioned',
    });
  });

  it("posts a bulk triage to the explicit '_all' bulk path", async () => {
    const qc = makeClient();
    post.mockResolvedValueOnce({ data: { updated: 2 } });
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1', 'a2'], state: 'dismissed' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(post).toHaveBeenCalledWith('/intel-api/clients/_all/alerts/work-state/bulk', {
      alertIds: ['a1', 'a2'],
      state: 'dismissed',
    });
  });

  it('a scoped client still posts under its own id', async () => {
    const qc = makeClient();
    post.mockResolvedValueOnce({ data: { ok: true } });
    const { result } = renderHook(() => useLwWorkState('c-1'), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1'], state: 'in_review' });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(post).toHaveBeenCalledWith('/intel-api/clients/c-1/alerts/a1/work-state', {
      state: 'in_review',
    });
  });
});

describe('useLwWorkState — optimistic update and rollback', () => {
  it('patches the real prefixed cache entry while the request is in flight', async () => {
    const qc = makeClient();
    seed(qc);
    let settle: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1'], state: 'actioned' });
    });

    expect(stateOf(qc, 'a1')).toBe('actioned');
    expect(stateOf(qc, 'a2')).toBe('new'); // untouched
    await act(async () => {
      settle({ data: { ok: true } });
    });
  });

  it('leaves workStateCounts to the server so a count never double-applies', async () => {
    const qc = makeClient();
    seed(qc);
    let settle: (v: unknown) => void = () => undefined;
    post.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1'], state: 'actioned' });
    });

    const counts = qc.getQueryData<InfiniteData<FeedResponse>>(TENANT_KEY)?.pages[0];
    expect(counts?.workStateCounts).toEqual(feedPage().workStateCounts);
    expect(counts?.total).toBe(2);
    await act(async () => {
      settle({ data: { ok: true } });
    });
  });

  it('rolls the cache back to its pre-mutation snapshot when the post fails', async () => {
    const qc = makeClient();
    seed(qc);
    post.mockRejectedValueOnce(new Error('404 Client not found'));
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1', 'a2'], state: 'dismissed' });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(stateOf(qc, 'a1')).toBe('new');
    expect(stateOf(qc, 'a2')).toBe('new');
  });

  it('surfaces the failure to the caller so the UI can show it', async () => {
    const qc = makeClient();
    seed(qc);
    post.mockRejectedValueOnce(new Error('boom'));
    const onError = vi.fn();
    const { result } = renderHook(() => useLwWorkState(''), { wrapper: wrapper(qc) });

    await act(async () => {
      result.current.mutate({ alertIds: ['a1'], state: 'actioned' }, { onError });
    });
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(result.current.isError).toBe(true);
  });
});
