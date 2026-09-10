import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';

// These tests exercise task orchestration; no specialist, external API or apply
// engine should initialize just to read task state.
jest.mock('./client-profile-fill.service.js', () => ({ ClientProfileFillService: class {} }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: class {} }));
jest.mock('./client-facilities.service.js', () => ({ ClientFacilitiesService: class {} }));
jest.mock('./client-advocacy-matter.service.js', () => ({ ClientAdvocacyMatterService: class {} }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
jest.mock('../intelligence/client-prepopulation.service.js', () => ({
  ClientPrepopulationService: class {},
}));
jest.mock('./client-profile-fill-context-plane.service.js', () => ({
  ClientProfileFillContextPlaneService: class {},
}));
jest.mock('./governed-client-profile-fill.factory.js', () => ({
  runWithGovernedCrmFillBundle: jest.fn(),
}));

const ctx = { tenantId: 'tenant-1' } as any;

function build(tx: any = {}, workflow: any = {}) {
  const prisma = {
    withSystem: jest.fn((fn) => fn(tx)),
    withTenant: jest.fn((_tenant, fn) => fn(tx)),
  };
  return new ClientProfileFillCompletionService(
    prisma as any,
    workflow,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  ) as any;
}

describe('Fill specialist retry and completion (Q11)', () => {
  it.each(['resolve', 'recordRunContext'])(
    'times out stalled %s and does not start a late specialist',
    async (blockedStep) => {
      jest.useFakeTimers();
      let release!: (value: unknown) => void;
      const stalled = new Promise((resolve) => {
        release = resolve;
      });
      const contextPlane = {
        resolve: jest.fn().mockResolvedValue({}),
        recordRunContext: jest.fn().mockResolvedValue(undefined),
      };
      contextPlane[blockedStep as keyof typeof contextPlane].mockReturnValue(stalled);
      const service = new ClientProfileFillWorkflowService(
        {} as any,
        {} as any,
        contextPlane as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      ) as any;
      service.syncSourceState = jest.fn().mockResolvedValue(undefined);
      service.heartbeat = jest.fn().mockResolvedValue(undefined);
      service.failTask = jest.fn().mockResolvedValue(undefined);
      service.completeTask = jest.fn();
      service.executeTask = jest.fn();
      service.requestSweep = jest.fn();
      const task = {
        id: 'bill-task',
        runId: 'run-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        taskType: 'bill_tracker',
        createdByUserId: 'user-1',
        input: {},
        attempt: 3,
        maxAttempts: 3,
      };
      try {
        const execution = service.executeClaimedTask(task);
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
        await execution;
        expect(service.failTask).toHaveBeenCalledWith(
          task,
          'task_failed',
          'Fill specialist exceeded its task budget. Retry this check.',
          false,
        );
        expect(jest.getTimerCount()).toBe(0);
        release({});
        await jest.advanceTimersByTimeAsync(0);
        expect(service.executeTask).not.toHaveBeenCalled();
        expect(service.completeTask).not.toHaveBeenCalled();
        if (blockedStep === 'resolve') expect(contextPlane.recordRunContext).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['queued', 'running'])(
    'keeps a %s core retry running while extension checks are terminal',
    async (status) => {
      const service = build();
      service.loadCompletionTasks = jest.fn().mockResolvedValue([
        { taskType: 'reconciliation', status: 'failed' },
        { taskType: 'completion_audit', status: 'completed' },
      ]);
      const result = await service.mergeRun(ctx, 'client-1', {
        id: 'run-1',
        status: 'partial',
        completedAt: '2026-09-09T00:00:00Z',
        tasks: [{ taskType: 'bill_tracker', status }],
        findings: [{ id: 'applied', status: 'accepted' }],
      });
      expect(result).toMatchObject({ status: 'running', stage: 'research', completedAt: null });
      expect(result.tasks).toHaveLength(3);
      expect(result.findings).toEqual([{ id: 'applied', status: 'accepted' }]);
    },
  );

  it('preserves cancellation even if a stale task snapshot is pending', async () => {
    const service = build();
    service.loadCompletionTasks = jest.fn().mockResolvedValue([{ status: 'queued' }]);
    expect(
      await service.mergeRun(ctx, 'client-1', { id: 'run-1', status: 'cancelled' }),
    ).toMatchObject({ status: 'cancelled', stage: 'cancelled' });
  });

  it('returns the complete review after delegating a core retry', async () => {
    const workflow = { retryTask: jest.fn().mockResolvedValue({ id: 'run-1', tasks: [] }) };
    const service = build(
      {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'run-1' }]),
        $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      },
      workflow,
    );
    service.requestTaskSweep = jest.fn();
    service.getRun = jest.fn().mockResolvedValue({ id: 'run-1', tasks: ['core', 'verification'] });
    expect(await service.retryTask(ctx, 'client-1', 'run-1', 'bill-task')).toEqual({
      id: 'run-1',
      tasks: ['core', 'verification'],
    });
    expect(workflow.retryTask).toHaveBeenCalledWith(ctx, 'client-1', 'run-1', 'bill-task');
  });

  it.each(['reconciliation', 'completion_audit'])(
    '%s defers while a core specialist is pending',
    async (taskType) => {
      const query = jest.fn().mockResolvedValue([{ pending: 1 }]);
      const service = build({ $queryRawUnsafe: query });
      await expect(
        service.assertCoreDependencies({ taskType, runId: 'run-1', tenantId: 'tenant-1' }),
      ).rejects.toThrow('Waiting for prerequisite Fill specialists');
      expect(query.mock.calls[0].slice(1)).toEqual(['run-1', 'tenant-1', [], true]);
    },
  );

  it('rechecks pending core tasks after selecting a finalization candidate', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql: string) =>
        sql.includes('UNION ALL')
          ? [{ status: 'queued' }, { status: 'failed' }, { status: 'completed' }]
          : [{ id: 'run-1', runId: 'run-1', tenantId: 'tenant-1' }],
      ),
      $executeRawUnsafe: jest.fn(),
    };
    await build(tx).finalizeRuns();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('reaches a terminal result when both task groups finish, preserving accepted findings', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        if (sql.includes('UNION ALL')) return [{ status: 'completed' }, { status: 'failed' }];
        if (sql.includes('GROUP BY kind'))
          return [{ kind: 'profile_field', state: 'accepted', count: 2 }];
        return [{ id: 'run-1', runId: 'run-1', tenantId: 'tenant-1' }];
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    await build(tx).finalizeRuns();
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const [, run, tenant, status, summary] = tx.$executeRawUnsafe.mock.calls[0];
    expect([run, tenant, status]).toEqual(['run-1', 'tenant-1', 'partial']);
    expect(JSON.parse(summary)).toMatchObject({ total: 2, byStatus: { accepted: 2 } });
  });
});
