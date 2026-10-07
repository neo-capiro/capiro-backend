import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLANNER_DEFAULT_PROJECT,
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_TIME_OPTIONS,
  type PlannerBootstrap,
  type PlannerTask,
  type PlannerTimer,
} from '@capiro/strategy-verifier';
import { PlannerTaskTimer, PlannerTimerWidget } from './planner-timers.js';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  scope: 'org_a',
  timer: null as PlannerTimer | null,
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post }),
}));
vi.mock('./planner-api.js', () => ({
  usePlannerKey: () => ['planner', mocks.scope, 'owner', null],
  usePlannerTask: () => ({ data: task, isError: false }),
  plannerError: (e: any) => e?.response?.data?.message ?? e?.message ?? 'Timer error',
}));
const project = {
  ...PLANNER_DEFAULT_PROJECT,
  id: '20000000-0000-4000-8000-000000000001',
  ownerId: 'owner',
  name: 'Timer project',
  access: 'admin' as const,
  version: 1,
  archived: false,
  createdAt: '',
  updatedAt: '',
};
const task: PlannerTask = {
  ...PLANNER_DEFAULT_TASK,
  id: '30000000-0000-4000-8000-000000000001',
  ownerId: 'owner',
  name: 'Focused task',
  access: 'editor',
  version: 1,
  archived: false,
  createdAt: '',
  updatedAt: '',
  completedAt: null,
  actualMinutes: 0,
  memberships: [{ projectId: project.id, sectionId: null, position: 0 }],
};
const bootstrap: PlannerBootstrap = {
  me: { id: 'owner', name: 'Owner' },
  people: [],
  projects: [project],
  timeOptions: { ...PLANNER_DEFAULT_TIME_OPTIONS },
};
const running = (): PlannerTimer => ({
  id: '50000000-0000-4000-8000-000000000001',
  version: 1,
  status: 'running',
  startedAt: '2035-01-01T12:00:00Z',
  endedAt: null,
  serverNow: '2035-01-01T12:00:05Z',
  elapsedMilliseconds: 5000,
  taskId: task.id,
  taskName: task.name,
  time: { projectId: project.id, timeZone: 'UTC', billable: false, category: '' },
  canStop: true,
  notice: null,
  minutes: 0,
});
let client: QueryClient;
beforeEach(() => {
  mocks.scope = 'org_a';
  mocks.timer = null;
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.get.mockImplementation(async () => ({
    data: mocks.scope === 'org_a' ? mocks.timer : null,
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
const wrap = (element: React.ReactNode) => (
  <QueryClientProvider client={client}>{element}</QueryClientProvider>
);
const readyStart = async () =>
  waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Start timer' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
describe('Native Planner timer workflows', () => {
  it('starts with organization defaults and a reviewed task allocation', async () => {
    mocks.post.mockImplementation(async () => {
      mocks.timer = running();
      return { data: mocks.timer };
    });
    render(wrap(<PlannerTaskTimer bootstrap={bootstrap} task={task} onOpen={vi.fn()} />));
    await readyStart();
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    await screen.findByText('Timer running for this task');
    expect(mocks.post).toHaveBeenCalledWith('/strategy-api/planner/time/timers', {
      startKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      taskId: task.id,
      time: { timeZone: 'UTC', projectId: project.id, billable: false, category: '' },
    });
    expect(screen.getByRole('button', { name: 'Stop and log time' })).toBeTruthy();
  });
  it('keeps the exact start key and details after failure and a configuration refresh', async () => {
    mocks.post.mockRejectedValueOnce(Error('Ambiguous start')).mockImplementationOnce(async () => {
      mocks.timer = running();
      return { data: mocks.timer };
    });
    const view = render(
      wrap(<PlannerTaskTimer bootstrap={bootstrap} task={task} onOpen={vi.fn()} />),
    );
    await readyStart();
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    await screen.findByText('Ambiguous start');
    const first = mocks.post.mock.calls[0]![1];
    view.rerender(
      wrap(
        <PlannerTaskTimer
          bootstrap={{
            ...bootstrap,
            timeOptions: {
              ...PLANNER_DEFAULT_TIME_OPTIONS,
              timeZone: 'Europe/London',
              billableDefault: true,
            },
          }}
          task={task}
          onOpen={vi.fn()}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry timer start' }));
    await screen.findByText('Timer running for this task');
    expect(mocks.post.mock.calls[1]![1]).toEqual(first);
  });
  it('reconciles a lost start response with the persisted running session', async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path.endsWith('/stop')) {
        mocks.timer = null;
        return { data: { ...running(), status: 'stopped' } };
      }
      mocks.timer = running();
      throw Error('Lost response');
    });
    render(wrap(<PlannerTaskTimer bootstrap={bootstrap} task={task} onOpen={vi.fn()} />));
    await readyStart();
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    await screen.findByText('Timer running for this task');
    expect(screen.queryByRole('button', { name: 'Retry timer start' })).toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop and log time' }));
    await readyStart();
    expect(screen.queryByText('Lost response')).toBeNull();
  });
  it('requires an explicit allocation for a task in multiple projects', async () => {
    const second = {
      ...project,
      id: '20000000-0000-4000-8000-000000000002',
      name: 'Second project',
    };
    const multi = {
      ...task,
      memberships: [...task.memberships, { projectId: second.id, sectionId: null, position: 0 }],
    };
    render(
      wrap(
        <PlannerTaskTimer
          bootstrap={{ ...bootstrap, projects: [project, second] }}
          task={multi}
          onOpen={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(
      (screen.getByRole('button', { name: 'Start timer' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('Timer project'), { target: { value: second.id } });
    await readyStart();
  });
  it.each(['viewer', 'archived', 'disabled'])('cannot start when work is %s', async (state) => {
    render(
      wrap(
        <PlannerTaskTimer
          bootstrap={{
            ...bootstrap,
            timeOptions: {
              ...PLANNER_DEFAULT_TIME_OPTIONS,
              timeTrackingEnabled: state !== 'disabled',
            },
          }}
          task={{
            ...task,
            access: state === 'viewer' ? 'viewer' : 'editor',
            archived: state === 'archived',
          }}
          onOpen={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Start timer' })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows the persisted timer throughout Planner and opens its exact task', async () => {
    mocks.timer = running();
    const open = vi.fn();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const view = render(wrap(<PlannerTimerWidget bootstrap={bootstrap} onOpen={open} />));
    await screen.findByRole('button', { name: task.name });
    expect(screen.getByRole('timer').textContent).toBe('00:00:05');
    now.mockReturnValue(5000);
    view.rerender(wrap(<PlannerTimerWidget bootstrap={bootstrap} onOpen={open} />));
    expect(screen.getByRole('timer').textContent).toBe('00:00:09');
    fireEvent.click(screen.getByRole('button', { name: task.name }));
    expect(open).toHaveBeenCalledWith(task.id);
  });
  it('disables duplicate stop clicks and retries the original version after an ambiguous failure', async () => {
    mocks.timer = running();
    let reject!: (error: Error) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    render(wrap(<PlannerTimerWidget bootstrap={bootstrap} onOpen={vi.fn()} />));
    const stop = await screen.findByRole('button', { name: 'Stop and log time' });
    fireEvent.click(stop);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(
      (screen.getByRole('button', { name: 'Logging timer…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    reject(Error('Ambiguous stop'));
    await screen.findByText('Ambiguous stop');
    mocks.post.mockImplementationOnce(async () => {
      const stopped = { ...mocks.timer!, status: 'stopped' };
      mocks.timer = null;
      return { data: stopped };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry stopping timer' }));
    await waitFor(() => expect(screen.queryByLabelText('Running timer')).toBeNull());
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.post.mock.calls[0]).toEqual([
      `/strategy-api/planner/time/timers/${running().id}/stop`,
      { version: 1 },
    ]);
  });
  it('can correct allocation, category and billable flag while preserving the captured zone', async () => {
    mocks.timer = running();
    const second = {
      ...project,
      id: '20000000-0000-4000-8000-000000000002',
      name: 'Second project',
    };
    mocks.post.mockImplementation(async () => {
      const stopped = { ...mocks.timer!, status: 'stopped' };
      mocks.timer = null;
      return { data: stopped };
    });
    render(
      wrap(
        <PlannerTaskTimer
          bootstrap={{
            ...bootstrap,
            projects: [project, second],
            timeOptions: { ...PLANNER_DEFAULT_TIME_OPTIONS, categories: ['Delivery'] },
          }}
          task={{
            ...task,
            memberships: [
              ...task.memberships,
              { projectId: second.id, sectionId: null, position: 0 },
            ],
          }}
          onOpen={vi.fn()}
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust timer details' }));
    fireEvent.change(screen.getByLabelText('Timer project'), { target: { value: second.id } });
    fireEvent.change(screen.getByLabelText('Timer category'), { target: { value: 'Delivery' } });
    fireEvent.click(screen.getByLabelText('Billable timer'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop and log time' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        `/strategy-api/planner/time/timers/${running().id}/stop`,
        { version: 1, time: { projectId: second.id, category: 'Delivery', billable: true } },
      ),
    );
  });
  it('redacts unavailable work but permits the owner to discard without logging', async () => {
    mocks.timer = {
      ...running(),
      taskId: null,
      taskName: null,
      time: null,
      canStop: false,
      notice: 'This timer’s task is no longer available.',
    };
    mocks.post.mockImplementation(async () => {
      const discarded = { ...mocks.timer!, status: 'discarded' };
      mocks.timer = null;
      return { data: discarded };
    });
    render(wrap(<PlannerTimerWidget bootstrap={bootstrap} onOpen={vi.fn()} />));
    await screen.findByText('Unavailable task');
    expect(screen.queryByText(task.name)).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Stop and log time' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard timer' }));
    await waitFor(() => expect(screen.queryByLabelText('Running timer')).toBeNull());
    expect(mocks.post).toHaveBeenCalledWith(
      `/strategy-api/planner/time/timers/${running().id}/discard`,
      { version: 1 },
    );
  });
  it('hides cached private work after a failed authorization refresh', async () => {
    mocks.timer = running();
    render(wrap(<PlannerTimerWidget bootstrap={bootstrap} onOpen={vi.fn()} />));
    await screen.findByRole('button', { name: task.name });
    mocks.get.mockRejectedValue(Error('Permission revoked'));
    await client.invalidateQueries({ queryKey: ['planner', 'org_a'] });
    await screen.findByText(/Timer unavailable/);
    expect(screen.queryByRole('button', { name: task.name })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop and log time' })).toBeNull();
  });
  it('keeps late mutation invalidation in its initiating organization and clears the new organization display', async () => {
    let resolve!: (value: { data: PlannerTimer }) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          resolve = resolvePromise;
        }),
    );
    const invalidation = vi.spyOn(client, 'invalidateQueries');
    const view = render(
      wrap(<PlannerTaskTimer bootstrap={bootstrap} task={task} onOpen={vi.fn()} />),
    );
    await readyStart();
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    mocks.scope = 'org_b';
    view.rerender(wrap(<PlannerTaskTimer bootstrap={bootstrap} task={task} onOpen={vi.fn()} />));
    resolve({ data: running() });
    await waitFor(() =>
      expect(invalidation).toHaveBeenCalledWith({ queryKey: ['planner', 'org_a', 'owner', null] }),
    );
    expect(screen.queryByText('Timer running for this task')).toBeNull();
    await readyStart();
  });
});
