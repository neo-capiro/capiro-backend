import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service.js';

/** Owner-operated, disposable LOCAL PostgreSQL only. No DATABASE_URL fallback.
 * Supply an ordinary login with CREATE on an isolated database named
 * prisma_context_synthetic_*. No production schema or role changes are needed.
 * One real Prisma connection is deliberately reused with hostile session GUCs.
 */
const fixtureUrl = process.env.PRISMA_TENANT_CONTEXT_TEST_URL;
const databaseSuite = fixtureUrl ? describe : describe.skip;

databaseSuite('Prisma tenant context on a reused PostgreSQL connection', () => {
  let prisma: PrismaService;
  let created = false;
  let pid: number;
  const schemaName = `prisma_context_${randomUUID().replaceAll('-', '')}`;
  const schema = Prisma.raw(`"${schemaName}"`);
  const table = Prisma.raw(`"${schemaName}".records`);
  type Context = { pid: number; tenant: string; actor: string; bypass: string; security: string };
  const context = async (tx: Prisma.TransactionClient) => {
    const [row] = await tx.$queryRaw<Context[]>`SELECT pg_backend_pid() AS pid,
      current_setting('app.current_tenant', true) AS tenant,
      current_setting('app.current_user', true) AS actor,
      current_setting('app.bypass_rls', true) AS bypass,
      current_setting('row_security') AS security`;
    if (!row) throw new Error('Missing synthetic connection context');
    return row;
  };
  const ids = async (tx: Prisma.TransactionClient) =>
    (await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM ${table} ORDER BY id`))
      .map(row => row.id);
  const contaminate = async () => {
    await prisma.$executeRaw`SELECT set_config('app.current_tenant', 'B', false),
      set_config('app.current_user', 'alice', false),
      set_config('app.bypass_rls', 'on', false), set_config('row_security', 'on', false)`;
  };
  const expectInheritedSession = async () => {
    expect(await context(prisma)).toEqual({ pid, tenant: 'B', actor: 'alice', bypass: 'on', security: 'on' });
  };

  beforeAll(async () => {
    const url = new URL(fixtureUrl!);
    if (!['postgresql:', 'postgres:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/^\/prisma_context_synthetic_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error('Expected an explicitly allocated local synthetic Prisma context database');
    }
    // Disallow proxy/alternate-host options; use one direct owned connection.
    url.search = '';
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '5');
    url.searchParams.set('connect_timeout', '5');
    prisma = new PrismaService({ datasources: { db: { url: url.toString() } } });
    await prisma.$connect();
    await prisma.$executeRaw`SET statement_timeout = '3000ms'`;
    await prisma.$executeRaw`SET lock_timeout = '1000ms'`;
    const [role] = await prisma.$queryRaw<Array<{ superuser: boolean; bypass: boolean }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ superuser: false, bypass: false });
    const [server] = await prisma.$queryRaw<Array<{ version: number; database: string; direct: boolean }>>`
      SELECT current_setting('server_version_num')::int AS version,
        current_database() AS database, current_user = session_user AS direct`;
    expect(server?.version).toBeGreaterThanOrEqual(160000);
    expect(server?.version).toBeLessThan(170000);
    expect(server?.database).toBe(url.pathname.slice(1));
    expect(server?.direct).toBe(true);
    await prisma.$executeRaw(Prisma.sql`CREATE SCHEMA ${schema}`);
    created = true;
    await prisma.$executeRaw(Prisma.sql`CREATE TABLE ${table} (
      id text PRIMARY KEY, tenant_id text NOT NULL, owner_id text)`);
    await prisma.$executeRaw(Prisma.sql`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await prisma.$executeRaw(Prisma.sql`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await prisma.$executeRaw(Prisma.sql`CREATE POLICY tenant_context ON ${table}
      USING (current_setting('app.bypass_rls', true) = 'on' OR (
        tenant_id = current_setting('app.current_tenant', true) AND
        (owner_id IS NULL OR owner_id = NULLIF(current_setting('app.current_user', true), ''))))
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR (
        tenant_id = current_setting('app.current_tenant', true) AND
        (owner_id IS NULL OR owner_id = NULLIF(current_setting('app.current_user', true), ''))))`);
    await prisma.withSystem(tx => tx.$executeRaw(Prisma.sql`INSERT INTO ${table} VALUES
      ('a-public','A',NULL), ('a-alice','A','alice'), ('a-bob','A','bob'), ('b-public','B',NULL)`));
    await contaminate();
    pid = (await context(prisma)).pid;
  }, 20_000);

  beforeEach(async () => { await contaminate(); });

  afterAll(async () => {
    if (!prisma) return;
    try {
      if (created) await prisma.$executeRaw(Prisma.sql`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      // No borrowed session is returned to a pool: this suite owns the client.
      await prisma.$disconnect();
    }
  });

  it('reproduces the unsafe tenant-only SET LOCAL precondition on actual raw rows', async () => {
    const rows = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', 'A', true)`;
      return ids(tx);
    });
    expect(rows).toEqual(['a-alice', 'a-bob', 'a-public', 'b-public']);
    await expectInheritedSession();
  });

  it('overrides bypass and absent user authority before tenant raw reads', async () => {
    await prisma.withTenant('A', async tx => {
      expect(await context(tx)).toEqual({ pid, tenant: 'A', actor: '', bypass: 'off', security: 'on' });
      expect(await ids(tx)).toEqual(['a-public']);
    });
    await expectInheritedSession();
  });

  it('binds only the requested user, not the inherited user or other tenant', async () => {
    await prisma.withTenantUser('A', 'bob', async tx => {
      expect(await context(tx)).toEqual({ pid, tenant: 'A', actor: 'bob', bypass: 'off', security: 'on' });
      expect(await ids(tx)).toEqual(['a-bob', 'a-public']);
    });
    await expectInheritedSession();
  });

  it('refuses cross-tenant writes through raw SQL and rolls back', async () => {
    await expect(prisma.withTenant('A', tx => tx.$executeRaw(Prisma.sql`
      INSERT INTO ${table} VALUES ('forbidden','B',NULL)`)))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    await expectInheritedSession();
    expect(await prisma.withSystem(ids)).not.toContain('forbidden');
  });

  it('refuses a different private owner through withTenantUser', async () => {
    await expect(prisma.withTenantUser('A', 'bob', tx => tx.$executeRaw(Prisma.sql`
      INSERT INTO ${table} VALUES ('forbidden-owner','A','alice')`)))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    expect(await prisma.withSystem(ids)).not.toContain('forbidden-owner');
  });

  it('preserves explicit system read/write access and neutralizes the next tenant call', async () => {
    await prisma.$executeRaw`SELECT set_config('app.bypass_rls', 'off', false)`;
    await prisma.withSystem(async tx => {
      expect((await context(tx)).bypass).toBe('on');
      expect(await ids(tx)).toHaveLength(4);
      await tx.$executeRaw(Prisma.sql`INSERT INTO ${table} VALUES ('system-write','B',NULL)`);
      await tx.$executeRaw(Prisma.sql`DELETE FROM ${table} WHERE id = 'system-write'`);
    });
    expect(await prisma.withTenant('A', ids)).toEqual(['a-public']);
  });

  it('awaits callback rollback, then safely reuses the same connection', async () => {
    const failure = new Error('synthetic callback failure');
    await expect(prisma.withTenantUser('A', 'bob', async tx => {
      await tx.$executeRaw(Prisma.sql`INSERT INTO ${table} VALUES ('rolled-back','A','bob')`);
      throw failure;
    })).rejects.toBe(failure);
    await expectInheritedSession();
    expect(await prisma.withTenantUser('A', 'bob', ids)).toEqual(['a-bob', 'a-public']);
  });

  it('reestablishes tenant context after a retryable callback rollback', async () => {
    let attempts = 0;
    const result = await prisma.withTenantRetry('A', async tx => {
      expect((await context(tx)).bypass).toBe('off');
      expect(await ids(tx)).toEqual(['a-public']);
      if (++attempts === 1) throw new Error('synthetic deadlock detected');
      return ids(tx);
    }, { retries: 1 });
    expect(attempts).toBe(2);
    expect(result).toEqual(['a-public']);
    await expectInheritedSession();
  });

  it('sets read-only before context SELECT and retains explicit read-only behavior', async () => {
    expect(await prisma.withTenant('A', ids, { readOnly: true, isolationLevel: 'RepeatableRead' }))
      .toEqual(['a-public']);
    await expect(prisma.withTenant('A', tx => tx.$executeRaw(Prisma.sql`
      INSERT INTO ${table} VALUES ('read-only-write','A',NULL)`), { readOnly: true }))
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '25006' } });
  });

  it('overrides inherited row_security=off without altering its session default', async () => {
    await prisma.$executeRaw`SELECT set_config('row_security', 'off', false)`;
    expect(await prisma.withTenant('A', ids)).toEqual(['a-public']);
    expect((await context(prisma)).security).toBe('off');
  });

  it('keeps queued tenant and user calls isolated on the same real pooled connection', async () => {
    const result = await Promise.all([
      prisma.withTenant('A', async tx => ({ context: await context(tx), ids: await ids(tx) })),
      prisma.withTenant('B', async tx => ({ context: await context(tx), ids: await ids(tx) })),
      prisma.withTenantUser('A', 'alice', async tx => ({ context: await context(tx), ids: await ids(tx) })),
    ]);
    expect(result.map(r => r.context.pid)).toEqual([pid, pid, pid]);
    expect(result.map(r => r.ids)).toEqual([['a-public'], ['b-public'], ['a-alice', 'a-public']]);
    await expectInheritedSession();
  });
});
