import {
  LegiWatchPhase9JobsService,
  LEGIWATCH_PHASE9_API_JOBS,
} from './legiwatch-phase9-jobs.service.js';

function harness() {
  const tx = { $queryRaw: jest.fn().mockResolvedValue([{ code: 'hsqa' }, { code: 'ssqa' }]) };
  const prisma = {
    withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const runtime = {
    run: jest.fn(async ({ execute }: { execute: () => Promise<unknown> }) => execute()),
  };
  const notifications = {
    syncFollow: jest.fn().mockResolvedValue({ inserted: 2 }),
    drainEmail: jest
      .fn()
      .mockResolvedValue({
        scanned: 1,
        sent: 1,
        retryScheduled: 0,
        terminalFailures: 0,
        suppressed: 0,
      }),
  };
  const jobs = new LegiWatchPhase9JobsService(
    prisma as never,
    runtime as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    notifications as never,
    { reconcileFollowedLifecycle: jest.fn().mockResolvedValue(3) } as never,
  );
  return { jobs, notifications, runtime };
}

describe('committee notification scheduled job', () => {
  it('reconciles every followed committee before draining and reports both outcomes', async () => {
    const { jobs, notifications } = harness();
    expect(LEGIWATCH_PHASE9_API_JOBS).toContain('notification-drain');
    await expect(jobs.run({ job: 'notification-drain' })).resolves.toMatchObject({
      committees: 2,
      inserted: 4,
      sent: 1,
      lifecycleInserted: 3,
    });
    expect(notifications.syncFollow.mock.calls).toEqual([
      [{ committeeSystemCode: 'hsqa' }],
      [{ committeeSystemCode: 'ssqa' }],
    ]);
    expect(notifications.drainEmail).toHaveBeenCalledTimes(1);
  });

  it('continues other intake and queued delivery but exposes an intake failure to runtime monitoring', async () => {
    const { jobs, notifications } = harness();
    notifications.syncFollow.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(jobs.run({ job: 'notification-drain' })).rejects.toThrow(
      'hsqa: database unavailable',
    );
    expect(notifications.syncFollow).toHaveBeenCalledTimes(2);
    expect(notifications.drainEmail).toHaveBeenCalledTimes(1);
  });
});
