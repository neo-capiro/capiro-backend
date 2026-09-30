import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = requireFromApi('pg');
const { PGlite } = await import(pathToFileURL(requireFromApi.resolve('@electric-sql/pglite')).href);

const migrationPath =
  'apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql';
// *.sql has no eol attribute, so an autocrlf checkout (Windows) holds CRLF
// bytes; the committed migration is LF-only.
const repairedSql = (
  await readFile(new URL(`../../${migrationPath}`, import.meta.url), 'utf8')
).replace(/\r\n/g, '\n');
// The incident merge base is an ancestor of every branch carrying this repair.
const originalSql = execFileSync(
  'git',
  ['show', `42942dedad59382f4b4aac6f904b9aee0e02efa6:${migrationPath}`],
  { encoding: 'utf8' },
);

assert.equal(
  createHash('sha256').update(originalSql).digest('hex'),
  '3f982ab8d2a7dea5ee37cf738317b9eaf4b2b16f248309ff9a1d6968074ee724',
  'the regression input must remain the exact pre-repair migration SQL',
);
assert.equal(
  createHash('sha256').update(repairedSql).digest('hex'),
  '8189f8a447c6851ca2d342ecab1da1ee822a2451b1610828aa434d99fceaf95b',
  'the migration must remain the reviewed fail-closed replacement',
);
assert.doesNotMatch(repairedSql, /\bMIN\s*\(/i);
assert.doesNotMatch(
  repairedSql,
  /\bDELETE\b/i,
  'duplicate deletion is a reviewed maintenance step',
);

// The migration carries its own BEGIN/COMMIT. Tests run its body inside an
// outer transaction that is always rolled back, so nothing persists.
assert.match(repairedSql, /^BEGIN;\n/);
assert.match(repairedSql, /\nCOMMIT;\n$/);
const migrationBody = repairedSql.replace(/^BEGIN;\n/, '').replace(/\nCOMMIT;\n$/, '\n');

// Exactly the shape migration history creates (20260521130000_synthesis_layer).
const historyTable = `
  CREATE TABLE public.client_intel_mapping (
    id uuid PRIMARY KEY,
    client_id uuid NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    marker text NOT NULL,
    UNIQUE (client_id, source, external_id)
  )
`;
const rows = [
  [
    '00000000-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'alpha',
    'a',
  ],
  [
    '00000000-0000-0000-0000-000000000007',
    '11111111-1111-1111-1111-111111111111',
    'sam',
    'beta',
    'b',
  ],
  [
    '00000000-0000-0000-0000-000000000008',
    '22222222-2222-2222-2222-222222222222',
    'fec',
    'singleton',
    'c',
  ],
];

// PGlite's query() uses the extended protocol, which accepts one statement;
// multi-statement scripts go through exec(). node-postgres query() without
// parameters uses the simple protocol, which accepts a script.
function runScript(db, sql) {
  return typeof db.exec === 'function' ? db.exec(sql) : db.query(sql);
}

async function insert(db, values) {
  for (const [id, clientId, source, externalId, marker] of values) {
    await db.query(
      `
        INSERT INTO public.client_intel_mapping (id, client_id, source, external_id, marker)
        VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text)
      `,
      [id, clientId, source, externalId, marker],
    );
  }
}

async function snapshot(db) {
  return (
    await db.query(`
      SELECT id::text, client_id::text, source, external_id, marker
      FROM public.client_intel_mapping
      ORDER BY id
    `)
  ).rows;
}

async function rolledBack(db, body) {
  await db.query('BEGIN');
  try {
    await body();
  } finally {
    await db.query('ROLLBACK');
  }
}

async function exerciseMigration(db) {
  await rolledBack(db, async () => {
    await db.query(`
      CREATE TABLE public.client_intel_mapping (
        id uuid PRIMARY KEY, client_id uuid, source text, external_id text
      )
    `);
    await assert.rejects(
      runScript(db, originalSql),
      (error) => {
        assert.equal(error.code, '42883');
        assert.match(error.message, /function min\(uuid\) does not exist/i);
        return true;
      },
      'the exact original migration must reproduce PostgreSQL 42883',
    );
  });

  await rolledBack(db, async () => {
    await db.query(historyTable);
    await insert(db, rows);
    const before = await snapshot(db);
    await runScript(db, migrationBody);
    assert.deepEqual(await snapshot(db), before, 'the proven invariant deletes no rows');
    await runScript(db, migrationBody);
    assert.deepEqual(await snapshot(db), before, 'a second run must be idempotent');
  });

  await rolledBack(db, async () => {
    await db.query(historyTable.replace(',\n    UNIQUE (client_id, source, external_id)', ''));
    const duplicates = [
      ...rows,
      [
        '00000000-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111',
        'sam',
        'alpha',
        'dup',
      ],
    ];
    await insert(db, duplicates);
    const before = await snapshot(db);
    await db.query('SAVEPOINT missing_invariant');
    await assert.rejects(runScript(db, migrationBody), /Global dedup uniqueness is unproven/);
    await db.query('ROLLBACK TO SAVEPOINT missing_invariant');
    assert.deepEqual(
      await snapshot(db),
      before,
      'a missing invariant fails closed and deletes nothing',
    );
  });

  await rolledBack(db, async () => {
    await db.query(historyTable.replace('external_id text NOT NULL', 'external_id text'));
    await db.query('SAVEPOINT nullable_key');
    await assert.rejects(
      runScript(db, migrationBody),
      /Dedup key columns must exist and be non-null/,
    );
    await db.query('ROLLBACK TO SAVEPOINT nullable_key');
  });
}

test('PGlite replays the original failure and proves the fail-closed invariant without deleting rows', async () => {
  const db = new PGlite();
  try {
    await exerciseMigration(db);
    const residue = await db.query(
      `SELECT to_regclass('public.client_intel_mapping')::text AS name`,
    );
    assert.equal(residue.rows[0].name, null);
  } finally {
    await db.close();
  }
});

const postgresConfigPath = process.env.CLIENT_INTEL_DEDUP_POSTGRES_CONFIG;
if (postgresConfigPath) {
  test('owned PostgreSQL replays 42883 and proves the fail-closed invariant in rolled-back transactions', async () => {
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
      const existing = await db.query(
        `SELECT to_regclass('public.client_intel_mapping')::text AS name`,
      );
      assert.equal(
        existing.rows[0].name,
        null,
        'refusing a cluster that already holds the real table',
      );

      await exerciseMigration(db);
      const residue = await db.query(
        `SELECT to_regclass('public.client_intel_mapping')::text AS name`,
      );
      assert.equal(residue.rows[0].name, null);
    } finally {
      await db.end();
    }
  });
}
