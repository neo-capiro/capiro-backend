import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { reviewDatabase } from './client-profile-fill-review.postgres-fixture.js';
import { readClientActivityMetrics } from './client-activity-metrics.js';

const url = process.env.FILL_REVIEW_TEST_DATABASE_URL;
(url ? describe : describe.skip)('full CRM activity metrics through ordinary PostgreSQL', () => {
  let store: Awaited<ReturnType<typeof reviewDatabase>>;
  let ctx: TenantContext, clientId: string;
  const now = new Date('2026-10-29T12:00:00Z');
  const start = new Date('2026-09-29T12:00:00Z');
  beforeAll(async () => {
    store = await reviewDatabase(url!);
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(
        readFileSync(
          join(__dirname, '../../prisma/migrations/20261120020000_client_activity/migration.sql'),
          'utf8',
        ),
      );
      await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON client_activity TO capiro_app');
    } finally {
      await admin.end();
    }
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    clientId = randomUUID();
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
    await store.db.client.create({
      data: { id: clientId, tenantId, name: 'Synthetic', status: 'active' },
    });
  });
  const read = (id = clientId, actor = ctx) =>
    readClientActivityMetrics(store.scoped, actor, id, () => now);
  const row = (extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    tenantId: ctx.tenantId,
    clientId,
    kind: 'note',
    title: 'Synthetic',
    occurredAt: now,
    ...extra,
  });

  it('returns complete real zeros and the UTC rolling window', async () => {
    expect(await read()).toEqual({
      definition: 'client-recorded-activity-v1',
      tenantId: ctx.tenantId,
      clientId,
      observedAt: now.toISOString(),
      coverage: 'complete',
      window: { start: start.toISOString(), end: now.toISOString(), timezone: 'UTC' },
      counts: {
        recordedActivities: 0,
        openRequests: 0,
        overdueRequests: 0,
        openCommitments: 0,
        overdueCommitments: 0,
      },
    });
  });
  it('counts beyond the capped timeline and includes exact window boundaries only once', async () => {
    await store.db.clientActivity.createMany({
      data: [
        ...Array.from({ length: 601 }, () =>
          row({ sourceType: 'meeting', sourceId: 'same-evidence' }),
        ),
        row({ occurredAt: start }),
        row({ occurredAt: new Date(start.getTime() - 1) }),
        row({ occurredAt: new Date(now.getTime() + 1) }),
      ],
    });
    expect((await read()).counts.recordedActivities).toBe(602);
  });
  it('counts unsettled requests and commitments over all time; due now, undated and settled work are not overdue', async () => {
    const past = new Date(now.getTime() - 1),
      future = new Date(now.getTime() + 1);
    await store.db.clientActivity.createMany({
      data: ['request', 'commitment'].flatMap((kind) => [
        row({ kind, dueAt: past, occurredAt: new Date('2025-01-01Z') }),
        row({ kind, dueAt: now }),
        row({ kind, dueAt: future }),
        row({ kind }),
        row({ kind, dueAt: past, settledAt: now }),
      ]),
    });
    expect((await read()).counts).toEqual({
      recordedActivities: 8,
      openRequests: 4,
      overdueRequests: 1,
      openCommitments: 4,
      overdueCommitments: 1,
    });
  });
  it('does not count other clients or tenants', async () => {
    const other = randomUUID(),
      foreignTenant = randomUUID(),
      foreignClient = randomUUID();
    await store.db.client.create({
      data: { id: other, tenantId: ctx.tenantId, name: 'Other', status: 'active' },
    });
    await store.db.tenant.create({
      data: {
        id: foreignTenant,
        slug: 'synthetic-' + foreignTenant,
        name: 'Foreign',
        status: 'active',
      },
    });
    await store.db.client.create({
      data: { id: foreignClient, tenantId: foreignTenant, name: 'Foreign', status: 'active' },
    });
    await store.db.clientActivity.createMany({
      data: [
        row(),
        row({ clientId: other }),
        row({ tenantId: foreignTenant, clientId: foreignClient }),
      ],
    });
    expect((await read()).counts.recordedActivities).toBe(1);
    await expect(read(foreignClient)).rejects.toThrow('Client not found');
  });
  it('enforces a private client grant and its revocation', async () => {
    await store.db.client.update({
      where: { id: clientId },
      data: { memoryWall: true },
    });
    await expect(read()).rejects.toThrow('Client not found');
    await store.db.clientMemoryAccess.create({
      data: { tenantId: ctx.tenantId, clientId, userId: ctx.userId },
    });
    expect((await read()).coverage).toBe('complete');
    await store.db.clientMemoryAccess.deleteMany({ where: { clientId } });
    await expect(read()).rejects.toThrow('Client not found');
  });
  it('refuses archived clients and malformed identifiers', async () => {
    await store.db.client.update({ where: { id: clientId }, data: { status: 'archived' } });
    await expect(read()).rejects.toThrow('Client not found');
    await expect(read('not-a-client')).rejects.toThrow('Client not found');
  });
  it.each(['member', 'role', 'identity', 'tenant'])(
    'refuses current %s authority loss',
    async (kind) => {
      if (kind === 'member')
        await store.db.tenantMembership.deleteMany({ where: { tenantId: ctx.tenantId } });
      if (kind === 'role')
        await store.db.tenantMembership.updateMany({
          where: { tenantId: ctx.tenantId },
          data: { role: 'user_admin' },
        });
      if (kind === 'identity') ctx = { ...ctx, clerkUserId: 'another-identity' };
      if (kind === 'tenant')
        await store.db.tenant.update({
          where: { id: ctx.tenantId },
          data: { status: 'suspended' },
        });
      await expect(read()).rejects.toThrow('Account owner access denied');
    },
  );
});
