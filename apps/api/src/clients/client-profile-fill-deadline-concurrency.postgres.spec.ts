import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { assertFillExecution, runWithFillTask } from './client-profile-fill-execution.js';
import { expireFillRuns } from './client-profile-fill-run-deadline.js';
import { queueFailedFillTask } from './client-profile-fill-retry.js';
import { ClientProfileFillTaskLedger } from './client-profile-fill-task-ledger.js';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';

// DB-owner-only execution. The existing fixture additionally restricts the URL
// to its disposable enrichment database, port and administrator. No fallback.
const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
const tables = ['client_profile_fill_task', 'client_profile_fill_extension_task'] as const;
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

(url ? describe : describe.skip)('Fill deadline multi-connection PostgreSQL admission', () => {
  let store: Awaited<ReturnType<typeof reviewDatabase>>;
  let ctx: TenantContext;
  let runId: string, clientId: string, taskId: string;
  let system: PrismaService;
  beforeAll(async () => {
    store = await reviewDatabase(url!);
  }, 60_000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });

  async function ordinary<T>(action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return store.db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.$executeRaw`SELECT set_config('app.current_tenant',${ctx.tenantId},true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user',${ctx.userId},true)`;
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '12s'");
        const roles = await tx.$queryRawUnsafe<
          Array<{ role: string; superuser: boolean; bypass: boolean }>
        >(
          'SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user',
        );
        expect(roles).toEqual([{ role: 'capiro_app', superuser: false, bypass: false }]);
        return action(tx);
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
  }

  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    runId = randomUUID();
    clientId = randomUUID();
    taskId = randomUUID();
    ctx = {
      tenantId,
      userId,
      tenantSlug: `synthetic-${tenantId}`,
      clerkUserId: `synthetic-${userId}`,
      role: 'user_admin',
    };
    await store.db.tenant.create({
      data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic deadline', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: ctx.clerkUserId, email: `${userId}@example.invalid` },
    });
    await store.db.tenantMembership.create({
      data: { tenantId, userId, role: ctx.role, status: 'active' },
    });
    await store.db.client.create({
      data: { id: clientId, tenantId, name: 'Synthetic deadline', status: 'active' },
    });
    await store.db.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_run
      (id,tenant_id,client_id,created_by_user_id,workflow_version,status,stage)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,2,'running','research')`,
      runId,
      tenantId,
      clientId,
      userId,
    );
    for (const table of tables)
      await store.db.$executeRawUnsafe(
        `INSERT INTO ${table}
        (id,run_id,tenant_id,client_id,task_type,task_key,status,worker_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,'running','original-lease')`,
        taskId,
        runId,
        tenantId,
        clientId,
        table === tables[0] ? 'public_web' : 'district_nexus',
      );
    await ordinary((tx) => insertFinding(tx, true));
    // Real ordinary-role PostgreSQL transactions; only system-sweep scope is
    // narrowed to this synthetic tenant. No production Prisma owner is replaced.
    system = { withSystem: ordinary } as unknown as PrismaService;
  });

  afterEach(async () => {
    // Delete only this test's generated identities; never reset the shared
    // fixture/schema. The DB owner still supervises cleanup after process death.
    if (!ctx) return;
    await store.db.$transaction(
      async (tx) => {
        for (const table of ['client_profile_fill_finding', ...tables])
          await tx.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id=$1::uuid AND run_id=$2::uuid`,
            ctx.tenantId,
            runId,
          );
        await tx.$executeRawUnsafe(
          'DELETE FROM client_profile_fill_run WHERE tenant_id=$1::uuid AND id=$2::uuid',
          ctx.tenantId,
          runId,
        );
        await tx.tenantMembership.deleteMany({
          where: { tenantId: ctx.tenantId, userId: ctx.userId },
        });
        await tx.client.deleteMany({ where: { id: clientId, tenantId: ctx.tenantId } });
        await tx.tenant.deleteMany({ where: { id: ctx.tenantId } });
        await tx.user.deleteMany({ where: { id: ctx.userId } });
        expect(await tx.tenant.count({ where: { id: ctx.tenantId } })).toBe(0);
        expect(await tx.user.count({ where: { id: ctx.userId } })).toBe(0);
        for (const table of ['client_profile_fill_finding', ...tables, 'client_profile_fill_run']) {
          const rows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
            `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1::uuid`,
            ctx.tenantId,
          );
          expect(rows[0]?.count).toBe(0);
        }
      },
      { timeout: 15_000 },
    );
  });

  async function insertFinding(tx: Prisma.TransactionClient, accepted: boolean) {
    return tx.$executeRawUnsafe(
      `INSERT INTO client_profile_fill_finding
      (run_id,tenant_id,client_id,kind,target_key,source,proposed_value_jsonb,confidence,status,
       content_hash,reviewed_by,reviewed_at,applied_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,'profile_field','description','public_web','"Synthetic"'::jsonb,1,
        $4,$5,CASE WHEN $6 THEN $7::uuid ELSE NULL END,
        CASE WHEN $6 THEN now() ELSE NULL END,CASE WHEN $6 THEN now() ELSE NULL END)`,
      runId,
      ctx.tenantId,
      clientId,
      accepted ? 'accepted' : 'pending',
      (accepted ? 'a' : 'b').repeat(64),
      accepted,
      ctx.userId,
    );
  }
  const identity = () => ({
    id: taskId,
    runId,
    tenantId: ctx.tenantId,
    clientId,
    workerId: 'original-lease',
  });
  const accepted = () =>
    ordinary((tx) =>
      tx.$queryRawUnsafe(
        "SELECT * FROM client_profile_fill_finding WHERE run_id=$1::uuid AND status='accepted' ORDER BY id",
        runId,
      ),
    );
  const snapshot = () =>
    ordinary(async (tx) => ({
      run: await tx.$queryRawUnsafe(
        'SELECT status,error,started_at FROM client_profile_fill_run WHERE id=$1::uuid',
        runId,
      ),
      tasks: await tx.$queryRawUnsafe(
        `SELECT 'core' AS family,status,worker_id,output_summary_jsonb FROM ${tables[0]} WHERE run_id=$1::uuid
      UNION ALL SELECT 'extension',status,worker_id,output_summary_jsonb FROM ${tables[1]} WHERE run_id=$1::uuid ORDER BY family`,
        runId,
      ),
    }));
  async function nearDeadline() {
    await ordinary((tx) =>
      tx.$executeRawUnsafe(
        "UPDATE client_profile_fill_run SET started_at=clock_timestamp()-interval '25 minutes'-interval '295 seconds' WHERE id=$1::uuid",
        runId,
      ),
    );
  }
  async function expiredNow() {
    await ordinary((tx) =>
      tx.$executeRawUnsafe(
        "UPDATE client_profile_fill_run SET started_at=clock_timestamp()-interval '31 minutes' WHERE id=$1::uuid",
        runId,
      ),
    );
  }
  async function until(check: () => Promise<boolean>, label: string) {
    const limit = Date.now() + 8_000;
    while (Date.now() < limit) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Missing database observation: ${label}`);
  }
  const deadlinePassed = () =>
    until(async () => {
      const rows = await store.db.$queryRawUnsafe<Array<{ expired: boolean }>>(
        "SELECT started_at+interval '30 minutes' <= clock_timestamp() AS expired FROM client_profile_fill_run WHERE id=$1::uuid",
        runId,
      );
      return rows[0]?.expired === true;
    }, 'original deadline passed');
  const blockedBy = (waiter: number, holder: number) =>
    until(async () => {
      const rows = await store.db.$queryRawUnsafe<Array<{ blocked: boolean }>>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
        waiter,
        holder,
      );
      return rows[0]?.blocked === true;
    }, 'waiter blocked by expiry transaction');
  async function pid(tx: Prisma.TransactionClient) {
    return (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!
      .pid;
  }
  async function assertExpired(
    saved: unknown,
    outcome: Record<string, string> = { externalOutcome: 'unresolved' },
  ) {
    const state = await snapshot();
    expect(state.run).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('deadline exceeded'),
      }),
    ]);
    expect(state.tasks).toEqual(
      ['core', 'extension'].map((family) => ({
        family,
        status: 'failed',
        worker_id: null,
        output_summary_jsonb: outcome,
      })),
    );
    expect(await accepted()).toEqual(saved);
  }
  async function denyWriter(kind: 'core' | 'extension') {
    await expect(
      runWithFillTask(ctx, identity(), kind, () =>
        ordinary(async (tx) => {
          await assertFillExecution(tx, ctx.tenantId, clientId, runId);
          await insertFinding(tx, false);
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  }

  test.each(['core', 'extension'] as const)(
    'expiry skips an admitted %s writer, then fences subsequent admission',
    async (kind) => {
      const saved = await accepted(),
        admitted = barrier(),
        release = barrier();
      await nearDeadline();
      const writer = runWithFillTask(ctx, identity(), kind, () =>
        ordinary(async (tx) => {
          await assertFillExecution(tx, ctx.tenantId, clientId, runId);
          admitted.resolve();
          await release.promise;
          // This admitted transaction may commit after the deadline; expiry is not
          // evidence of physical cessation or retroactive transaction cancellation.
          await insertFinding(tx, false);
        }),
      );
      try {
        await Promise.race([
          admitted.promise,
          writer.then(() => {
            throw Error('Writer ended before admission barrier');
          }),
        ]);
        await deadlinePassed();
        await expireFillRuns(system);
        expect((await snapshot()).tasks).toEqual(
          ['core', 'extension'].map((family) => ({
            family,
            status: 'running',
            worker_id: 'original-lease',
            output_summary_jsonb: {},
          })),
        );
      } finally {
        release.resolve();
        await writer;
      }
      await expireFillRuns(system);
      await assertExpired(saved);
      await denyWriter(kind);
    },
    30_000,
  );

  test('waiting writer and retry recheck admission after expiry wins the run lock', async () => {
    const saved = await accepted(),
      locked = barrier<number>(),
      release = barrier();
    const writerPid = barrier<number>(),
      retryPid = barrier<number>();
    await nearDeadline();
    const expiry = ordinary(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM client_profile_fill_run WHERE id=$1::uuid FOR UPDATE',
        runId,
      );
      locked.resolve(await pid(tx));
      await release.promise;
      await expireFillRuns({
        withSystem: (action: (value: Prisma.TransactionClient) => Promise<void>) => action(tx),
      } as PrismaService);
    });
    const holder = await Promise.race([
      locked.promise,
      expiry.then(() => {
        throw Error('Expiry ended before lock barrier');
      }),
    ]);
    const writer = runWithFillTask(ctx, identity(), 'core', () =>
      ordinary(async (tx) => {
        writerPid.resolve(await pid(tx));
        await assertFillExecution(tx, ctx.tenantId, clientId, runId);
        await insertFinding(tx, false);
      }),
    );
    const refused = expect(writer).rejects.toMatchObject({ status: 409 });
    const retry = ordinary(async (tx) => {
      retryPid.resolve(await pid(tx));
      // Existing retry ordering: acquire scoped run lock before failed-to-queued
      // CAS. The helper must refuse even though expiry has made the task failed.
      await tx.$queryRawUnsafe(
        'SELECT id FROM client_profile_fill_run WHERE id=$1::uuid FOR UPDATE',
        runId,
      );
      return queueFailedFillTask(tx, 'core', ctx.tenantId, clientId, runId, taskId);
    });
    try {
      await blockedBy(
        await Promise.race([
          writerPid.promise,
          writer.then(() => {
            throw Error('Writer ended before PID barrier');
          }),
        ]),
        holder,
      );
      await blockedBy(
        await Promise.race([
          retryPid.promise,
          retry.then(() => {
            throw Error('Retry ended before PID barrier');
          }),
        ]),
        holder,
      );
      await deadlinePassed();
    } finally {
      release.resolve();
      await expiry;
    }
    await refused;
    expect(await retry).toBe(0);
    await assertExpired(saved);
  }, 30_000);

  test('both ledgers publish atomically and neither claim family admits work during expiry', async () => {
    const saved = await accepted(),
      coreWritten = barrier(),
      release = barrier();
    await ordinary(async (tx) => {
      for (const table of tables)
        await tx.$executeRawUnsafe(
          `UPDATE ${table} SET status='queued',worker_id=NULL WHERE run_id=$1::uuid`,
          runId,
        );
    });
    await expiredNow();
    const ledger = new ClientProfileFillTaskLedger(system, 'claim-racer', { safeError: String });
    const core = new ClientProfileFillWorkflowService(
      system,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as { claimTasks(): Promise<unknown[]> };
    expect(await core.claimTasks()).toEqual([]);
    expect(await ledger.claimTasks()).toEqual([]);
    const expiry = expireFillRuns({
      withSystem: (action: (tx: Prisma.TransactionClient) => Promise<void>) =>
        ordinary((tx) =>
          action(
            new Proxy(tx, {
              get(target, property) {
                if (property === '$executeRawUnsafe')
                  return async (sql: string, ...args: unknown[]) => {
                    const result = await target.$executeRawUnsafe(sql, ...args);
                    if (sql.includes(`UPDATE ${tables[0]}\n`)) {
                      coreWritten.resolve();
                      await release.promise;
                    }
                    return result;
                  };
                return Reflect.get(target, property);
              },
            }),
          ),
        ),
    } as PrismaService);
    try {
      await Promise.race([
        coreWritten.promise,
        expiry.then(() => {
          throw Error('Expiry ended before first-ledger barrier');
        }),
      ]);
      // A separate connection must still see BOTH old ledgers before commit.
      expect((await snapshot()).tasks).toEqual(
        ['core', 'extension'].map((family) => ({
          family,
          status: 'queued',
          worker_id: null,
          output_summary_jsonb: {},
        })),
      );
      expect(await core.claimTasks()).toEqual([]);
      expect(await ledger.claimTasks()).toEqual([]);
    } finally {
      release.resolve();
      await expiry;
    }
    await assertExpired(saved, {});
  }, 30_000);

  test('a real second-ledger SQL error rolls back both ledgers and run state before a fresh sweep', async () => {
    const saved = await accepted();
    await expiredNow();
    const before = await snapshot();
    let coreWrites = 0;
    await expect(
      expireFillRuns({
        withSystem: (action: (tx: Prisma.TransactionClient) => Promise<void>) =>
          ordinary((tx) =>
            action(
              new Proxy(tx, {
                get(target, property) {
                  if (property === '$executeRawUnsafe')
                    return async (sql: string, ...args: unknown[]) => {
                      // SQLSTATE 22012 occurs inside the real second ledger UPDATE, after
                      // the first UPDATE has executed in the same database transaction.
                      if (sql.includes(`UPDATE ${tables[1]}\n`))
                        sql = sql.replace(
                          "SET status = 'failed'",
                          "SET max_attempts = 1 / 0, status = 'failed'",
                        );
                      const result = await target.$executeRawUnsafe(sql, ...args);
                      if (sql.includes(`UPDATE ${tables[0]}\n`)) coreWrites++;
                      return result;
                    };
                  return Reflect.get(target, property);
                },
              }),
            ),
          ),
      } as PrismaService),
    ).rejects.toMatchObject({ code: 'P2010', meta: expect.objectContaining({ code: '22012' }) });
    expect(coreWrites).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await accepted()).toEqual(saved);
    await denyWriter('extension');
    await expireFillRuns(system);
    await assertExpired(saved);
  }, 30_000);
});
