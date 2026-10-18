import { Prisma } from '@prisma/client';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { MeriService } from './meri.service.js';

const requireFromApi = createRequire(resolve(__dirname, '../../package.json'));
const { PGlite } = requireFromApi('@electric-sql/pglite') as {
  PGlite: { create(): Promise<{
    exec(sql: string): Promise<unknown>;
    query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    close(): Promise<void>;
  }> };
};

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const approvedId = '44444444-4444-4444-8444-444444444444';
const unprojectedId = '55555555-5555-4555-8555-555555555555';

describe('legacy automatic recall while governance is enforced', () => {
  const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  afterEach(() => {
    if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
  });

  it('admits keyword fallback only through current canonical projections', async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    const read = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      expect(sql.text).toContain('mi.effective_from <= now()');
      expect(sql.text).toContain('mi.approved_at IS NOT NULL');
      expect(sql.text).toContain("mi.governed_status IN ('active', 'stale')");
      expect(sql.text).toContain("mi.slug = 'clio:' || cm.id::text");
      expect(sql.text).toContain('AND EXISTS (');
      expect(sql.text).toContain("mi.type = COALESCE(NULLIF(cm.metadata_jsonb #>> '{governance,canonicalType}', ''), 'note')");
      expect(sql.text).toContain('ORDER BY cm.updated_at DESC');
      expect(sql.text.indexOf("mi.governed_status IN ('active', 'stale')")).toBeLessThan(
        sql.text.indexOf('LIMIT 20'),
      );
      expect(sql.values).toContainEqual([clientId]);
      // SQL has excluded 20 newer ineligible or unprojected rows before LIMIT.
      return [{ id: approvedId, key: 'approved-budget', value: 'Approved budget constraint' }];
    });
    const findMany = jest.fn(async () => [
      { id: unprojectedId, key: 'unprojected-budget', value: 'Unreviewed old budget' },
    ]);
    const tx = {
      clioMemory: { findMany },
      $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
      $queryRaw: read,
    };
    // Constructor dependencies are unrelated to the recall branch under test.
    const service = Object.create(MeriService.prototype) as any;
    service.prisma = { withTenantUser: (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx) };
    service.semanticMemorySearch = jest.fn(async () => []);

    const result = await service.clioRecall(tenantId, userId, 'budget', clientId);
    expect(result.map((row: { key: string }) => row.key)).toEqual(['approved-budget']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns an older approved canonical projection beyond twenty newer ineligible rows', async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'enforce';
    const db = await PGlite.create();
    try {
      await db.exec(`
        CREATE TABLE clio_memory (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL, key text NOT NULL, value text NOT NULL,
          scope text NOT NULL, owner_user_id uuid, client_id uuid,
          metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
          expires_at timestamptz, updated_at timestamptz NOT NULL
        );
        CREATE TABLE memory_items (
          id uuid PRIMARY KEY, tenant_id uuid NOT NULL, slug text NOT NULL,
          type text NOT NULL DEFAULT 'note',
          client_id uuid, owner_user_id uuid, visibility text NOT NULL DEFAULT 'tenant',
          status text NOT NULL DEFAULT 'active', memory_class text NOT NULL DEFAULT 'institutional_authoritative',
          memory_scope text NOT NULL DEFAULT 'firm', approved_by_user_id uuid,
          approved_at timestamptz, source_type text NOT NULL DEFAULT 'manual',
          source_ref text, source_id text, sensitivity text NOT NULL DEFAULT 'normal',
          expires_at timestamptz, valid_until timestamptz, effective_from timestamptz,
          governed_status text NOT NULL DEFAULT 'active', conflict_status text NOT NULL DEFAULT 'none',
          controlling_item_id uuid
        );
      `);
      await db.query(`
        INSERT INTO clio_memory(id, tenant_id, key, value, scope, updated_at)
        SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
          $1::uuid, 'unreviewed-' || i, 'budget draft', 'firm',
          '2026-10-01T00:00:00Z'::timestamptz
        FROM generate_series(1, 20) i
      `, [tenantId]);
      await db.query(`
        INSERT INTO clio_memory(id, tenant_id, key, value, scope, metadata_jsonb, updated_at)
        VALUES ($1::uuid, $2::uuid, 'approved-budget', 'Approved budget constraint',
          'firm', '{"governance":{"canonicalType":"client-compass"}}'::jsonb,
          '2020-01-01T00:00:00Z'::timestamptz)
      `, [approvedId, tenantId]);
      await db.query(`
        INSERT INTO memory_items(id, tenant_id, type, slug, approved_by_user_id, approved_at, source_ref)
        VALUES ($1::uuid, $2::uuid, 'client-compass', 'clio:' || $3::text, $4::uuid,
          '2020-01-01T00:00:00Z'::timestamptz, $3::text)
      `, [unprojectedId, tenantId, approvedId, userId]);
      // A revoked canonical projection must not be revived by an active row
      // with the same slug and client but a different type.
      const collidedId = '66666666-6666-4666-8666-666666666666';
      await db.query(`
        INSERT INTO clio_memory(id, tenant_id, key, value, scope, metadata_jsonb, updated_at)
        VALUES ($1::uuid, $2::uuid, 'revoked-budget', 'Revoked budget rule', 'firm',
          '{"governance":{"canonicalType":"client-compass"}}'::jsonb,
          '2026-10-01T00:00:00Z'::timestamptz)
      `, [collidedId, tenantId]);
      await db.query(`
        INSERT INTO memory_items(id, tenant_id, type, slug, approved_by_user_id, approved_at, source_ref)
        VALUES
          ('77777777-7777-4777-8777-777777777777'::uuid, $1::uuid, 'note',
            'clio:' || $2::text, $3::uuid, now(), $2::text),
          ('88888888-8888-4888-8888-888888888888'::uuid, $1::uuid, 'client-compass',
            'clio:' || $2::text, $3::uuid, now(), $2::text)
      `, [tenantId, collidedId, userId]);
      await db.query(`
        UPDATE memory_items SET governed_status='revoked', status='revoked'
        WHERE id='88888888-8888-4888-8888-888888888888'::uuid
      `);
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = Prisma.sql(strings, ...values);
          return (await db.query(sql.text, sql.values)).rows;
        },
      };
      const service = Object.create(MeriService.prototype) as any;
      service.prisma = {
        withTenantUser: (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx),
      };
      service.semanticMemorySearch = jest.fn(async () => []);

      const result = await service.clioRecall(tenantId, userId, 'budget', null);
      expect(result.map((row: { key: string }) => row.key)).toEqual(['approved-budget']);
    } finally {
      await db.close();
    }
  });
});
