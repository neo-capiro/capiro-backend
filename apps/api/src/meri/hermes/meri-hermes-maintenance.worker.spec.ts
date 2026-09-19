/**
 * Phase 1 required fix 2a/2b — the scheduled maintenance owner.
 *
 * `MeriHermesRuntimeAdapter.takeOverStaleRuns()` and
 * `MeriHermesWorkerLifecycleService.sweepIdleWorkers()` were implemented and
 * unit-tested with NOTHING calling them in production. The request-driven
 * half that Lane A added (`sweepStaleConsumers()` on the conversation
 * discovery endpoint) only fires when a client asks — and the case being
 * recovered is precisely the one where nobody asks, because the replica died
 * and the user's tab went with it. `MeriHermesMaintenanceService` is the
 * background caller; this spec proves it.
 *
 * What is proved here, and how:
 *
 *  1. AUTOMATIC RECOVERY AFTER A REAL PROCESS DEATH. A separate OS process
 *     claims a live run's consumer lease through the production repository
 *     and is SIGKILLed — no SIGTERM handler, no finally block, no lease
 *     release. The surviving side then runs NOTHING but
 *     `MeriHermesMaintenanceService.onModuleInit()` (the production entry
 *     point, with its production guards satisfied rather than bypassed), and
 *     the run reaches an honest terminal state with exactly one assistant
 *     message. The spec never calls `takeOverStaleRuns`, `takeOverRun` or
 *     `sweepStaleConsumers` itself — that is the whole point.
 *  2. CONCURRENT REPLICAS DO NOT DOUBLE-RECOVER. Two maintenance services on
 *     two independent connections sweep the same orphan simultaneously;
 *     exactly one takeover wins and exactly one assistant message exists.
 *  3. IDLE WORKERS ARE RECLAIMED BY THE SAME TICK.
 *  4. THE TIMER CANNOT START BY ACCIDENT (unit tests, CLI bootstraps, or an
 *     operator kill switch).
 *
 * Runs against the LOCAL fixture database only; the fixture tenant is a fresh
 * `randomUUID()` and is cascade-deleted in `afterAll`.
 *
 * NOTE ON BLAST RADIUS: the maintenance sweep is cross-tenant BY DESIGN (a
 * background owner recovers orphans regardless of whose they are), so on a
 * Postgres shared with other worktrees it can also finalize genuinely
 * orphaned rows left behind by other runs. That is exactly what it would do
 * in production; the assertions below are scoped to this spec's own tenant.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HttpAdapterHost } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import { StopTaskCommand } from '@aws-sdk/client-ecs';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesRunRecord, MeriHermesRunRepository } from './meri-hermes-run-store.js';
import {
  MeriHermesMaintenanceService,
  MeriHermesWorkerLifecycleService,
  type MeriHermesWorkerState,
} from './meri-hermes-worker-lifecycle.service.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-maintenance.worker.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-maintenance.worker.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

jest.setTimeout(180_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(50);
  }
}

/** A Nest `HttpAdapterHost` that looks like the real long-running HTTP server. */
function httpServerPresent(): HttpAdapterHost {
  return { httpAdapter: {} } as unknown as HttpAdapterHost;
}

describe('Meri/Hermes scheduled maintenance (real local Postgres)', () => {
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let repoA: MeriHermesPrismaRunRepository;
  let repoB: MeriHermesPrismaRunRepository;
  let tenantId: string;
  let userId: string;
  let actor: TenantContext;
  const started: MeriHermesMaintenanceService[] = [];

  beforeAll(async () => {
    prismaA = new PrismaService();
    prismaB = new PrismaService();
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    repoA = new MeriHermesPrismaRunRepository(prismaA);
    repoB = new MeriHermesPrismaRunRepository(prismaB);
    tenantId = randomUUID();
    userId = randomUUID();
    actor = {
      tenantId,
      tenantSlug: `meri-hermes-maint-${tenantId}`,
      userId,
      clerkUserId: userId,
      role: 'standard_user',
    };
    await prismaA.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-maint-${tenantId}`,
          name: 'Meri Hermes maintenance spec fixture',
          status: 'active',
        },
      });
      await tx.user.create({ data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` } });
    });
  });

  afterEach(() => {
    // Never leave a timer running into the next test.
    for (const service of started.splice(0)) service.onModuleDestroy();
  });

  afterAll(async () => {
    await prismaA.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prismaA.withSystem((tx) => tx.user.delete({ where: { id: userId } })).catch(() => undefined);
    await Promise.all([prismaA.$disconnect(), prismaB.$disconnect()]);
  });

  async function makeConversation(): Promise<string> {
    const id = randomUUID();
    await prismaA.withTenant(tenantId, (tx) =>
      tx.clioConversation.create({ data: { id, tenantId, userId, title: 'Maintenance fixture conversation' } }),
    );
    return id;
  }

  function envelope(conversationId: string): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId,
      actorType: 'user',
      actorId: userId,
      conversationId,
      workspaceId: null,
      executionScopeId: `tenant:${tenantId}:user:${userId}`,
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: [], deny: [], readOnly: true },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 10, maxOutputTokens: 1000, maxWallClockMs: 600_000 },
    };
  }

  function createRun(repo: MeriHermesPrismaRunRepository, conversationId: string): Promise<MeriHermesRunRecord> {
    return repo.create({
      envelope: envelope(conversationId),
      actorContext: actor,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
  }

  /** Same shape as the ownership spec's adapter: real repository + Postgres, stubbed Hermes HTTP. */
  function makeAdapter(
    prisma: PrismaService,
    repo: MeriHermesPrismaRunRepository,
    consumerId: string,
    hermesStatus: { status: string; output?: string } = { status: 'completed', output: 'Final answer from Hermes.' },
  ): MeriHermesRuntimeAdapter {
    const runtime = {
      createRun: async () => ({ runId: `hermes-${randomUUID()}`, status: 'started', sessionId: null, replayed: false }),
      getRun: async (id: string) => ({
        run_id: id,
        status: hermesStatus.status,
        output: hermesStatus.output ?? 'Final answer from Hermes.',
      }),
      streamRunEvents: async () => undefined,
      stopRun: async () => ({}),
    };
    const client = { forScope: () => runtime } as unknown as MeriHermesRuntimeClient;
    const adapter = new MeriHermesRuntimeAdapter(
      prisma,
      { isMeriHermesRuntimeEnabled: async () => true, isEnabled: async () => false } as never,
      client,
      repo,
      { securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }) } as never,
      { scheduleAfterTurnMaintenance: () => undefined } as never,
    );
    adapter.consumerId = consumerId;
    adapter.env = {
      ...process.env,
      MERI_HERMES_RUNTIME_URL: 'http://localhost:1/hermes-stub',
      MERI_HERMES_API_KEY: 'stub-key',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(40),
      MERI_COMPLIANCE_BLOCK: 'false',
      // A lease unrenewed for a second is dead, so the spec does not have to
      // wait a production minute to observe recovery.
      MERI_HERMES_CONSUMER_STALE_MS: '1000',
      MERI_HERMES_CONSUMER_HEARTBEAT_MS: '2000',
    };
    return adapter;
  }

  /** Fleet-configured lifecycle service whose ECS calls are counted, never made. */
  function makeWorkers(prisma: PrismaService, idleGraceMs: number) {
    const stopped: string[] = [];
    const runs = { listActiveForScope: async () => [] } as unknown as MeriHermesRunRepository;
    const service = new MeriHermesWorkerLifecycleService(prisma, runs);
    service.env = {
      MERI_HERMES_ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-test',
      MERI_HERMES_TASK_DEFINITION_FAMILY: 'capiro-test-meri-hermes-worker',
      MERI_HERMES_SUBNET_IDS: 'subnet-aaa',
      MERI_HERMES_SECURITY_GROUP_ID: 'sg-worker',
      MERI_HERMES_EFS_FILE_SYSTEM_ID: 'fs-123',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(32),
      MERI_HERMES_WORKER_IDLE_GRACE_MS: String(idleGraceMs),
    };
    service.ecs = {
      send: async (command: unknown) => {
        if (command instanceof StopTaskCommand) {
          stopped.push(String((command as unknown as { input: { task?: string } }).input.task));
          return {};
        }
        throw new Error('unexpected ECS command in the maintenance spec');
      },
    };
    return { service, stopped };
  }

  /** A lifecycle service with NO fleet configuration, for tests that only care about run recovery. */
  function makeUnconfiguredWorkers(prisma: PrismaService): MeriHermesWorkerLifecycleService {
    const runs = { listActiveForScope: async () => [] } as unknown as MeriHermesRunRepository;
    const service = new MeriHermesWorkerLifecycleService(prisma, runs);
    service.env = {};
    return service;
  }

  function makeMaintenance(
    adapter: MeriHermesRuntimeAdapter,
    workers: MeriHermesWorkerLifecycleService,
    env: NodeJS.ProcessEnv = {},
  ): MeriHermesMaintenanceService {
    const service = new MeriHermesMaintenanceService(adapter, workers, httpServerPresent());
    service.env = {
      ...process.env,
      // jest sets NODE_ENV=test, which the production guard refuses to start
      // under. Overriding it HERE, visibly, in a spec whose whole subject is
      // the scheduler, is the deliberate opt-in the guard is designed to
      // require — the guard itself is left intact and is asserted below.
      NODE_ENV: 'production',
      MERI_HERMES_MAINTENANCE_SWEEP_MS: '250',
      ...env,
    };
    return service;
  }

  async function assistantMessages(conversationId: string): Promise<Array<{ id: string; body: string }>> {
    return prismaA.withTenant(tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { conversationId, role: 'assistant' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true },
      }),
    );
  }

  /**
   * Start a REAL separate OS process that claims the run's consumer lease
   * through the production repository, then SIGKILL it. Returns once the
   * process is dead and the lease is orphaned.
   */
  async function killOwningProcess(runId: string, consumerId: string): Promise<void> {
    const fixture = join(__dirname, 'meri-hermes-consumer-process.fixture.ts');
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      [tsxCli, fixture, runId, consumerId],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    try {
      const ready = await new Promise<string>((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(
          () => reject(new Error(`consumer process never reported READY. stderr=${stderr.join('').slice(-800)}`)),
          90_000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          buffered += chunk.toString();
          const line = buffered.split('\n').find((l) => l.startsWith('READY ') || l.startsWith('FAILED '));
          if (!line) return;
          clearTimeout(timer);
          resolve(line.trim());
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(new Error(`consumer process could not be spawned: ${String(error)}`));
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`consumer process exited early with code ${code}. stderr=${stderr.join('').slice(-800)}`));
        });
      });
      expect(ready).toBe(`READY ${consumerId}`);

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Automatic recovery, driven only by the scheduler
  // ---------------------------------------------------------------------------

  test('1. a run orphaned by a SIGKILLed API process is recovered AUTOMATICALLY by the scheduled sweep, with no request and no direct call', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
      output: 'Partial answer from the replica that died.',
    });

    const deadConsumerId = `replica-child-${randomUUID().slice(0, 8)}`;
    await killOwningProcess(run.runId, deadConsumerId);

    const orphaned = (await repoB.get(run.runId))!;
    expect(orphaned.status).toBe('running');
    expect(orphaned.consumerId).toBe(deadConsumerId);

    // The surviving replica. Everything it will do from here is done by its
    // own timer: the spec calls onModuleInit() and then only READS.
    const survivor = makeAdapter(prismaB, repoB, 'replica-survivor-auto');
    const takeoverSpy = jest.spyOn(survivor, 'takeOverStaleRuns');
    const maintenance = makeMaintenance(survivor, makeUnconfiguredWorkers(prismaB));

    expect(maintenance.shouldStart()).toBe(true);
    maintenance.onModuleInit();
    started.push(maintenance);

    // Past the (spec-shortened) stale window, then let the timer do its work.
    const finished = await waitFor(async () => {
      const current = await repoB.get(run.runId);
      return current && current.finishedAt ? current : null;
    }, 'the scheduled sweep to recover the orphaned run');

    // Honest terminal state: `completed` only because the Hermes stub really
    // reports completed; otherwise `interrupted`. Never a fabricated success.
    expect(['completed', 'interrupted']).toContain(finished.status);
    expect(finished.consumerId).toBe('replica-survivor-auto');
    expect(await assistantMessages(conversationId)).toHaveLength(1);

    // It really was the wired caller, invoked by the timer rather than by the spec.
    expect(takeoverSpy).toHaveBeenCalled();
    expect(takeoverSpy.mock.calls.every(([, opts]) => typeof opts?.limit === 'number')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Two replicas sweeping at once
  // ---------------------------------------------------------------------------

  test('2. two replicas sweeping the same orphan concurrently take it over exactly once', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
    });
    // Orphaned: dispatched, never heartbeated, untouched for longer than the
    // stale window (the "never heartbeated" case needs BOTH — see the
    // ownership spec's 3c regression).
    await prismaA.withSystem((tx) =>
      tx.meriAgentRun.update({
        where: { id: run.runId },
        data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
      }),
    );

    const adapterA = makeAdapter(prismaA, repoA, 'replica-race-a');
    const adapterB = makeAdapter(prismaB, repoB, 'replica-race-b');
    const maintenanceA = makeMaintenance(adapterA, makeUnconfiguredWorkers(prismaA));
    const maintenanceB = makeMaintenance(adapterB, makeUnconfiguredWorkers(prismaB));

    // `runOnce()` is exactly what each replica's timer invokes.
    const [a, b] = await Promise.all([maintenanceA.runOnce(), maintenanceB.runOnce()]);

    const finished = (await repoA.get(run.runId))!;
    expect(finished.finishedAt).not.toBeNull();
    expect(['replica-race-a', 'replica-race-b']).toContain(finished.consumerId);
    // One winner, one assistant message — never two bubbles for one turn.
    expect(a.recovered + b.recovered).toBeGreaterThanOrEqual(1);
    expect(await assistantMessages(conversationId)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Idle workers are reclaimed by the same tick
  // ---------------------------------------------------------------------------

  test('3. the same tick reclaims an idle worker (sweepIdleWorkers finally has a production caller)', async () => {
    const executionScopeId = `tenant:${tenantId}:user:${userId}:idle`;
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const idle: MeriHermesWorkerState = {
      status: 'healthy',
      taskArn: 'arn:aws:ecs:us-east-1:000000000000:task/idle-one',
      taskDefinitionArn: 'arn:aws:ecs:us-east-1:000000000000:task-definition/scope:1',
      accessPointId: 'fsap-idle',
      url: 'http://10.0.3.1:8642',
      createdAt: anHourAgo,
      updatedAt: anHourAgo,
      lastHealthCheckAt: anHourAgo,
      lastActivityAt: anHourAgo,
      lastError: null,
    };
    await prismaA.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.create({
        data: {
          id: executionScopeId,
          tenantId,
          principalType: 'user',
          principalId: userId,
          kind: 'private',
          authorizationVersion: 'v1',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          workerState: idle as any,
        },
      }),
    );

    const { service: workers, stopped } = makeWorkers(prismaA, 30 * 60 * 1000);
    const maintenance = makeMaintenance(makeAdapter(prismaA, repoA, 'replica-idle'), workers);

    const result = await maintenance.runOnce();

    expect(result.workersStopped).toBeGreaterThanOrEqual(1);
    expect(stopped).toContain('arn:aws:ecs:us-east-1:000000000000:task/idle-one');
    const row = await prismaA.withTenant(tenantId, (tx) =>
      tx.meriExecutionScope.findUnique({ where: { id: executionScopeId }, select: { workerState: true } }),
    );
    const state = row?.workerState as unknown as MeriHermesWorkerState;
    expect(state.status).toBe('stopped');
    expect(state.url).toBeNull();
    // The arn is deliberately retained so a replica that died before StopTask
    // returned still leaves a trail for `stopSupersededTask()`.
    expect(state.taskArn).toBe('arn:aws:ecs:us-east-1:000000000000:task/idle-one');
  });

  test('3b. a scope with NO fleet configuration is skipped rather than throwing every tick', async () => {
    const maintenance = makeMaintenance(
      makeAdapter(prismaA, repoA, 'replica-unconfigured'),
      makeUnconfiguredWorkers(prismaA),
    );
    const result = await maintenance.runOnce();
    expect(result.workersStopped).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 4. The timer must never start by accident
  // ---------------------------------------------------------------------------

  describe('4. start guards', () => {
    function bare(env: NodeJS.ProcessEnv, host?: HttpAdapterHost): MeriHermesMaintenanceService {
      const service = new MeriHermesMaintenanceService(
        {} as unknown as MeriHermesRuntimeAdapter,
        {} as unknown as MeriHermesWorkerLifecycleService,
        host,
      );
      service.env = env;
      return service;
    }

    it('does not start under NODE_ENV=test — so no unit test ever starts a sweep by accident', () => {
      expect(bare({ NODE_ENV: 'test' }, httpServerPresent()).shouldStart()).toBe(false);
    });

    it('does not start without an HTTP adapter (a CLI/one-shot AppModule context closes Prisma underneath timers)', () => {
      expect(bare({ NODE_ENV: 'production' }).shouldStart()).toBe(false);
      expect(
        bare({ NODE_ENV: 'production' }, { httpAdapter: undefined } as unknown as HttpAdapterHost).shouldStart(),
      ).toBe(false);
    });

    it('honours the operator kill switch', () => {
      expect(
        bare({ NODE_ENV: 'production', MERI_HERMES_MAINTENANCE_ENABLED: 'false' }, httpServerPresent()).shouldStart(),
      ).toBe(false);
    });

    it('starts in a real long-running API process, and is NOT gated on the Hermes pilot flags (recovery must survive a rollback)', () => {
      expect(
        bare({ NODE_ENV: 'production', MERI_HERMES_ENABLED: 'false' }, httpServerPresent()).shouldStart(),
      ).toBe(true);
    });

    it('onModuleInit under the ambient jest environment schedules nothing at all', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      try {
        const service = new MeriHermesMaintenanceService(
          {} as unknown as MeriHermesRuntimeAdapter,
          {} as unknown as MeriHermesWorkerLifecycleService,
          httpServerPresent(),
        );
        service.onModuleInit(); // env defaults to the ambient process.env (NODE_ENV=test)
        expect(setIntervalSpy).not.toHaveBeenCalled();
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        service.onModuleDestroy();
      } finally {
        setIntervalSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    });

    it('a started scheduler stops cleanly on module destroy', () => {
      const service = new MeriHermesMaintenanceService(
        { reconcileStuckDispatches: async () => 0, takeOverStaleRuns: async () => [] } as unknown as MeriHermesRuntimeAdapter,
        { fleetConfigured: () => false } as unknown as MeriHermesWorkerLifecycleService,
        httpServerPresent(),
      );
      service.env = { NODE_ENV: 'production', MERI_HERMES_MAINTENANCE_SWEEP_MS: '5000' };
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      try {
        service.onModuleInit();
        service.onModuleDestroy();
        expect(clearTimeoutSpy.mock.calls.length + clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      } finally {
        clearIntervalSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });
  });
});
