import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MemoryOwnerItemsService } from './memory-owner-items.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user',
  role: 'standard_user',
};
const walled = '33333333-3333-4333-8333-333333333333';
const deniedItem = '44444444-4444-4444-8444-444444444444';
const allowedItem = '55555555-5555-4555-8555-555555555555';

describe('owner memory picker SQL boundary', () => {
  it('fills the page past a newer walled item, then includes it only with a current grant', async () => {
    const db = new PGlite();
    const oldLifecycle = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    const oldTenants = process.env.MEMORY_GOVERNANCE_TENANTS;
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    process.env.MEMORY_GOVERNANCE_TENANTS = 'all';
    try {
      await db.exec(`
        CREATE TABLE clients (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
          status text NOT NULL, memory_wall boolean NOT NULL
        );
        CREATE TABLE client_memory_access (
          tenant_id uuid NOT NULL, client_id uuid NOT NULL, user_id uuid NOT NULL
        );
        CREATE TABLE memory_items (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
          owner_user_id uuid NOT NULL, client_id uuid,
          memory_scope text NOT NULL, visibility text NOT NULL,
          legal_hold boolean NOT NULL, controlling_item_id uuid,
          status text NOT NULL, governed_status text NOT NULL,
          conflict_status text, effective_from timestamptz,
          valid_until timestamptz, expires_at timestamptz,
          title text NOT NULL, sections_jsonb jsonb NOT NULL,
          updated_at timestamptz NOT NULL
        );
      `);
      await db.query(
        `INSERT INTO clients (id, tenant_id, status, memory_wall)
         VALUES ($1, $2, 'active', true)`,
        [walled, ctx.tenantId],
      );
      await db.query(
        `INSERT INTO memory_items
          (id,tenant_id,owner_user_id,client_id,memory_scope,visibility,legal_hold,
           status,governed_status,conflict_status,title,sections_jsonb,updated_at)
         VALUES
          ($1,$3,$4,$5,'user_private','user',false,'active','active','none',
           'Denied newer','[{"body":"Secret"}]'::jsonb,'2026-10-18T13:00:00.123456Z'),
          ($2,$3,$4,NULL,'user_private','user',false,'active','active','none',
           'Allowed older','[{"body":"Known"}]'::jsonb,'2026-10-18T12:00:00.654321Z')`,
        [deniedItem, allowedItem, ctx.tenantId, ctx.userId, walled],
      );
      const prisma = {
        withTenantUser: async (
          _tenant: string,
          _user: string,
          run: (tx: object) => Promise<unknown>,
        ) =>
          run({
            $queryRaw: async (sql: Prisma.Sql) => (await db.query(sql.text, sql.values)).rows,
          }),
      } as unknown as PrismaService;
      const service = new MemoryOwnerItemsService(prisma);

      const withoutGrant = await service.list(ctx, { limit: 1 });
      expect(withoutGrant.items.map((item) => item.id)).toEqual([allowedItem]);
      expect(withoutGrant.nextCursor).toBeNull();

      await db.query(
        'INSERT INTO client_memory_access (tenant_id,client_id,user_id) VALUES ($1,$2,$3)',
        [ctx.tenantId, walled, ctx.userId],
      );
      const previewWithoutClient = await service.list(ctx, { limit: 1, visibleClientIds: [] });
      expect(previewWithoutClient.items.map((item) => item.id)).toEqual([allowedItem]);
      expect(previewWithoutClient.nextCursor).toBeNull();
      const previewWithClient = await service.list(ctx, { limit: 1, visibleClientIds: [walled] });
      expect(previewWithClient.items.map((item) => item.id)).toEqual([deniedItem]);
      const firstPage = await service.list(ctx, { limit: 1 });
      expect(firstPage.items.map((item) => item.id)).toEqual([deniedItem]);
      expect(firstPage.items[0]?.clientId).toBe(walled);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await service.list(ctx, { limit: 1, cursor: firstPage.nextCursor });
      expect(secondPage.items.map((item) => item.id)).toEqual([allowedItem]);
      expect(secondPage.nextCursor).toBeNull();

      await db.query('DELETE FROM client_memory_access WHERE user_id=$1', [ctx.userId]);
      await db.query('UPDATE clients SET status=$1 WHERE id=$2', ['archived', walled]);
      const afterRemoval = await service.list(ctx, { limit: 1 });
      expect(afterRemoval.items.map((item) => item.id)).toEqual([allowedItem]);
    } finally {
      if (oldLifecycle === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
      else process.env.MEMORY_GOVERNANCE_LIFECYCLE = oldLifecycle;
      if (oldTenants === undefined) delete process.env.MEMORY_GOVERNANCE_TENANTS;
      else process.env.MEMORY_GOVERNANCE_TENANTS = oldTenants;
      await db.close();
    }
  }, 60_000);
});
