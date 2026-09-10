import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');

test(
  'Intel migrate propagates a real failed-ledger error without repairing history',
  { timeout: 120000 },
  async () => {
    assert.ok(process.env.DATABASE_URL, 'A disposable PostgreSQL DATABASE_URL is required');
    const source = new URL(process.env.DATABASE_URL);
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(source.hostname),
      'Only disposable localhost PostgreSQL is allowed',
    );
    const name = `phase1_runner_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new PrismaClient({ datasources: { db: { url: source.href } } });
    let db;
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      const target = new URL(source);
      target.pathname = `/${name}`;
      db = new PrismaClient({ datasources: { db: { url: target.href } } });
      await db.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (
      id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
      finished_at timestamptz, migration_name varchar(255) NOT NULL,
      logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0)`);
      await db.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" (id,checksum,migration_name,logs)
      VALUES ($1,repeat('a',64),'synthetic_failed_migration','Synthetic failure; preserve operator evidence')`,
        randomUUID(),
      );
      const before = await db.$queryRawUnsafe(
        'SELECT to_jsonb(m) AS row FROM "_prisma_migrations" m ORDER BY id',
      );
      const run = spawnSync('sh', ['scripts/entrypoint.sh', 'migrate'], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: { ...process.env, DATABASE_URL: target.href },
        encoding: 'utf8',
        timeout: 90000,
      });
      assert.ifError(run.error);
      assert.equal(run.status, 1, 'The migration runner must propagate Prisma failure');
      assert.match(run.stdout + run.stderr, /P3009/);
      assert.deepEqual(
        await db.$queryRawUnsafe(
          'SELECT to_jsonb(m) AS row FROM "_prisma_migrations" m ORDER BY id',
        ),
        before,
      );
      const tables = await db.$queryRawUnsafe(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      );
      assert.deepEqual(
        tables.map((t) => t.tablename),
        ['_prisma_migrations'],
      );
    } finally {
      await db?.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.$disconnect();
    }
  },
);
