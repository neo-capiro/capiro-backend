import { LegiWatchPhase9RuntimeService } from './legiwatch-phase9-runtime.service.js';
import { LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS } from './legiwatch-phase9.types.js';

function runtimeRow(overrides: Record<string, unknown> = {}) {
  return {
    jobKey: 'central-discovery',
    jobType: 'central_discovery',
    status: 'succeeded',
    enabled: true,
    scheduleEnabled: true,
    expectedIntervalSeconds: 600,
    maxLagSeconds: 1800,
    ruleName: 'capiro-dev-legiwatch-central-discovery',
    taskFamily: 'capiro-dev-legiwatch-phase9-api',
    lastStartedAt: new Date('2026-08-21T11:55:00Z'),
    lastHeartbeatAt: new Date('2026-08-21T11:59:00Z'),
    lastSuccessAt: new Date('2026-08-21T11:59:00Z'),
    lastFailureAt: null,
    lastFinishedAt: new Date('2026-08-21T11:59:00Z'),
    consecutiveFailures: 0,
    lastError: null,
    metrics: { observed: 3 },
    ...overrides,
  };
}

function harness(input: { registered?: number; enabled?: number } = {}) {
  const execute = jest.fn(async (_sql: string, ..._args: unknown[]) => 1);
  const query = jest.fn(async (sql: string, ..._args: unknown[]) => {
    if (sql.includes('COUNT(*) FILTER (WHERE job_key = ANY')) {
      return [
        {
          registered: input.registered ?? LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.length,
          enabled: input.enabled ?? LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.length,
        },
      ];
    }
    if (sql.includes('FROM legiwatch_runtime_heartbeat')) return [runtimeRow()];
    return [];
  });
  const tx = { $executeRawUnsafe: execute, $queryRawUnsafe: query };
  const prisma = {
    $executeRawUnsafe: execute,
    $queryRawUnsafe: query,
    withSystem: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    service: new LegiWatchPhase9RuntimeService(prisma as never),
    execute,
    query,
    prisma,
  };
}

function completeRegistrations(enabled = true) {
  return LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.map((jobKey) => ({
    jobKey,
    enabled,
    scheduleEnabled: enabled,
    ruleName: `capiro-dev-legiwatch-${jobKey}`,
    taskFamily: jobKey.includes('worker')
      ? 'capiro-dev-legiwatch-phase9-intel'
      : 'capiro-dev-legiwatch-phase9-api',
  }));
}

describe('LegiWatchPhase9RuntimeService', () => {
  it('marks an enabled recent heartbeat fresh', async () => {
    const { service } = harness();
    await expect(service.list(new Date('2026-08-21T12:00:00Z'))).resolves.toEqual([
      expect.objectContaining({
        jobKey: 'central-discovery',
        enabled: true,
        scheduleEnabled: true,
        stale: false,
        metrics: { observed: 3 },
      }),
    ]);
  });

  it('marks a disabled or stale runtime job unhealthy', async () => {
    const { service, query } = harness();
    query.mockImplementationOnce(async () => [
      runtimeRow({
        enabled: false,
        scheduleEnabled: false,
        status: 'disabled',
        lastHeartbeatAt: null,
      }),
    ]);
    await expect(service.list(new Date('2026-08-21T12:00:00Z'))).resolves.toEqual([
      expect.objectContaining({ stale: true }),
    ]);
  });

  it('rejects a scheduled job that is not enabled', async () => {
    const { service } = harness();
    await expect(
      service.registerSchedules({
        registrations: [
          {
            jobKey: 'central-discovery',
            enabled: false,
            scheduleEnabled: true,
          },
        ],
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH SCHEDULES',
      }),
    ).rejects.toThrow(/scheduled while disabled/i);
  });

  it('rejects unknown and duplicate runtime keys', async () => {
    const { service } = harness();
    await expect(
      service.registerSchedules({
        registrations: [
          { jobKey: 'unknown-job', enabled: true, scheduleEnabled: true },
        ],
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH SCHEDULES',
      }),
    ).rejects.toThrow(/Unknown Phase 9 runtime job/);
    await expect(
      service.registerSchedules({
        registrations: [
          { jobKey: 'metrics', enabled: true, scheduleEnabled: true },
          { jobKey: 'metrics', enabled: true, scheduleEnabled: true },
        ],
        actor: 'admin-user',
        confirmation: 'ENABLE LEGIWATCH SCHEDULES',
      }),
    ).rejects.toThrow(/Duplicate Phase 9 runtime registration/);
  });

  it('requires the exact enable or disable confirmation', async () => {
    const { service } = harness();
    await expect(
      service.registerSchedules({
        registrations: completeRegistrations(true),
        actor: 'admin-user',
        confirmation: 'yes',
      }),
    ).rejects.toThrow(/Exact confirmation required/);
  });

  it('marks schedules enabled only when all required jobs are registered and active', async () => {
    const { service, execute } = harness();
    await service.registerSchedules({
      registrations: completeRegistrations(true),
      actor: 'admin-user',
      confirmation: 'ENABLE LEGIWATCH SCHEDULES',
    });
    const stateCall = execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE legiwatch_cutover_state'),
    );
    expect(stateCall?.[1]).toBe(true);
    expect(stateCall?.[2]).toBe('admin-user');
  });

  it('keeps the cutover state disabled for a partial runtime matrix', async () => {
    const { service, execute } = harness({ registered: 11, enabled: 10 });
    await service.registerSchedules({
      registrations: [
        {
          jobKey: 'metrics',
          enabled: true,
          scheduleEnabled: true,
          ruleName: 'metrics-rule',
          taskFamily: 'api-jobs',
        },
      ],
      actor: 'admin-user',
      confirmation: 'ENABLE LEGIWATCH SCHEDULES',
    });
    const stateCall = execute.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE legiwatch_cutover_state'),
    );
    expect(stateCall?.[1]).toBe(false);
  });

  it('refuses an automated job while its registry row is dark', async () => {
    const { service, query } = harness();
    query.mockImplementationOnce(async () => [
      runtimeRow({ enabled: false, scheduleEnabled: false }),
    ]);
    await expect(
      service.begin({ jobKey: 'central-discovery', workerId: 'worker-a' }),
    ).rejects.toThrow(/dark\/disabled/);
  });

  it('allows a deliberate manual smoke run while the schedule is dark', async () => {
    const { service, query, execute } = harness();
    query.mockImplementationOnce(async () => [
      runtimeRow({ enabled: false, scheduleEnabled: false }),
    ]);
    await expect(
      service.begin({
        jobKey: 'central-discovery',
        workerId: 'smoke-worker',
        manual: true,
      }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("status='running'"),
      'central-discovery',
      'smoke-worker',
    );
  });

  it('records success and failure without leaking raw error formatting', async () => {
    const { service, execute } = harness();
    await service.succeed({ jobKey: 'metrics', metrics: { emitted: 1 } });
    await service.fail({
      jobKey: 'metrics',
      error: new Error('provider\nsecret-ish stack line'),
      metrics: { emitted: 0 },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("status='succeeded'"),
      'metrics',
      JSON.stringify({ emitted: 1 }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("status='failed'"),
      'metrics',
      'provider secret-ish stack line',
      JSON.stringify({ emitted: 0 }),
    );
  });
});
