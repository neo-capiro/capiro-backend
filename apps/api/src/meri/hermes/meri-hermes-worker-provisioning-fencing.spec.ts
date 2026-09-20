/**
 * Phase 1 required fix 2c — concurrent FIRST USE of a cold execution scope
 * must provision exactly ONE worker.
 *
 * The defect this proves fixed (documented in the service's own header until
 * now): `resolveWorker()` read `workerState`, saw "no worker", and
 * provisioned. Two concurrent first requests for the same scope therefore
 * each ran `RegisterTaskDefinition` + `RunTask`, producing two competing
 * Fargate workers for ONE execution scope — a direct violation of
 * single-writer-per-profile (two agents mounting the same EFS home, each
 * unaware of the other's writes) and a wasted task.
 *
 * Why this spec uses the REAL local Postgres rather than the in-memory fake
 * the rest of `meri-hermes-worker-lifecycle.service.spec.ts` uses: the fix IS
 * a `pg_advisory_xact_lock`. A fake `withTenant` that just invokes the
 * callback serializes nothing and would let a broken implementation pass. The
 * only thing that can prove this is two independent Prisma connections racing
 * against one database, which is what happens below.
 *
 * Runs against the LOCAL fixture database only; the tenant is a fresh
 * `randomUUID()` and is cascade-deleted in `afterAll`, so repeated runs are
 * idempotent and safe on a Postgres shared with other worktrees.
 */
import { randomUUID } from 'node:crypto';
import {
  CreateAccessPointCommand,
  DescribeAccessPointsCommand,
} from '@aws-sdk/client-efs';
import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesRunRepository } from './meri-hermes-run-store.js';
import {
  MeriHermesWorkerLifecycleService,
  type MeriHermesWorkerState,
} from './meri-hermes-worker-lifecycle.service.js';
import type { MeriHermesWorkerScopeRef } from './meri-hermes-worker-resolver.port.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-worker-provisioning-fencing.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-worker-provisioning-fencing.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

jest.setTimeout(60_000);

const SIGNING_KEY = 'x'.repeat(32);

function baseEnv(): NodeJS.ProcessEnv {
  return {
    MERI_HERMES_ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-test',
    MERI_HERMES_TASK_DEFINITION_FAMILY: 'capiro-test-meri-hermes-worker',
    MERI_HERMES_SUBNET_IDS: 'subnet-aaa,subnet-bbb',
    MERI_HERMES_SECURITY_GROUP_ID: 'sg-worker',
    MERI_HERMES_EFS_FILE_SYSTEM_ID: 'fs-123',
    MERI_HERMES_BROKER_SIGNING_KEY: SIGNING_KEY,
    MERI_HERMES_PROVISION_TIMEOUT_MS: '20000',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One shared, counting AWS fake for every replica in a test: the whole point
 * is to count calls ACROSS replicas, so they must share the counters exactly
 * as the real AWS account is shared.
 */
function awsFleetFake(opts: { runTaskDelayMs?: number } = {}) {
  const counts = { describeTaskDefinition: 0, registerTaskDefinition: 0, runTask: 0, describeTasks: 0, describeAccessPoints: 0, createAccessPoint: 0 };
  const ecs = {
    send: async (command: unknown) => {
      if (command instanceof DescribeTaskDefinitionCommand) {
        counts.describeTaskDefinition += 1;
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
            containerDefinitions: [{ name: 'hermes-worker', image: `repo@sha256:${'a'.repeat(64)}` }],
          },
        };
      }
      if (command instanceof RegisterTaskDefinitionCommand) {
        counts.registerTaskDefinition += 1;
        return {
          taskDefinition: {
            taskDefinitionArn: `arn:aws:ecs:us-east-1:000000000000:task-definition/scope-family:${counts.registerTaskDefinition}`,
          },
        };
      }
      if (command instanceof RunTaskCommand) {
        counts.runTask += 1;
        // A real RunTask + cold start is slow. Holding the winner here is what
        // gives every other caller time to reach the fence and (incorrectly,
        // if it were broken) decide to provision too.
        if (opts.runTaskDelayMs) await sleep(opts.runTaskDelayMs);
        return { tasks: [{ taskArn: `arn:aws:ecs:us-east-1:000000000000:task/worker-${counts.runTask}` }], failures: [] };
      }
      if (command instanceof DescribeTasksCommand) {
        counts.describeTasks += 1;
        return {
          tasks: [
            {
              lastStatus: 'RUNNING',
              attachments: [
                { type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: '10.0.9.9' }] },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected ECS command ${(command as { constructor?: { name?: string } })?.constructor?.name}`);
    },
  };
  const efs = {
    send: async (command: unknown) => {
      if (command instanceof DescribeAccessPointsCommand) {
        counts.describeAccessPoints += 1;
        return { AccessPoints: [] };
      }
      if (command instanceof CreateAccessPointCommand) {
        counts.createAccessPoint += 1;
        return { AccessPointId: `fsap-${counts.createAccessPoint}` };
      }
      throw new Error(`unexpected EFS command ${(command as { constructor?: { name?: string } })?.constructor?.name}`);
    },
  };
  return { counts, ecs, efs };
}

function healthyFetch(): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
}

describe('Hermes worker provisioning fence (real local Postgres)', () => {
  /** Independent connections = independent API replicas. */
  let prismas: PrismaService[];
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    prismas = [new PrismaService(), new PrismaService()];
    await Promise.all(prismas.map((p) => p.$connect()));
    tenantId = randomUUID();
    userId = randomUUID();
    await prismas[0]!.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-fence-${tenantId}`,
          name: 'Meri Hermes provisioning fence fixture',
          status: 'active',
        },
      });
    });
  });

  afterAll(async () => {
    await prismas[0]!.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await Promise.all(prismas.map((p) => p.$disconnect()));
  });

  function scopeRef(executionScopeId: string): MeriHermesWorkerScopeRef {
    return {
      tenantId,
      executionScopeId,
      actorType: 'user',
      actorId: userId,
      authorizationVersion: 'v1:fence',
    };
  }

  function makeService(
    prisma: PrismaService,
    aws: ReturnType<typeof awsFleetFake>,
  ): MeriHermesWorkerLifecycleService {
    const runs = { listActiveForScope: async () => [] } as unknown as MeriHermesRunRepository;
    const service = new MeriHermesWorkerLifecycleService(prisma, runs);
    service.env = baseEnv();
    service.ecs = aws.ecs;
    service.efs = aws.efs;
    service.fetchImpl = healthyFetch();
    service.pollIntervalMs = 10;
    return service;
  }

  async function readState(executionScopeId: string): Promise<MeriHermesWorkerState | null> {
    const row = await prismas[0]!.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.findUnique({ where: { id: executionScopeId }, select: { workerState: true } }),
    );
    const value = row?.workerState as Record<string, unknown> | undefined;
    return value && typeof value.status === 'string' ? (value as unknown as MeriHermesWorkerState) : null;
  }

  test('1. N concurrent first-use requests for one cold scope provision exactly ONE worker and all receive it', async () => {
    const executionScopeId = `tenant:${tenantId}:user:${userId}:cold`;
    const aws = awsFleetFake({ runTaskDelayMs: 250 });

    // Six callers spread across two independent replicas/connections — the
    // shape of two API tasks each handling concurrent first turns.
    const services = [
      makeService(prismas[0]!, aws),
      makeService(prismas[1]!, aws),
      makeService(prismas[0]!, aws),
      makeService(prismas[1]!, aws),
      makeService(prismas[0]!, aws),
      makeService(prismas[1]!, aws),
    ];

    const results = await Promise.all(services.map((service) => service.resolveWorker(scopeRef(executionScopeId))));

    // Exactly one of everything that creates or costs something.
    expect(aws.counts.runTask).toBe(1);
    expect(aws.counts.registerTaskDefinition).toBe(1);
    expect(aws.counts.createAccessPoint).toBe(1);

    // And every caller got the SAME worker, not just "a" worker.
    const urls = new Set(results.map((r) => r.url));
    expect(urls.size).toBe(1);
    expect([...urls][0]).toBe('http://10.0.9.9:8642');

    const state = await readState(executionScopeId);
    expect(state?.status).toBe('healthy');
    expect(state?.url).toBe('http://10.0.9.9:8642');
    expect(state?.taskArn).toBe('arn:aws:ecs:us-east-1:000000000000:task/worker-1');
  });

  test('2. a concurrent caller WAITS for the in-flight provisioner instead of starting a second worker', async () => {
    const executionScopeId = `tenant:${tenantId}:user:${userId}:wait`;
    const aws = awsFleetFake({ runTaskDelayMs: 400 });
    const first = makeService(prismas[0]!, aws);
    const second = makeService(prismas[1]!, aws);

    const firstCall = first.resolveWorker(scopeRef(executionScopeId));
    // Long enough that the claim is committed and the winner is inside RunTask.
    await sleep(120);
    const claimDuringProvisioning = await readState(executionScopeId);
    expect(claimDuringProvisioning?.status).toBe('provisioning');

    const secondCall = second.resolveWorker(scopeRef(executionScopeId));
    const [a, b] = await Promise.all([firstCall, secondCall]);

    expect(a.url).toBe(b.url);
    expect(aws.counts.runTask).toBe(1);
    expect(aws.counts.registerTaskDefinition).toBe(1);
  });

  test('3. an ABANDONED provisioning claim (the owning replica died) is taken over, not waited on forever', async () => {
    const executionScopeId = `tenant:${tenantId}:user:${userId}:abandoned`;
    const aws = awsFleetFake();
    const service = makeService(prismas[0]!, aws);

    // A claim written by a replica that then died: `provisioning`, far older
    // than the provisioning timeout plus its slack.
    const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await prismas[0]!.withTenant(tenantId, async (tx) => {
      await tx.meriExecutionScope.create({
        data: {
          id: executionScopeId,
          tenantId,
          principalType: 'user',
          principalId: userId,
          kind: 'private',
          authorizationVersion: 'v1:fence',
          workerState: {
            status: 'provisioning',
            taskArn: null,
            taskDefinitionArn: null,
            accessPointId: null,
            url: null,
            createdAt: longAgo,
            updatedAt: longAgo,
            lastHealthCheckAt: null,
            lastActivityAt: longAgo,
            lastError: null,
          },
        },
      });
    });

    const resolved = await service.resolveWorker(scopeRef(executionScopeId));

    expect(resolved.url).toBe('http://10.0.9.9:8642');
    expect(aws.counts.runTask).toBe(1);
    const state = await readState(executionScopeId);
    expect(state?.status).toBe('healthy');
  });

  test('4. a healthy cached worker is reused by concurrent callers with no AWS calls at all', async () => {
    const executionScopeId = `tenant:${tenantId}:user:${userId}:cached`;
    const warm = awsFleetFake();
    await makeService(prismas[0]!, warm).resolveWorker(scopeRef(executionScopeId));
    expect(warm.counts.runTask).toBe(1);

    const cold = awsFleetFake();
    const services = [makeService(prismas[0]!, cold), makeService(prismas[1]!, cold), makeService(prismas[0]!, cold)];
    const results = await Promise.all(services.map((s) => s.resolveWorker(scopeRef(executionScopeId))));

    expect(results.map((r) => r.url)).toEqual([
      'http://10.0.9.9:8642',
      'http://10.0.9.9:8642',
      'http://10.0.9.9:8642',
    ]);
    expect(cold.counts).toEqual({
      describeTaskDefinition: 0,
      registerTaskDefinition: 0,
      runTask: 0,
      describeTasks: 0,
      describeAccessPoints: 0,
      createAccessPoint: 0,
    });
  });
});
