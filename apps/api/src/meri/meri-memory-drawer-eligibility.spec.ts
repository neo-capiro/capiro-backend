import { Prisma } from '@prisma/client';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';

const requireFromApi = createRequire(resolve(__dirname, '../../package.json'));
const { PGlite } = requireFromApi('@electric-sql/pglite') as {
  PGlite: { create(): Promise<{
    exec(sql: string): Promise<unknown>;
    query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    close(): Promise<void>;
  }> };
};

const tenant = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const allowedClient = '33333333-3333-4333-8333-333333333333';
const deniedClient = '44444444-4444-4444-8444-444444444444';
const allowedMemory = '55555555-5555-4555-8555-555555555555';
const deniedMemory = '66666666-6666-4666-8666-666666666666';
const revokedMemory = '77777777-7777-4777-8777-777777777777';
const ctx = { tenantId: tenant, userId: user, role: 'capiro_admin' } as TenantContext;

describe('Meri memory drawer source eligibility', () => {
  const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  afterEach(() => {
    if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
  });

  it('applies client wall and terminal filtering before the limit on both GET lists', async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    const db = await PGlite.create();
    try {
      await db.exec(`
        CREATE TABLE clients (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL,
          memory_wall boolean NOT NULL);
        CREATE TABLE client_memory_access (tenant_id uuid NOT NULL, client_id uuid NOT NULL,
          user_id uuid NOT NULL);
        CREATE TABLE clio_memory (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL, key text NOT NULL, value text NOT NULL,
          scope text NOT NULL, owner_user_id uuid, client_id uuid, source text,
          metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
          expires_at timestamptz, updated_at timestamptz NOT NULL
        );
        CREATE TABLE memory_candidate (
          tenant_id uuid NOT NULL, committed_memory_id uuid, committed_memory_item_id uuid
        );
        CREATE TABLE memory_items (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL, type text NOT NULL DEFAULT 'note',
          slug text NOT NULL, client_id uuid, owner_user_id uuid,
          visibility text NOT NULL DEFAULT 'tenant', status text NOT NULL DEFAULT 'active',
          memory_class text NOT NULL DEFAULT 'client_steering',
          memory_scope text NOT NULL DEFAULT 'client', approved_by_user_id uuid,
          approved_at timestamptz, source_type text NOT NULL DEFAULT 'manual',
          source_ref text, source_id text, sensitivity text NOT NULL DEFAULT 'normal',
          expires_at timestamptz, valid_until timestamptz, effective_from timestamptz,
          governed_status text NOT NULL DEFAULT 'active',
          conflict_status text NOT NULL DEFAULT 'none', controlling_item_id uuid
        );
      `);
      await db.query(`INSERT INTO clients(id, tenant_id, name, memory_wall) VALUES
        ($1::uuid, $3::uuid, 'Allowed client', false),
        ($2::uuid, $3::uuid, 'Denied client', true)`, [allowedClient, deniedClient, tenant]);
      for (const [id, clientId, updatedAt] of [
        [deniedMemory, deniedClient, '2026-10-03T00:00:00Z'],
        [revokedMemory, null, '2026-10-02T00:00:00Z'],
        [allowedMemory, allowedClient, '2026-10-01T00:00:00Z'],
      ]) {
        await db.query(`INSERT INTO clio_memory
          (id, tenant_id, key, value, scope, client_id, source, metadata_jsonb, updated_at)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'conversation',
            '{"createdBy":"auto"}'::jsonb, $7::timestamptz)`,
          [id, tenant, `key-${id}`, `value-${id}`, clientId ? 'client' : 'firm', clientId, updatedAt]);
        await db.query(`INSERT INTO memory_items
          (id, tenant_id, slug, client_id, memory_scope, approved_by_user_id,
           approved_at, source_ref, status, governed_status)
          VALUES ($1::uuid, $2::uuid, 'clio:' || $3::text, $4::uuid, $5,
            $6::uuid, now(), $3::text, $7, $7)`,
          [id, tenant, id, clientId, clientId ? 'client' : 'firm', user,
            id === revokedMemory ? 'revoked' : 'active']);
      }
      const tx = {
        $queryRaw: async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
          const sql = 'text' in first ? first : Prisma.sql(first, ...values);
          return (await db.query(sql.text, sql.values)).rows;
        },
        client: {
          findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
            (await db.query('SELECT id::text AS id, name FROM clients WHERE id = ANY($1::uuid[])',
              [where.id.in])).rows,
        },
      };
      const service = Object.create(MeriService.prototype) as any;
      service.prisma = { withTenantUser: (_tenant: string, _user: string,
        run: (tx: unknown) => unknown) => run(tx) };

      const all = await service.listMemories(ctx, 1);
      const recent = await service.listRecentLearnedMemories(ctx, 1);
      expect(all.map((row: { id: string }) => row.id)).toEqual([allowedMemory]);
      expect(recent.map((row: { id: string }) => row.id)).toEqual([allowedMemory]);
      expect(all[0].clientName).toBe('Allowed client');
    } finally {
      await db.close();
    }
  });
});
