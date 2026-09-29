#!/usr/bin/env node
/** Full destructive rehearsal is restricted to the pinned GitHub Actions pgvector service.
 * Local guard/prerequisite tests remain supported; arbitrary PGHOST and split Docker/native
 * Windows full rehearsals are intentionally refused before any target subprocess.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function assertPhase3DisposableInvocation(env = process.env, platform = process.platform) {
  if (env.GITHUB_ACTIONS !== 'true' || env.CI !== 'true' || env.CI_DISPOSABLE_POSTGRES !== '1') {
    throw new Error(
      'Full Phase 3 DB rehearsal requires the GitHub-owned disposable service: GITHUB_ACTIONS=true, CI=true, CI_DISPOSABLE_POSTGRES=1; direct local full rehearsals are unsupported.',
    );
  }
  if (platform !== 'linux')
    throw new Error(
      'Full Phase 3 DB rehearsal supports only the GitHub Linux service; prior split Docker/native Windows invocation is unsupported.',
    );
  if (env.PGHOST !== '127.0.0.1' || env.PGPORT !== '5432' || env.PGUSER !== 'postgres')
    throw new Error('Phase 3 target must be exactly postgres@127.0.0.1:5432.');
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGDATABASE']) {
    if (env[key]) throw new Error(`Phase 3 refuses inherited libpq target override ${key}.`);
  }
  const pinned = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^PG/i.test(key) &&
        key !== 'DATABASE_URL' &&
        key !== 'DIRECT_URL' &&
        key !== 'SHADOW_DATABASE_URL',
    ),
  );
  return Object.freeze({
    ...pinned,
    PGHOST: '127.0.0.1',
    PGHOSTADDR: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGDATABASE: 'postgres',
    PGPASSWORD: env.PGPASSWORD || '',
  });
}

export function createPhase3OwnedResources({
  admin,
  psqlInput,
  freshDb,
  upgradeDb,
  probeRole,
  probePassword,
  appendOnlySql,
}) {
  if (
    [freshDb, upgradeDb, probeRole].some((name) => typeof name !== 'string' || name.length > 63) ||
    !/^outreach_v3_p3_fresh_[a-zA-Z0-9_]+$/.test(freshDb) ||
    !/^outreach_v3_p3_upgrade_[a-zA-Z0-9_]+$/.test(upgradeDb) ||
    !/^outreach_v3_p3_probe_[a-zA-Z0-9_]+$/.test(probeRole) ||
    !/^[a-zA-Z0-9_]+$/.test(probePassword)
  )
    throw new Error('Invalid owned Phase 3 resource identity.');
  let verified = false;
  let probeCreated = false;
  const created = new Set();
  const allowed = new Set([freshDb, upgradeDb]);
  const requireVerified = () => {
    if (!verified) throw new Error('Phase 3 target identity was not verified.');
  };
  return {
    verifyTarget() {
      if (
        admin(
          "SELECT current_database(), current_user, inet_server_port(), current_setting('is_superuser');",
        ).trim() !== 'postgres|postgres|5432|on'
      )
        throw new Error('Unexpected Phase 3 PostgreSQL target identity.');
      const ready =
        admin(`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname='capiro'), EXISTS (
        SELECT 1 FROM pg_roles r WHERE r.rolname='capiro_worker'
        AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolcanlogin OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE r.oid IN (m.roleid,m.member))
      );`).trim();
      if (ready !== 't|t')
        throw new Error(
          'Owned service capiro database / least-privilege worker role prerequisites are missing; run the guarded canonical CI bootstrap.',
        );
      verified = true;
    },
    createProbe() {
      requireVerified();
      if (probeCreated) throw new Error('Phase 3 probe already created by this invocation.');
      admin(
        `CREATE ROLE "${probeRole}" LOGIN PASSWORD '${probePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
      );
      probeCreated = true;
    },
    createDb(db) {
      requireVerified();
      if (!allowed.has(db) || created.has(db))
        throw new Error('Refusing unowned or repeated Phase 3 database creation.');
      // CREATE collision fails; never delete a database merely because its name matches.
      admin(`CREATE DATABASE "${db}";`);
      created.add(db);
      psqlInput(db, appendOnlySql);
    },
    cleanup() {
      const errors = [];
      if (!verified) return errors;
      for (const db of [...created].reverse()) {
        try {
          admin(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db}' AND pid<>pg_backend_pid();`,
          );
          admin(`DROP DATABASE "${db}";`);
          created.delete(db);
        } catch (error) {
          errors.push(error);
        }
      }
      if (probeCreated) {
        try {
          admin(`DROP ROLE "${probeRole}";`);
          probeCreated = false;
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
  };
}

export function runPhase3DatabaseRehearsal() {
  // Validate before version checks, any PostgreSQL call, resource setup, or cleanup.
  const targetEnv = assertPhase3DisposableInvocation();
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const PRISMA = resolve(ROOT, 'apps/api/prisma');
  const MAIN_SCHEMA = resolve(PRISMA, 'schema.prisma');
  const FOCUSED_SCHEMA = resolve(PRISMA, 'outreach-v3-phase3/schema.prisma');
  const PHASE3_MIGRATIONS = [
    '20261001012000_outreach_v3_reasoning_conversations',
    '20261001012100_outreach_v3_reasoning_turn_claim',
    '20261001012200_outreach_v3_reasoning_archive_claim_cleanup',
  ];
  const migrationSql = PHASE3_MIGRATIONS.map((name) =>
    readFileSync(resolve(PRISMA, 'migrations', name, 'migration.sql'), 'utf8'),
  );

  const PSQL = process.env.PSQL_BIN || 'psql';
  const PGHOST = targetEnv.PGHOST;
  const PGPORT = targetEnv.PGPORT;
  const PGUSER = targetEnv.PGUSER;
  const PGPASSWORD = targetEnv.PGPASSWORD;
  const suffix = randomUUID().replaceAll('-', '');
  const FRESH_DB = `outreach_v3_p3_fresh_${suffix}`;
  const UPGRADE_DB = `outreach_v3_p3_upgrade_${suffix}`;
  const PROBE_ROLE = `outreach_v3_p3_probe_${suffix}`;
  const PROBE_PASSWORD = `p3_${process.pid}_probe`;
  const tempRoot = mkdtempSync(join(tmpdir(), 'capiro-outreach-v3-p3-'));

  const TENANT_A = '00000000-0000-4000-8000-000000000001';
  const TENANT_B = '00000000-0000-4000-8000-000000000002';
  const USER_A = '00000000-0000-4000-8000-000000000011';
  const USER_B = '00000000-0000-4000-8000-000000000012';
  const SESSION_A = '00000000-0000-4000-8000-000000000021';
  const SESSION_B = '00000000-0000-4000-8000-000000000022';
  const VERSION_A = '00000000-0000-4000-8000-000000000031';
  const CONVERSATION_A = '00000000-0000-4000-8000-000000000041';
  const TURN_A = '00000000-0000-4000-8000-000000000051';
  const HASH_A = 'a'.repeat(64);
  const USER_HASH = 'b'.repeat(64);
  const ASSISTANT_HASH = 'c'.repeat(64);

  let passes = 0;
  function ok(label) {
    passes += 1;
    console.log(`  PASS  ${label}`);
  }
  function eq(label, actual, expected) {
    if (String(actual).trim() !== String(expected).trim()) {
      throw new Error(
        `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    ok(`${label} (${String(actual).trim()})`);
  }
  function run(bin, args, options = {}) {
    const result = spawnSync(bin, args, {
      cwd: options.cwd || ROOT,
      env: { ...targetEnv, ...(options.env || {}) },
      input: options.input,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(
        `${bin} ${args.join(' ')} failed (${result.status})\n${result.stderr || result.stdout}`,
      );
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    }
    return String(result.stdout || '').trim();
  }
  function psql(db, sql, options = {}) {
    return psqlInput(db, sql, options);
  }
  function psqlInput(db, sql, options = {}) {
    return run(
      PSQL,
      [
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-qAt',
        '-h',
        PGHOST,
        '-p',
        PGPORT,
        '-U',
        options.user || PGUSER,
        '-d',
        db,
      ],
      {
        env: {
          PGPASSWORD: options.password ?? PGPASSWORD,
          PGDATABASE: db,
          PGUSER: options.user || PGUSER,
        },
        input: sql,
      },
    );
  }
  function admin(sql) {
    return psqlInput('postgres', sql);
  }
  function createDb(db) {
    resources.createDb(db);
  }
  function databaseUrl(db) {
    const url = new URL('postgresql://localhost');
    url.username = PGUSER;
    if (PGPASSWORD) url.password = PGPASSWORD;
    url.hostname = PGHOST;
    url.port = PGPORT;
    url.pathname = `/${db}`;
    url.searchParams.set('schema', 'public');
    return url.toString();
  }
  function migrate(db, schemaPath) {
    run(
      'pnpm',
      ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath],
      { env: { DATABASE_URL: databaseUrl(db) } },
    );
  }
  function validateFocused(db) {
    run(
      'pnpm',
      ['--filter', '@capiro/api', 'exec', 'prisma', 'validate', '--schema', FOCUSED_SCHEMA],
      { env: { DATABASE_URL: databaseUrl(db) } },
    );
  }
  function expectSqlFailure(label, db, sql, pattern, options = {}) {
    try {
      psql(db, sql, options);
    } catch (error) {
      const text = `${error.message || ''}\n${error.stderr || ''}`;
      if (pattern && !pattern.test(text)) {
        throw new Error(`${label}: failed for unexpected reason: ${text.slice(-1200)}`);
      }
      ok(label);
      return;
    }
    throw new Error(`${label}: statement unexpectedly succeeded`);
  }
  function seedIdentity(db) {
    psql(
      db,
      `INSERT INTO tenants (id, slug, name, status) VALUES
      ('${TENANT_A}','p3-a-${process.pid}','P3 A','active'),
      ('${TENANT_B}','p3-b-${process.pid}','P3 B','active')
      ON CONFLICT (id) DO NOTHING;
     INSERT INTO users (id, clerk_user_id, email) VALUES
      ('${USER_A}','p3_user_a_${process.pid}','p3-a-${process.pid}@example.invalid'),
      ('${USER_B}','p3_user_b_${process.pid}','p3-b-${process.pid}@example.invalid')
      ON CONFLICT (id) DO NOTHING;`,
    );
  }
  function seedPhase2State(db) {
    const blank = JSON.stringify({
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: null,
        tone: null,
        length: 'undecided',
        customLengthInstruction: null,
      },
    }).replaceAll("'", "''");
    psql(
      db,
      `INSERT INTO outreach_sessions
      (id,tenant_id,created_by_user_id,status,current_state_version,title)
      VALUES
      ('${SESSION_A}','${TENANT_A}','${USER_A}','active',1,'P3 tenant A'),
      ('${SESSION_B}','${TENANT_B}','${USER_B}','active',1,'P3 tenant B')
      ON CONFLICT (id) DO NOTHING;
     INSERT INTO outreach_state_versions
      (id,tenant_id,session_id,version,schema_version,spec_jsonb,spec_hash,created_by_user_id)
      VALUES
      ('${VERSION_A}','${TENANT_A}','${SESSION_A}',1,'outreach_campaign_spec_v1','${blank}'::jsonb,'${HASH_A}','${USER_A}')
      ON CONFLICT (session_id,version) DO NOTHING;`,
    );
  }
  function createProbe() {
    resources.createProbe();
  }
  function grantProbe(db) {
    psql(
      db,
      `GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}";
     GRANT SELECT,INSERT,UPDATE ON outreach_reasoning_conversations TO "${PROBE_ROLE}";
     GRANT SELECT,INSERT ON outreach_reasoning_turns TO "${PROBE_ROLE}";`,
    );
  }
  function seedReasoning(db) {
    psql(
      db,
      `INSERT INTO outreach_reasoning_conversations
      (id,tenant_id,session_id,created_by_user_id,provider,state_mode,model,reasoning_effort,status)
      VALUES ('${CONVERSATION_A}','${TENANT_A}','${SESSION_A}','${USER_A}','openai','capiro_managed','eval-model','medium','active');
     INSERT INTO outreach_reasoning_turns
      (id,tenant_id,conversation_id,session_id,actor_user_id,state_version,
       user_message_text,assistant_message_text,user_message_hash,assistant_message_hash,
       tool_result_refs_jsonb,proposal_ids_jsonb,open_questions_jsonb,usage_jsonb,
       latency_ms,status,failure_code)
      VALUES ('${TURN_A}','${TENANT_A}','${CONVERSATION_A}','${SESSION_A}','${USER_A}',1,
       'visible user','visible assistant','${USER_HASH}','${ASSISTANT_HASH}',
       '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,10,'succeeded',NULL);`,
    );
  }
  function checkDb(db, labelPrefix) {
    eq(
      `${labelPrefix}: conversation table exists`,
      psql(db, `SELECT to_regclass('public.outreach_reasoning_conversations') IS NOT NULL;`),
      't',
    );
    eq(
      `${labelPrefix}: turn table exists`,
      psql(db, `SELECT to_regclass('public.outreach_reasoning_turns') IS NOT NULL;`),
      't',
    );
    eq(
      `${labelPrefix}: both tables force RLS`,
      psql(
        db,
        `SELECT COUNT(*) FROM pg_class WHERE oid IN ('outreach_reasoning_conversations'::regclass,'outreach_reasoning_turns'::regclass) AND relrowsecurity AND relforcerowsecurity;`,
      ),
      '2',
    );
    grantProbe(db);
    seedReasoning(db);

    eq(
      `${labelPrefix}: tenant A sees its conversation`,
      psql(
        db,
        `SET app.current_tenant='${TENANT_A}'; SELECT COUNT(*) FROM outreach_reasoning_conversations;`,
        { user: PROBE_ROLE, password: PROBE_PASSWORD },
      )
        .split('\n')
        .at(-1),
      '1',
    );
    eq(
      `${labelPrefix}: tenant B cannot see tenant A conversation`,
      psql(
        db,
        `SET app.current_tenant='${TENANT_B}'; SELECT COUNT(*) FROM outreach_reasoning_conversations;`,
        { user: PROBE_ROLE, password: PROBE_PASSWORD },
      )
        .split('\n')
        .at(-1),
      '0',
    );
    expectSqlFailure(
      `${labelPrefix}: tenant A cannot insert tenant B conversation`,
      db,
      `SET app.current_tenant='${TENANT_A}'; INSERT INTO outreach_reasoning_conversations
      (tenant_id,session_id,created_by_user_id,provider,state_mode,model,reasoning_effort,status)
      VALUES ('${TENANT_B}','${SESSION_B}','${USER_B}','openai','capiro_managed','x','medium','active');`,
      /row-level security/i,
      { user: PROBE_ROLE, password: PROBE_PASSWORD },
    );

    expectSqlFailure(
      `${labelPrefix}: turn UPDATE rejected`,
      db,
      `UPDATE outreach_reasoning_turns SET latency_ms=11 WHERE id='${TURN_A}';`,
      /append-only/i,
    );
    expectSqlFailure(
      `${labelPrefix}: turn DELETE rejected`,
      db,
      `DELETE FROM outreach_reasoning_turns WHERE id='${TURN_A}';`,
      /append-only/i,
    );
    expectSqlFailure(
      `${labelPrefix}: conversation DELETE rejected`,
      db,
      `DELETE FROM outreach_reasoning_conversations WHERE id='${CONVERSATION_A}';`,
      /delete-protected/i,
    );
    expectSqlFailure(
      `${labelPrefix}: conversation identity mutation rejected`,
      db,
      `UPDATE outreach_reasoning_conversations SET model='different' WHERE id='${CONVERSATION_A}';`,
      /identity is immutable/i,
    );
    expectSqlFailure(
      `${labelPrefix}: partial claim rejected`,
      db,
      `UPDATE outreach_reasoning_conversations SET in_flight_turn_id='00000000-0000-4000-8000-000000000099' WHERE id='${CONVERSATION_A}';`,
      /turn_claim_shape_check|check constraint/i,
    );

    psql(
      db,
      `UPDATE outreach_reasoning_conversations SET in_flight_turn_id='00000000-0000-4000-8000-000000000099', in_flight_started_at=NOW() WHERE id='${CONVERSATION_A}';`,
    );
    ok(`${labelPrefix}: complete turn claim accepted`);
    psql(
      db,
      `UPDATE outreach_reasoning_conversations SET status='archived', archived_at=NOW() WHERE id='${CONVERSATION_A}';`,
    );
    ok(`${labelPrefix}: conversation archive accepted`);
    psql(
      db,
      `UPDATE outreach_reasoning_conversations SET in_flight_turn_id=NULL, in_flight_started_at=NULL, last_used_at=NOW() WHERE id='${CONVERSATION_A}';`,
    );
    ok(`${labelPrefix}: archived turn claim cleanup accepted`);
    expectSqlFailure(
      `${labelPrefix}: archived provider state mutation rejected`,
      db,
      `UPDATE outreach_reasoning_conversations SET last_response_id='resp_mutated' WHERE id='${CONVERSATION_A}';`,
      /archived outreach reasoning conversation is immutable/i,
    );

    psql(
      db,
      `BEGIN; SET LOCAL app.allow_audit_purge='on'; DELETE FROM outreach_reasoning_conversations WHERE id='${CONVERSATION_A}'; COMMIT;`,
    );
    eq(
      `${labelPrefix}: explicit tenant lifecycle purge removes conversation`,
      psql(
        db,
        `SELECT COUNT(*) FROM outreach_reasoning_conversations WHERE id='${CONVERSATION_A}';`,
      ),
      '0',
    );
    eq(
      `${labelPrefix}: tenant lifecycle purge cascades visible turns`,
      psql(db, `SELECT COUNT(*) FROM outreach_reasoning_turns WHERE id='${TURN_A}';`),
      '0',
    );
  }

  const resources = createPhase3OwnedResources({
    admin,
    psqlInput,
    freshDb: FRESH_DB,
    upgradeDb: UPGRADE_DB,
    probeRole: PROBE_ROLE,
    probePassword: PROBE_PASSWORD,
    appendOnlySql: readFileSync(
      resolve(ROOT, 'scripts/ci/research-portfolio-append-only-prerequisite.sql'),
      'utf8',
    ),
  });
  let exitCode = 0;
  try {
    resources.verifyTarget();
    run(PSQL, ['--version']);
    run(process.env.PNPM_BIN || 'pnpm', ['--version']);
    createProbe();

    console.log('== Revised Outreach Phase 3 DB rehearsal: fresh path ==');
    createDb(FRESH_DB);
    migrate(FRESH_DB, MAIN_SCHEMA);
    validateFocused(FRESH_DB);
    seedIdentity(FRESH_DB);
    seedPhase2State(FRESH_DB);
    checkDb(FRESH_DB, 'fresh');

    console.log('== Revised Outreach Phase 3 DB rehearsal: ordered upgrade ==');
    createDb(UPGRADE_DB);
    const upgradePrisma = resolve(tempRoot, 'prisma');
    cpSync(PRISMA, upgradePrisma, { recursive: true });
    for (const migration of PHASE3_MIGRATIONS) {
      rmSync(resolve(upgradePrisma, 'migrations', migration), { recursive: true, force: true });
    }
    migrate(UPGRADE_DB, resolve(upgradePrisma, 'schema.prisma'));
    seedIdentity(UPGRADE_DB);
    seedPhase2State(UPGRADE_DB);
    const phase2Before = psql(
      UPGRADE_DB,
      `SELECT version||':'||spec_hash||':'||md5(spec_jsonb::text) FROM outreach_state_versions WHERE id='${VERSION_A}';`,
    );
    for (const sql of migrationSql) psqlInput(UPGRADE_DB, sql);
    const phase2After = psql(
      UPGRADE_DB,
      `SELECT version||':'||spec_hash||':'||md5(spec_jsonb::text) FROM outreach_state_versions WHERE id='${VERSION_A}';`,
    );
    eq(
      'upgrade: Phase 2 canonical state unchanged by Phase 3 migrations',
      phase2After,
      phase2Before,
    );
    checkDb(UPGRADE_DB, 'upgrade');

    console.log(`OUTREACH_V3_PHASE3_DB_COMPLETE checks=${passes}`);
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    for (const cleanupError of resources.cleanup()) {
      exitCode = 1;
      console.error('Owned Phase 3 cleanup failed:', cleanupError.message);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runPhase3DatabaseRehearsal();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
