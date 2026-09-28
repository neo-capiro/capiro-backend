import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  indexHistory,
  parseIndex,
  predicateSignature,
  statements,
  verifyIndexes,
} from './verify-funding-indexes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const dir = path.join(root, 'apps/api/prisma/migrations');
const migrations = fs
  .readdirSync(dir)
  .filter((name) => fs.existsSync(path.join(dir, name, 'migration.sql')))
  .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8') }));
const history = indexHistory(migrations);
const sqlOwned = JSON.parse(
  fs.readFileSync(path.join(root, 'scripts/ci/funding-sql-owned-indexes.json'), 'utf8'),
);
assert.ok(
  process.env.FUNDING_GENERATED_SCHEMA_SQL,
  'Generate Prisma schema SQL before running this suite',
);
const generatedSql = fs.readFileSync(process.env.FUNDING_GENERATED_SCHEMA_SQL, 'utf8');
let db;
let catalog;

before(async () => {
  db = new PGlite();
  // Empty synthetic tables retain PostgreSQL index semantics. No application
  // database, application rows, credentials or migrations are executed here.
  const tables = new Map();
  for (const { signature: s } of history.active.values()) {
    const columns = tables.get(s.table) || new Map();
    for (const key of s.keys) columns.set(key.column || key.coalesceEmptyText, 'text');
    for (const term of s.predicate || [])
      columns.set(
        term.column,
        'equalsBoolean' in term ? 'boolean' : columns.get(term.column) || 'text',
      );
    tables.set(s.table, columns);
  }
  for (const [name, columns] of tables)
    await db.exec(
      `CREATE TABLE "${name}" (${[...columns].map(([column, type]) => `"${column}" ${type}`).join(',')})`,
    );
  for (const [name, expected] of history.active) {
    const file = migrations.find((m) => m.name === expected.migration);
    const sql = statements(file.sql).find(
      (s) =>
        /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s) &&
        s.includes(`"${name}"`) &&
        parseIndex(s).name === name,
    );
    assert.ok(sql);
    await db.exec(sql);
  }
  catalog = (
    await db.query(
      `SELECT c.relname AS name,n.nspname AS schema,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live,i.indimmediate AS immediate,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`,
    )
  ).rows;
});
after(async () => {
  await db?.close();
});
const verify = (overrides = {}) =>
  verifyIndexes({ history, generatedSql, sqlOwned, catalog, ...overrides });

test('all 88 historical names resolve to 87 real indexes, seven SQL-owned, and one deliberately removed', () => {
  assert.deepEqual(verify(), {
    scoped: 88,
    active: 87,
    sqlOwned: 7,
    removed: ['tango_event_outbox_delivery_uniq'],
  });
});
test('a generated default unique name passes without a literal schema map', () => {
  const name = 'tango_procurement_forecast_tango_forecast_id_key';
  assert.match(generatedSql, new RegExp(`CREATE UNIQUE INDEX "${name}"`));
  assert.doesNotThrow(() => verify());
});
test('a name in a generated SQL comment cannot replace a declaration', () => {
  const name = 'tango_procurement_forecast_tango_forecast_id_key';
  const sql = generatedSql.replace(
    new RegExp(`CREATE UNIQUE INDEX "${name}"[^;]+;`),
    `-- ${name}\n`,
  );
  assert.throws(() => verify({ generatedSql: sql }), /Prisma/);
});
test('missing, invalid, unready, dead and deferred catalog indexes fail', () => {
  assert.throws(() => verify({ catalog: catalog.slice(1) }), /Missing or unusable/);
  for (const flag of ['valid', 'ready', 'live', 'immediate'])
    assert.throws(
      () => verify({ catalog: catalog.map((r, i) => (i === 0 ? { ...r, [flag]: false } : r)) }),
      /Missing or unusable/,
    );
});
test('wrong uniqueness, key order, table and sort direction fail', () => {
  const name = 'tango_subaward_action_date_idx';
  const row = catalog.find((r) => r.name === name);
  assert.ok(row);
  for (const definition of [
    row.definition.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
    row.definition.replace('action_date DESC, provider_key', 'provider_key, action_date DESC'),
    row.definition.replace('public.tango_subaward', 'public.other_table'),
    row.definition.replace('action_date DESC', 'action_date'),
  ]) {
    assert.notEqual(definition, row.definition);
    assert.throws(
      () => verify({ catalog: catalog.map((r) => (r.name === name ? { ...r, definition } : r)) }),
      /catalog/,
    );
  }
});
test('removing or weakening a partial predicate fails', () => {
  const name = 'client_funding_opportunity_generic_uniq';
  const row = catalog.find((r) => r.name === name);
  assert.ok(row);
  const oldShape =
    'CREATE UNIQUE INDEX "client_funding_opportunity_generic_uniq" ON "client_funding_opportunity" ("tenant_id", "client_id", "source", "source_record_key") WHERE "source_record_key" IS NOT NULL';
  for (const definition of [row.definition.replace(/ WHERE[\s\S]*/, ''), oldShape])
    assert.throws(
      () => verify({ catalog: catalog.map((r) => (r.name === name ? { ...r, definition } : r)) }),
      /catalog/,
    );
});
test('expression index changes fail instead of being omitted', () => {
  const name = 'tango_budget_vendor_flow_grain_uniq';
  const row = catalog.find((r) => r.name === name);
  assert.ok(row);
  const definition = row.definition.replace(/COALESCE\([^)]*\)/i, 'funding_organization_id');
  assert.notEqual(definition, row.definition);
  assert.throws(
    () => verify({ catalog: catalog.map((r) => (r.name === name ? { ...r, definition } : r)) }),
    /catalog/,
  );
});
test('SQL-owned contracts cannot silently replace Prisma ownership or declare a nonpartial substitute', () => {
  const regular =
    'CREATE UNIQUE INDEX "tango_budget_account_row_id_uniq" ON "tango_budget_account" ("tango_account_row_id")';
  assert.throws(
    () =>
      verify({
        sqlOwned: [
          ...sqlOwned,
          {
            migration: history.active.get('tango_budget_account_row_id_uniq').migration,
            sql: regular,
          },
        ],
      }),
    /cannot bypass Prisma/,
  );
  const partial = sqlOwned[0].sql.replace(/\s+WHERE[\s\S]*/, ';');
  assert.throws(() => verify({ generatedSql: generatedSql + '\n' + partial }), /falsely declared/);
  assert.throws(() => verify({ sqlOwned: sqlOwned.slice(1) }), /Prisma/);
});
test('a removed single-delivery unique index cannot be resurrected in schema or catalog', () => {
  const sql =
    'CREATE UNIQUE INDEX "tango_event_outbox_delivery_uniq" ON "tango_event_outbox" ("delivery_id");';
  assert.throws(() => verify({ generatedSql: generatedSql + '\n' + sql }), /resurrected/);
  assert.throws(
    () =>
      verify({
        catalog: [
          ...catalog,
          { ...catalog[0], name: 'tango_event_outbox_delivery_uniq', definition: sql },
        ],
      }),
    /resurrected/,
  );
  const renamed = sql.replace('tango_event_outbox_delivery_uniq', 'renamed_delivery_unique');
  assert.throws(() => verify({ generatedSql: generatedSql + '\n' + renamed }), /another name/);
  assert.throws(
    () =>
      verify({
        catalog: [
          ...catalog,
          { ...catalog[0], name: 'renamed_delivery_unique', definition: renamed },
        ],
      }),
    /another name/,
  );
});
test('later unscoped migrations replace scoped definitions without losing coverage', () => {
  const events = history.history.filter(
    (e) => e.name === 'client_funding_opportunity_generic_uniq',
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['create', 'create', 'drop', 'create'],
  );
  assert.equal(
    history.active.get('client_funding_opportunity_generic_uniq').migration,
    '20260916180000_opportunity_bookmarks',
  );
  assert.equal(
    history.active.get('client_funding_opportunity_generic_uniq').signature.keys.length,
    5,
  );
});
test('new scoped indexes are required and unknown or conflicting operations fail closed', () => {
  const base = { name: '1_tango_test', sql: 'CREATE INDEX "new_idx" ON "rows" ("a");' };
  const h = indexHistory([base]);
  assert.throws(
    () => verifyIndexes({ history: h, generatedSql: '', sqlOwned: [], catalog: [] }),
    /Prisma/,
  );
  assert.throws(
    () =>
      indexHistory([
        base,
        { name: '2_other', sql: 'ALTER INDEX "new_idx" RENAME TO "other_idx";' },
      ]),
    /Unreviewed/,
  );
  assert.throws(
    () =>
      indexHistory([
        base,
        { name: '2_tango_test', sql: 'CREATE INDEX IF NOT EXISTS "new_idx" ON "rows" ("b");' },
      ]),
    /without DROP/,
  );
  assert.throws(
    () => parseIndex('CREATE INDEX "new_idx" ON "rows" USING hash ("a")'),
    /Unsupported index method/,
  );
  assert.throws(() => parseIndex('CREATE INDEX "new_idx" ON "rows" ("a") INCLUDE ("b")'), /suffix/);
  assert.throws(() => predicateSignature('a IS NOT NULL OR b IS NOT NULL'), /tail/);
  assert.throws(
    () => indexHistory([{ name: '1_tango_test', sql: '-- CREATE INDEX "fake" ON "rows" ("a");' }]),
    /No scoped/,
  );
});
test('Prisma models match every subaward and checkpoint column, type, nullability and database default', async () => {
  const expected = new PGlite();
  const actual = new PGlite();
  try {
    for (const instance of [expected, actual])
      await instance.exec(
        'CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE SQL AS $$ SELECT gen_random_uuid() $$',
      );
    const source = migrations.find((m) => m.name === '20261001010000_tango_subaward_intelligence');
    for (const [instance, sql] of [
      [expected, source.sql],
      [actual, generatedSql],
    ])
      for (const statement of statements(sql))
        if (
          /^CREATE TABLE(?: IF NOT EXISTS)? "tango_subaward(?:_sync_checkpoint)?"\s*\(/.test(
            statement,
          )
        )
          await instance.exec(statement);
    const query =
      "SELECT table_name,column_name,ordinal_position,is_nullable,data_type,udt_name,character_maximum_length,numeric_precision,numeric_scale,datetime_precision,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('tango_subaward','tango_subaward_sync_checkpoint') ORDER BY table_name,ordinal_position";
    const a = (await actual.query(query)).rows;
    const e = (await expected.query(query)).rows;
    assert.equal(e.length, 45);
    assert.deepEqual(a, e);
  } finally {
    await expected.close();
    await actual.close();
  }
});
test('workflow includes verifier-only changes and generates real SQL before running the contract tests and catalog gate', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/funding-opportunities-ci.yml'),
    'utf8',
  );
  const scope = workflow.match(/grep -Eq '([^']+)'/)?.[1];
  assert.ok(scope);
  for (const file of [
    'scripts/ci/verify-funding-indexes.mjs',
    'scripts/ci/verify-funding-indexes.test.mjs',
    'scripts/ci/funding-sql-owned-indexes.json',
  ])
    assert.match(file, new RegExp(scope));
  const generate = workflow.indexOf('prisma migrate diff --from-empty --to-schema-datamodel');
  const tests = workflow.indexOf(
    'FUNDING_GENERATED_SCHEMA_SQL="$RUNNER_TEMP/funding-schema.sql" node --test',
  );
  const verify = workflow.indexOf('node scripts/ci/verify-funding-indexes.mjs --schema-sql');
  assert.ok(generate > 0 && tests > generate && verify > tests);
});
