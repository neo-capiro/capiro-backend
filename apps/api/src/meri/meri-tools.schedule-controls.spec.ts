import { MeriToolsService } from './meri-tools.service';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;
const TASK = '11111111-1111-4111-8111-111111111111';

type Update = (ctx: never, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function harness(task: Record<string, unknown> | null) {
  const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
  const tx = {
    clioScheduledTask: {
      findFirst: jest.fn(async () => task),
      updateMany,
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (db: typeof tx) => unknown) => fn(tx)),
  };
  const update: Update = (context, input) =>
    (
      MeriToolsService.prototype as unknown as { updateScheduledTask: Update }
    ).updateScheduledTask.call({ prisma }, context, input);
  return { update, updateMany };
}

const monday8 = {
  enabled: false,
  lastStatus: 'paused',
  intervalMinutes: 10080,
  metadata: { localTime: '08:00', timeZone: 'America/New_York', weekday: 1 },
};

describe('pause, resume, run now (Release E, T10)', () => {
  it('pauses an active task and keeps its definition', async () => {
    const h = harness({ ...monday8, enabled: true, lastStatus: 'ok' });
    await expect(h.update(ctx, { taskId: TASK, action: 'pause' })).resolves.toMatchObject({
      updated: true,
      action: 'pause',
      enabled: false,
    });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: TASK,
        tenantId: 'tenant-1',
        ownerUserId: 'user-1',
        enabled: true,
        NOT: { lastStatus: 'canceled' },
      },
      data: { enabled: false, lastStatus: 'paused' },
    });
  });

  it('resumes on the next local anchor, not immediately', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T18:00:00.000Z')); // Wednesday
    try {
      const h = harness(monday8);
      const result = await h.update(ctx, { taskId: TASK, action: 'resume' });
      expect(result).toMatchObject({
        updated: true,
        enabled: true,
        nextRunAt: '2026-10-12T12:00:00.000Z',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs an active task at the next scheduler tick, once', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T18:00:00.000Z'));
    try {
      const h = harness({ ...monday8, enabled: true, lastStatus: 'ok' });
      await expect(h.update(ctx, { taskId: TASK, action: 'run_now' })).resolves.toMatchObject({
        updated: true,
        nextRunAt: '2026-10-07T18:00:00.000Z',
      });
      expect(h.updateMany.mock.calls[0]![0]).toMatchObject({
        data: { nextRunAt: new Date('2026-10-07T18:00:00.000Z') },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [
      'a canceled task cannot be resumed',
      { ...monday8, lastStatus: 'canceled' },
      'resume',
      'Task not found.',
    ],
    ['a missing task', null, 'pause', 'Task not found.'],
    ['a paused task cannot run', monday8, 'run_now', 'Resume the task before running it.'],
    [
      'a running task cannot run again',
      { ...monday8, enabled: true, lastStatus: 'running' },
      'run_now',
      'The task is running now.',
    ],
    ['an unknown action', monday8, 'delete', 'action must be pause, resume, or run_now.'],
  ])('refuses: %s', async (_label, task, action, error) => {
    const h = harness(task as Record<string, unknown> | null);
    await expect(h.update(ctx, { taskId: TASK, action })).resolves.toMatchObject({
      updated: false,
      error,
    });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['pausing a paused task', monday8, 'pause', false],
    ['resuming an active task', { ...monday8, enabled: true, lastStatus: 'ok' }, 'resume', true],
  ])('is idempotent: %s succeeds without a write', async (_label, task, action, enabled) => {
    const h = harness(task);
    await expect(h.update(ctx, { taskId: TASK, action })).resolves.toMatchObject({
      updated: true,
      unchanged: true,
      enabled,
    });
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});
