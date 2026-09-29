import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = requireFromApi('pg');
const { PGlite } = await import(pathToFileURL(requireFromApi.resolve('@electric-sql/pglite')).href);

const migrationUrl = new URL(
  '../../apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql',
  import.meta.url,
);
const repairedSql = await readFile(migrationUrl, 'utf8');
const originalSql = execFileSync(
  'git',
  [
    'show',
    '5f63b98d0:apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql',
  ],
  { encoding: 'utf8' },
);

assert.equal(
  createHash('sha256').update(originalSql).digest('hex'),
  '3f982ab8d2a7dea5ee37cf738317b9eaf4b2b16f248309ff9a1d6968074ee724',
  'the regression input must remain the exact pre-repair migration SQL',
);
assert.doesNotMatch(repairedSql, /\bMIN\s*\(/i);
assert.match(repairedSql, /ROW_NUMBER\s*\(\)\s+OVER/i);
assert.equal(repairedSql.includes('\r'), false, 'the repaired migration SQL must remain LF-only');

const rows = [
  [
    '00000000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'alpha',
    'a-high-first',
  ],
  [
    '00000000-0000-0000-0000-000000000007',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'beta',
    'b-high-first',
  ],
  [
    '00000000-0000-0000-0000-000000000008',
    '22222222-2222-2222-2222-222222222222',
    'fec',
    'singleton',
    'singleton',
  ],
  [
    '00000000-0000-0000-0000-00000000000a',
    '22222222-2222-2222-2222-222222222222',
    'lda',
    null,
    'null-high-first',
  ],
  [
    '00000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'alpha',
    'a-low-later',
  ],
  [
    '00000000-0000-0000-0000-000000000009',
    '22222222-2222-2222-2222-222222222222',
    'lda',
    null,
    'null-low-later',
  ],
  [
    '00000000-0000-0000-0000-000000000004',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'beta',
    'b-low-later',
  ],
  [
    '00000000-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'alpha',
    'a-middle-last',
  ],
  [
    '00000000-0000-0000-0000-000000000005',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'beta',
    'b-middle-last',
  ],
];

const expectedRows = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    client_id: '11111111-1111-1111-1111-111111111111',
    source: 'sam',
    external_id: 'alpha',
    marker: 'a-low-later',
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    client_id: '11111111-1111-1111-1111-111111111111',
    source: 'sam',
    external_id: 'beta',
    marker: 'b-low-later',
  },
  {
    id: '00000000-0000-0000-0000-000000000008',
    client_id: '22222222-2222-2222-2222-222222222222',
    source: 'fec',
    external_id: 'singleton',
    marker: 'singleton',
  },
  {
    id: '00000000-0000-0000-0000-000000000009',
    client_id: '22222222-2222-2222-2222-222222222222',
    source: 'lda',
    external_id: null,
    marker: 'null-low-later',
  },
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function queryRows(db) {
  return (
    await db.query(`
      SELECT id::text, client_id::text, source, external_id, marker
      FROM client_intel_mapping
      ORDER BY id
    `)
  ).rows;
}

async function exerciseMigration(db, schema) {
  const quotedSchema = quoteIdentifier(schema);
  await db.query(`CREATE SCHEMA ${quotedSchema}`);
  await db.query(`SET LOCAL search_path TO ${quotedSchema}, pg_catalog`);
  await db.query(`
    CREATE TABLE client_intel_mapping (
      id uuid PRIMARY KEY,
      client_id uuid,
      source text,
      external_id text,
      marker text NOT NULL
    )
  `);

  await db.query('SAVEPOINT original_sql_failure');
  await assert.rejects(
    db.query(originalSql),
    (error) => {
      assert.equal(error.code, '42883');
      assert.match(error.message, /function min\(uuid\) does not exist/i);
      return true;
    },
    'the exact original migration must reproduce PostgreSQL 42883',
  );
  await db.query('ROLLBACK TO SAVEPOINT original_sql_failure');
  await db.query('RELEASE SAVEPOINT original_sql_failure');

  for (const [id, clientId, source, externalId, marker] of rows) {
    await db.query(
      `
        INSERT INTO client_intel_mapping (id, client_id, source, external_id, marker)
        VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text)
      `,
      [id, clientId, source, externalId, marker],
    );
  }

  await db.query(repairedSql);
  assert.deepEqual(await queryRows(db), expectedRows);

  const duplicateGroups = await db.query(`
    SELECT COUNT(*)::integer AS count
    FROM (
      SELECT client_id, source, external_id
      FROM client_intel_mapping
      GROUP BY client_id, source, external_id
      HAVING COUNT(*) > 1
    ) AS duplicates
  `);
  assert.equal(duplicateGroups.rows[0].count, 0);

  await db.query(repairedSql);
  assert.deepEqual(await queryRows(db), expectedRows, 'a second run must be idempotent');
}

async function runInRolledBackSchema(db) {
  const schema = `client_intel_dedup_${randomUUID().replaceAll('-', '_')}`;
  await db.query('BEGIN');
  try {
    await exerciseMigration(db, schema);
  } finally {
    await db.query('ROLLBACK');
  }
  return schema;
}

test('PGlite replays the exact failure and verifies deterministic lowest-UUID retention', async () => {
  const db = new PGlite();
  try {
    const schema = await runInRolledBackSchema(db);
    const residue = await db.query('SELECT to_regnamespace($1)::text AS schema_name', [schema]);
    assert.equal(residue.rows[0].schema_name, null);
  } finally {
    await db.close();
  }
});

const postgresConfigPath = process.env.CLIENT_INTEL_DEDUP_POSTGRES_CONFIG;
if (postgresConfigPath) {
  test('owned PostgreSQL replays 42883 and verifies repaired SQL in a rolled-back schema', async () => {
    const config = JSON.parse(await readFile(postgresConfigPath, 'utf8'));
    const allowedTarget = {
      host: '127.0.0.1',
      port: 55433,
      user: 'meri_foundation_owner',
      database: 'postgres',
    };

    assert.equal(config.host, allowedTarget.host, 'refusing a non-local PostgreSQL host');
    assert.equal(config.port, allowedTarget.port, 'refusing an unexpected PostgreSQL port');
    assert.equal(config.user, allowedTarget.user, 'refusing an unexpected PostgreSQL user');
    assert.equal(
      config.database,
      allowedTarget.database,
      'refusing an unexpected PostgreSQL database',
    );
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    assert.equal(typeof config.password, 'string');
    assert.ok(config.password.length > 0, 'the local PostgreSQL password is required');

    const db = new Client({
      ...allowedTarget,
      password: config.password,
      ssl: false,
      application_name: 'client-intel-dedup-replay-test',
      connectionTimeoutMillis: 5_000,
    });
    await db.connect();
    try {
      const identity = (
        await db.query(`
          SELECT
            host(inet_server_addr()) AS host,
            inet_server_port() AS port,
            current_user AS user,
            current_database() AS database
        `)
      ).rows[0];
      assert.equal(identity.host, allowedTarget.host);
      assert.equal(identity.port, allowedTarget.port);
      assert.equal(identity.user, allowedTarget.user);
      assert.equal(identity.database, allowedTarget.database);

      const schema = await runInRolledBackSchema(db);
      const residue = await db.query('SELECT to_regnamespace($1)::text AS schema_name', [schema]);
      assert.equal(residue.rows[0].schema_name, null);
    } finally {
      await db.end();
    }
  });
}
