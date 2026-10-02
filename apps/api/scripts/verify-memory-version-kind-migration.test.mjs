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
  let created = false;
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
    await db.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await db.query(`SET search_path TO ${schema}`);
    await db.query("SET lock_timeout='2s'; SET statement_timeout='10s'");
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
    return await work(
      db,
      schema,
      () =>
        new Client({
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: config.database,
          connectionTimeoutMillis: 3000,
        }),
    );
  } finally {
    try {
      if (created) {
        // Production migration owns its BEGIN/COMMIT. Cleanup therefore uses
        // the verified random namespace, never an enclosing test transaction.
        await db.query('ROLLBACK');
        await db.query('SET search_path TO pg_catalog');
        assert.match(schema, /^meri_kind_[a-f0-9]{32}$/u);
        await db.query(`DROP SCHEMA ${schema} CASCADE`);
        assert.equal(
          Number(
            (await db.query('SELECT count(*) AS n FROM pg_namespace WHERE nspname=$1', [schema]))
              .rows[0].n,
          ),
          0,
        );
      }
    } finally {
      await db.end();
    }
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
  await db.query('BEGIN');
  try {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, code);
      if (constraint) assert.equal(error.constraint, constraint);
      return true;
    });
  } finally {
    await db.query('ROLLBACK');
  }
}

test('repair SQL bounds its transaction around one atomic ALTER and remains LF-exact', async () => {
  const bytes = await readFile(repairPath);
  assert.equal(bytes.includes(13), false);
  const sql = bytes
    .toString('utf8')
    .replace(/^--.*$/gmu, '')
    .trim();
  const statements = sql
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  assert.equal(statements.length, 5);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements[1], "SET LOCAL lock_timeout = '5s'");
  assert.equal(statements[2], "SET LOCAL statement_timeout = '30s'");
  assert.match(statements[3], /^ALTER TABLE "memory_candidate"/u);
  assert.equal(statements[4], 'COMMIT');
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
          await db.query('BEGIN');
          await db.query(
            'ALTER TABLE memory_candidate DROP CONSTRAINT memory_candidate_source_kind_chk',
          );
          await insert(db, 'memory_correction', {});
          await db.query('ROLLBACK');
        },
      );
      const unchanged = async () =>
        (
          await db.query(`SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='memory_candidate'::regclass AND NOT tgisinternal ORDER BY tgname`)
        ).rows;
      const triggers = await unchanged();
      const limits = await db.query(
        "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement",
      );
      await db.query(await readFile(repairPath, 'utf8'));
      assert.deepEqual(
        (
          await db.query(
            "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement",
          )
        ).rows,
        limits.rows,
      );
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
          await db.query("BEGIN; SELECT set_config('app.memory_version_activation','on',true)");
          await db.query(
            "UPDATE memory_candidate SET status='approved',committed_memory_item_id=$2 WHERE id=$1",
            [id, committed],
          );
          await db.query('COMMIT');
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
        await rejected(
          db,
          async () => {
            await db.query("SELECT set_config('app.memory_version_activation','on',true)");
            return db.query(
              "UPDATE memory_candidate SET status='approved',committed_memory_item_id=$2 WHERE id=$1",
              [id, committed],
            );
          },
          '55000',
        );
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
      await db.query(
        'ALTER TABLE memory_candidate DROP CONSTRAINT memory_candidate_version_payload_check',
      );
      try {
        await assert.rejects(db.query(await readFile(repairPath, 'utf8')), { code: '42704' });
      } finally {
        await db.query('ROLLBACK');
      }
      assert.deepEqual(
        (
          await db.query(
            "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass AND conname='memory_candidate_source_kind_chk'",
          )
        ).rows[0],
        before,
      );
      await db.query((await historicalSql()).payloadSql);
      await db.query(await readFile(repairPath, 'utf8'));
      for (const kind of versionKinds) await insert(db, `memory_${kind}`, payload(kind));
    }),
);

test(
  'production transaction cancels table-lock acquisition at five seconds without partial change or leaked limits',
  { skip: !configPath, timeout: 15_000 },
  async () =>
    withOwnedSchema(async (db, schema, peer) => {
      const holder = peer();
      try {
        await holder.connect();
        await holder.query('BEGIN');
        await holder.query(`LOCK TABLE ${schema}.memory_candidate IN ACCESS SHARE MODE`);
        const before = (
          await db.query(
            "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass ORDER BY conname",
          )
        ).rows;
        const started = performance.now();
        try {
          await assert.rejects(db.query(await readFile(repairPath, 'utf8')), { code: '55P03' });
        } finally {
          await db.query('ROLLBACK');
        }
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 4_800 && elapsed < 8_000, `bounded lock timeout: ${elapsed}`);
        assert.deepEqual(
          (
            await db.query(
              "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='memory_candidate'::regclass ORDER BY conname",
            )
          ).rows,
          before,
        );
        assert.deepEqual(
          (
            await db.query(
              "SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement",
            )
          ).rows,
          [{ lock: '2s', statement: '10s' }],
        );
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    }),
);
