import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { withMailQueryDeadline } from './mail-query-deadline.js';

const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
(configPath ? describe : describe.skip)('actual owned PostgreSQL mail-query cancellation', () => {
  let prisma: PrismaService;
  const tenant = '00000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    assert.ok(configPath && isAbsolute(configPath));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 55433);
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    assert.ok(isAbsolute(config.dataDirectory));
    const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
    url.username = config.user; url.password = config.password;
    // One connection proves cancellation returns capacity to this exact pool.
    url.searchParams.set('connection_limit', '1'); url.searchParams.set('pool_timeout', '5');
    prisma = new PrismaService({ datasources: { db: { url: url.toString() } }, log: [] });
    await prisma.$connect();
    const rows = await prisma.$queryRaw<Array<{ owner: boolean; address: string; port: number; directory: string }>>`
      SELECT current_user=${config.user} AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory`;
    assert.equal(rows[0]?.owner, true); assert.equal(rows[0]?.address, config.host); assert.equal(rows[0]?.port, 55433);
    assert.equal(rows[0]?.directory.replaceAll('\\', '/'), config.dataDirectory.replaceAll('\\', '/'));
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  test('a later scan is cancelled within the shared budget, then the same pool is reusable without leaked timeout', async () => {
    const before = (await prisma.$queryRaw<Array<{ pid: number; timeout: string }>>`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout`)[0]!;
    let scans = 0;
    const started = performance.now();
    const error = await withMailQueryDeadline(prisma, tenant, async query => {
      scans += 1; await query(Prisma.sql`SELECT 1 AS n FROM pg_sleep(2)`);
      scans += 1; await query(Prisma.sql`SELECT 1 AS n FROM pg_sleep(8)`);
      scans += 1; return query(Prisma.sql`SELECT 1 AS n`);
    }).catch(e => e);
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(ServiceUnavailableException); expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect(scans).toBe(2); expect(elapsed).toBeGreaterThan(3000); expect(elapsed).toBeLessThan(4500);
    const after = (await prisma.$queryRaw<Array<{ pid: number; timeout: string }>>`SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS timeout`)[0]!;
    expect(after).toEqual(before);
    await expect(withMailQueryDeadline(prisma, tenant, query => query(Prisma.sql`SELECT 7 AS n`))).resolves.toEqual([{ n: 7 }]);
  }, 12_000);

  test('fast count/page/coverage results remain intact in one owned transaction', async () => {
    const result = await withMailQueryDeadline(prisma, tenant, async query => ({
      count: await query(Prisma.sql`SELECT 2 AS n`),
      page: await query(Prisma.sql`SELECT 'owned-message'::text AS id`),
      coverage: await query(Prisma.sql`SELECT 3 AS synced`),
    }));
    expect(result).toEqual({ count: [{ n: 2 }], page: [{ id: 'owned-message' }], coverage: [{ synced: 3 }] });
  });
});
