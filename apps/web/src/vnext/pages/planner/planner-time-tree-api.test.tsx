// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlannerTimeTree } from './planner-time-tree-api.js';
import { PlannerTimeList, PlannerTaskTimeRollup } from './planner-time-list.js';
import {
  PLANNER_DEFAULT_TASK,
  type PlannerTask,
  type PlannerTimeTreePage,
} from '@capiro/strategy-verifier';
const state = vi.hoisted(() => ({ key: ['planner', 'org-a', 'me'], get: vi.fn() }));
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: state.get }) }));
vi.mock('./planner-api.js', () => ({
  usePlannerKey: () => state.key,
  plannerError: (error: Error) => error.message,
  usePlannerTasks: vi.fn(),
}));
const clients: QueryClient[] = [];
const node = (id: string) => ({
  id,
  parentId: null,
  scoped: true,
  version: 1,
  estimateMinutes: 30,
  actualMinutes: 15,
});
const page = (
  ids: string[],
  nextCursor: string | null = null,
  matched = ids.length,
): PlannerTimeTreePage => ({ nodes: ids.map(node), nextCursor, matched, revision: 'a'.repeat(64) });
function Probe() {
  const query = usePlannerTimeTree({ projectId: 'project' }, true);
  return (
    <p>
      {query.isError
        ? 'Error: ' + query.error.message
        : query.data
          ? 'Ready: ' + query.data.map((n) => n.id).join(',')
          : 'Loading'}
    </p>
  );
}
function show(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
beforeEach(() => {
  state.key = ['planner', 'org-a', 'me'];
  state.get.mockReset();
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
describe('Complete qualified time trees', () => {
  it('keeps the task’s own history separate from its complete accessible subtask summary', async () => {
    const task: PlannerTask = {
      ...PLANNER_DEFAULT_TASK,
      id: 'a',
      name: 'Parent',
      ownerId: 'me',
      access: 'editor',
      version: 1,
      archived: false,
      completedAt: null,
      createdAt: '2026-10-07T12:00:00Z',
      updatedAt: '2026-10-07T12:00:00Z',
      actualMinutes: 60,
    };
    const value = page(['a', 'b']);
    value.nodes = [
      { ...node('a'), estimateMinutes: 60, actualMinutes: 60 },
      { ...node('b'), parentId: 'a', estimateMinutes: 30, actualMinutes: 45 },
    ];
    state.get.mockResolvedValueOnce({ data: value });
    show(<PlannerTaskTimeRollup task={task} />);
    expect(await screen.findByLabelText('Time including subtasks')).toHaveTextContent(
      'Estimated 1:30 · Actual 1:45',
    );
    expect(screen.getByLabelText('Time including subtasks')).toHaveTextContent(
      'Time entries below belong to this task.',
    );
    expect(state.get.mock.calls[0]![1].params).toEqual({ taskId: 'a' });
  });
  it('captures the first revision across all pages and verifies it before publishing', async () => {
    state.get
      .mockResolvedValueOnce({ data: page(['a'], 'a', 3) })
      .mockResolvedValueOnce({ data: page(['b', 'c'], null, 3) })
      .mockResolvedValueOnce({ data: page(['a'], 'a', 3) });
    show(<Probe />);
    await screen.findByText('Ready: a,b,c');
    expect(state.get.mock.calls[1]![1].params).toEqual({
      projectId: 'project',
      cursor: 'a',
      revision: 'a'.repeat(64),
    });
    expect(state.get.mock.calls[2]![1].params).toEqual({
      projectId: 'project',
      revision: 'a'.repeat(64),
    });
  });
  it('never publishes a partial tree when later paging or final permission verification fails', async () => {
    for (const final of [false, true]) {
      state.get.mockReset().mockResolvedValueOnce({ data: page(['a'], 'a', 2) });
      if (final) state.get.mockResolvedValueOnce({ data: page(['b'], null, 2) });
      state.get.mockRejectedValueOnce(new Error('Access changed'));
      show(<Probe />);
      await screen.findByText('Error: Access changed');
      expect(screen.queryByText(/Ready:/)).not.toBeInTheDocument();
      cleanup();
    }
  });
  it('rejects mixed revisions, duplicate nodes and incomplete totals', async () => {
    const cases = [
      [
        { data: page(['a'], 'a', 2) },
        { data: { ...page(['b'], null, 2), revision: 'b'.repeat(64) } },
      ],
      [{ data: page(['a'], 'a', 2) }, { data: page(['a'], null, 2) }],
      [{ data: page(['a'], null, 2) }],
    ];
    for (const values of cases) {
      state.get.mockReset();
      for (const value of values) state.get.mockResolvedValueOnce(value);
      show(<Probe />);
      await waitFor(() => expect(screen.getByText(/^Error:/)).toBeInTheDocument());
      expect(screen.queryByText(/Ready:/)).not.toBeInTheDocument();
      cleanup();
    }
  });
  it('keeps a late old-organization response out of the currently displayed tree', async () => {
    let resolve!: (value: { data: PlannerTimeTreePage }) => void;
    state.get
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockResolvedValueOnce({ data: page(['current-org']) });
    const view = show(<Probe />);
    state.key = ['planner', 'org-b', 'me'];
    view.rerender(
      <QueryClientProvider client={clients[0]!}>
        <Probe />
      </QueryClientProvider>,
    );
    await screen.findByText('Ready: current-org');
    await act(async () => resolve({ data: page(['old-org']) }));
    expect(screen.getByText('Ready: current-org')).toBeInTheDocument();
    expect(screen.queryByText('Ready: old-org')).not.toBeInTheDocument();
  });
  it('hides cached totals after access failure and waits for a successful retry', async () => {
    const task: PlannerTask = {
      ...PLANNER_DEFAULT_TASK,
      id: 'a',
      name: 'Private work',
      ownerId: 'me',
      access: 'editor',
      version: 1,
      archived: false,
      completedAt: null,
      createdAt: '2026-10-07T12:00:00Z',
      updatedAt: '2026-10-07T12:00:00Z',
      actualMinutes: 15,
    };
    state.get.mockResolvedValueOnce({ data: page(['a']) });
    show(
      <PlannerTimeList
        tasks={[task]}
        people={[]}
        onOpen={vi.fn()}
        onPatch={vi.fn()}
        disabled={false}
        scope={{ projectId: 'project' }}
        complete
      />,
    );
    await screen.findByRole('button', { name: 'Actual time for Private work: 0:15' });
    state.get.mockRejectedValueOnce(new Error('Access denied'));
    await act(async () => {
      await clients[0]!.invalidateQueries({ queryKey: ['planner', 'org-a', 'me'] });
    });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /Actual time/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry time totals' })).toBeInTheDocument();
  });
});
