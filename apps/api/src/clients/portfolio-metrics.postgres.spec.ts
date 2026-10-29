import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { readPortfolioMetrics } from './portfolio-metrics.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)('portfolio baseline metrics with ordinary PostgreSQL', () => {
  let store: Awaited<ReturnType<typeof reviewDatabase>>, ctx: TenantContext;
  const now = new Date('2026-10-29T12:00:00Z');
  beforeAll(async () => {
    store = await reviewDatabase(url!);
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      if (
        !(await admin.query("SELECT to_regclass('public.tracked_bill') present")).rows[0].present
      ) {
        await admin.query(
          'CREATE OR REPLACE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$',
        );
        await admin.query(
          readFileSync(
            join(
              __dirname,
              '../../prisma/migrations/20260601120000_add_tracked_bill/migration.sql',
            ),
            'utf8',
          ),
        );
      }
      await admin.query(
        readFileSync(
          join(__dirname, '../../prisma/migrations/20261120020000_client_activity/migration.sql'),
          'utf8',
        ),
      );
      await admin.query('GRANT SELECT ON tracked_bill, client_activity TO capiro_app');
    } finally {
      await admin.end();
    }
  }, 90000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    ctx = {
      tenantId,
      userId,
      clerkUserId: 'synthetic-' + userId,
      tenantSlug: 'synthetic-' + tenantId,
      role: 'standard_user',
    };
    await store.db.tenant.create({
      data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' },
    });
    await store.db.tenantMembership.create({
      data: { tenantId, userId, status: 'active', role: ctx.role },
    });
  });
  const read = (prisma = store.scoped) => readPortfolioMetrics(prisma, ctx, () => now);
  const client = (data: Record<string, unknown> = {}) =>
    store.db.client.create({
      data: { tenantId: ctx.tenantId, name: 'Synthetic', status: 'active', ...data },
    });
  const objective = (clientId: string, status = 'draft') =>
    store.db.clientObjective.create({
      data: {
        tenantId: ctx.tenantId,
        clientId,
        clientRequestId: randomUUID(),
        createRequestHash: 'a'.repeat(64),
        createdByUserId: ctx.userId,
        status,
        outcome: 'Synthetic outcome',
        governmentProblem: 'Synthetic problem',
        askType: 'funding',
        minimumWin: 'Synthetic minimum',
      },
    });
  it('reports real zero values for complete empty populations', async () => {
    const result = await read();
    expect(result.clients).toMatchObject({ status: 'available', counts: { activeClients: 0 } });
    expect(result.billWatch).toMatchObject({
      status: 'available',
      counts: { activeClients: 0, clientsWithWatches: 0, distinctBills: 0 },
    });
    expect(result.objectives).toMatchObject({ status: 'available', counts: { objectives: 0 } });
  });
  it('counts beyond display pages and excludes inactive/prospect/walled/deleted records', async () => {
    const visible = await Promise.all(Array.from({ length: 60 }, () => client()));
    const hidden = await Promise.all([
      client({ status: 'archived' }),
      client({ status: 'inactive' }),
      client({ profileType: ' prospect ' }),
      client({ memoryWall: true }),
    ]);
    for (const row of visible) await objective(row.id);
    for (const row of hidden) await objective(row.id, 'in_review');
    await objective(visible[0]!.id, 'in_review');
    await objective(visible[0]!.id, 'ready');
    const removed = await objective(visible[0]!.id);
    await store.db.clientObjective.update({ where: { id: removed.id }, data: { deletedAt: now } });
    const result = await read();
    expect(result.clients).toMatchObject({ counts: { activeClients: 60 } });
    expect(result.objectives).toMatchObject({
      counts: { objectives: 62, awaitingReview: 1, ready: 1 },
    });
  });
  it('uses exact UTC activity boundaries and deduplicates saved bill coverage', async () => {
    const a = await client({ profileType: null }),
      b = await client();
    const rows = [
      { kind: 'note', occurredAt: new Date(now.getTime() - 30 * 86400000) },
      { kind: 'note', occurredAt: now },
      { kind: 'note', occurredAt: new Date(now.getTime() + 1) },
      { kind: 'request', occurredAt: new Date(1), dueAt: new Date(now.getTime() - 1) },
      { kind: 'request', occurredAt: new Date(1), dueAt: now },
      { kind: 'commitment', occurredAt: new Date(1), dueAt: new Date(1), settledAt: now },
    ];
    for (const row of rows)
      await store.db.clientActivity.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: a.id,
          createdByUserId: ctx.userId,
          title: 'Synthetic',
          ...row,
        },
      });
    for (const [clientId, bill] of [
      [a.id, '119-hr-1'],
      [a.id, '119-hr-2'],
      [b.id, '119-hr-1'],
    ])
      await store.db
        .$executeRaw`INSERT INTO tracked_bill (id,tenant_id,client_id,bill_id) VALUES (${randomUUID()}::uuid,${ctx.tenantId}::uuid,${clientId}::uuid,${bill})`;
    const result = await read();
    expect(result.activity).toMatchObject({
      counts: { recordedActivities: 2, overdueRequests: 1, overdueCommitments: 0 },
    });
    expect(result.billWatch).toMatchObject({
      counts: { activeClients: 2, clientsWithWatches: 2, clientBillWatches: 3, distinctBills: 2 },
    });
  });
  it('rechecks wall grants and current role on each read', async () => {
    const row = await client({ memoryWall: true });
    await store.db.clientMemoryAccess.create({
      data: { tenantId: ctx.tenantId, clientId: row.id, userId: ctx.userId, grantedBy: ctx.userId },
    });
    expect((await read()).clients).toMatchObject({ counts: { activeClients: 1 } });
    await store.db.clientMemoryAccess.deleteMany({ where: { clientId: row.id } });
    expect((await read()).clients).toMatchObject({ counts: { activeClients: 0 } });
    await store.db.tenantMembership.updateMany({
      where: { tenantId: ctx.tenantId },
      data: { role: 'client_portal_user' },
    });
    await expect(read()).rejects.toThrow('access denied');
  });
  it('does not include another tenant even when its client is active and public', async () => {
    const tenantId = randomUUID();
    await store.db.tenant.create({
      data: { id: tenantId, slug: tenantId, name: 'Other synthetic', status: 'active' },
    });
    const foreign = await client({ tenantId });
    await store.db.clientActivity.create({
      data: {
        tenantId,
        clientId: foreign.id,
        createdByUserId: ctx.userId,
        title: 'Foreign synthetic',
        kind: 'note',
        occurredAt: now,
      },
    });
    const result = await read();
    expect(result.clients).toMatchObject({ counts: { activeClients: 0 } });
    expect(result.activity).toMatchObject({ counts: { recordedActivities: 0 } });
  });
  it('keeps valid source counts when the watch source fails', async () => {
    await client();
    const fault = {
      withTenantUser: (tenant: string, actor: string, work: (tx: unknown) => unknown) =>
        store.scoped.withTenantUser(
          tenant,
          actor,
          (tx) =>
            work(
              new Proxy(tx, {
                get(target, key) {
                  if (key !== '$queryRaw') return Reflect.get(target, key);
                  return (...args: unknown[]) => {
                    const sql = args[0] as { strings?: string[] };
                    if (sql.strings?.join('').includes('FROM tracked_bill'))
                      throw Error('Synthetic source outage');
                    return Reflect.apply(target.$queryRaw, target, args);
                  };
                },
              }),
            ) as never,
        ),
    } as PrismaService;
    const result = await read(fault);
    expect(result.clients).toMatchObject({ status: 'available', counts: { activeClients: 1 } });
    expect(result.billWatch).toEqual({ status: 'unavailable' });
  });
});
