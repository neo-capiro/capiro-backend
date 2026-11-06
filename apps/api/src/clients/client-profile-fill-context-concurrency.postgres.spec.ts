import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { runWithFillTask } from './client-profile-fill-execution.js';
import { ClientProfileFillContextPlaneService } from './client-profile-fill-context-plane.service.js';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

(url ? describe : describe.skip)('profile context writers use one PostgreSQL lock order', () => {
  let store: Awaited<ReturnType<typeof reviewDatabase>>;
  let ctx: TenantContext, clientId: string, runId: string, taskIds: string[];
  beforeAll(async () => {
    store = await reviewDatabase(url!);
  }, 60_000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    clientId = randomUUID();
    runId = randomUUID();
    taskIds = [randomUUID(), randomUUID()];
    ctx = {
      tenantId,
      userId,
      tenantSlug: 'synthetic-' + tenantId,
      clerkUserId: 'synthetic-' + userId,
      role: 'user_admin',
    };
    await store.db.tenant.create({
      data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' },
    });
    await store.db.tenantMembership.create({
      data: { tenantId, userId, role: ctx.role, status: 'active' },
    });
    await store.db.client.create({
      data: { id: clientId, tenantId, name: 'Synthetic', status: 'active' },
    });
    await store.db.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_run (id,tenant_id,client_id,created_by_user_id,status,stage)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'running','research')`,
      runId,
      tenantId,
      clientId,
      userId,
    );
    for (const [index, id] of taskIds.entries())
      await store.db.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_task (id,run_id,tenant_id,client_id,task_type,task_key,status,worker_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'public_web',$5,'running','synthetic-lease')`,
        id,
        runId,
        tenantId,
        clientId,
        'source-' + index,
      );
  });

  const task = (index: number) => ({
    id: taskIds[index]!,
    runId,
    clientId,
    tenantId: ctx.tenantId,
    workerId: 'synthetic-lease',
  });
  const bundle = () => ({
    kind: 'synthetic',
    packetId: 'synthetic',
    traceHash: 'synthetic',
    canonicalClient: { id: clientId },
    coverage: {},
  });

  async function blockedBy(waiter: number, blocker: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await store.db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
        waiter,
        blocker,
      );
      if (row?.blocked) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('The synthetic second transaction did not reach the expected real lock wait');
  }

  function harness(pause: 'before-run-update' | 'after-run-lock') {
    const paused = barrier(),
      release = barrier(),
      secondStarted = barrier();
    const pids: number[] = [];
    let count = 0;
    const transaction = <T>(action: (tx: Prisma.TransactionClient) => Promise<T>) =>
      store.scoped.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
        const index = count++;
        const [row] = await tx.$queryRawUnsafe<Array<{ pid: number }>>(
          'SELECT pg_backend_pid() AS pid',
        );
        pids[index] = row!.pid;
        if (index === 1) secondStarted.resolve();
        const wrapped = new Proxy(tx, {
          get(target, name) {
            if (name === '$executeRawUnsafe')
              return async (sql: string, ...args: unknown[]) => {
                if (
                  index === 0 &&
                  pause === 'before-run-update' &&
                  /UPDATE client_profile_fill_run/.test(sql)
                ) {
                  paused.resolve();
                  await release.promise;
                }
                return target.$executeRawUnsafe(sql, ...args);
              };
            if (name === '$queryRawUnsafe')
              return async (sql: string, ...args: unknown[]) => {
                const result = await target.$queryRawUnsafe(sql, ...args);
                if (
                  index === 0 &&
                  pause === 'after-run-lock' &&
                  /FROM client_profile_fill_run/.test(sql) &&
                  /FOR (SHARE|UPDATE)/.test(sql)
                ) {
                  paused.resolve();
                  await release.promise;
                }
                return result;
              };
            const value = Reflect.get(target, name);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return action(wrapped);
      });
    const prisma = {
      withTenant: (_tenant: string, action: Parameters<typeof transaction>[0]) =>
        transaction(action),
      withSystem: transaction,
    } as unknown as PrismaService;
    const contexts = new ClientProfileFillContextPlaneService(prisma, {} as never);
    const write = (index: number) =>
      runWithFillTask(ctx, task(index), 'core', () =>
        contexts.recordRunContext(ctx, runId, bundle() as never),
      );
    const workflow = new ClientProfileFillWorkflowService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as {
      heartbeat(value: ReturnType<typeof task>, controller?: AbortController): Promise<void>;
    };
    return { paused, release, secondStarted, pids, write, workflow };
  }

  test('parallel source context writes commit without a shared-lock upgrade deadlock', async () => {
    const h = harness('before-run-update');
    const first = h.write(0);
    const pending: Promise<unknown>[] = [first];
    void first.catch(() => undefined);
    let second: Promise<void> | undefined;
    try {
      await Promise.race([h.paused.promise, first]);
      second = h.write(1);
      pending.push(second);
      void second.catch(() => undefined);
      await Promise.race([h.secondStarted.promise, second]);
      await blockedBy(h.pids[1]!, h.pids[0]!);
    } finally {
      h.release.resolve();
      await Promise.allSettled(pending);
    }
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    const [row] = await store.db.$queryRawUnsafe<Array<{ state: { status: string } }>>(
      "SELECT source_states_jsonb->'context_plane' AS state FROM client_profile_fill_run WHERE id=$1::uuid",
      runId,
    );
    expect(row!.state.status).toBe('completed');
  }, 15_000);

  test('a concurrent heartbeat waits on the run before taking the task lock', async () => {
    const h = harness('after-run-lock');
    const write = h.write(0);
    const pending: Promise<unknown>[] = [write];
    void write.catch(() => undefined);
    let heartbeat: Promise<void> | undefined;
    const controller = new AbortController();
    try {
      await Promise.race([h.paused.promise, write]);
      heartbeat = h.workflow.heartbeat(task(0), controller);
      pending.push(heartbeat);
      void heartbeat.catch(() => undefined);
      await Promise.race([h.secondStarted.promise, heartbeat]);
      await blockedBy(h.pids[1]!, h.pids[0]!);
    } finally {
      h.release.resolve();
      await Promise.allSettled(pending);
    }
    await expect(Promise.all([write, heartbeat])).resolves.toEqual([undefined, undefined]);
    expect(controller.signal.aborted).toBe(false);
  }, 15_000);
});
