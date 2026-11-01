import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import {
  retryResearchTask,
  type ResearchRetryCommand,
} from './client-profile-fill-retry-command.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'exact task retry through current authority and ordinary PostgreSQL',
  () => {
    let store: Awaited<ReturnType<typeof reviewDatabase>>;
    let ctx: TenantContext, clientId: string, runId: string, coreId: string, extensionId: string;
    let command: ResearchRetryCommand;
    beforeAll(async () => {
      store = await reviewDatabase(url!);
    }, 60000);
    afterAll(async () => {
      await store?.db.$disconnect();
    });
    beforeEach(async () => {
      const tenantId = randomUUID(),
        userId = randomUUID();
      clientId = randomUUID();
      runId = randomUUID();
      coreId = randomUUID();
      extensionId = randomUUID();
      ctx = {
        tenantId,
        userId,
        tenantSlug: 'synthetic-' + tenantId,
        clerkUserId: 'synthetic-' + userId,
        role: 'standard_user',
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
        `INSERT INTO client_profile_fill_run
      (id,tenant_id,client_id,created_by_user_id,status,stage,workflow_version,completed_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'partial','review_ready',2,now())`,
        runId,
        tenantId,
        clientId,
        userId,
      );
      for (const [table, id, type] of [
        ['client_profile_fill_task', coreId, 'public_web'],
        ['client_profile_fill_extension_task', extensionId, 'district_nexus'],
      ])
        await store.db.$executeRawUnsafe(
          `INSERT INTO ${table}
      (id,run_id,tenant_id,client_id,task_type,task_key,status,attempt,max_attempts,completed_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,'failed',3,3,now())`,
          id,
          runId,
          tenantId,
          clientId,
          type,
        );
      for (const type of ['reconciliation', 'completion_audit'])
        await store.db.$executeRawUnsafe(
          `INSERT INTO client_profile_fill_extension_task
        (run_id,tenant_id,client_id,task_type,task_key,status,completed_at,output_summary_jsonb)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$4,'completed',now(),'{"previous":true}')`,
          runId,
          tenantId,
          clientId,
          type,
        );
      command = { requestId: randomUUID(), expectedAttempt: 3, expectedTaskType: 'public_web' };
    });
    const retry = (taskId = coreId, input = command) =>
      retryResearchTask(store.scoped, ctx, clientId, runId, taskId, input);
    const task = (family = 'core') =>
      store.db.$queryRawUnsafe<Array<{ status: string; attempt: number; max: number }>>(
        `SELECT status,attempt,max_attempts AS max FROM ${family === 'core' ? 'client_profile_fill_task' : 'client_profile_fill_extension_task'} WHERE id=$1::uuid`,
        family === 'core' ? coreId : extensionId,
      );

    test.each(['core', 'extension'])(
      '%s exact retries queue once and preserve the original receipt after later failure',
      async (family) => {
        const id = family === 'core' ? coreId : extensionId;
        command.expectedTaskType = family === 'core' ? 'public_web' : 'district_nexus';
        const results = await Promise.all([retry(id), retry(id)]);
        expect(results.map((value) => value.status)).toEqual(['queued', 'queued']);
        expect(results.filter((value) => value.replayed)).toHaveLength(1);
        expect(await task(family)).toEqual([{ status: 'queued', attempt: 3, max: 6 }]);
        const table =
          family === 'core' ? 'client_profile_fill_task' : 'client_profile_fill_extension_task';
        await store.db.$executeRawUnsafe(
          `UPDATE ${table} SET status='failed',attempt=4,completed_at=now() WHERE id=$1::uuid`,
          id,
        );
        expect(await retry(id)).toMatchObject({ status: 'queued', replayed: true });
        expect(await task(family)).toEqual([{ status: 'failed', attempt: 4, max: 6 }]);
        expect(await store.db.auditLog.count({ where: { id: command.requestId } })).toBe(1);
      },
    );
    test('distinct concurrent requests for the same failed attempt produce one queued and one refused receipt', async () => {
      const results = await Promise.all([
        retry(),
        retry(coreId, { ...command, requestId: randomUUID() }),
      ]);
      expect(results.map((value) => value.status).sort()).toEqual(['queued', 'refused']);
      expect(await task()).toEqual([{ status: 'queued', attempt: 3, max: 6 }]);
    });
    test('a stale refusal remains refused even if the task later returns to that attempt', async () => {
      command.expectedAttempt = 2;
      expect(await retry()).toMatchObject({ status: 'refused', replayed: false });
      await store.db.$executeRawUnsafe(
        'UPDATE client_profile_fill_task SET attempt=2 WHERE id=$1::uuid',
        coreId,
      );
      expect(await retry()).toMatchObject({ status: 'refused', replayed: true });
      expect((await task())[0]?.status).toBe('failed');
    });
    test.each(['task', 'attempt', 'type'])(
      'a saved request cannot change its %s',
      async (field) => {
        await retry();
        await expect(
          retry(field === 'task' ? extensionId : coreId, {
            ...command,
            ...(field === 'attempt' ? { expectedAttempt: 4 } : {}),
            ...(field === 'type' ? { expectedTaskType: 'district_nexus' } : {}),
          }),
        ).rejects.toMatchObject({ status: 409 });
      },
    );
    test.each(['wall', 'membership', 'role', 'tenant'])(
      'current %s changes revoke command and receipt access',
      async (mode) => {
        await retry();
        if (mode === 'wall')
          await store.db.client.update({ where: { id: clientId }, data: { memoryWall: true } });
        if (mode === 'membership')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            data: { status: 'removed' },
          });
        if (mode === 'role')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId },
            data: { role: 'user_admin' },
          });
        if (mode === 'tenant')
          await store.db.tenant.update({
            where: { id: ctx.tenantId },
            data: { status: 'suspended' },
          });
        await expect(retry()).rejects.toMatchObject({ status: mode === 'wall' ? 404 : 403 });
      },
    );
    test('cancelled or foreign tasks receive refusals without reopening the run', async () => {
      expect(await retry(randomUUID())).toMatchObject({ status: 'refused' });
      command.requestId = randomUUID();
      await store.db.$executeRawUnsafe(
        "UPDATE client_profile_fill_run SET status='cancelled',stage='cancelled' WHERE id=$1::uuid",
        runId,
      );
      expect(await retry()).toMatchObject({ status: 'refused' });
      expect((await task())[0]?.status).toBe('failed');
      expect(
        await store.db.$queryRawUnsafe(
          'SELECT status FROM client_profile_fill_run WHERE id=$1::uuid',
          runId,
        ),
      ).toEqual([{ status: 'cancelled' }]);
    });
    test('receipt failure rolls back the task, review checks and run transition', async () => {
      await store.db.$executeRawUnsafe(
        `ALTER TABLE audit_logs ADD CONSTRAINT synthetic_retry_receipt_failure CHECK(id<>'${command.requestId}'::uuid)`,
      );
      try {
        await expect(retry()).rejects.toBeDefined();
        expect(await task()).toEqual([{ status: 'failed', attempt: 3, max: 3 }]);
        expect(
          await store.db.$queryRawUnsafe(
            'SELECT status FROM client_profile_fill_run WHERE id=$1::uuid',
            runId,
          ),
        ).toEqual([{ status: 'partial' }]);
        expect(
          await store.db.$queryRawUnsafe(
            "SELECT status FROM client_profile_fill_extension_task WHERE run_id=$1::uuid AND task_type='completion_audit'",
            runId,
          ),
        ).toEqual([{ status: 'completed' }]);
      } finally {
        await store.db.$executeRawUnsafe(
          'ALTER TABLE audit_logs DROP CONSTRAINT synthetic_retry_receipt_failure',
        );
      }
    });
  },
);
