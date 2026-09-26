import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const container = 'capiro-meri-phase4-reservation-recovery-rehearsal';
const port = '55443';
const root = resolve(__dirname, '../../..');
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/capiro?schema=public`;
const pnpmEntrypoint = (() => {
  const value = process.env.npm_execpath;
  if (!value) throw new Error('run this rehearsal through the checked-in pnpm script');
  return value;
})();

function run(command: string, args: readonly string[], options: {
  env?: NodeJS.ProcessEnv; capture?: boolean; allowFailure?: boolean;
} = {}) {
  const result = spawnSync(command, [...args], {
    cwd: root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} failed with status ${String(result.status)}`);
  }
  return result;
}

function runPnpm(args: readonly string[], env: NodeJS.ProcessEnv) {
  return run(process.execPath, [pnpmEntrypoint, ...args], { env, allowFailure: true });
}

function query(sql: string): string {
  const result = run('docker', [
    'exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-At',
    '-U', 'postgres', '-d', 'capiro', '-c', sql,
  ], { capture: true });
  return result.stdout.trim();
}

const existing = run('docker', [
  'ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}',
], { capture: true }).stdout.trim();
if (existing) throw new Error(`refusing to replace existing container ${container}`);

try {
  run('docker', [
    'run', '--name', container,
    '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=capiro', '-p', `127.0.0.1:${port}:5432`,
    '-d', 'pgvector/pgvector:pg16',
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = run('docker', [
      'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'capiro',
    ], { capture: true, allowFailure: true });
    if (probe.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (!ready) throw new Error('disposable PostgreSQL did not become ready');

  const migrationEnv = { ...process.env, DATABASE_URL: databaseUrl };
  const expectedGate = runPnpm([
    '--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy',
  ], migrationEnv);
  if (expectedGate.status === 0) {
    throw new Error('Phase 4 PUBLIC baseline negative control unexpectedly passed');
  }
  const failed = query(`SELECT migration_name FROM _prisma_migrations
    WHERE finished_at IS NULL AND rolled_back_at IS NULL
    ORDER BY started_at DESC LIMIT 1`);
  if (failed !== '20280928050000_meri_phase4_route_operator') {
    throw new Error(`unexpected migration failure: ${failed}`);
  }

  run('docker', [
    'exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
    '-d', 'capiro', '-c',
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
     REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
     REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
     ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
     GRANT EXECUTE ON FUNCTION public.digest(bytea,text),
       public.gen_random_bytes(integer) TO PUBLIC;`,
  ]);
  const resolved = runPnpm([
    '--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'resolve',
    '--rolled-back', '20280928050000_meri_phase4_route_operator',
  ], migrationEnv);
  if (resolved.status !== 0) throw new Error('failed to resolve expected PUBLIC-gate migration');
  const deployed = runPnpm([
    '--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy',
  ], migrationEnv);
  if (deployed.status !== 0) throw new Error('failed to apply migrations after baseline');

  const invariant = query(`SELECT
    (SELECT count(*) FROM pg_auth_members m
      WHERE m.roleid='meri_phase4_authority_owner'::regrole
         OR m.member='meri_phase4_authority_owner'::regrole),
    (SELECT count(*) FROM pg_auth_members m
      WHERE m.roleid='meri_phase4_recovery_operator'::regrole
         OR m.member='meri_phase4_recovery_operator'::regrole),
    has_schema_privilege('meri_phase4_authority_owner','public','CREATE'),
    has_schema_privilege('meri_phase4_recovery_operator','public','CREATE'),
    has_table_privilege('meri_phase4_recovery_operator',
      'public.meri_phase4_recovery_obligations','SELECT,INSERT,UPDATE,DELETE'),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
      WHERE x.grantee=0 AND x.privilege_type='EXECUTE' AND n.nspname='public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
    (SELECT c.relowner='meri_phase4_authority_owner'::regrole AND
      c.relrowsecurity AND c.relforcerowsecurity
      FROM pg_class c WHERE c.oid='public.meri_phase4_recovery_obligations'::regclass),
    (SELECT count(*)=3 AND bool_and(p.proowner='meri_phase4_authority_owner'::regrole)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (
        'meri_phase4_guard_recovery_obligation',
        'meri_phase4_claim_recovery_obligations',
        'meri_phase4_record_recovery_outcome'
      )),
    (has_function_privilege('meri_phase4_recovery_operator',
       'public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint)','EXECUTE') AND
     has_function_privilege('meri_phase4_recovery_operator',
       'public.meri_phase4_record_recovery_outcome(uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar)','EXECUTE')),
    (has_function_privilege('capiro_app',
       'public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint)','EXECUTE') OR
     has_function_privilege('capiro_app',
       'public.meri_phase4_record_recovery_outcome(uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar)','EXECUTE') OR
     has_function_privilege('meri_phase4_route_operator',
       'public.meri_phase4_claim_recovery_obligations(uuid,integer,bigint)','EXECUTE') OR
     has_function_privilege('meri_phase4_route_operator',
       'public.meri_phase4_record_recovery_outcome(uuid,uuid,uuid,uuid,uuid,varchar,varchar,uuid,varchar,varchar)','EXECUTE')),
    (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL)`);
  if (invariant !== '0|0|f|f|f|0|t|t|t|f|449') {
    throw new Error(`Phase 4 reservation migrated invariant mismatch: ${invariant}`);
  }

  const tests = runPnpm([
    '--filter', '@capiro/api', 'exec', 'jest', '--runInBand', '--forceExit',
    'src/meri/hermes/meri-phase4-reservation-recovery.db.integration.spec.ts',
    'src/meri/hermes/meri-phase4-recovery-obligation.db.integration.spec.ts',
    'src/meri/hermes/meri-phase4-recovery-outcome-application.db.integration.spec.ts',
  ], {
    ...process.env,
    MERI_PHASE4_ROUTE_TEST_DATABASE_URL:
      `postgresql://postgres:postgres@127.0.0.1:${port}/capiro`,
    MERI_PHASE4_ROUTE_TEST_ACKNOWLEDGE_DISPOSABLE: 'yes',
  });
  if (tests.status !== 0) throw new Error('Phase 4 reservation database tests failed');
  const finalMemberships = query(`SELECT count(*) FROM pg_auth_members m
    WHERE m.roleid='meri_phase4_recovery_operator'::regrole
       OR m.member='meri_phase4_recovery_operator'::regrole`);
  if (finalMemberships !== '0') {
    throw new Error(`Phase 4 recovery test membership survived: ${finalMemberships}`);
  }
} finally {
  run('docker', ['rm', '-f', container], { allowFailure: true });
}
