import type { TenantContext } from '@capiro/shared';
import {
  ClientProfileFillTaskRuntime,
  type TaskRuntimePorts,
} from './client-profile-fill-task-runtime.js';
import {
  TaskDeferredError,
  type CompletionTaskRow,
} from './client-profile-fill-completion-runtime.shared.js';
import { assertFillExecution } from './client-profile-fill-execution.js';
import {
  expireFillRuns,
  fillTaskBudget,
  FILL_RUN_BUDGET_MS,
} from './client-profile-fill-run-deadline.js';

const startedAt = new Date('2026-10-31T12:00:00Z');
const deadlineAt = new Date(startedAt.getTime() + FILL_RUN_BUDGET_MS);
const task = {
  id: 'task',
  runId: 'run',
  tenantId: 'tenant',
  clientId: 'client',
  workerId: 'lease',
} as CompletionTaskRow;
const ctx = { tenantId: 'tenant', clientId: 'client', userId: 'actor' } as unknown as TenantContext;
function harness(status = 'running') {
  const ports: TaskRuntimePorts = {
    recoverStaleTasks: jest.fn(),
    claimTasks: jest.fn(async () => []),
    executeClaimedTask: jest.fn(),
    finalizeRuns: jest.fn(),
    loadRunActor: jest.fn(async () => [{ createdByUserId: 'actor', status, deadlineAt }]),
    resolveActor: jest.fn(async () => ctx),
    executeTask: jest.fn(async () => 0),
    finishTask: jest.fn(),
    deferTask: jest.fn(),
    failTask: jest.fn(),
    heartbeat: jest.fn(),
  };
  return { ports, worker: new ClientProfileFillTaskRuntime(ports) };
}
beforeEach(() => jest.useFakeTimers().setSystemTime(startedAt));
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('uses the original absolute deadline, fails closed on invalid dates and rejects its exact boundary', () => {
  expect(fillTaskBudget(deadlineAt, 300_000)).toBe(300_000);
  jest.setSystemTime(deadlineAt.getTime() - 1);
  expect(fillTaskBudget(deadlineAt, 300_000)).toBe(1);
  jest.setSystemTime(deadlineAt);
  expect(() => fillTaskBudget(deadlineAt, 300_000)).toThrow('deadline exceeded');
  expect(() => fillTaskBudget(new Date(NaN), 300_000)).toThrow('deadline exceeded');
});

it('preserves dependency deferrals across worker restarts without granting a new run budget', async () => {
  const { ports, worker } = harness();
  jest.mocked(ports.executeTask).mockRejectedValue(new TaskDeferredError('Waiting'));
  await worker.executeClaimedTask(task);
  expect(ports.deferTask).toHaveBeenCalledWith(task, 'Waiting');
  expect(ports.failTask).not.toHaveBeenCalled();
  jest.setSystemTime(deadlineAt.getTime() - 1);
  await new ClientProfileFillTaskRuntime(ports).executeClaimedTask({
    ...task,
    workerId: 'new-lease',
  });
  expect(ports.deferTask).toHaveBeenCalledTimes(2);
  jest.setSystemTime(deadlineAt);
  await new ClientProfileFillTaskRuntime(ports).executeClaimedTask(task);
  expect(ports.executeTask).toHaveBeenCalledTimes(2);
  expect(ports.failTask).toHaveBeenCalledWith(
    task,
    expect.objectContaining({ message: expect.stringContaining('deadline exceeded') }),
  );
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['cancelled', 'completed', 'partial', 'failed'])(
  'does not dispatch a claimed task after run becomes %s',
  async (status) => {
    const { worker, ports } = harness(status);
    await worker.executeClaimedTask(task);
    expect(ports.resolveActor).not.toHaveBeenCalled();
    expect(ports.executeTask).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('rechecks remaining time after slow actor resolution before invoking a specialist', async () => {
  const { worker, ports } = harness();
  jest.mocked(ports.resolveActor).mockImplementation(async () => {
    jest.setSystemTime(deadlineAt);
    return ctx;
  });
  await worker.executeClaimedTask(task);
  expect(ports.executeTask).not.toHaveBeenCalled();
  expect(ports.finishTask).not.toHaveBeenCalled();
  expect(ports.failTask).toHaveBeenCalledTimes(1);
});

it('ends the local attempt at run expiry, leaves provider completion unknown, and fences its late callback', async () => {
  const { worker, ports } = harness();
  jest.setSystemTime(deadlineAt.getTime() - 1000);
  let release!: () => void;
  const provider = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes = jest.fn();
  let lateResult: Promise<unknown> | undefined;
  jest.mocked(ports.executeTask).mockImplementation(() => {
    lateResult = provider.then(async () => {
      await assertFillExecution({} as never, task.tenantId, task.clientId, task.runId);
      writes();
      return 1;
    });
    return lateResult as Promise<number>;
  });
  const running = worker.executeClaimedTask(task);
  await jest.advanceTimersByTimeAsync(1000);
  await running;
  expect(ports.failTask).toHaveBeenCalledWith(
    task,
    expect.objectContaining({
      message: expect.stringContaining('external outcomes remain unresolved'),
    }),
  );
  expect(ports.finishTask).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
  release();
  await expect(lateResult).rejects.toThrow('no longer current');
  expect(writes).not.toHaveBeenCalled();
});

it('expires both task families under the run lock and records uncertainty before clearing running leases', async () => {
  const events: string[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      events.push('lock');
      expect(sql).toContain('FOR UPDATE OF r SKIP LOCKED');
      expect(sql).toContain('clock_timestamp()');
      return [{ id: 'run', tenantId: 'tenant' }];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      events.push(sql.includes('UPDATE client_profile_fill_run ') ? 'run' : 'task');
      return 1;
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (action: (value: typeof tx) => Promise<void>) => action(tx)),
  };
  await expireFillRuns(prisma as never);
  expect(events).toEqual(['lock', 'task', 'task', 'run']);
  expect(prisma.withSystem).toHaveBeenCalledTimes(1);
  for (const [sql] of tx.$executeRawUnsafe.mock.calls.slice(0, 2)) {
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(sql).toContain('externalOutcome":"unresolved');
    expect(sql).toContain('worker_id = NULL');
    expect(sql).not.toContain('attempt =');
  }
});
