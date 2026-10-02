import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
const migration = (name) => new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url);
const repairPath = migration('20281005010000_memory_version_candidate_source_kinds');
const oldKinds = [
  'explicit_user',
  'workflow_event',
  'artifact_approval',
  'model_extraction',
  'settings_sections',
  'learning_signal',
];
const versionKinds = ['correction', 'restore', 'contradiction'];
const sourceId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const payload = (kind) => ({
  versionProposal: { kind, sourceItemId: sourceId, targetItemId: null },
});

/** Exact constraint/trigger SQL slices from the immutable historical migrations.
 * The prerequisite tables are intentionally minimal; this is a constraint
 * regression, not full-schema replay or shared-database/RLS qualification. */
async function historicalSql() {
  const base = await readFile(migration('20260712020000_memory_candidate'), 'utf8');
  const initial = base.match(
    /CONSTRAINT "memory_candidate_source_kind_chk"\s+CHECK \("source_kind" IN \([^;]+?\)\)/gu,
  );
  assert.equal(initial?.length, 1);
  const settings = await readFile(
    migration('20260818030000_widen_memory_candidate_source_kind'),
    'utf8',
  );
  const learning = await readFile(
    migration('20261213010000_learning_signal_candidate_generation'),
    'utf8',
  );
  const versions = await readFile(migration('20260812010000_memory_immutable_versions'), 'utf8');
  const kindSql = learning.slice(
    learning.indexOf('ALTER TABLE "memory_candidate"'),
    learning.indexOf('CREATE UNIQUE INDEX'),
  );
  const payloadSql = versions.slice(0, versions.indexOf('-- Every immutable version insert'));
  const activationSql = versions.slice(
    versions.indexOf('CREATE OR REPLACE FUNCTION guard_memory_version_candidate_activation()'),
    versions.indexOf('-- Legal hold is a database boundary'),
  );
  assert.ok(kindSql.includes("'learning_signal'"));
  assert.ok(payloadSql.includes('VALIDATE CONSTRAINT memory_candidate_version_payload_check'));
  assert.ok(
    activationSql.includes('EXECUTE FUNCTION guard_memory_version_candidate_activation();'),
  );
  return {
    initial: `ALTER TABLE memory_candidate ADD ${initial[0]}`,
    settings,
    kindSql,
    payloadSql,
    activationSql,
  };
}

async function withOwnedSchema(work) {
  assert.ok(configPath && isAbsolute(configPath), 'Explicit owned PostgreSQL config required');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 55433);
  assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
  assert.ok(isAbsolute(config.dataDirectory));
  const db = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: 3000,
  });
  const schema = `meri_kind_${randomUUID().replaceAll('-', '')}`;
  let begun = false;
  try {
    await db.connect();
    const actual = (
      await db.query(
        "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
        [config.user],
      )
    ).rows[0];
    assert.equal(actual.owner, true);
    assert.equal(actual.address, config.host);
    assert.equal(actual.port, config.port);
    assert.equal(
      actual.directory.replaceAll('\\', '/'),
      config.dataDirectory.replaceAll('\\', '/'),
    );
    await db.query('BEGIN');
    begun = true;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}`);
    await db.query("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
    await db.query(`CREATE TABLE memory_candidate(
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, source_kind varchar(24) NOT NULL,
      payload_jsonb jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'pending',
      committed_memory_item_id uuid, duplicate_memory_item_id uuid,
      conflict_status text, conflict_group_id uuid, controlling_item_id uuid,
      CONSTRAINT unchanged_status_check CHECK(status IN ('pending','approved','auto_committed')));
      CREATE TABLE memory_items(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,
        supersedes_id uuid,contradicts_id uuid,conflict_group_id uuid)`);
    const sql = await historicalSql();
    for (const part of [sql.initial, sql.settings, sql.kindSql, sql.payloadSql, sql.activationSql])
      await db.query(part);
    const result = await work(db, schema);
    await db.query('ROLLBACK');
    begun = false;
    assert.equal(
      Number(
        (await db.query('SELECT count(*) AS n FROM pg_namespace WHERE nspname=$1', [schema]))
          .rows[0].n,
      ),
      0,
    );
    return result;
  } finally {
    if (begun) await db.query('ROLLBACK');
    await db.end();
  }
}

async function insert(db, kind, value = {}) {
  const id = randomUUID();
  await db.query(
    'INSERT INTO memory_candidate(id,tenant_id,source_kind,payload_jsonb) VALUES ($1,$2,$3,$4)',
    [id, tenantId, kind, JSON.stringify(value)],
  );
  return id;
}

async function rejected(db, operation, code, constraint) {
  await db.query('SAVEPOINT expected_rejection');
  try {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, code);
      if (constraint) assert.equal(error.constraint, constraint);
      return true;
    });
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expected_rejection');
    await db.query('RELEASE SAVEPOINT expected_rejection');
  }
}

test('repair SQL remains a single atomic ALTER and LF-exact', async () => {
  const bytes = await readFile(repairPath);
  assert.equal(bytes.includes(13), false);
  const sql = bytes
    .toString('utf8')
    .replace(/^--.*$/gmu, '')
    .trim();
  assert.equal(sql.split(';').filter((part) => part.trim()).length, 1);
  assert.match(sql, /^ALTER TABLE "memory_candidate"/u);
  assert.equal((sql.match(/DROP CONSTRAINT/gu) ?? []).length, 2);
  assert.equal((sql.match(/ADD CONSTRAINT/gu) ?? []).length, 2);
});

test(
  'actual historical constraints reproduce rejection/null hole, then repaired kinds retain immutable activation',
  { skip: !configPath },
  async (t) =>
    withOwnedSchema(async (db, schema) => {
      for (const kind of oldKinds) await insert(db, kind);
      for (const kind of versionKinds) {
        await t.test(`historical six-kind check rejects canonical ${kind}`, () =>
          rejected(
            db,
            () => insert(db, `memory_${kind}`, payload(kind)),
            '23514',
            'memory_candidate_source_kind_chk',
          ),
        );
      }
      await t.test(
        'the historical payload guard alone accepts missing versionProposal as UNKNOWN',
        async () => {
          await db.query('SAVEPOINT demonstrate_null');
          await db.query(
            'ALTER TABLE memory_candidate DROP CONSTRAINT memory_candidate_source_kind_chk',
          );
          await insert(db, 'memory_correction', {});
          await db.query('ROLLBACK TO SAVEPOINT demonstrate_null');
          await db.query('RELEASE SAVEPOINT demonstrate_null');
        },
      );
      const unchanged = async () =>
        (
          await db.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='memory_candidate'::regclass AND NOT tgisinternal ORDER BY tgname`)
        ).rows;
      const triggers = await unchanged();
      await db.query(await readFile(repairPath, 'utf8'));
      assert.deepEqual(await unchanged(), triggers);
      assert.equal(
        Number((await db.query('SELECT count(*) AS n FROM memory_candidate')).rows[0].n),
        6,
      );
      const checks = (
        await db.query(`SELECT conname,convalidated FROM pg_constraint
      WHERE conrelid='memory_candidate'::regclass AND contype='c' ORDER BY conname`)
      ).rows;
      assert.deepEqual(checks, [
        { conname: 'memory_candidate_source_kind_chk', convalidated: true },
        { conname: 'memory_candidate_version_payload_check', convalidated: true },
        { conname: 'unchanged_status_check', convalidated: true },
      ]);
      for (const kind of oldKinds)
        await t.test(`preserves existing ${kind}`, () => insert(db, kind));
      for (const kind of versionKinds) {
        await t.test(`accepts typed ${kind} and preserves dedicated activation guard`, async () => {
          const id = await insert(db, `memory_${kind}`, payload(kind));
          await rejected(
            db,
            () => db.query("UPDATE memory_candidate SET status='approved' WHERE id=$1", [id]),
            '55000',
          );
          const committed = randomUUID();
          const conflict = kind === 'contradiction' ? randomUUID() : null;
          await db.query('INSERT INTO memory_items VALUES ($1,$2,$3,$4,$5)', [
            committed,
            tenantId,
            kind === 'contradiction' ? null : sourceId,
            kind === 'contradiction' ? sourceId : null,
            conflict,
          ]);
          await db.query("SELECT set_config('app.memory_version_activation','on',true)");
          await db.query(
            "UPDATE memory_candidate SET status='approved',committed_memory_item_id=$2 WHERE id=$1",
            [id, committed],
          );
          await db.query("SELECT set_config('app.memory_version_activation','off',true)");
          const row = (
            await db.query(
              'SELECT source_kind,status,conflict_status FROM memory_candidate WHERE id=$1',
              [id],
            )
          ).rows[0];
          assert.deepEqual(row, {
            source_kind: `memory_${kind}`,
            status: 'approved',
            conflict_status: kind === 'contradiction' ? 'open' : 'none',
          });
        });
      }
      for (const [label, value] of [
        ['absent object', {}],
        ['JSON null object', { versionProposal: null }],
        ['array object', { versionProposal: [] }],
        ['missing kind', { versionProposal: { sourceItemId: sourceId } }],
        ['wrong kind', payload('restore')],
        ['missing source', { versionProposal: { kind: 'correction' } }],
        ['invalid source', { versionProposal: { kind: 'correction', sourceItemId: 'not-a-uuid' } }],
        [
          'invalid target',
          { versionProposal: { ...payload('correction').versionProposal, targetItemId: 17 } },
        ],
      ])
        await t.test(`rejects ${label}`, () =>
          rejected(
            db,
            () => insert(db, 'memory_correction', value),
            '23514',
            'memory_candidate_version_payload_check',
          ),
        );
      await t.test('unknown kinds remain rejected', () =>
        rejected(
          db,
          () => insert(db, 'unreviewed_kind'),
          '23514',
          'memory_candidate_source_kind_chk',
        ),
      );
      await t.test('missing optional target stays supported', () =>
        insert(db, 'memory_restore', {
          versionProposal: { kind: 'restore', sourceItemId: sourceId },
        }),
      );
      await t.test('cross-tenant committed lineage stays rejected', async () => {
        const id = await insert(db, 'memory_correction', payload('correction'));
        const committed = randomUUID();
        await db.query('INSERT INTO memory_items(id,tenant_id,supersedes_id) VALUES($1,$2,$3)', [
          committed,
          randomUUID(),
          sourceId,
        ]);
        await db.query("SELECT set_config('app.memory_version_activation','on',true)");
        await rejected(
          db,
          () =>
            db.query(
              "UPDATE memory_candidate SET status='approved',committed_memory_item_id=$2 WHERE id=$1",
              [id, committed],
            ),
          '55000',
        );
        await db.query("SELECT set_config('app.memory_version_activation','off',true)");
      });
      assert.match(schema, /^meri_kind_[a-f0-9]{32}$/u);
    }),
);

test(
  'fresh empty history upgrades; missing expected guard fails atomically without widening source kinds',
  { skip: !configPath },
  async () =>
    withOwnedSchema(async (db) => {
      const before = (
        await db.query(
          "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass AND conname='memory_candidate_source_kind_chk'",
        )
      ).rows[0];
      await db.query('SAVEPOINT missing_guard');
      await db.query(
        'ALTER TABLE memory_candidate DROP CONSTRAINT memory_candidate_version_payload_check',
      );
      await rejected(db, async () => db.query(await readFile(repairPath, 'utf8')), '42704');
      assert.deepEqual(
        (
          await db.query(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass AND conname='memory_candidate_source_kind_chk'",
          )
        ).rows[0],
        before,
      );
      await db.query('ROLLBACK TO SAVEPOINT missing_guard');
      await db.query('RELEASE SAVEPOINT missing_guard');
      await db.query(await readFile(repairPath, 'utf8'));
      for (const kind of versionKinds) await insert(db, `memory_${kind}`, payload(kind));
    }),
);
