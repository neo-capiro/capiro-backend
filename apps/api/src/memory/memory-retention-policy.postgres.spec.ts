import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { TenantContext } from '@capiro/shared';
import { ownerRetentionCase } from './memory-owner-retention.postgres-fixture.js';
import { settingsSubmissionFixture } from './settings-drafts/submission.postgres-fixture.js';
import { readMemoryRetentionPolicy } from './memory-retention-policy.js';
import { fileDefForType } from './memory-catalog.js';

const url = process.env.MEMORY_POLICY_TEST_DATABASE_URL;
(url ? describe : describe.skip)('effective memory policy — ordinary PostgreSQL role', () => {
  let store: Awaited<ReturnType<typeof settingsSubmissionFixture>>;
  beforeAll(async () => {
    store = await settingsSubmissionFixture(url!);
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      if (
        !(await admin.query("SELECT to_regprocedure('memory_retention_policy_v1()') AS ready"))
          .rows[0].ready
      )
        await admin.query(
          readFileSync(
            join(
              __dirname,
              '../../prisma/migrations/20281029120000_memory_retention_policy_read/migration.sql',
            ),
            'utf8',
          ),
        );
    } finally {
      await admin.end();
    }
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  async function fixture() {
    const f = await ownerRetentionCase(store);
    const ctx: TenantContext = {
      tenantId: f.tenantId,
      userId: f.userId,
      clerkUserId: `owner-${f.userId}`,
      tenantSlug: `owner-${f.tenantId}`,
      role: 'user_admin',
    };
    return { ...f, ctx };
  }
  it('reports only installed policy metadata, its observation and explicit unavailable requests', async () => {
    const f = await fixture();
    const result = await readMemoryRetentionPolicy(store.prisma, f.ctx);
    expect(result).toMatchObject({
      schemaVersion: 1,
      owner: { tenantId: f.tenantId, userId: f.userId },
      requests: { export: 'unavailable', deletion: 'unavailable' },
      policy: {
        version: 1,
        personalAfterOffboardingHours: 720,
        clientAfterClosureHours: 2160,
        draftAfterCreationHours: 720,
        ownerClosureSuppressesImmediately: true,
        firmSurvivesAuthorDeparture: true,
        accessWithdrawal: 'revoke_access_only',
        heldContent: 'retain_held_and_required_lineage',
        receipts: 'retain_content_free_identity',
        payloadStores: ['memory_candidate', 'memory_items', 'clio_memory', 'context_embeddings'],
        outsideScope: ['conversations', 'uploads', 'office_drafts', 'filed_records'],
      },
    });
    expect(new Date(result.observedAt).getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(Object.keys(result).sort()).toEqual([
      'observedAt',
      'owner',
      'policy',
      'requests',
      'schemaVersion',
    ]);
  });
  it('reported owner durations match the real closure triggers without changing retained firm ownership', async () => {
    const f = await fixture();
    const personal = await f.create('user_private'),
      client = await f.create('client'),
      firm = await f.create('firm');
    const policy = (await readMemoryRetentionPolicy(store.prisma, f.ctx)).policy as Record<
      string,
      number
    >;
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId, userId: f.userId },
      data: { status: 'removed' },
    });
    await store.db.client.update({ where: { id: f.clientId }, data: { status: 'archived' } });
    for (const [id, hours] of [
      [personal.retentionSubjectId, policy.personalAfterOffboardingHours],
      [client.retentionSubjectId, policy.clientAfterClosureHours],
    ] as const) {
      const period = await store.db.memoryRetentionSubject.findUniqueOrThrow({
        where: { id: id! },
      });
      expect((period.purgeAfter!.getTime() - period.closedAt!.getTime()) / 3600000).toBe(hours);
    }
    expect(
      (
        await store.db.memoryRetentionSubject.findUniqueOrThrow({
          where: { id: firm.retentionSubjectId! },
        })
      ).closedAt,
    ).toBeNull();
  });
  it('reported draft duration matches the existing draft save owner', async () => {
    const f = await fixture(),
      id = randomUUID();
    const policy = (await readMemoryRetentionPolicy(store.prisma, f.ctx)).policy as Record<
      string,
      number
    >;
    await store.drafts.save(f.ctx, 'user-profile', 'me', id, {
      requestId: randomUUID(),
      expectedRevision: 0,
      action: 'save',
      baseItemId: null,
      baseVersion: null,
      sections: [
        { key: fileDefForType('user-profile')!.sections[0]!.key, body: 'Synthetic proposed text' },
      ],
    });
    const draft = await store.db.memorySettingsDraft.findUniqueOrThrow({ where: { id } });
    expect((draft.expiresAt.getTime() - draft.createdAt.getTime()) / 3600000).toBe(
      policy.draftAfterCreationHours,
    );
  });
  it.each(['membership', 'tenant', 'identity', 'foreign-tenant'] as const)(
    'refuses %s loss before returning policy',
    async (kind) => {
      const f = await fixture();
      if (kind === 'membership')
        await store.db.tenantMembership.deleteMany({ where: { tenantId: f.tenantId } });
      if (kind === 'tenant')
        await store.db.tenant.update({ where: { id: f.tenantId }, data: { status: 'suspended' } });
      if (kind === 'identity') f.ctx.clerkUserId = 'not-this-user';
      if (kind === 'foreign-tenant') f.ctx.tenantId = randomUUID();
      await expect(readMemoryRetentionPolicy(store.prisma, f.ctx)).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it('does not expose or modify private drafts, held records or requests when read', async () => {
    const f = await fixture();
    await f.create('user_private');
    const snapshot = () => store.db.clioMemory.findMany({ where: { tenantId: f.tenantId } });
    const before = await snapshot(),
      result = await readMemoryRetentionPolicy(store.prisma, f.ctx);
    expect(await snapshot()).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('Synthetic content');
    expect(await store.db.memorySettingsDraft.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
});
