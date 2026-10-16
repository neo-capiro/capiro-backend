import { BadRequestException, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { archiveReportTarget, linkReportTarget, updateReportTarget } from '../report-targets.js';
import { EngagementPlansController } from './engagement-plans.controller.js';
import {
  normalizeCreatePlan,
  normalizeCreateWave,
  normalizePatchPlan,
  normalizePatchWave,
} from './engagement-plan.rules.js';
import {
  assertFixtureUrl,
  ctx,
  FIXTURE_URL,
  foreignCtx,
  ids,
  outcome,
  PlanPostgresFixture,
} from './engagement-plan-postgres.fixture.js';

describe('Manual Engagement plans on the reserved native PostgreSQL fixture', () => {
  jest.setTimeout(60000);
  let f: PlanPostgresFixture;
  const create = (extra: Record<string, unknown> = {}) =>
    f.service.create(
      ctx,
      normalizeCreatePlan({
        clientId: ids.client,
        requestId: randomUUID(),
        title: 'Synthetic manual plan',
        ...extra,
      }),
    );
  const wave = (planId: string, expectedPlanVersion: number, extra: Record<string, unknown> = {}) =>
    f.service.createWave(
      ctx,
      planId,
      normalizeCreateWave({
        requestId: randomUUID(),
        expectedPlanVersion,
        title: 'Synthetic child wave',
        ...extra,
      }),
    );
  const status = (error: unknown) =>
    error instanceof HttpException ? error.getStatus() : undefined;
  const code = (error: unknown) =>
    error instanceof HttpException && typeof error.getResponse() === 'object'
      ? (error.getResponse() as { code?: string }).code
      : undefined;
  beforeAll(async () => {
    f = new PlanPostgresFixture();
    await f.initialize();
  });
  beforeEach(async () => {
    await f.reset();
  });
  afterAll(async () => {
    if (f) await f.close();
  });

  test('fixture guard rejects another host, port, database or user before any setup', () => {
    expect(() => assertFixtureUrl(FIXTURE_URL)).not.toThrow();
    for (const url of [
      FIXTURE_URL.replace('127.0.0.1', 'localhost'),
      FIXTURE_URL.replace('60009', '5432'),
      FIXTURE_URL.replace('engagement_plan_acceptance', 'postgres'),
      FIXTURE_URL.replace('codex_engagement@', 'postgres@'),
    ])
      expect(() => assertFixtureUrl(url)).toThrow('Refusing database activity');
  });

  test('multiple active plans remain independent; manual lifecycle and exact-version review preserve history', async () => {
    const first = await create();
    const second = await create({ title: 'Another plan for the same client' });
    const p = first.aggregate.id;
    await f.service.patch(ctx, p, { expectedPlanVersion: 1, action: 'activate' });
    await f.service.patch(ctx, second.aggregate.id, { expectedPlanVersion: 1, action: 'activate' });
    const active = await f.service.list(ctx, { clientId: ids.client, limit: 10 });
    expect(active.summaries[0]).toMatchObject({ totalPlans: 2, activePlans: 2, draftPlans: 0 });
    const reviewed = await f.service.review(ctx, p, {
      expectedPlanVersion: 2,
      reviewDueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(reviewed).toMatchObject({
      version: 3,
      reviewedPlanVersion: 3,
      review: { status: 'current' },
    });
    const deactivated = await f.service.patch(ctx, p, {
      expectedPlanVersion: 3,
      action: 'deactivate',
    });
    expect(deactivated).toMatchObject({
      version: 4,
      lifecycle: 'draft',
      review: { status: 'stale', reason: 'plan_changed' },
    });
    await f.service.patch(ctx, p, { expectedPlanVersion: 4, action: 'archive' });
    expect(await f.service.get(ctx, p)).toMatchObject({ version: 5, lifecycle: 'archived' });
    const illegal = await outcome(
      f.service.patch(ctx, p, { expectedPlanVersion: 5, title: 'Not editable while archived' }),
    );
    expect(code(illegal.error)).toBe('PLAN_INVALID_LIFECYCLE');
    const restored = await f.service.patch(ctx, p, { expectedPlanVersion: 5, action: 'restore' });
    expect(restored).toMatchObject({
      version: 6,
      lifecycle: 'draft',
      reviewedPlanVersion: 3,
      review: { status: 'stale' },
    });
    expect(
      await f.service.patch(ctx, p, { expectedPlanVersion: 6, action: 'restore' }),
    ).toMatchObject({ version: 6 });
    expect(
      code(
        (await outcome(f.service.patch(ctx, p, { expectedPlanVersion: 5, action: 'restore' })))
          .error,
      ),
    ).toBe('PLAN_VERSION_CONFLICT');
    const history = await f.service.history(ctx, p, { limit: 2 });
    expect(history.items.map((item) => item.version)).toEqual([6, 5]);
    expect(history).toMatchObject({
      completeness: 'partial',
      pagination: { hasMore: true, beforeVersion: 5 },
    });
    const older = await f.service.history(ctx, p, { limit: 10, beforeVersion: 5 });
    expect(older.items.map((item) => item.version)).toEqual([4, 3, 2, 1]);
    expect(older.completeness).toBe('complete');
    expect((await f.service.get(ctx, second.aggregate.id)).lifecycle).toBe('active');
  });

  test('real controller normalizers reject rescope/unknown fields and database identity is immutable', async () => {
    const p = await create();
    const controller = new EngagementPlansController(f.service);
    expect(() =>
      controller.patch(ctx, p.aggregate.id, { expectedPlanVersion: 1, clientId: ids.otherClient }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.create(ctx, {
        clientId: ids.client,
        requestId: randomUUID(),
        title: 'Unknown field',
        arbitrary: true,
      }),
    ).toThrow(BadRequestException);
    await expect(
      f.pool.query('UPDATE engagement_plans SET client_id=$1 WHERE id=$2', [
        ids.otherClient,
        p.aggregate.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await f.service.get(ctx, p.aggregate.id)).toMatchObject({
      clientId: ids.client,
      version: 1,
    });
  });

  test('plan/wave replay returns original receipts plus current aggregate, including uppercase paths and old versions', async () => {
    const controller = new EngagementPlansController(f.service);
    const planInput = {
      clientId: ids.client.toUpperCase(),
      requestId: randomUUID(),
      title: 'Replay original',
    };
    const first = await controller.create(ctx, planInput);
    const id = first.aggregate.id;
    await controller.patch(ctx, id.toUpperCase(), {
      expectedPlanVersion: 1,
      title: 'Current edited title',
    });
    const replay = await controller.create(ctx, planInput);
    expect(replay).toMatchObject({
      reconciled: true,
      receipt: { planId: id, planVersion: 1 },
      aggregate: { version: 2, title: 'Current edited title' },
    });
    const waveInput = { requestId: randomUUID(), expectedPlanVersion: 2, title: 'Original wave' };
    const child = await controller.createWave(ctx, id.toUpperCase(), waveInput);
    await controller.patchWave(ctx, id.toUpperCase(), child.receipt.waveId!.toUpperCase(), {
      expectedPlanVersion: 3,
      title: 'Current wave',
    });
    const childReplay = await controller.createWave(ctx, id.toUpperCase(), waveInput);
    expect(childReplay).toMatchObject({
      reconciled: true,
      receipt: { planVersion: 3, waveId: child.receipt.waveId },
      aggregate: { version: 4 },
    });
    expect(childReplay.aggregate.waves[0]?.title).toBe('Current wave');
    expect(
      code(
        (await outcome(controller.createWave(ctx, id, { ...waveInput, title: 'Changed payload' })))
          .error,
      ),
    ).toBe('PLAN_CREATE_REQUEST_CONFLICT');
    expect(
      code(
        (await outcome(controller.create(ctx, { ...planInput, title: 'Changed payload' }))).error,
      ),
    ).toBe('PLAN_CREATE_REQUEST_CONFLICT');
    const counts = await f.pool.query(
      'SELECT (SELECT count(*)::int FROM engagement_plans) AS plans,(SELECT count(*)::int FROM engagement_plan_waves) AS waves,(SELECT count(*)::int FROM engagement_plan_command_receipts) AS receipts',
    );
    expect(counts.rows[0]).toEqual({ plans: 1, waves: 1, receipts: 2 });
  });

  test('two native connections racing parent/child commands at one version yield one commit and one conflict', async () => {
    const p = (await create()).aggregate;
    const results = await Promise.allSettled([
      f.service.patch(ctx, p.id, { expectedPlanVersion: 1, title: 'Parent winner candidate' }),
      f.otherService.createWave(
        ctx,
        p.id,
        normalizeCreateWave({
          expectedPlanVersion: 1,
          requestId: randomUUID(),
          title: 'Child winner candidate',
        }),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(code(failure?.reason)).toBe('PLAN_VERSION_CONFLICT');
    expect((await f.service.get(ctx, p.id)).version).toBe(2);
    const rows = await f.pool.query(
      'SELECT version,count(*)::int AS count FROM engagement_plan_revisions WHERE plan_id=$1 GROUP BY version ORDER BY version',
      [p.id],
    );
    expect(rows.rows).toEqual([
      { version: 1, count: 1 },
      { version: 2, count: 1 },
    ]);
    const orphans = await f.pool.query(
      'SELECT count(*)::int AS count FROM engagement_plan_waves w LEFT JOIN engagement_plans p ON p.id=w.plan_id AND p.tenant_id=w.tenant_id AND p.client_id=w.client_id WHERE p.id IS NULL',
    );
    expect(orphans.rows[0]?.count).toBe(0);
  });

  test('two existing children racing at the same parent version cannot both commit', async () => {
    const p = (await create()).aggregate;
    const a = await wave(p.id, 1);
    const b = await wave(p.id, 2);
    const results = await Promise.allSettled([
      f.service.patchWave(ctx, p.id, a.receipt.waveId!, {
        expectedPlanVersion: 3,
        title: 'First child edit',
      }),
      f.otherService.patchWave(ctx, p.id, b.receipt.waveId!, {
        expectedPlanVersion: 3,
        title: 'Second child edit',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      code(
        (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
      ),
    ).toBe('PLAN_VERSION_CONFLICT');
    const current = await f.service.get(ctx, p.id);
    expect(current).toMatchObject({ version: 4 });
    expect(current.waves).toHaveLength(2);
    expect(current.waves.filter((child) => child.title.endsWith('child edit'))).toHaveLength(1);
    const audit = await f.pool.query(
      'SELECT count(*)::int AS count FROM engagement_plan_revisions WHERE plan_id=$1 AND version=4',
      [p.id],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  test('a real audit-insert failure atomically rolls back parent advance, wave and receipt', async () => {
    const p = (await create()).aggregate;
    await f.pool
      .query(`CREATE FUNCTION codex_fail_plan_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation='create_wave' THEN RAISE EXCEPTION 'Synthetic acceptance audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER codex_fail_plan_revision BEFORE INSERT ON engagement_plan_revisions FOR EACH ROW EXECUTE FUNCTION codex_fail_plan_revision()`);
    await expect(wave(p.id, 1)).rejects.toThrow();
    const rows = await f.pool.query(
      `SELECT version,(SELECT count(*)::int FROM engagement_plan_waves) AS waves,
      (SELECT count(*)::int FROM engagement_plan_command_receipts) AS receipts,
      (SELECT count(*)::int FROM engagement_plan_revisions) AS revisions FROM engagement_plans WHERE id=$1`,
      [p.id],
    );
    expect(rows.rows[0]).toEqual({ version: 1, waves: 0, receipts: 1, revisions: 1 });
  });

  test.each(['archive', 'rescope', 'rekey', 'merge'] as const)(
    'actual report-target %s races are fenced before/after binding without following another identity',
    async (operation) => {
      for (const bindingFirst of [false, true]) {
        await f.reset();
        const ref = await f.target();
        if (operation === 'merge') {
          await f.target(ids.client, `directory:${ids.directory}`);
          await f.pool.query(
            "INSERT INTO engagement_report_target_overrides(tenant_id,target_id,report_year,prep_status) VALUES($1,$2,2026,'complete')",
            [ids.tenant, ref.targetId],
          );
        }
        const mutate = () =>
          operation === 'archive'
            ? archiveReportTarget(f.b, ctx, ref.targetId)
            : operation === 'rescope'
              ? updateReportTarget(f.b, ctx, ref.targetId, { clientId: ids.otherClient })
              : linkReportTarget(f.b, f.directory, ctx, {
                  clientId: ids.client,
                  targetId: ref.targetId,
                  directoryContactId: ids.directory,
                });
        const bind = () => outcome(create({ officeReferences: [ref] }));
        const write = () => outcome(mutate());
        let pendingBinding!: ReturnType<typeof bind>;
        let pendingWriter!: ReturnType<typeof write>;
        const held = await f.holdTargets();
        try {
          if (bindingFirst) pendingBinding = bind();
          else pendingWriter = write();
          await f.waitForLocks('pg_advisory_xact_lock', 1, held.pid);
          if (bindingFirst) pendingWriter = write();
          else pendingBinding = bind();
          await f.waitForLocks('pg_advisory_xact_lock', 2, held.pid);
        } finally {
          await held.release();
        }
        const [binding, writer] = await Promise.all([pendingBinding, pendingWriter]);
        expect(writer.error).toBeUndefined();
        if (bindingFirst) {
          expect(binding.error).toBeUndefined();
          expect(binding.value!.aggregate.officeReferences).toEqual([{ ...ref, available: true }]);
          const current = await f.service.get(ctx, binding.value!.aggregate.id);
          expect(current.officeReferences).toEqual([{ ...ref, available: false }]);
          expect(JSON.stringify(current.officeReferences)).not.toContain(ids.otherClient);
          expect(JSON.stringify(current.officeReferences)).not.toContain(
            `directory:${ids.directory}`,
          );
        } else {
          expect(code(binding.error)).toBe('PLAN_OFFICE_UNAVAILABLE');
          expect(
            (await f.pool.query('SELECT count(*)::int AS count FROM engagement_plans')).rows[0]
              ?.count,
          ).toBe(0);
        }
        if (operation === 'merge') {
          expect(
            (
              await f.pool.query(
                'SELECT count(*)::int AS count FROM engagement_report_target_offices WHERE id=$1',
                [ref.targetId],
              )
            ).rows[0]?.count,
          ).toBe(0);
          expect(
            (await f.pool.query('SELECT prep_status FROM engagement_report_target_overrides')).rows,
          ).toEqual([{ prep_status: 'complete' }]);
        }
      }
    },
  );

  test('current grant, membership, Clerk, tenant, role and wall changes are rechecked after an actual client-lock wait', async () => {
    const mutations = [
      { sql: 'DELETE FROM client_memory_access WHERE client_id=$1', values: [ids.client] },
      {
        sql: "UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=$1 AND user_id=$2",
        values: [ids.tenant, ids.user],
      },
      {
        sql: "UPDATE users SET clerk_user_id='user_replaced_identity' WHERE id=$1",
        values: [ids.user],
      },
      { sql: "UPDATE tenants SET status='inactive' WHERE id=$1", values: [ids.tenant] },
      {
        sql: "UPDATE tenant_memberships SET role='client_portal_user' WHERE tenant_id=$1 AND user_id=$2",
        values: [ids.tenant, ids.user],
      },
      { sql: 'UPDATE clients SET memory_wall=true WHERE id=$1', values: [ids.client] },
    ];
    for (let index = 0; index < mutations.length; index++) {
      await f.reset();
      const p = (await create()).aggregate;
      if (index === 0) {
        await f.pool.query('UPDATE clients SET memory_wall=true WHERE id=$1', [ids.client]);
        await f.pool.query(
          'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
          [ids.tenant, ids.client, ids.user],
        );
      }
      const held = await f.holdClient();
      const pending = outcome(
        f.service.patch(ctx, p.id, {
          expectedPlanVersion: 1,
          title: 'Must not commit after revocation',
        }),
      );
      try {
        await f.waitForLocks('FROM clients', 1, held.pid);
        // The holder itself owns the client row being changed; all values stay bound.
        const mutation = mutations[index]!;
        await held.connection.query(mutation.sql, mutation.values);
      } finally {
        await held.release();
      }
      const result = await pending;
      expect(status(result.error)).toBe(404);
      expect(
        (await f.pool.query('SELECT version FROM engagement_plans WHERE id=$1', [p.id])).rows[0]
          ?.version,
      ).toBe(1);
    }
  });

  test('an actual service read holds the grant through an aggregate-lock wait and revocation blocks until commit', async () => {
    const p = (await create()).aggregate;
    await f.pool.query('UPDATE clients SET memory_wall=true WHERE id=$1', [ids.client]);
    await f.pool.query(
      'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
      [ids.tenant, ids.client, ids.user],
    );
    const holder = await f.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM engagement_plans WHERE id=$1 FOR UPDATE', [p.id]);
    const heldPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    const read = outcome(f.service.get(ctx, p.id));
    let revoke!: ReturnType<typeof outcome>;
    try {
      const waiting = await f.waitForLocks('FROM engagement_plans', 1, heldPid);
      revoke = outcome(
        f.pool.query('DELETE FROM client_memory_access WHERE client_id=$1 AND user_id=$2', [
          ids.client,
          ids.user,
        ]),
      );
      await f.waitForLocks('DELETE FROM client_memory_access', 1, waiting[0]!.pid);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect((await read).error).toBeUndefined();
    expect((await revoke).error).toBeUndefined();
    expect(status((await outcome(f.service.get(ctx, p.id))).error)).toBe(404);
    await f.pool.query(
      "UPDATE tenant_memberships SET role='capiro_admin' WHERE tenant_id=$1 AND user_id=$2",
      [ids.tenant, ids.user],
    );
    expect(
      status((await outcome(f.service.get({ ...ctx, role: 'capiro_admin' }, p.id))).error),
    ).toBe(404);
  });

  test('missing, foreign-tenant, walled and archived-client GETs have identical nondisclosing 404 bodies', async () => {
    const ordinary = await create();
    const archived = await create({ clientId: ids.otherClient });
    const foreign = await f.otherService.create(
      foreignCtx,
      normalizeCreatePlan({
        clientId: ids.foreignClient,
        requestId: randomUUID(),
        title: 'Foreign plan',
      }),
    );
    await f.pool.query("UPDATE clients SET status='archived' WHERE id=$1", [ids.otherClient]);
    await f.pool.query('UPDATE clients SET memory_wall=true WHERE id=$1', [ids.client]);
    const results = await Promise.all(
      [randomUUID(), foreign.aggregate.id, ordinary.aggregate.id, archived.aggregate.id].map((id) =>
        outcome(f.service.get(ctx, id)),
      ),
    );
    const bodies = results.map((result) => {
      expect(status(result.error)).toBe(404);
      return (result.error as HttpException).getResponse();
    });
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain(ids.foreignClient);
  });

  test('pagination preserves partial state, binds cursors to permitted scope and propagates read failures', async () => {
    await create();
    await create({ clientId: ids.otherClient });
    const first = await f.service.list(ctx, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.completeness).toMatchObject({
      page: 'partial',
      summaryCoverage: 'returned_clients',
    });
    expect(first.pagination.hasMore).toBe(true);
    const second = await f.service.list(ctx, { limit: 1, cursor: first.pagination.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const sourceCursor = JSON.parse(
      Buffer.from(first.pagination.nextCursor!, 'base64url').toString('utf8'),
    ) as { at: string; id: string; scope: string };
    expect(sourceCursor.at).toMatch(/\.\d{6}Z$/);
    const cursorAt = (at: string) =>
      Buffer.from(JSON.stringify({ ...sourceCursor, at })).toString('base64url');
    const invalidDay = await outcome(
      f.service.list(ctx, { limit: 1, cursor: cursorAt('2028-02-30T00:00:00.000000Z') }),
    );
    expect(status(invalidDay.error)).toBe(400);
    expect(code(invalidDay.error)).toBe('PLAN_INPUT_INVALID');
    await expect(
      f.service.list(ctx, { limit: 1, cursor: cursorAt('2028-02-29T00:00:00.123456Z') }),
    ).resolves.toHaveProperty('items');
    await f.pool.query('UPDATE clients SET memory_wall=true WHERE id=$1', [ids.otherClient]);
    expect(
      code(
        (await outcome(f.service.list(ctx, { limit: 1, cursor: first.pagination.nextCursor! })))
          .error,
      ),
    ).toBe('PLAN_SCOPE_CHANGED');
    expect(
      status((await outcome(f.service.list(ctx, { clientId: ids.otherClient, limit: 1 }))).error),
    ).toBe(404);
    await f.pool.query(
      'ALTER TABLE engagement_plan_waves RENAME TO codex_temporarily_unavailable_waves',
    );
    try {
      expect(
        (await outcome(f.service.list(ctx, { clientId: ids.client, limit: 1 }))).error,
      ).toBeDefined();
    } finally {
      await f.pool.query(
        'ALTER TABLE codex_temporarily_unavailable_waves RENAME TO engagement_plan_waves',
      );
    }
  });

  test('the real public Objective authority binds the exact revision and rejects stale or cross-client bindings', async () => {
    const objectiveId = randomUUID(),
      revisionId = randomUUID();
    await f.pool.query(
      'INSERT INTO client_objectives(id,tenant_id,client_id,version) VALUES($1,$2,$3,1)',
      [objectiveId, ids.tenant, ids.client],
    );
    await f.pool.query(
      'INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id,version) VALUES($1,$2,$3,$4,1)',
      [revisionId, ids.tenant, ids.client, objectiveId],
    );
    const p = await create({ objective: { objectiveId, objectiveVersion: 1 } });
    expect(p.aggregate.objectiveBinding).toEqual({
      clientId: ids.client,
      objectiveId,
      objectiveVersion: 1,
      objectiveRevisionId: revisionId,
    });
    await f.pool.query('UPDATE client_objectives SET version=2 WHERE id=$1', [objectiveId]);
    expect(
      code((await outcome(create({ objective: { objectiveId, objectiveVersion: 1 } }))).error),
    ).toBe('PLAN_OBJECTIVE_VERSION_CONFLICT');
    const wrongClient = await outcome(
      create({ clientId: ids.otherClient, objective: { objectiveId, objectiveVersion: 2 } }),
    );
    expect(status(wrongClient.error)).toBe(404);
    expect((await f.service.get(ctx, p.aggregate.id)).objectiveBinding).toEqual(
      p.aggregate.objectiveBinding,
    );
  });

  test('native query evidence keeps target, client, actor/grant and aggregate locks in the agreed order', async () => {
    const p = (await create()).aggregate;
    f.queries.length = 0;
    await f.service.get(ctx, p.id);
    const index = (predicate: (sql: string) => boolean) => f.queries.findIndex(predicate);
    const order = [
      index((q) => q.includes('pg_advisory_xact_lock')),
      index((q) => q.includes('FROM clients') && q.includes('FOR UPDATE')),
      index((q) => q.includes('FROM tenants t') && q.includes('FOR SHARE')),
      index((q) => q.includes('FROM client_memory_access') && q.includes('FOR SHARE')),
      index((q) => q.includes('FROM engagement_plans') && q.includes('FOR UPDATE')),
    ];
    expect(order.every((value) => value >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('JSONB key ordering does not turn an unchanged wave window into an edit or bypass stale version checks', async () => {
    const p = (await create()).aggregate;
    const child = await wave(p.id, 1, {
      window: {
        startDate: '2028-02-28',
        endDateExclusive: '2028-03-02',
        timeZone: 'America/New_York',
      },
    });
    const read = await f.service.get(ctx, p.id);
    const before = await f.service.history(ctx, p.id, { limit: 10 });
    const currentWindow = read.waves[0]!.window;
    const unchanged = await f.service.patchWave(
      ctx,
      p.id,
      child.receipt.waveId!,
      normalizePatchWave({ expectedPlanVersion: 2, window: currentWindow }),
    );
    expect(unchanged.version).toBe(2);
    expect((await f.service.history(ctx, p.id, { limit: 10 })).items).toHaveLength(
      before.items.length,
    );
    const stale = await outcome(
      f.service.patchWave(
        ctx,
        p.id,
        child.receipt.waveId!,
        normalizePatchWave({ expectedPlanVersion: 1, window: currentWindow }),
      ),
    );
    expect(code(stale.error)).toBe('PLAN_VERSION_CONFLICT');
  });
});
