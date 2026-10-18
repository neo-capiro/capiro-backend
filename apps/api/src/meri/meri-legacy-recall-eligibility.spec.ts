import { Prisma } from '@prisma/client';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

describe('legacy automatic recall uses canonical eligibility in either lifecycle mode', () => {
  const prior = process.env.MEMORY_GOVERNANCE_LIFECYCLE;
  afterEach(() => {
    if (prior === undefined) delete process.env.MEMORY_GOVERNANCE_LIFECYCLE;
    else process.env.MEMORY_GOVERNANCE_LIFECYCLE = prior;
  });

  it.each(['off', 'enforce'])('admits keyword fallback only through current canonical projections with lifecycle %s', async (mode) => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = mode;
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

  it.each(['off', 'enforce'])('returns an older approved projection beyond twenty newer ineligible rows with lifecycle %s', async (mode) => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = mode;
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
      // A legacy-active row may be held by governance alone. A future row may
      // likewise have an active source and projection but not yet be effective.
      await db.query(`
        INSERT INTO clio_memory(id, tenant_id, key, value, scope, updated_at)
        VALUES
          ('99999999-9999-4999-8999-999999999999'::uuid, $1::uuid,
           'held-budget', 'Held budget', 'firm', now()),
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, $1::uuid,
           'future-budget', 'Future budget', 'firm', now()),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, $1::uuid,
           'foreign-budget', 'Foreign private budget', 'user_private', now())
      `, [tenantId]);
      await db.query(`
        UPDATE clio_memory SET owner_user_id=$1::uuid
        WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
      `, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
      await db.query(`
        INSERT INTO memory_items(id, tenant_id, slug, approved_by_user_id,
          approved_at, source_ref, memory_class, memory_scope, owner_user_id,
          visibility, governed_status, effective_from)
        VALUES
          ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid, $1::uuid,
           'clio:99999999-9999-4999-8999-999999999999', $2::uuid, now(), 'held',
           'institutional_authoritative', 'firm', null, 'tenant', 'revoked', null),
          ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid, $1::uuid,
           'clio:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $2::uuid, now(), 'future',
           'institutional_authoritative', 'firm', null, 'tenant', 'active', now() + interval '1 day'),
          ('ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid, $1::uuid,
           'clio:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, null, 'foreign',
           'user_preference', 'user_private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
           'user', 'active', null)
      `, [tenantId, userId]);
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

  it.each([false, true])('rechecks Clio-derived steering before prompt injection when the client wall allows=%s', async (allowed) => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off';
    const clioId = '66666666-6666-4666-8666-666666666666';
    const rendered = [
      { id: approvedId, slug: 'firm', layer: 'firm-identity', type: 'firm-soul',
        title: 'Firm', body: 'Ordinary firm context' },
      { id: clioId, slug: `clio:${clioId}`, layer: 'client-steering', type: 'client-compass',
        title: 'Client', body: 'Clio client context' },
    ];
    const queries: Prisma.Sql[] = [];
    const tx = {
      $queryRawUnsafe: jest.fn(async () => [{ allowed }]),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(Prisma.sql(strings, ...values));
        return allowed ? [{ id: clioId }] : [];
      }),
    };
    const service = Object.create(MeriService.prototype) as any;
    service.prisma = {
      withTenant: (_tenant: string, run: (tx: unknown) => unknown) => run(tx),
      withTenantUser: (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx),
    };
    service.contextCompiler = { compile: jest.fn(async () => ({ rendered })) };

    const output = await service.loadUserVoiceContext({ tenantId, userId }, clientId);
    expect(output).toContain('Ordinary firm context');
    expect(output?.includes('Clio client context')).toBe(allowed);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("mi.governed_status IN ('active', 'stale')");
    expect(queries[0]!.text).toContain('mi.effective_from <= now()');
    expect(queries[0]!.text).toContain('mi.owner_user_id');
    expect(queries[0]!.values).toContainEqual(allowed ? [clientId] : []);
  });

  it('retains ordinary voice files but withholds Clio steering when canonical columns are unavailable', async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off';
    const service = Object.create(MeriService.prototype) as any;
    service.prisma = {
      withTenantUser: (_tenant: string, _user: string, run: (tx: unknown) => unknown) =>
        run({ $queryRaw: jest.fn(async () => { throw new Error('missing governed_status'); }) }),
    };
    service.contextCompiler = { compile: jest.fn(async () => ({ rendered: [
      { id: approvedId, slug: 'voice', layer: 'user-voice', type: 'user-voice',
        title: 'Voice', body: 'Ordinary voice context' },
      { id: unprojectedId, slug: `clio:${unprojectedId}`, layer: 'firm-identity',
        type: 'firm-soul', title: 'Legacy', body: 'Clio held context' },
    ] })) };

    const output = await service.loadUserVoiceContext({ tenantId, userId }, null);
    expect(output).toContain('Ordinary voice context');
    expect(output).not.toContain('Clio held context');
  });

  it('routes off-mode semantic Clio recall through canonical eligibility after a stubbed embedding response', async () => {
    process.env.MEMORY_GOVERNANCE_LIFECYCLE = 'off';
    const priorFetch = global.fetch;
    const fetchStub = jest.fn(async () => ({ ok: true,
      json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }),
    }));
    global.fetch = fetchStub as unknown as typeof fetch;
    try {
      const queries: Prisma.Sql[] = [];
      const tx = {
        $queryRawUnsafe: jest.fn(async () => [{ allowed: false }]),
        $queryRaw: jest.fn(async (query: Prisma.Sql) => {
          queries.push(query);
          return [{ key: 'budget', value: 'Approved budget', score: 0.9 }];
        }),
      };
      const service = Object.create(MeriService.prototype) as any;
      service.prisma = { withTenantUser: (_tenant: string, _user: string,
        run: (tx: unknown) => unknown) => run(tx) };
      service.config = { get: (key: string) => key === 'OPENAI_API_KEY' ? 'test-only-key' : undefined };

      const result = await service.semanticMemorySearch(tenantId, userId, 'budget', 8, clientId);
      expect(result).toEqual([{ key: 'budget', value: 'Approved budget', score: 0.9 }]);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain('mi.effective_from <= now()');
      expect(queries[0]!.text).toContain("mi.governed_status IN ('active', 'stale')");
      expect(queries[0]!.values).toContainEqual([]);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1); // wall only
      expect(fetchStub).toHaveBeenCalledTimes(1); // local stub; no provider call
    } finally {
      global.fetch = priorFetch;
    }
  });

  it('has no legacy projection branch that can bypass canonical current-memory eligibility', () => {
    const source = readFileSync(resolve(__dirname, 'meri.service.ts'), 'utf8');
    const projection = source.slice(source.indexOf('private async projectionRecall('),
      source.indexOf('private toRecalledRows('));
    expect(projection).toContain('canonicalMemoryEligibilitySql({');
    expect(projection).not.toContain('$queryRawUnsafe');
    expect(projection).not.toContain('governedRecallSuppressionEnabled()');
  });
});
