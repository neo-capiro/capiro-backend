import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const container = 'capiro-meri-b1-b6-requalification';
const root = resolve(__dirname, '../../..');
const suffix = randomBytes(5).toString('hex');
const b3Database = `b3_accept_${suffix}`;
const pnpmEntrypoint = (() => {
  const value = process.env.npm_execpath;
  if (!value) throw new Error('run this rehearsal through the checked-in pnpm script');
  return value;
})();

const passwords = {
  b1: 'b1_test_local_only',
  research: 'b6_research_local_only',
  entity: 'b6_entity_local_only',
  integrated: 'b6_integrated_local_only',
} as const;

function run(command: string, args: readonly string[], options: {
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  allowFailure?: boolean;
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

function runPnpm(args: readonly string[], env: NodeJS.ProcessEnv, allowFailure = false) {
  return run(process.execPath, [pnpmEntrypoint, ...args], { env, allowFailure });
}

function psql(database: string, sql: string, capture = false): string {
  const result = run('docker', [
    'exec', container, 'psql', '-v', 'ON_ERROR_STOP=1',
    ...(capture ? ['-At'] : []), '-U', 'postgres', '-d', database, '-c', sql,
  ], { capture });
  return result.stdout?.trim() ?? '';
}

function postgresUrl(database: string) {
  return `postgresql://postgres:postgres@127.0.0.1:5498/${database}?schema=public`;
}

function verifyApiInvariant(database: string) {
  const invariant = psql(database, `SELECT
    (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),
    (SELECT count(*) FROM pg_auth_members m
      WHERE m.roleid='meri_phase4_authority_owner'::regrole
         OR m.member='meri_phase4_authority_owner'::regrole),
    has_schema_privilege('meri_phase4_authority_owner','public','CREATE'),
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) x
      WHERE x.grantee=0 AND x.privilege_type='EXECUTE' AND n.nspname='public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))`, true);
  if (invariant !== '449|0|f|0') {
    throw new Error(`${database}: migrated invariant mismatch ${invariant}`);
  }
}

function migrateApi(database: string) {
  const env = { ...process.env, DATABASE_URL: postgresUrl(database) };
  const first = runPnpm(
    ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'], env, true,
  );
  if (first.status !== 0) {
    const failed = psql(database, `SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
      ORDER BY started_at DESC LIMIT 1`, true);
    if (failed !== '20280928050000_meri_phase4_route_operator') {
      throw new Error(`${database}: unexpected API migration failure ${failed}`);
    }
    psql(database, `
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
      REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.digest(bytea,text),
        public.gen_random_bytes(integer) TO PUBLIC;
    `);
    runPnpm([
      '--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'resolve',
      '--rolled-back', '20280928050000_meri_phase4_route_operator',
    ], env);
    runPnpm(
      ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'], env,
    );
  }
  verifyApiInvariant(database);
}

function runJest(spec: string, env: NodeJS.ProcessEnv) {
  runPnpm(
    ['--filter', '@capiro/api', 'exec', 'jest', '--runInBand', '--forceExit', spec],
    { ...process.env, ...env, NODE_OPTIONS: '--max-old-space-size=4096' },
  );
}

const existing = run('docker', [
  'ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}',
], { capture: true }).stdout.trim();
if (existing) throw new Error(`refusing to replace existing container ${container}`);

try {
  run('docker', [
    'run', '--name', container,
    '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=postgres',
    '-p', '127.0.0.1:5498:5432',
    '-p', '127.0.0.1:55446:5432',
    '-p', '127.0.0.1:55447:5432',
    '-p', '127.0.0.1:55448:5432',
    '-d', 'pgvector/pgvector:pg16',
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = run('docker', [
      'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres',
    ], { capture: true, allowFailure: true });
    if (probe.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (!ready) throw new Error('disposable PostgreSQL did not become ready');

  for (const [role, password] of [
    ['b1_test', passwords.b1],
    ['b6_research', passwords.research],
    ['b6_entity_test', passwords.entity],
    ['b6_integrated', passwords.integrated],
  ] as const) {
    psql('postgres', `CREATE ROLE ${role} LOGIN SUPERUSER PASSWORD '${password}'`);
  }
  const databases = ['b1_accept', b3Database, 'capiro', 'b6_entity_accept'] as const;
  for (const database of databases) {
    psql('postgres', `CREATE DATABASE ${database}`);
  }
  migrateApi('b1_accept');
  for (const database of databases.slice(1)) {
    psql('postgres', `DROP DATABASE ${database} WITH (FORCE)`);
    psql('postgres', `CREATE DATABASE ${database} TEMPLATE b1_accept`);
    verifyApiInvariant(database);
  }

  const b3AdminUrl = postgresUrl(b3Database);
  runPnpm(
    ['--filter', '@capiro/intel-api', 'exec', 'prisma', 'migrate', 'deploy'],
    { ...process.env, DATABASE_URL: b3AdminUrl },
  );
  const intelMigrations = psql(b3Database, `SELECT
    count(*) - 449 FROM _prisma_migrations WHERE finished_at IS NOT NULL`, true);
  if (intelMigrations !== '61') {
    throw new Error(`B3 intel migration count mismatch: ${intelMigrations}`);
  }

  const b1Url = `postgresql://b1_test:${passwords.b1}@127.0.0.1:5498/b1_accept?schema=public`;
  runJest('src/meri/meri-b1-visibility.db.integration.spec.ts', {
    MERI_B1_TEST_DATABASE_URL: b1Url,
  });
  runJest('src/meri/meri-v3-visual-analysis.wall.db.integration.spec.ts', {
    DATABASE_URL: b1Url,
  });

  const b3Url = `postgresql://b1_test:${passwords.b1}@127.0.0.1:5498/${b3Database}?schema=public`;
  runJest('src/funding-opportunities/funding-opportunity-v2-search.http.integration.spec.ts', {
    DATABASE_URL: b3Url,
    FUNDING_OPPORTUNITIES_TEST_DATABASE_URL: b3Url,
    FUNDING_OPPORTUNITIES_ALLOW_LOCAL_DISPOSABLE: 'b3_accept',
  });

  const researchUrl =
    `postgresql://b6_research:${passwords.research}@127.0.0.1:55446/capiro?schema=public`;
  runJest('src/meri/meri-research-evidence.db.integration.spec.ts', {
    MERI_B6_RESEARCH_TEST_DATABASE_URL: researchUrl,
  });

  const entityUrl =
    `postgresql://b6_entity_test:${passwords.entity}` +
    '@127.0.0.1:55447/b6_entity_accept?schema=public';
  runJest('src/meri/meri-b6-entity.db.integration.spec.ts', {
    MERI_B6_ENTITY_TEST_DATABASE_URL: entityUrl,
  });

  const integratedUrl =
    `postgresql://b6_integrated:${passwords.integrated}@127.0.0.1:55448/capiro?schema=public`;
  runJest('src/meri/meri-b6-integrated.db.integration.spec.ts', {
    MERI_B6_INTEGRATED_TEST_DATABASE_URL: integratedUrl,
  });
} finally {
  run('docker', ['rm', '-f', container], { allowFailure: true });
}
