import {
  CreateAccessPointCommand,
  DescribeAccessPointsCommand,
} from '@aws-sdk/client-efs';
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesRunRepository, MeriHermesRunRecord } from './meri-hermes-run-store.js';
import {
  MeriHermesWorkerLifecycleService,
  MeriHermesWorkerProvisioningTimeoutError,
  type MeriHermesWorkerState,
} from './meri-hermes-worker-lifecycle.service.js';
import type { MeriHermesWorkerScopeRef } from './meri-hermes-worker-resolver.port.js';

const SCOPE: MeriHermesWorkerScopeRef = {
  tenantId: 'tenant-1',
  executionScopeId: 'tenant:tenant-1:user:alice',
  actorType: 'user',
  actorId: 'alice',
  authorizationVersion: 'v1:abc123',
};

const SIGNING_KEY = 'x'.repeat(32);

const BASE_ENV: NodeJS.ProcessEnv = {
  MERI_HERMES_ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-test',
  MERI_HERMES_TASK_DEFINITION_FAMILY: 'capiro-test-meri-hermes-worker',
  MERI_HERMES_SUBNET_IDS: 'subnet-aaa,subnet-bbb',
  MERI_HERMES_SECURITY_GROUP_ID: 'sg-worker',
  MERI_HERMES_EFS_FILE_SYSTEM_ID: 'fs-123',
  MERI_HERMES_BROKER_SIGNING_KEY: SIGNING_KEY,
};

/** Minimal in-memory fake standing in for PrismaService's withTenant/withSystem + meriExecutionScope CRUD. */
function fakePrisma(seed: Record<string, { workerState?: unknown; tenantId?: string }> = {}) {
  const rows = new Map(Object.entries(seed));
  const tx = {
    meriExecutionScope: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = rows.get(id);
        return row ? { id, workerState: row.workerState ?? {}, tenantId: row.tenantId ?? 'tenant-1' } : null;
      },
      upsert: async ({
        where: { id },
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = rows.get(id);
        const row = existing ? { ...existing, ...update } : { workerState: {}, ...create };
        rows.set(id, row as { workerState?: unknown; tenantId?: string });
        return row;
      },
      update: async ({
        where: { id },
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const existing = rows.get(id) ?? {};
        const row = { ...existing, ...data };
        rows.set(id, row);
        return row;
      },
    },
    $queryRaw: async () => [] as unknown[],
    /**
     * `resolveWorker()` and `teardownIfIdle()` now take a per-scope
     * `pg_advisory_xact_lock` (Phase 1 required fix 2c). In this fake there
     * is no database and no concurrency, so the lock is a no-op — the REAL
     * serialization is proved against Postgres in
     * `meri-hermes-worker-provisioning-fencing.spec.ts`.
     */
    $executeRaw: async () => 0,
  };
  type FakeTx = typeof tx;
  return {
    rows,
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: FakeTx) => unknown) => fn(tx)),
    withSystem: jest.fn(async (fn: (tx: FakeTx) => unknown) => fn(tx)),
  };
}

function fakeRunRepository(active: MeriHermesRunRecord[] = []): MeriHermesRunRepository {
  return {
    listActiveForScope: jest.fn(async () => active),
  } as unknown as MeriHermesRunRepository;
}

function healthyFetch(): typeof fetch {
  return jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
}

function makeService(input: {
  env?: NodeJS.ProcessEnv;
  prisma?: ReturnType<typeof fakePrisma>;
  runs?: MeriHermesRunRepository;
}) {
  const prisma = input.prisma ?? fakePrisma();
  const runs = input.runs ?? fakeRunRepository();
  const service = new MeriHermesWorkerLifecycleService(prisma as unknown as PrismaService, runs);
  service.env = input.env ?? BASE_ENV;
  return { service, prisma, runs };
}

describe('MeriHermesWorkerLifecycleService.resolveWorker', () => {
  it('returns the cached URL and skips provisioning for a healthy cached worker', async () => {
    const state: MeriHermesWorkerState = {
      status: 'healthy',
      taskArn: 'arn:aws:ecs:us-east-1:000000000000:task/existing',
      taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/scope-family:1',
      accessPointId: 'fsap-existing',
      url: 'http://10.0.1.5:8642',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      lastHealthCheckAt: '2026-09-19T00:00:00.000Z',
      lastActivityAt: '2026-09-19T00:00:00.000Z',
      lastError: null,
    };
    const { service } = makeService({
      prisma: fakePrisma({ [SCOPE.executionScopeId]: { workerState: state, tenantId: SCOPE.tenantId } }),
    });
    const ecsSend = jest.fn();
    const efsSend = jest.fn();
    service.ecs = { send: ecsSend };
    service.efs = { send: efsSend };

    const result = await service.resolveWorker(SCOPE);

    expect(result).toEqual({ url: 'http://10.0.1.5:8642' });
    expect(ecsSend).not.toHaveBeenCalled();
    expect(efsSend).not.toHaveBeenCalled();
  });

  it('provisions a new worker end to end in the right order: access point -> task definition -> RunTask -> wait-healthy -> persist', async () => {
    const { service, prisma } = makeService({});
    const calls: string[] = [];

    const ecsSend = jest.fn(async (command: unknown) => {
      if (command instanceof DescribeTaskDefinitionCommand) {
        calls.push('ecs.describeTaskDefinition');
        return {
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/capiro-test-meri-hermes-worker:3',
            taskRoleArn: 'arn:aws:iam::000000000000:role/WorkerTaskRole',
            executionRoleArn: 'arn:aws:iam::000000000000:role/WorkerExecutionRole',
            networkMode: 'awsvpc',
            cpu: '1024',
            memory: '2048',
            requiresCompatibilities: ['FARGATE'],
            runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
            containerDefinitions: [{ name: 'hermes-worker', image: 'repo@sha256:' + 'a'.repeat(64) }],
          },
        };
      }
      if (command instanceof RegisterTaskDefinitionCommand) {
        calls.push('ecs.registerTaskDefinition');
        return {
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/capiro-test-meri-hermes-worker-scopehash:1',
          },
        };
      }
      if (command instanceof RunTaskCommand) {
        calls.push('ecs.runTask');
        // Capture the per-run overrides so we can assert the token/scope id were injected.
        (ecsSend as unknown as { lastRunTaskInput: unknown }).lastRunTaskInput = (
          command as unknown as { input: unknown }
        ).input;
        return { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:000000000000:task/newly-run' }], failures: [] };
      }
      if (command instanceof DescribeTasksCommand) {
        calls.push('ecs.describeTasks');
        return {
          tasks: [
            {
              lastStatus: 'RUNNING',
              attachments: [
                {
                  type: 'ElasticNetworkInterface',
                  details: [{ name: 'privateIPv4Address', value: '10.0.2.9' }],
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected ECS command ${command?.constructor?.name}`);
    });

    const efsSend = jest.fn(async (command: unknown) => {
      if (command instanceof DescribeAccessPointsCommand) {
        calls.push('efs.describeAccessPoints');
        return { AccessPoints: [] };
      }
      if (command instanceof CreateAccessPointCommand) {
        calls.push('efs.createAccessPoint');
        return { AccessPointId: 'fsap-new' };
      }
      throw new Error(`unexpected EFS command ${command?.constructor?.name}`);
    });

    service.ecs = { send: ecsSend };
    service.efs = { send: efsSend };
    const fetchSpy = jest.fn(async () => {
      calls.push('fetch.health');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    service.fetchImpl = fetchSpy;
    service.pollIntervalMs = 1;

    const result = await service.resolveWorker(SCOPE);

    expect(result).toEqual({ url: 'http://10.0.2.9:8642' });
    expect(calls).toEqual([
      'efs.describeAccessPoints',
      'efs.createAccessPoint',
      'ecs.describeTaskDefinition',
      'ecs.registerTaskDefinition',
      'ecs.runTask',
      'ecs.describeTasks',
      'fetch.health',
    ]);

    // The worker token was minted BEFORE RunTask and passed as a per-run
    // override, never baked into anything static.
    const runTaskInput = (ecsSend as unknown as { lastRunTaskInput: any }).lastRunTaskInput;
    const overrideEnv = runTaskInput.overrides.containerOverrides[0].environment as Array<{
      name: string;
      value: string;
    }>;
    const scopeIdVar = overrideEnv.find((e) => e.name === 'MERI_EXECUTION_SCOPE_ID');
    const tokenVar = overrideEnv.find((e) => e.name === 'MERI_WORKER_TOKEN');
    expect(scopeIdVar?.value).toBe(SCOPE.executionScopeId);
    expect(tokenVar?.value).toMatch(/^mhw1\./);
    expect(runTaskInput.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe('DISABLED');

    // Final state persisted onto MeriExecutionScope.workerState.
    const row = prisma.rows.get(SCOPE.executionScopeId) as { workerState: MeriHermesWorkerState };
    expect(row.workerState.status).toBe('healthy');
    expect(row.workerState.url).toBe('http://10.0.2.9:8642');
    expect(row.workerState.accessPointId).toBe('fsap-new');
  });

  it('surfaces a provisioning timeout as a clear typed error instead of hanging', async () => {
    const { service, prisma } = makeService({
      env: { ...BASE_ENV, MERI_HERMES_PROVISION_TIMEOUT_MS: '20' },
    });
    service.pollIntervalMs = 5;

    const ecsSend = jest.fn(async (command: unknown) => {
      if (command instanceof DescribeTaskDefinitionCommand) {
        return {
          taskDefinition: {
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/capiro-test-meri-hermes-worker:1',
            containerDefinitions: [{ name: 'hermes-worker' }],
          },
        };
      }
      if (command instanceof RegisterTaskDefinitionCommand) {
        return { taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:...:task-definition/scope:1' } };
      }
      if (command instanceof RunTaskCommand) {
        return { tasks: [{ taskArn: 'arn:aws:ecs:...:task/stuck' }], failures: [] };
      }
      if (command instanceof DescribeTasksCommand) {
        // Never reaches RUNNING or STOPPED -- forces the wait loop to time out.
        return { tasks: [{ lastStatus: 'PROVISIONING' }] };
      }
      throw new Error('unexpected ECS command');
    });
    const efsSend = jest.fn(async (command: unknown) => {
      if (command instanceof DescribeAccessPointsCommand) return { AccessPoints: [] };
      if (command instanceof CreateAccessPointCommand) return { AccessPointId: 'fsap-timeout' };
      throw new Error('unexpected EFS command');
    });
    service.ecs = { send: ecsSend };
    service.efs = { send: efsSend };
    service.fetchImpl = healthyFetch();

    await expect(service.resolveWorker(SCOPE)).rejects.toBeInstanceOf(MeriHermesWorkerProvisioningTimeoutError);

    const row = prisma.rows.get(SCOPE.executionScopeId) as { workerState: MeriHermesWorkerState };
    expect(row.workerState.status).toBe('failed');
    expect(row.workerState.lastError).toMatch(/Timed out/);
  }, 10_000);
});

describe('MeriHermesWorkerLifecycleService.teardownIfIdle', () => {
  function idleState(overrides: Partial<MeriHermesWorkerState> = {}): MeriHermesWorkerState {
    return {
      status: 'healthy',
      taskArn: 'arn:aws:ecs:us-east-1:000000000000:task/idle-worker',
      taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/scope:1',
      accessPointId: 'fsap-idle',
      url: 'http://10.0.3.1:8642',
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      lastHealthCheckAt: '2026-09-19T00:00:00.000Z',
      lastActivityAt: '2026-09-19T00:00:00.000Z', // far in the past relative to `now` below
      lastError: null,
      ...overrides,
    };
  }

  const NOW = new Date('2026-09-19T01:00:00.000Z'); // 1 hour after lastActivityAt

  it('stops the Fargate task for an idle scope with no active runs', async () => {
    const prisma = fakePrisma({ [SCOPE.executionScopeId]: { workerState: idleState(), tenantId: SCOPE.tenantId } });
    const runs = fakeRunRepository([]);
    const { service } = makeService({ prisma, runs });
    const stopSend = jest.fn(async (_command: unknown) => ({}));
    service.ecs = { send: stopSend };

    const outcome = await service.teardownIfIdle(
      { tenantId: SCOPE.tenantId, executionScopeId: SCOPE.executionScopeId },
      60_000, // 1 minute idle grace; lastActivityAt is 1 hour stale
      NOW,
    );

    expect(outcome).toBe('stopped');
    expect(stopSend).toHaveBeenCalledTimes(1);
    const stopCommand = stopSend.mock.calls[0]?.[0];
    expect(stopCommand).toBeInstanceOf(StopTaskCommand);
    const row = prisma.rows.get(SCOPE.executionScopeId) as { workerState: MeriHermesWorkerState };
    expect(row.workerState.status).toBe('stopped');
    expect(row.workerState.url).toBeNull();
  });

  it('leaves an idle scope alone when it still has an active run', async () => {
    const prisma = fakePrisma({ [SCOPE.executionScopeId]: { workerState: idleState(), tenantId: SCOPE.tenantId } });
    const runs = fakeRunRepository([{ runId: 'run-1' } as unknown as MeriHermesRunRecord]);
    const { service } = makeService({ prisma, runs });
    const stopSend = jest.fn(async (_command: unknown) => ({}));
    service.ecs = { send: stopSend };

    const outcome = await service.teardownIfIdle(
      { tenantId: SCOPE.tenantId, executionScopeId: SCOPE.executionScopeId },
      60_000,
      NOW,
    );

    expect(outcome).toBe('skipped_active');
    expect(stopSend).not.toHaveBeenCalled();
    const row = prisma.rows.get(SCOPE.executionScopeId) as { workerState: MeriHermesWorkerState };
    expect(row.workerState.status).toBe('healthy');
  });

  it('leaves a scope alone that has not been idle long enough', async () => {
    const recentState = idleState({ lastActivityAt: new Date(NOW.getTime() - 1_000).toISOString() });
    const prisma = fakePrisma({ [SCOPE.executionScopeId]: { workerState: recentState, tenantId: SCOPE.tenantId } });
    const { service } = makeService({ prisma, runs: fakeRunRepository([]) });
    const stopSend = jest.fn(async (_command: unknown) => ({}));
    service.ecs = { send: stopSend };

    const outcome = await service.teardownIfIdle(
      { tenantId: SCOPE.tenantId, executionScopeId: SCOPE.executionScopeId },
      60_000,
      NOW,
    );

    expect(outcome).toBe('skipped_not_idle');
    expect(stopSend).not.toHaveBeenCalled();
  });
});
