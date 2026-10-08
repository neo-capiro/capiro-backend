// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  plannerLoadCapacity,
  usePlannerCapacityPlan,
  usePlannerCapacityMutations,
} from './planner-capacity-api.js';
const mocks = vi.hoisted(() => ({ key: ['planner', 'org-a', 'me'], get: vi.fn(), post: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post }),
}));
vi.mock('./planner-api.js', () => ({ usePlannerKey: () => mocks.key }));
const page = (ids: string[], nextCursor: string | null = null, matched = ids.length) =>
  ({
    revision: 'a'.repeat(64),
    matched,
    nextCursor,
    allocations: ids.map((id) => ({ id })),
    plan: { id: 'plan' },
    projectIds: [],
    personIds: [],
  }) as any;
const clients: QueryClient[] = [];
function Probe() {
  const q = usePlannerCapacityPlan('plan', false);
  const m = usePlannerCapacityMutations();
  return (
    <>
      <p>
        {q.isError
          ? 'Error: ' + q.error.message
          : q.data
            ? 'Ready: ' + q.data.allocations.map((a) => a.id).join(',')
            : 'Loading'}
      </p>
      <button
        onClick={() => m.record.mutate({ kind: 'plans', id: 'plan', name: 'Plan', data: {} })}
      >
        Save record
      </button>
      <button
        onClick={() =>
          m.weeklyCapacities.mutate({
            planId: 'plan',
            revision: 'opening',
            changes: [{ id: 'me', weeklyMinutes: 1800 }],
          })
        }
      >
        Save weekly capacity
      </button>
    </>
  );
}
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.key = ['planner', 'org-a', 'me'];
  mocks.get.mockReset();
  mocks.post.mockReset();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});
describe('Complete authorized capacity snapshots', () => {
  it('uses the same revision on every page and finally revalidates all grants', async () => {
    mocks.get
      .mockResolvedValueOnce({ data: page(['a'], 'a', 3) })
      .mockResolvedValueOnce({ data: page(['b', 'c'], null, 3) })
      .mockResolvedValueOnce({ data: page(['a'], 'a', 3) });
    const result = await plannerLoadCapacity({ get: mocks.get }, 'plan', false);
    expect(result.allocations.map((a) => a.id)).toEqual(['a', 'b', 'c']);
    expect(mocks.get.mock.calls[1]![1].params).toEqual({
      archived: 'false',
      cursor: 'a',
      revision: 'a'.repeat(64),
    });
    expect(mocks.get.mock.calls[2]![1].params).toEqual({
      archived: 'false',
      revision: 'a'.repeat(64),
    });
  });
  it.each(['mixed', 'duplicates', 'incomplete', 'stalled', 'revoked'])(
    'never publishes %s allocation snapshots',
    async (mode) => {
      mocks.get.mockResolvedValueOnce({ data: page(['a'], mode === 'incomplete' ? null : 'a', 2) });
      if (mode === 'mixed')
        mocks.get.mockResolvedValueOnce({
          data: { ...page(['b'], null, 2), revision: 'b'.repeat(64) },
        });
      if (mode === 'duplicates') mocks.get.mockResolvedValueOnce({ data: page(['a'], null, 2) });
      if (mode === 'stalled') mocks.get.mockResolvedValueOnce({ data: page([], 'a', 2) });
      if (mode === 'revoked')
        mocks.get
          .mockResolvedValueOnce({ data: page(['b'], null, 2) })
          .mockRejectedValueOnce(new Error('Access revoked'));
      await expect(plannerLoadCapacity({ get: mocks.get }, 'plan', false)).rejects.toThrow();
    },
  );
  it('hides a previously successful cached schedule after permission revocation', async () => {
    mocks.get.mockResolvedValue({ data: page(['a']) });
    show();
    await screen.findByText('Ready: a');
    mocks.get.mockRejectedValue(new Error('Access revoked'));
    await act(() => clients[0]!.invalidateQueries({ queryKey: mocks.key }));
    await screen.findByText('Error: Access revoked');
    expect(screen.queryByText('Ready: a')).not.toBeInTheDocument();
  });
  it.each(['Save record', 'Save weekly capacity'])(
    'keeps late old-organization reads and %s invalidation in their initiating organization',
    async (action) => {
      mocks.get.mockResolvedValue({ data: page(['a']) });
      let resolve!: (value: any) => void;
      mocks.post.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
      const view = show();
      await screen.findByText('Ready: a');
      const invalidate = vi.spyOn(clients[0]!, 'invalidateQueries');
      fireEvent.click(screen.getByRole('button', { name: action }));
      await waitFor(() => expect(mocks.post).toHaveBeenCalled());
      mocks.key = ['planner', 'org-b', 'me'];
      mocks.get.mockResolvedValue({ data: page(['current']) });
      view.rerender(
        <QueryClientProvider client={clients[0]!}>
          <Probe />
        </QueryClientProvider>,
      );
      await screen.findByText('Ready: current');
      await act(async () => resolve({ data: { id: 'old' } }));
      await waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ['planner', 'org-a', 'me'] }),
      );
      expect(screen.getByText('Ready: current')).toBeInTheDocument();
      expect(mocks.post.mock.calls[0]![0]).toBe(
        '/strategy-api/planner/capacity/' +
          (action === 'Save record' ? 'plans' : 'weekly-capacities'),
      );
      expect(mocks.post.mock.calls[0]![1]).not.toHaveProperty('kind');
    },
  );
});
