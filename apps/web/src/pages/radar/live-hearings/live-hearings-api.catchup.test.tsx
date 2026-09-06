import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

import { useHearingIntelligence, usePublicHearingTranscript } from './live-hearings-api.js';

const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: clients.at(-1)! }, children);
}
function client() {
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }));
}
function segment(sequence: number) {
  return { id: `s-${sequence}`, sequence, text: `Recorded segment ${sequence}`, startMs: sequence * 5000, isFinal: true };
}
function transcriptPage(items: ReturnType<typeof segment>[], total: number, resumeCursor: string, nextCursor: string | null = null, captureId = 'capture-1') {
  return { data: { items, total, resumeCursor, nextCursor, hasMore: Boolean(nextCursor), capture: { id: captureId } } };
}
function cursorOf(url: string) {
  return new URL(url, 'https://example.test').searchParams.get('cursor');
}

afterEach(() => {
  cleanup();
  for (const queryClient of clients.splice(0)) queryClient.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  get.mockReset();
});

describe('canonical hearing catch-up', () => {
  it('drains more than 500 segments, then resumes only the live tail while hidden, including after four hours', async () => {
    vi.useFakeTimers();
    client();
    let count = 501;
    get.mockImplementation(async (url: string) => {
      const cursor = cursorOf(url);
      if (!cursor) return transcriptPage(Array.from({ length: 500 }, (_, index) => segment(index + 1)), count, '500', '500');
      const after = Number(cursor);
      return transcriptPage(Array.from({ length: count - after }, (_, index) => segment(after + index + 1)), count, String(count));
    });
    const { result } = renderHook(() => usePublicHearingTranscript('long-hearing'), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current.data?.pages[0]?.items).toHaveLength(501);
    expect(get.mock.calls.map(([url]) => cursorOf(url))).toEqual([null, '500']);

    focusManager.setFocused(false);
    count = 502;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_010); });
    expect(result.current.data?.pages[0]?.items).toHaveLength(502);
    expect(cursorOf(get.mock.calls.at(-1)![0])).toBe('501');

    await act(async () => { await vi.advanceTimersByTimeAsync(20_010); });
    expect(result.current.data?.pages).toHaveLength(1);
    expect(result.current.data?.pages[0]?.items).toHaveLength(502);
    expect(get.mock.calls.filter(([url]) => cursorOf(url) === null)).toHaveLength(1);

    // Jump the clock through a four-hour hearing. The next poll still runs;
    // periodic reconciliation rereads corrections, then resumes incrementally.
    vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    count = 503;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_010); });
    expect(result.current.data?.pages[0]?.items).toHaveLength(503);
    expect(get.mock.calls.filter(([url]) => cursorOf(url) === null)).toHaveLength(2);
    count = 504;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_010); });
    expect(result.current.data?.pages[0]?.items).toHaveLength(504);
    expect(cursorOf(get.mock.calls.at(-1)![0])).toBe('503');
  });

  it('reconciles a restarted capture rather than applying the old capture cursor to it', async () => {
    client();
    get.mockResolvedValueOnce(transcriptPage([segment(100)], 1, 'old-100'));
    const { result } = renderHook(() => usePublicHearingTranscript('restarted-hearing'), { wrapper });
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.sequence).toBe(100));
    get.mockResolvedValueOnce(transcriptPage([], 1, 'old-100', null, 'capture-2'));
    get.mockResolvedValueOnce(transcriptPage([segment(1)], 1, 'new-1', null, 'capture-2'));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.sequence).toBe(1));
    expect(get.mock.calls.map(([url]) => cursorOf(url))).toEqual([null, 'old-100', null]);
    expect(result.current.data?.pages[0]?.items).toHaveLength(1);
  });

  it('keeps recorded segments after a transient tail failure and resumes from the same cursor', async () => {
    client();
    get.mockResolvedValueOnce(transcriptPage([segment(1)], 1, '1'));
    const { result } = renderHook(() => usePublicHearingTranscript('resuming-hearing'), { wrapper });
    await waitFor(() => expect(result.current.data?.pages[0]?.items).toHaveLength(1));
    get.mockRejectedValueOnce(new Error('Network interrupted'));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.pages[0]?.items).toHaveLength(1);
    get.mockResolvedValueOnce(transcriptPage([segment(2)], 2, '2'));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data?.pages[0]?.items).toHaveLength(2));
    expect(get.mock.calls.slice(1).map(([url]) => cursorOf(url))).toEqual(['1', '1']);
  });

  it('reconciles every intelligence page, retaining status and removing corrected/deleted findings', async () => {
    client();
    const insight = (n: number) => ({ id: `i-${n}`, title: `Finding ${n}`, summary: 'Grounded summary' });
    get.mockResolvedValueOnce({ data: { items: Array.from({ length: 200 }, (_, n) => insight(n)), hasMore: true, nextCursor: 'intel-next' } });
    get.mockResolvedValueOnce({ data: { items: [insight(200)], hasMore: false, status: 'PROCESSING', summary: { total: 201 }, jobs: { public: { pending: 2 } } } });
    const { result } = renderHook(() => useHearingIntelligence('intel-hearing'), { wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(201));
    expect(cursorOf(get.mock.calls[1]![0])).toBe('intel-next');
    expect(result.current.data?.status).toBe('PROCESSING');
    expect(result.current.data?.jobs?.public?.pending).toBe(2);
    expect(result.current.data?.total).toBe(201);
    get.mockResolvedValueOnce({ data: { items: [{ ...insight(0), summary: 'Corrected summary' }], hasMore: false, status: 'READY', summary: { total: 1 } } });
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.summary).toBe('Corrected summary');
    expect(result.current.data?.status).toBe('READY');
  });

  it('stops a broken cursor rather than spinning indefinitely', async () => {
    client();
    get.mockResolvedValue(transcriptPage([segment(1)], 2, 'same', 'same'));
    const { result } = renderHook(() => usePublicHearingTranscript('broken-cursor'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/pagination did not advance/);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
