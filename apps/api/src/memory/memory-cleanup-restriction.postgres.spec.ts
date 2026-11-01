import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { conversationMemoryRetentionFixture } from './memory-conversation-retention.postgres-fixture.js';
import { ownerRetentionCase } from './memory-owner-retention.postgres-fixture.js';
import { readMemoryCleanupRestriction } from './memory-retention-policy.js';

const url = process.env.MEMORY_CLEANUP_RESTRICTION_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'memory cleanup restriction through ordinary PostgreSQL authority',
  () => {
    let store: Awaited<ReturnType<typeof conversationMemoryRetentionFixture>>;
    let admin: Client;
    beforeAll(async () => {
      store = await conversationMemoryRetentionFixture(url!);
      admin = new Client({ connectionString: url });
      await admin.connect();
    }, 60000);
    afterAll(async () => {
      await admin?.end();
      await store?.db.$disconnect();
    });
    async function fixture() {
      const f = await ownerRetentionCase(store);
      const ctx = {
        tenantId: f.tenantId,
        userId: f.userId,
        clerkUserId: 'owner-' + f.userId,
        tenantSlug: 'owner-' + f.tenantId,
        role: 'user_admin',
      } as TenantContext;
      return { ...f, ctx, read: () => readMemoryCleanupRestriction(store.prisma, ctx) };
    }
    it('returns only current content-free status, without reading or mutating memory content', async () => {
      const f = await fixture(),
        saved = await f.create('user_private');
      const response = await f.read();
      expect(response).toEqual({
        schemaVersion: 1,
        owner: { tenantId: f.tenantId, userId: f.userId },
        check: 'submission_receipt_disposition',
        restriction: 'none',
        observedAt: expect.any(String),
      });
      expect(Date.parse(response.observedAt)).toBeGreaterThan(Date.now() - 60000);
      expect(await store.db.clioMemory.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(
        saved,
      );
      expect(JSON.stringify(response)).not.toContain('Synthetic content');
    });
    it('reports a legacy or renamed payload column as blocked even when every receipt is empty', async () => {
      const f = await fixture();
      await admin.query('ALTER TABLE clio_meri_memory_submissions ADD COLUMN candidate jsonb');
      try {
        expect((await f.read()).restriction).toBe('legacy_receipt_disposition_required');
        await admin.query(
          'ALTER TABLE clio_meri_memory_submissions RENAME COLUMN candidate TO renamed_payload',
        );
        expect((await f.read()).restriction).toBe('legacy_receipt_disposition_required');
      } finally {
        await admin.query(
          'ALTER TABLE clio_meri_memory_submissions DROP COLUMN IF EXISTS candidate, DROP COLUMN IF EXISTS renamed_payload',
        );
      }
      expect((await f.read()).restriction).toBe('none');
    });
    it('reports missing or inaccessible receipt storage as unavailable, never unrestricted', async () => {
      const f = await fixture();
      await admin.query(
        'ALTER TABLE clio_meri_memory_submissions RENAME TO restriction_fixture_missing',
      );
      try {
        expect((await f.read()).restriction).toBe('unavailable');
      } finally {
        await admin.query(
          'ALTER TABLE restriction_fixture_missing RENAME TO clio_meri_memory_submissions',
        );
      }
      await admin.query('REVOKE SELECT ON clio_meri_memory_submissions FROM capiro_app');
      try {
        expect((await f.read()).restriction).toBe('unavailable');
      } finally {
        await admin.query('GRANT SELECT ON clio_meri_memory_submissions TO capiro_app');
      }
    });
    it.each(['membership', 'identity', 'tenant'] as const)(
      'rechecks %s before observing schema',
      async (kind) => {
        const f = await fixture();
        if (kind === 'membership')
          await store.db.tenantMembership.updateMany({
            where: { tenantId: f.tenantId },
            data: { status: 'removed' },
          });
        if (kind === 'identity') f.ctx.clerkUserId = 'another-synthetic-user';
        if (kind === 'tenant') f.ctx.tenantId = randomUUID();
        await expect(f.read()).rejects.toMatchObject({ status: 403 });
      },
    );
  },
);
