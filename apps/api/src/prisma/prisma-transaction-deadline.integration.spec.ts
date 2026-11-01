import { PrismaService } from './prisma.service.js';

/** Existing DB coordinator only: the same explicit disposable local database
 * contract as the context fixture. No ambient DATABASE_URL, schema/role changes,
 * installs, server startup or server shutdown. Two bounded real-client checks.
 */
const fixtureUrl = process.env.PRISMA_TENANT_CONTEXT_TEST_URL;
const databaseSuite = fixtureUrl ? describe : describe.skip;
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

databaseSuite('Prisma absolute deadline on an owned single-connection PostgreSQL16 pool', () => {
  let prisma: PrismaService;
  let pid: number;
  const backend = async () => {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    if (!row) throw new Error('Missing synthetic connection');
    return row.pid;
  };
  beforeAll(async () => {
    const url = new URL(fixtureUrl!);
    if (!['postgresql:', 'postgres:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/^\/prisma_context_synthetic_[a-z0-9_]+$/.test(url.pathname)) {
      throw new Error('Expected an explicitly allocated local synthetic Prisma context database');
    }
    url.search = '';
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '5');
    url.searchParams.set('connect_timeout', '5');
    prisma = new PrismaService({ datasources: { db: { url: url.toString() } } });
    await prisma.$connect();
    const [identity] = await prisma.$queryRaw<Array<{ superuser: boolean; bypass: boolean; version: number }>>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypass,
        current_setting('server_version_num')::int AS version FROM pg_roles WHERE rolname = current_user`;
    expect(identity).toMatchObject({ superuser: false, bypass: false });
    expect(identity?.version).toBeGreaterThanOrEqual(160000);
    expect(identity?.version).toBeLessThan(170000);
    pid = await backend();
  }, 15000);
  afterAll(async () => { await prisma?.$disconnect(); });

  it('uses the remaining acquisition allocation while the sole connection is held', async () => {
    const acquired = gate(), release = gate();
    const holder = prisma.$transaction(async () => {
      acquired.release();
      await release.promise;
    }, { timeout: 4000, maxWait: 1000 });
    // A setup failure must reject the gate wait rather than strand the test.
    const holderFailure = holder.catch(error => { acquired.release(); throw error; });
    void holderFailure.catch(() => undefined);
    const work = jest.fn(async () => 'unexpected');
    try {
      await acquired.promise;
      const started = Date.now();
      const failure = await prisma.withTenant('synthetic-A', work,
        { timeoutMs: 200, deadline: { at: started + 200 } }).then(
          () => null, error => error as { code?: string });
      expect(['P2028', 'PRISMA_TRANSACTION_DEADLINE_EXCEEDED']).toContain(failure?.code);
      expect(work).not.toHaveBeenCalled();
      // Native scheduling is observed, not promised as a hard200ms response.
      expect(Date.now() - started).toBeLessThan(1000);
    } finally { release.release(); await holderFailure; }
    expect(await backend()).toBe(pid);
  }, 6000);

  it('cancels a long query under the shared allowance and awaits rollback before reuse', async () => {
    let completed = false;
    const started = Date.now();
    const failure = await prisma.withTenant('synthetic-A', async tx => {
      // A scalar avoids Prisma's unsupported PostgreSQL void deserialization.
      await tx.$queryRaw`SELECT 1::int AS value FROM pg_sleep(2)`;
      completed = true;
    }, { timeoutMs: 500, deadline: { at: started + 500 } }).then(
      () => null, error => error as { code?: string; meta?: { code?: string } });
    expect(completed).toBe(false);
    expect(failure).not.toBeNull();
    const timeout = failure?.code === 'PRISMA_TRANSACTION_DEADLINE_EXCEEDED'
      || failure?.code === 'P2028'
      || (failure?.code === 'P2010' && failure.meta?.code === '57014');
    expect(timeout).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await backend()).toBe(pid);
    const rows = await prisma.withTenant('synthetic-B', tx => tx.$queryRaw<Array<{ tenant: string; bypass: string }>>`
      SELECT current_setting('app.current_tenant') AS tenant,
        current_setting('app.bypass_rls') AS bypass`);
    expect(rows).toEqual([{ tenant: 'synthetic-B', bypass: 'off' }]);
  }, 6000);
});
