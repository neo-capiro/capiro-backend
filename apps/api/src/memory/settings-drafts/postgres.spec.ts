import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MemoryAuthorizationService } from '../memory-authorization.service.js';
import {
  ownerRetentionCase,
  ownerRetentionDatabase,
} from '../memory-owner-retention.postgres-fixture.js';
import { fileDefForType } from '../memory-catalog.js';
import { SettingsMemoryDraftService } from './service.js';
import { expireSettingsMemoryDraftsInTx } from './retention.js';
import { writeDraft } from './store.js';
import { draftTarget, draftRequestHash, parseDraftWrite } from './input.js';

const url = process.env.MEMORY_DRAFT_TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'private Settings memory drafts with ordinary PostgreSQL role',
  () => {
    let store: Awaited<ReturnType<typeof ownerRetentionDatabase>>;
    let service: SettingsMemoryDraftService;
    beforeAll(async () => {
      store = await ownerRetentionDatabase(url!);
      const found = await store.db.$queryRaw<
        Array<{ ready: boolean }>
      >`SELECT to_regclass('memory_settings_drafts') IS NOT NULL AS ready`;
      if (!found[0]?.ready) {
        const { Client } = await import('pg');
        const db = new Client({ connectionString: url });
        await db.connect();
        try {
          await db.query(
            readFileSync(
              join(
                __dirname,
                '../../../prisma/migrations/20281029060000_settings_memory_drafts/migration.sql',
              ),
              'utf8',
            ),
          );
        } finally {
          await db.end();
        }
      }
      const prisma = {
        withTenantUser: <T>(tenantId: string, userId: string, fn: (tx: any) => Promise<T>) =>
          store.scoped(tenantId, async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_user',${userId},true)`;
            return fn(tx);
          }),
      } as PrismaService;
      service = new SettingsMemoryDraftService(prisma, new MemoryAuthorizationService(prisma));
    }, 60000);
    afterAll(async () => {
      await store?.db.$disconnect();
    });
    async function fixture(type = 'user-profile') {
      const f = await ownerRetentionCase(store);
      const ctx = { ...f, role: 'user_admin' } as unknown as TenantContext;
      const key = fileDefForType(type)!.sections[0]!.key;
      const input = (expectedRevision = 0) => ({
        requestId: randomUUID(),
        expectedRevision,
        action: 'save',
        baseItemId: null,
        baseVersion: null,
        sections: [{ key, body: 'Private proposed wording' }],
      });
      const slug = type === 'client-soul' ? f.clientId : type === 'firm-soul' ? 'firm' : 'me';
      const id = randomUUID();
      return { ...f, ctx, key, input, slug, id, type };
    }
    async function expire(id: string) {
      // Only this isolated synthetic database: age one row without a production clock override.
      await store.db.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE memory_settings_drafts DISABLE TRIGGER memory_settings_draft_guard`;
        await tx.$executeRaw`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-interval '721 hours' AS created)
        UPDATE memory_settings_drafts SET created_at=stamp.created,expires_at=stamp.created+interval '720 hours' FROM stamp WHERE id=${id}::uuid`;
        await tx.$executeRaw`ALTER TABLE memory_settings_drafts ENABLE TRIGGER memory_settings_draft_guard`;
      });
    }
    it('saves a private draft and an exact receipt without publishing or indexing', async () => {
      const f = await fixture();
      const body = f.input();
      const receipt = await service.save(f.ctx, f.type, f.slug, f.id, body);
      expect(receipt).toMatchObject({
        schema: 'memory-settings-draft-receipt/1',
        draftId: f.id,
        requestId: body.requestId,
        revision: 1,
        state: 'draft',
      });
      expect(await service.receipt(f.ctx, f.type, f.slug, f.id, body.requestId)).toEqual(receipt);
      expect(await service.read(f.ctx, f.type, f.slug, f.id)).toMatchObject({
        revision: 1,
        sections: body.sections,
        baseChanged: false,
      });
      const row = await store.db.memorySettingsDraft.findUniqueOrThrow({ where: { id: f.id } });
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(30 * 24 * 3600000);
      expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(await store.db.memoryCandidate.count({ where: { tenantId: f.tenantId } })).toBe(0);
      expect(await store.db.contextEmbedding.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });
    it('retains the original response across duplicate retries and later revisions', async () => {
      const f = await fixture();
      const first = f.input();
      const receipt = await service.save(f.ctx, f.type, f.slug, f.id, first);
      await service.save(f.ctx, f.type, f.slug, f.id, {
        ...f.input(1),
        sections: [{ key: f.key, body: 'Newer draft' }],
      });
      expect(await service.save(f.ctx, f.type, f.slug, f.id, first)).toEqual(receipt);
      await expect(
        service.save(f.ctx, f.type, f.slug, f.id, { ...first, sections: [] }),
      ).rejects.toThrow('different edits');
      expect((await service.read(f.ctx, f.type, f.slug, f.id)).revision).toBe(2);
    });
    it('serializes competing revisions and discards without changing active memory', async () => {
      const f = await fixture();
      await service.save(f.ctx, f.type, f.slug, f.id, f.input());
      const writes = await Promise.allSettled([
        service.save(f.ctx, f.type, f.slug, f.id, f.input(1)),
        service.save(f.ctx, f.type, f.slug, f.id, f.input(1)),
      ]);
      expect(writes.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
      expect(writes.filter((w) => w.status === 'rejected')).toHaveLength(1);
      await service.save(f.ctx, f.type, f.slug, f.id, {
        ...f.input(2),
        action: 'discard',
        sections: [],
      });
      expect(await service.read(f.ctx, f.type, f.slug, f.id)).toMatchObject({
        state: 'discarded',
        sections: null,
        revision: 3,
      });
      await expect(service.save(f.ctx, f.type, f.slug, f.id, f.input(3))).rejects.toThrow(
        'no longer editable',
      );
      expect(await store.db.memoryItem.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });
    it('binds an exact active source and flags changes without replacing the draft base', async () => {
      const f = await fixture();
      const item = await store.scoped(f.tenantId, (tx) =>
        tx.memoryItem.create({
          data: {
            tenantId: f.tenantId,
            ownerUserId: f.userId,
            visibility: 'user',
            memoryScope: 'user_private',
            memoryClass: 'user_preference',
            governedStatus: 'active',
            type: f.type,
            slug: f.userId,
            title: 'Synthetic profile',
            source: 'manual',
            sections: [{ key: f.key, heading: 'Profile', owner: 'human', body: 'Original' }],
          },
        }),
      );
      const base = await service.readFile(f.ctx, f.type, f.slug);
      expect(base.baseItemId).toBe(item.id);
      const write = { ...f.input(), baseItemId: base.baseItemId, baseVersion: base.baseVersion };
      await service.save(f.ctx, f.type, f.slug, f.id, write);
      await store.scoped(f.tenantId, (tx) =>
        tx.memoryItem.update({ where: { id: item.id }, data: { sections: [] } }),
      );
      expect((await service.read(f.ctx, f.type, f.slug, f.id)).baseChanged).toBe(true);
      await expect(
        service.save(f.ctx, f.type, f.slug, randomUUID(), { ...write, requestId: randomUUID() }),
      ).rejects.toThrow('Active memory changed');
      expect((await service.read(f.ctx, f.type, f.slug, f.id)).sections).toEqual(write.sections);
    });
    it('rejects another author or tenant at the ordinary role boundary', async () => {
      const f = await fixture();
      await service.save(f.ctx, f.type, f.slug, f.id, f.input());
      const other = await fixture();
      const rows = await store.scoped(f.tenantId, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_user',${other.userId},true)`;
        return tx.memorySettingsDraft.findMany({ where: { id: f.id } });
      });
      expect(rows).toEqual([]);
      await expect(service.read(other.ctx, f.type, 'me', f.id)).rejects.toThrow('unavailable');
      expect(
        await store.scoped(other.tenantId, (tx) =>
          tx.memorySettingsDraftReceipt.findMany({ where: { draftId: f.id } }),
        ),
      ).toEqual([]);
    });
    it('removal suppresses drafts and rejoining cannot revive the prior author period', async () => {
      const f = await fixture('firm-soul');
      await service.save(f.ctx, f.type, f.slug, f.id, f.input());
      await store.db.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'removed' },
      });
      await expect(service.read(f.ctx, f.type, f.slug, f.id)).rejects.toThrow('unavailable');
      await store.db.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'active' },
      });
      await expect(service.read(f.ctx, f.type, f.slug, f.id)).rejects.toThrow('unavailable');
      await expect(service.save(f.ctx, f.type, f.slug, f.id, f.input())).rejects.toThrow(
        'no longer available',
      );
      await service.save(f.ctx, f.type, f.slug, randomUUID(), f.input());
    });
    it('current client wall and closure stop draft access', async () => {
      const f = await fixture('client-soul');
      await service.save(f.ctx, f.type, f.slug, f.id, f.input());
      await store.db.client.update({ where: { id: f.clientId }, data: { memoryWall: true } });
      await expect(service.read(f.ctx, f.type, f.slug, f.id)).rejects.toThrow('unavailable');
      await store.db.client.update({
        where: { id: f.clientId },
        data: { memoryWall: false, status: 'archived' },
      });
      await expect(service.save(f.ctx, f.type, f.slug, f.id, f.input(1))).rejects.toThrow(
        'unavailable',
      );
    });
    it('expiry suppresses reads before cleanup, erases content and prevents late replay', async () => {
      const f = await fixture();
      const body = f.input();
      const receipt = await service.save(f.ctx, f.type, f.slug, f.id, body);
      await expire(f.id);
      await expect(service.read(f.ctx, f.type, f.slug, f.id)).rejects.toThrow('expired');
      expect(await service.receipt(f.ctx, f.type, f.slug, f.id, body.requestId)).toEqual(receipt);
      expect(
        await store.scoped(null, (tx) => expireSettingsMemoryDraftsInTx(tx, f.tenantId)),
      ).toEqual({ erased: 1, retainedExpired: 0 });
      expect(await store.db.memorySettingsDraft.findUnique({ where: { id: f.id } })).toMatchObject({
        state: 'expired',
        sections: null,
      });
      expect(await service.save(f.ctx, f.type, f.slug, f.id, body)).toEqual(receipt);
      await expect(service.save(f.ctx, f.type, f.slug, f.id, f.input())).rejects.toThrow(
        'no longer editable',
      );
    });
    it('retains a held draft while suppressing expired content and clears it after release', async () => {
      const f = await fixture();
      await service.save(f.ctx, f.type, f.slug, f.id, f.input());
      await store.db.memorySettingsDraft.update({ where: { id: f.id }, data: { legalHold: true } });
      await expire(f.id);
      expect(
        await store.scoped(null, (tx) => expireSettingsMemoryDraftsInTx(tx, f.tenantId)),
      ).toEqual({ erased: 0, retainedExpired: 1 });
      await expect(service.read(f.ctx, f.type, f.slug, f.id)).rejects.toThrow('expired');
      await store.db.memorySettingsDraft.update({
        where: { id: f.id },
        data: { legalHold: false },
      });
      expect(
        (await store.scoped(null, (tx) => expireSettingsMemoryDraftsInTx(tx, f.tenantId))).erased,
      ).toBe(1);
    });
    it('invalid sections, stale versions and receipt tampering produce no content effect', async () => {
      const f = await fixture();
      await expect(
        service.save(f.ctx, f.type, f.slug, f.id, {
          ...f.input(),
          sections: [{ key: 'engine', body: 'invalid' }],
        }),
      ).rejects.toThrow('Invalid');
      await expect(
        service.save(f.ctx, f.type, f.slug, f.id, {
          ...f.input(),
          baseItemId: randomUUID(),
          baseVersion: 'a'.repeat(64),
        }),
      ).rejects.toThrow('Active memory changed');
      expect(await store.db.memorySettingsDraft.count({ where: { tenantId: f.tenantId } })).toBe(0);
      const body = f.input();
      await service.save(f.ctx, f.type, f.slug, f.id, body);
      await expect(
        store.db.memorySettingsDraftReceipt.updateMany({
          where: { draftId: f.id },
          data: { revision: 77 },
        }),
      ).rejects.toThrow('immutable');
      await expect(
        store.db.memorySettingsDraft.update({
          where: { id: f.id },
          data: { authorUserId: randomUUID() },
        }),
      ).rejects.toThrow('immutable');
      await expect(store.db.memorySettingsDraft.delete({ where: { id: f.id } })).rejects.toThrow(
        'retained',
      );
    });
    it('rolls back a saved draft and receipt together when the enclosing operation fails', async () => {
      const f = await fixture();
      const target = draftTarget(f.type, f.slug, f.userId),
        write = parseDraftWrite(f.type, f.input());
      await expect(
        store.scoped(f.tenantId, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_user',${f.userId},true)`;
          await writeDraft(tx, f.ctx, target, f.id, write, draftRequestHash(target, f.id, write), {
            baseItemId: null,
            baseVersion: null,
          });
          throw Error('synthetic enclosing failure');
        }),
      ).rejects.toThrow('synthetic enclosing failure');
      expect(await store.db.memorySettingsDraft.count({ where: { id: f.id } })).toBe(0);
      expect(await store.db.memorySettingsDraftReceipt.count({ where: { draftId: f.id } })).toBe(0);
      expect((await service.save(f.ctx, f.type, f.slug, f.id, write)).revision).toBe(1);
    });
    it('source legal hold preserves expired draft content until release', async () => {
      const f = await fixture();
      const source = await store.scoped(f.tenantId, (tx) =>
        tx.memoryItem.create({
          data: {
            tenantId: f.tenantId,
            ownerUserId: f.userId,
            visibility: 'user',
            memoryScope: 'user_private',
            memoryClass: 'user_preference',
            governedStatus: 'active',
            type: f.type,
            slug: f.userId,
            title: 'Held source',
            source: 'manual',
            sections: [],
            legalHold: true,
          },
        }),
      );
      const base = await service.readFile(f.ctx, f.type, f.slug);
      await service.save(f.ctx, f.type, f.slug, f.id, {
        ...f.input(),
        baseItemId: base.baseItemId,
        baseVersion: base.baseVersion,
      });
      await expect(
        service.save(f.ctx, f.type, f.slug, f.id, {
          ...f.input(1),
          action: 'discard',
          sections: [],
          baseItemId: base.baseItemId,
          baseVersion: base.baseVersion,
        }),
      ).rejects.toThrow('legal hold');
      expect((await service.read(f.ctx, f.type, f.slug, f.id)).revision).toBe(1);
      await expire(f.id);
      expect(
        await store.scoped(null, (tx) => expireSettingsMemoryDraftsInTx(tx, f.tenantId)),
      ).toEqual({ erased: 0, retainedExpired: 1 });
      await store.db.memoryItem.update({ where: { id: source.id }, data: { legalHold: false } });
      expect(
        (await store.scoped(null, (tx) => expireSettingsMemoryDraftsInTx(tx, f.tenantId))).erased,
      ).toBe(1);
    });
  },
);
