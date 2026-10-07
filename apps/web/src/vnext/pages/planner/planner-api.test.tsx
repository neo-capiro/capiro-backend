import { cleanup, renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  usePlannerEvents,
  usePlannerInbox,
  usePlannerReportRows,
  usePlannerTimesheetWork,
  usePlannerTimeReviewPages,
  usePlannerTimesheetHistory,
} from './planner-api.js';

const fixture = vi.hoisted(() => ({ get: vi.fn(), userId: 'user_first' }));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ orgId: 'org_qa', userId: fixture.userId }),
}));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: fixture.get }) }));
vi.mock('../../../state/impersonation.js', () => ({
  useImpersonation: () => ({ actAsTenantSlug: null }),
}));
afterEach(() => {
  cleanup();
  fixture.get.mockReset();
  fixture.userId = 'user_first';
});
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
describe('Planner activity pagination', () => {
  it('sends people and status filters and binds review paging to its captured revision', async () => {
    fixture.get.mockImplementation(async (_path, config) => ({
      data: {
        items: [],
        revision: 'review-revision',
        nextCursor: config.params.cursor ? null : 'member-100',
      },
    }));
    const view = {
      people: ['member'],
      statuses: ['submitted' as const],
      sort: 'total' as const,
      direction: 'desc' as const,
    };
    const { result } = renderHook(() => usePlannerTimeReviewPages('2026-10-05', view, true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fixture.get.mock.calls.at(-1)![1]).toEqual({
      params: {
        week: '2026-10-05',
        paged: 'true',
        people: 'member',
        statuses: 'submitted',
        sort: 'total',
        direction: 'desc',
        cursor: 'member-100',
        revision: 'review-revision',
      },
      signal: expect.any(AbortSignal),
    });
  });
  it('keeps status history pages separate from time/work pages and isolates new revisions', async () => {
    fixture.get.mockImplementation(async (_path, config) => ({
      data: {
        history: [],
        revision: config.params.revision,
        nextHistoryCursor: config.params.historyCursor ? null : 'status-100',
      },
    }));
    const { result, rerender } = renderHook(
      ({ revision }) => usePlannerTimesheetHistory('2026-10-05', 'member', revision),
      { initialProps: { revision: 'first' }, wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fixture.get.mock.calls.at(-1)![1]).toEqual({
      params: {
        week: '2026-10-05',
        userId: 'member',
        revision: 'first',
        historyCursor: 'status-100',
      },
      signal: expect.any(AbortSignal),
    });
    rerender({ revision: 'next' });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(result.current.data?.pages[0]?.revision).toBe('next');
  });
  it('binds weekly work pages to a captured data revision and isolates the next revision', async () => {
    fixture.get.mockImplementation(async (_path, config) => ({
      data: {
        workRows: [],
        nextWorkCursor: config.params.workCursor ? null : 'task:project',
        revision: config.params.revision,
      },
    }));
    const { result, rerender } = renderHook(
      ({ revision }) => usePlannerTimesheetWork('2026-10-05', 'owner', revision),
      { initialProps: { revision: 'a'.repeat(64) }, wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fixture.get).toHaveBeenLastCalledWith('/strategy-api/planner/timesheets', {
      params: {
        week: '2026-10-05',
        userId: 'owner',
        revision: 'a'.repeat(64),
        workCursor: 'task:project',
      },
    });
    rerender({ revision: 'b'.repeat(64) });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(fixture.get).toHaveBeenLastCalledWith('/strategy-api/planner/timesheets', {
      params: { week: '2026-10-05', userId: 'owner', revision: 'b'.repeat(64) },
    });
  });
  it('binds report pages to the current dashboard version and authorized data revision', async () => {
    fixture.get.mockImplementation(async (_path, config) => ({
      data: {
        items: [],
        nextCursor: config.params.cursor ? null : 'next-report-row',
        revision: 'a'.repeat(64),
      },
    }));
    const { result, rerender } = renderHook(
      ({ version, bucket }) => usePlannerReportRows('dashboard', 'widget', version, bucket),
      {
        initialProps: { version: 3, bucket: 'done' },
        wrapper: wrapper(),
      },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(fixture.get).toHaveBeenLastCalledWith(
      '/strategy-api/planner/reports/dashboard/widgets/widget',
      {
        params: {
          rows: 'true',
          version: '3',
          bucket: 'done',
          cursor: 'next-report-row',
          revision: 'a'.repeat(64),
        },
      },
    );
    rerender({ version: 4, bucket: 'todo' });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    expect(fixture.get).toHaveBeenLastCalledWith(
      '/strategy-api/planner/reports/dashboard/widgets/widget',
      { params: { rows: 'true', version: '4', bucket: 'todo' } },
    );
  });
  it('keeps goal history and audience metadata separate from project/task activity', async () => {
    fixture.get.mockImplementation(async (path) => ({
      data: {
        items: [{ id: path }],
        nextCursor: null,
        goalContext: { audienceCount: 3, following: true },
      },
    }));
    const { result } = renderHook(() => usePlannerEvents(undefined, undefined, 'goal-first'), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fixture.get).toHaveBeenCalledWith('/strategy-api/planner/goals/goal-first/events', {
      params: { paged: 'true' },
    });
    expect(result.current.data!.pages[0]!.goalContext).toEqual({
      audienceCount: 3,
      following: true,
    });
  });
  it('retains earlier activity when loading the next cursor and isolates a different task', async () => {
    fixture.get.mockImplementation(async (path, config) => ({
      data: config.params.cursor
        ? { items: [{ id: 'older', text: 'Older update' }], nextCursor: null }
        : { items: [{ id: path, text: 'Newest update' }], nextCursor: 'notification-cursor' },
    }));
    const { result, rerender } = renderHook(({ taskId }) => usePlannerEvents(taskId), {
      initialProps: { taskId: 'task-first' },
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(
      result.current.data!.pages.flatMap((page) => page.items).map((item) => item.text),
    ).toEqual(['Newest update', 'Older update']);
    expect(fixture.get).toHaveBeenLastCalledWith('/strategy-api/planner/tasks/task-first/events', {
      params: { paged: 'true', cursor: 'notification-cursor' },
    });
    rerender({ taskId: 'task-second' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.pages).toHaveLength(1);
    expect(result.current.data!.pages[0]!.items[0]!.id).toContain('task-second');
  });
  it('can continue an empty revoked inbox page and separates archives and signed-in users', async () => {
    fixture.get.mockImplementation(async (_path, config) => ({
      data: config.params.cursor
        ? { items: [{ id: 'visible', read: false, archived: false }], nextCursor: null }
        : { items: [], nextCursor: 'revoked-page-cursor' },
    }));
    const { result, rerender } = renderHook(({ archive }) => usePlannerInbox(archive), {
      initialProps: { archive: false },
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(result.current.data!.pages[0]!.items).toEqual([]);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(result.current.data!.pages.flatMap((page) => page.items).map((item) => item.id)).toEqual(
      ['visible'],
    );
    rerender({ archive: true });
    await waitFor(() =>
      expect(fixture.get).toHaveBeenLastCalledWith('/strategy-api/planner/inbox', {
        params: { paged: 'true', archived: 'true' },
      }),
    );
    fixture.userId = 'user_second';
    rerender({ archive: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.pages).toHaveLength(1);
    expect(result.current.data!.pages[0]!.items).toEqual([]);
  });
});
