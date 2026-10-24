import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import { SupportRequestsService } from '../../src/help/support-requests/support-requests.service.js';
import { fixture, ctx, tenant, actor, outsider, foreign, id, release, settled } from './fixture.js';

// Explicit root-scheduled suite only: existing fixture refuses shared/non-loopback/nonempty DBs.
// The suite needs a fresh slot, not a DB already used by broadcasts.pg.spec.ts.
let h: Awaited<ReturnType<typeof fixture>>;
let service: SupportRequestsService;
const report = {
  id: id(801),
  summary: 'Synthetic summary',
  detail: 'Synthetic detail',
  runReference: null,
};
beforeAll(async () => {
  h = await fixture('broadcasts');
  await h.sql(`ALTER TABLE tenants ADD status text NOT NULL DEFAULT 'active';
      CREATE OR REPLACE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(current_setting('app.bypass_rls',true),'off')='on' $$;
      DROP POLICY tenant_isolation ON tenant_memberships;
      CREATE POLICY tenant_isolation ON tenant_memberships
        USING(rls_bypass() OR tenant_id=current_tenant_id())
        WITH CHECK(rls_bypass() OR tenant_id=current_tenant_id());
      CREATE TABLE audit_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_user_id uuid,actor_role text,action text NOT NULL,entity_type text,entity_id text,
        before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,request_id text,occurred_at timestamptz NOT NULL DEFAULT now());
      GRANT SELECT,INSERT ON audit_logs TO capiro_app;`);
  await h.sql(
    readFileSync(
      resolve(__dirname, '../../prisma/migrations/20281024030000_support_requests/migration.sql'),
      'utf8',
    ),
  );
  service = new SupportRequestsService(h.prisma);
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

it('commits one record for concurrent same-ID replay and refuses a changed payload', async () => {
  const [first, second] = await Promise.all([
    service.create(ctx, report),
    service.create(ctx, report),
  ]);
  expect(first).toEqual(second);
  expect(await service.ownReceipt(ctx, report.id)).toEqual(first);
  expect((await h.sql('SELECT count(*)::int AS n FROM support_requests')).rows[0].n).toBe(1);
  await expect(
    service.create(ctx, { ...report, detail: 'Different report' }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await service.ownReceipt(ctx, report.id)).detail).toBe(report.detail);
});
it('rejects another active actor and tenant without exposing an own receipt', async () => {
  await service.create(ctx, report);
  await expect(service.ownReceipt({ ...ctx, userId: outsider }, report.id)).rejects.toMatchObject({
    status: 404,
  });
  await h.sql(
    `INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active')`,
    [foreign, outsider],
  );
  await expect(
    service.ownReceipt({ ...ctx, tenantId: foreign, userId: outsider }, report.id),
  ).rejects.toMatchObject({ status: 404 });
  const rows = await h.prisma.withTenant(foreign, (tx) =>
    tx.supportRequest.findMany({ where: { id: report.id } }),
  );
  expect(rows).toEqual([]);
});
it('observes member revocation that commits while create waits, then refuses saved receipt access after revocation', async () => {
  const gate = await h.lock(
    `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
    [tenant, actor],
  );
  const pending = settled(service.create(ctx, report));
  try {
    await h.waitForLock('FROM tenant_memberships');
  } finally {
    await release(gate);
  }
  expect((await pending).error).toMatchObject({ status: 403 });
  expect((await h.sql('SELECT count(*)::int AS n FROM support_requests')).rows[0].n).toBe(0);
  await h.sql(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2`, [
    tenant,
    actor,
  ]);
  await service.create(ctx, report);
  await h.sql(`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`, [
    tenant,
    actor,
  ]);
  await expect(service.ownReceipt(ctx, report.id)).rejects.toMatchObject({ status: 403 });
});
it('observes tenant suspension that commits while create waits', async () => {
  const gate = await h.lock(`UPDATE tenants SET status='suspended' WHERE id=$1`, [tenant]);
  const pending = settled(service.create(ctx, report));
  try {
    await h.waitForLock('FROM tenants');
  } finally {
    await release(gate);
  }
  expect((await pending).error).toMatchObject({ status: 403 });
  expect((await h.sql('SELECT count(*)::int AS n FROM support_requests')).rows[0].n).toBe(0);
});
it('enforces immutable UPDATE and deletes reports through the tenant and user lifecycle FKs', async () => {
  await service.create(ctx, report);
  await expect(
    h.sql('UPDATE support_requests SET detail=$1 WHERE id=$2', ['changed', report.id]),
  ).rejects.toThrow('immutable');
  await h.sql('INSERT INTO tenants(id) VALUES($1)', [id(900)]);
  await h.sql('INSERT INTO users(id,clerk_user_id) VALUES($1,$2)', [
    id(901),
    'support-lifecycle-synthetic',
  ]);
  await h.sql(
    'INSERT INTO support_requests(id,tenant_id,submitted_by_user_id,summary,detail) VALUES($1,$2,$3,$4,$5)',
    [id(902), id(900), id(901), 'Synthetic', 'Synthetic'],
  );
  await h.sql('DELETE FROM tenants WHERE id=$1', [id(900)]);
  expect((await h.sql('SELECT id FROM support_requests WHERE id=$1', [id(902)])).rowCount).toBe(0);
  await h.sql(
    'INSERT INTO support_requests(id,tenant_id,submitted_by_user_id,summary,detail) VALUES($1,$2,$3,$4,$5)',
    [id(903), foreign, id(901), 'Synthetic', 'Synthetic'],
  );
  await h.sql('DELETE FROM users WHERE id=$1', [id(901)]);
  expect((await h.sql('SELECT id FROM support_requests WHERE id=$1', [id(903)])).rowCount).toBe(0);
});
it('requires fresh staff role and does not return cross-tenant report content if access auditing fails', async () => {
  await h.sql(
    `INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active')`,
    [foreign, outsider],
  );
  await service.create({ ...ctx, tenantId: foreign, userId: outsider }, report);
  const staff = { ...ctx, role: 'capiro_admin' as const };
  await expect(service.listForStaff(staff, { tenantId: foreign })).rejects.toMatchObject({
    status: 403,
  });
  await h.sql(
    `UPDATE tenant_memberships SET role='capiro_admin' WHERE tenant_id=$1 AND user_id=$2`,
    [tenant, actor],
  );
  expect((await service.listForStaff(staff, { tenantId: foreign })).items).toHaveLength(1);
  expect((await service.detailForStaff(staff, foreign, report.id)).detail).toBe(report.detail);
  const audits = await h.sql('SELECT action,before_jsonb,after_jsonb FROM audit_logs');
  expect(audits.rows).toHaveLength(2);
  expect(audits.rows.every((row) => row.before_jsonb === null && row.after_jsonb === null)).toBe(
    true,
  );
  await h.sql(`CREATE FUNCTION support_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER support_test_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION support_test_audit_failure()`);
  try {
    await expect(service.detailForStaff(staff, foreign, report.id)).rejects.toThrow(
      'synthetic audit failure',
    );
  } finally {
    await h.sql(
      'DROP TRIGGER support_test_audit_failure ON audit_logs; DROP FUNCTION support_test_audit_failure()',
    );
  }
});
