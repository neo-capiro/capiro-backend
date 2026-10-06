// Real PostgreSQL fresh/retired-upgrade qualification. Never targets an existing
// application DB: create uniquely named fixtures on the owned localhost service.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const prismaRoot = path.join(apiRoot, 'prisma');
const scenarioKind = process.argv[2] ?? 'committee-news';
assert.ok(['committee-news', 'committee-url-provenance'].includes(scenarioKind));
const urlProvenance = scenarioKind === 'committee-url-provenance';
const migration = urlProvenance
  ? '20281008030000_committee_url_official_review'
  : '20281008020000_legiwatch_committee_news_update_type';
const tableName = urlProvenance ? 'congress_committee' : 'committee_site_update';
const constraintName = urlProvenance
  ? 'congress_committee_url_source_chk'
  : 'committee_site_update_update_type_chk';
const newType = urlProvenance ? 'official_review' : 'committee_news_published';
const retirement = '20280929010000_remove_meri_hermes_runtime';
const oldTypes = urlProvenance
  ? [null, 'congress_gov', 'community']
  : [
      'hearing_announced',
      'date_changed',
      'time_changed',
      'room_changed',
      'postponed',
      'canceled',
      'witness_added',
      'witness_removed',
      'witness_testimony_published',
      'committee_memo_published',
      'bill_added',
      'amendment_added',
      'livestream_posted',
      'livestream_changed',
      'archive_posted',
      'official_transcript_posted',
    ];
const retiredTables = [
  'meri_agent_interactions',
  'meri_agent_run_events',
  'meri_agent_profile_leases',
  'meri_agent_admission_slots',
  'meri_agent_run_reservations',
  'meri_agent_budget_periods',
  'meri_agent_runs',
  'meri_execution_scopes',
];

function fixtureUrl() {
  const raw = process.env.LEGIWATCH_MIGRATION_REHEARSAL_DATABASE_URL;
  if (!raw)
    throw new Error('LEGIWATCH_MIGRATION_REHEARSAL_DATABASE_URL is required; no skipped rehearsal');
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Only owned localhost PostgreSQL',
  );
  assert.equal(url.username, 'legiwatch_test', 'Only the disposable CI fixture identity');
  assert.ok(
    ['/capiro', '/capiro_committee_alerts_ci'].includes(url.pathname),
    'Unexpected fixture service',
  );
  url.pathname = '/postgres';
  return url;
}

function deploy(schema, databaseUrl) {
  execFileSync(
    process.execPath,
    [
      path.join(apiRoot, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      schema,
    ],
    {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
      timeout: 10 * 60_000,
    },
  );
}

async function catalog(db) {
  return (
    await db.query(`
    SELECT c.oid::text AS oid,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS grants,
      c.relrowsecurity AS rls,c.relforcerowsecurity AS forced_rls,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull) ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      (SELECT jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid)) ORDER BY x.conname)
       FROM pg_constraint x WHERE x.conrelid=c.oid AND x.conname<>'${constraintName}') AS constraints,
      (SELECT jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) ORDER BY indexname)
       FROM pg_indexes WHERE schemaname='public' AND tablename='${tableName}') AS indexes,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p
       WHERE p.schemaname='public' AND p.tablename='${tableName}') AS policies
    FROM pg_class c WHERE c.oid='public.${tableName}'::regclass
  `)
  ).rows[0];
}

async function insertType(db, type, prefix = 'fixture') {
  if (urlProvenance) {
    return db.query(
      `INSERT INTO congress_committee (system_code,thomas_id,name,chamber,is_current,url,url_source)
       VALUES ($1,$1,'Migration qualification','house',true,'https://example.house.gov/',$2)`,
      [`${prefix}-${type ?? 'null'}`, type],
    );
  }
  return db.query(
    `INSERT INTO committee_site_update
    (id,committee_system_code,update_type,normalized_title,source_url,content_hash)
    VALUES ($1,'hssm00',$2,'Migration qualification','https://smallbusiness.house.gov/news/', $1)`,
    [`${prefix}-${type}`, type],
  );
}

async function rejectType(db, type) {
  await assert.rejects(
    insertType(db, type, 'rejected'),
    (error) => error.code === '23514' && error.constraint === constraintName,
  );
}

async function checkLedgerAndRetirement(db, includeNews) {
  for (const name of includeNews ? [retirement, migration] : [retirement]) {
    const rows = (
      await db.query(
        `SELECT checksum FROM _prisma_migrations
      WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [name],
      )
    ).rows;
    assert.equal(rows.length, 1, `Successful migration ledger entry: ${name}`);
    assert.equal(
      rows[0].checksum,
      createHash('sha256')
        .update(readFileSync(path.join(prismaRoot, 'migrations', name, 'migration.sql')))
        .digest('hex'),
    );
  }
  for (const table of retiredTables)
    assert.equal(
      (await db.query('SELECT to_regclass($1) AS relation', [`public.${table}`])).rows[0].relation,
      null,
      `Retired table stays absent: ${table}`,
    );
  assert.equal(
    (
      await db.query(`SELECT count(*)::int AS count FROM _prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL`)
    ).rows[0].count,
    0,
  );
}

async function assertFinal(db, prefix) {
  for (const type of [...oldTypes, newType]) await insertType(db, type, prefix);
  await rejectType(db, 'invented_update_type');
  await checkLedgerAndRetirement(db, true);
  const definition = (
    await db.query(`SELECT pg_get_constraintdef(oid) AS definition,convalidated
    FROM pg_constraint WHERE conrelid='${tableName}'::regclass
      AND conname='${constraintName}'`)
  ).rows;
  assert.equal(definition.length, 1);
  assert.equal(definition[0].convalidated, true);
  for (const type of [...oldTypes, newType])
    if (type !== null) assert.ok(definition[0].definition.includes(`'${type}'`));
  return definition[0];
}

async function main() {
  const adminUrl = fixtureUrl();
  const admin = new Client({ connectionString: adminUrl.toString() });
  const owned = [];
  const temporary = mkdtempSync(path.join(tmpdir(), 'capiro-committee-news-migration-'));
  const prefix = `capiro_news_migration_${process.pid}_${randomBytes(4).toString('hex')}`;
  await admin.connect();
  try {
    const names = readdirSync(path.join(prismaRoot, 'migrations'))
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    assert.ok(names.includes(migration), 'Reviewed migration exists');
    const baseline = path.join(temporary, 'prisma');
    cpSync(prismaRoot, baseline, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(prismaRoot, source).split(path.sep);
        return (
          relative[0] !== 'migrations' ||
          !relative[1] ||
          !/^\d{14}_/.test(relative[1]) ||
          relative[1] < migration
        );
      },
    });
    for (const scenario of ['fresh', 'retired_upgrade']) {
      const name = `${prefix}_${scenario}`;
      assert.match(name, /^capiro_news_migration_[0-9]+_[a-f0-9]{8}_(fresh|retired_upgrade)$/);
      await admin.query(`CREATE DATABASE "${name}"`);
      owned.push(name);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      const db = new Client({ connectionString: url.toString() });
      await db.connect();
      try {
        for (const file of [
          'disposable-capiro-worker-prerequisite.sql',
          'research-portfolio-append-only-prerequisite.sql',
        ])
          await db.query(readFileSync(path.join(repoRoot, 'scripts/ci', file), 'utf8'));
        if (scenario === 'fresh') {
          deploy(path.join(prismaRoot, 'schema.prisma'), url.toString());
          const constraint = await assertFinal(db, 'fresh');
          const table = await catalog(db);
          assert.equal(table.rls, false, 'Committee facts remain global');
          assert.equal(table.forced_rls, false);
          console.log(JSON.stringify({ scenario, status: 'passed', constraint, catalog: table }));
        } else {
          deploy(path.join(baseline, 'schema.prisma'), url.toString());
          await checkLedgerAndRetirement(db, false);
          for (const type of oldTypes) await insertType(db, type, 'legacy');
          await rejectType(db, newType);
          // A real non-owner grant makes accidental grant loss observable even
          // when the disposable cluster does not define capiro_app.
          await db.query(`GRANT SELECT ON ${tableName} TO capiro_worker`);
          const before = await catalog(db);
          cpSync(
            path.join(prismaRoot, 'migrations', migration),
            path.join(baseline, 'migrations', migration),
            { recursive: true },
          );
          deploy(path.join(baseline, 'schema.prisma'), url.toString());
          assert.deepEqual(await catalog(db), before, 'Only the update-type constraint may change');
          assert.equal(
            (
              await db.query(
                `SELECT count(*)::int AS count FROM ${tableName} WHERE ${urlProvenance ? 'system_code' : 'id'} LIKE 'legacy-%'`,
              )
            ).rows[0].count,
            oldTypes.length,
          );
          const constraint = await assertFinal(db, 'upgraded');
          // A second real runner invocation proves the ledger is stable.
          deploy(path.join(baseline, 'schema.prisma'), url.toString());
          await checkLedgerAndRetirement(db, true);
          console.log(
            JSON.stringify({
              scenario,
              status: 'passed',
              preservedLegacyRows: oldTypes.length,
              constraint,
              preservedCatalog: before,
            }),
          );
        }
      } finally {
        await db.end();
      }
    }
    console.log(
      JSON.stringify({
        status: 'passed',
        migration,
        checksum: createHash('sha256')
          .update(readFileSync(path.join(prismaRoot, 'migrations', migration, 'migration.sql')))
          .digest('hex'),
        checks: [
          'freshDatabase',
          'retiredUpgrade',
          'legacyWriterCompatibility',
          'unknownTypeRejected',
          'grantsRlsOwnershipPreserved',
        ],
      }),
    );
  } finally {
    for (const name of owned) await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    const resolved = path.resolve(temporary);
    assert.ok(
      path.dirname(resolved) === path.resolve(tmpdir()) &&
        path.basename(resolved).startsWith('capiro-committee-news-migration-'),
    );
    rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
