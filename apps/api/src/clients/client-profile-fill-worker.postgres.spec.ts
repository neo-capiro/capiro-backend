import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { resolveFillRunActor } from './client-profile-fill-worker-actor.js';
import { runWithFillTask } from './client-profile-fill-execution.js';
import { ClientProfileFillCompletionPersistence } from './client-profile-fill-completion-persistence.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'research worker authority and late writes through ordinary PostgreSQL',
  () => {
    let store: Awaited<ReturnType<typeof reviewDatabase>>;
    let ctx: TenantContext, clientId: string, runId: string, taskId: string;
    let scoped: typeof store.scoped;
    let emit: (kind: 'core' | 'extension') => Promise<boolean>;
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
      taskId = randomUUID();
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
      for (const table of ['client_profile_fill_task', 'client_profile_fill_extension_task'])
        await store.db.$executeRawUnsafe(
          `INSERT INTO ${table} (id,run_id,tenant_id,client_id,task_type,task_key,status,worker_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,'running','lease-original')`,
          taskId,
          runId,
          tenantId,
          clientId,
          table.endsWith('extension_task') ? 'district_nexus' : 'public_web',
        );
      scoped = Object.assign(Object.create(store.scoped), {
        withTenant: (tenant: string, fn: Parameters<typeof store.scoped.withTenantUser>[2]) =>
          store.scoped.withTenantUser(tenant, ctx.userId, fn),
      });
      const completion = new ClientProfileFillCompletionPersistence(scoped);
      const core = new ClientProfileFillService(
        scoped,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const input = {
        kind: 'profile_field',
        targetKey: 'description',
        source: 'public_web',
        factKind: 'fact' as const,
        currentValue: null,
        proposedValue: 'Synthetic candidate',
        confidence: 0.9,
        evidence: [],
        status: 'pending' as const,
      };
      emit = (kind) =>
        kind === 'core'
          ? (core as unknown as { addFinding(...args: unknown[]): Promise<boolean> }).addFinding(
              ctx.tenantId,
              clientId,
              runId,
              input,
            )
          : completion.addFinding(ctx.tenantId, clientId, runId, input);
    });
    const task = () => ({
      id: taskId,
      runId,
      clientId,
      tenantId: ctx.tenantId,
      workerId: 'lease-original',
    });
    const execute = (kind: 'core' | 'extension') =>
      runWithFillTask(ctx, task(), kind, () => emit(kind));
    const count = async () =>
      Number(
        (
          await store.db.$queryRawUnsafe<Array<{ count: number }>>(
            'SELECT count(*)::int AS count FROM client_profile_fill_finding WHERE run_id=$1::uuid',
            runId,
          )
        )[0]!.count,
      );
    test('reconstructs the current membership and Clerk identity from the saved requester under the ordinary role', async () => {
      expect(await resolveFillRunActor(scoped, ctx.tenantId, clientId, runId)).toEqual(ctx);
      expect(
        await store.scoped.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          tx.$queryRawUnsafe('SELECT current_user AS role'),
        ),
      ).toEqual([{ role: 'capiro_app' }]);
      await store.db.tenantMembership.updateMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        data: { role: 'standard_user' },
      });
      expect(await resolveFillRunActor(scoped, ctx.tenantId, clientId, runId)).toEqual({
        ...ctx,
        role: 'standard_user',
      });
      await store.db.tenantMembership.updateMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        data: { status: 'removed' },
      });
      await expect(
        resolveFillRunActor(scoped, ctx.tenantId, clientId, runId),
      ).rejects.toMatchObject({ status: 403 });
    });
    test.each(['core', 'extension'] as const)(
      '%s finding persistence is current and deduplicated',
      async (kind) => {
        expect(await execute(kind)).toBe(true);
        expect(await execute(kind)).toBe(false);
        expect(await count()).toBe(1);
        expect(
          (await store.db.client.findUniqueOrThrow({ where: { id: clientId } })).description,
        ).toBeNull();
      },
    );
    test.each(
      (['core', 'extension'] as const).flatMap((kind) =>
        (['lease', 'cancel', 'deadline', 'terminal', 'wall', 'membership', 'role', 'tenant'] as const).map((change) => ({
          kind,
          change,
        })),
      ),
    )('$kind rejects $change changes before any finding write', async ({ kind, change }) => {
      if (change === 'lease')
        await store.db.$executeRawUnsafe(
          `UPDATE ${kind === 'core' ? 'client_profile_fill_task' : 'client_profile_fill_extension_task'} SET worker_id='lease-new' WHERE id=$1::uuid`,
          taskId,
        );
      if (change === 'deadline')
        await store.db.$executeRawUnsafe(
          "UPDATE client_profile_fill_run SET started_at=clock_timestamp()-interval '31 minutes' WHERE id=$1::uuid", runId,
        );
      if (change === 'terminal')
        await store.db.$executeRawUnsafe(
          "UPDATE client_profile_fill_run SET status='completed' WHERE id=$1::uuid", runId,
        );
      if (change === 'cancel')
        await store.db.$executeRawUnsafe(
          "UPDATE client_profile_fill_run SET status='cancelled' WHERE id=$1::uuid",
          runId,
        );
      if (change === 'wall')
        await store.db.client.update({ where: { id: clientId }, data: { memoryWall: true } });
      if (change === 'membership')
        await store.db.tenantMembership.updateMany({
          where: { tenantId: ctx.tenantId, userId: ctx.userId },
          data: { status: 'removed' },
        });
      if (change === 'role')
        await store.db.tenantMembership.updateMany({
          where: { tenantId: ctx.tenantId, userId: ctx.userId },
          data: { role: 'standard_user' },
        });
      if (change === 'tenant')
        await store.db.tenant.update({
          where: { id: ctx.tenantId },
          data: { status: 'suspended' },
        });
      await expect(execute(kind)).rejects.toBeDefined();
      expect(await count()).toBe(0);
    });
    test.each(['core', 'extension'] as const)(
      '%s late callback retains an expired execution scope',
      async (kind) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let late!: Promise<boolean>;
        await runWithFillTask(ctx, task(), kind, async () => {
          late = gate.then(() => emit(kind));
        });
        const refused = expect(late).rejects.toMatchObject({ status: 409 });
        release();
        await refused;
        expect(await count()).toBe(0);
      },
    );
    test('rechecks cancellation after waiting for the run lock', async () => {
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancellation = store.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT id FROM client_profile_fill_run WHERE id=$1::uuid FOR UPDATE',
          runId,
        );
        locked();
        await gate;
        await tx.$executeRawUnsafe(
          "UPDATE client_profile_fill_run SET status='cancelled' WHERE id=$1::uuid",
          runId,
        );
      });
      await acquired;
      const write = execute('core');
      const refused = expect(write).rejects.toMatchObject({ status: 409 });
      release();
      await cancellation;
      await refused;
      expect(await count()).toBe(0);
    });
  },
);
