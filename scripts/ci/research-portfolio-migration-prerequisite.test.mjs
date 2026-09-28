import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '../../node_modules/.pnpm/@electric-sql+pglite@0.5.8/node_modules/@electric-sql/pglite/dist/index.js';

const prerequisiteSql = await readFile(
  new URL('./research-portfolio-append-only-prerequisite.sql', import.meta.url),
  'utf8',
);
const consumerSql = await readFile(
  new URL(
    '../../apps/api/prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const deliveryTriggerSql = consumerSql.match(
  /CREATE TRIGGER "research_portfolio_subscription_deliveries_append_only"[\s\S]*?;/,
)?.[0];
assert.ok(deliveryTriggerSql, 'Phase 10 delivery trigger SQL must be present');

async function withDatabase(run) {
  const db = new PGlite();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

async function functionMetadata(db) {
  return (
    await db.query(`
      SELECT
        function_definition.oid::text AS oid,
        function_definition.prorettype = 'pg_catalog.trigger'::regtype AS returns_trigger,
        function_language.lanname AS language,
        function_definition.prosecdef AS security_definer,
        pg_get_functiondef(function_definition.oid) AS definition
      FROM pg_catalog.pg_proc AS function_definition
      JOIN pg_catalog.pg_namespace AS function_schema
        ON function_schema.oid = function_definition.pronamespace
      JOIN pg_catalog.pg_language AS function_language
        ON function_language.oid = function_definition.prolang
      WHERE function_schema.nspname = 'public'
        AND function_definition.proname = 'reject_append_only_mutation'
        AND function_definition.pronargs = 0
    `)
  ).rows[0];
}

test('missing helper is created and the actual delivery trigger permits INSERT but blocks mutation', async () => {
  await withDatabase(async (db) => {
    await db.exec(prerequisiteSql);

    const metadata = await functionMetadata(db);
    assert.equal(metadata.returns_trigger, true);
    assert.equal(metadata.language, 'plpgsql');
    assert.equal(metadata.security_definer, false);
    assert.doesNotMatch(prerequisiteSql, /CREATE\s+OR\s+REPLACE/i);

    await db.exec(`
      CREATE TABLE research_portfolio_subscription_deliveries (
        id integer PRIMARY KEY,
        value text NOT NULL
      );
    `);
    await db.exec(deliveryTriggerSql);
    await db.exec(
      "INSERT INTO research_portfolio_subscription_deliveries (id, value) VALUES (1, 'inserted')",
    );

    const rows = () => db.query('SELECT * FROM research_portfolio_subscription_deliveries');
    assert.deepEqual((await rows()).rows, [{ id: 1, value: 'inserted' }]);
    await assert.rejects(
      db.exec(
        "UPDATE research_portfolio_subscription_deliveries SET value = 'changed' WHERE id = 1",
      ),
      /Append-only table: updates and deletes are not allowed on research_portfolio_subscription_deliveries/,
    );
    await assert.rejects(
      db.exec('DELETE FROM research_portfolio_subscription_deliveries WHERE id = 1'),
      /Append-only table: updates and deletes are not allowed on research_portfolio_subscription_deliveries/,
    );
    assert.deepEqual((await rows()).rows, [{ id: 1, value: 'inserted' }]);
  });
});

test('reapplying the CI prerequisite preserves the compatible existing definition', async () => {
  await withDatabase(async (db) => {
    await db.exec(prerequisiteSql);
    const before = await functionMetadata(db);

    await db.exec(prerequisiteSql);
    const after = await functionMetadata(db);

    assert.deepEqual(after, before);
  });
});

test('an existing non-trigger function fails closed without replacement', async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE FUNCTION public.reject_append_only_mutation()
      RETURNS integer
      LANGUAGE sql
      AS $$ SELECT 1 $$;
    `);
    const before = await functionMetadata(db);

    await assert.rejects(db.exec(prerequisiteSql), /Incompatible existing function/);
    assert.deepEqual(await functionMetadata(db), before);
  });
});

test('an existing SECURITY DEFINER trigger function fails closed without replacement', async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE FUNCTION public.reject_append_only_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      BEGIN
        RAISE EXCEPTION 'Append-only table: updates and deletes are not allowed on %', TG_TABLE_NAME;
      END;
      $$;
    `);
    const before = await functionMetadata(db);

    await assert.rejects(db.exec(prerequisiteSql), /Incompatible existing function/);
    assert.deepEqual(await functionMetadata(db), before);
  });
});

test('an existing trigger function with permissive behavior fails closed', async () => {
  await withDatabase(async (db) => {
    await db.exec(`
      CREATE FUNCTION public.reject_append_only_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
    `);
    const before = await functionMetadata(db);

    await assert.rejects(db.exec(prerequisiteSql), /Incompatible existing function/);
    assert.deepEqual(await functionMetadata(db), before);
  });
});
