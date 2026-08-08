#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.PSQL_BIN || 'psql';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '5432';
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || '';
const DB = `outreach_v3_p2_flow_${process.pid}_${Date.now().toString(36)}`.replace(
  /[^a-zA-Z0-9_]/g,
  '_',
);

let output = null;
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--output') output = process.argv[++i];
  else throw new Error(`Unknown argument: ${process.argv[i]}`);
}
if (output) {
  output = resolve(ROOT, output);
  mkdirSync(dirname(output), { recursive: true });
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ''}` : '';
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status})${detail}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function psql(db, sql) {
  return run(
    PSQL,
    ['-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-h', PGHOST, '-p', PGPORT, '-U', PGUSER, '-d', db, '-c', sql],
    { env: { PGPASSWORD }, capture: true },
  );
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

function dropDatabase() {
  try {
    psql(
      'postgres',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid <> pg_backend_pid();`,
    );
  } catch {}
  try {
    psql('postgres', `DROP DATABASE IF EXISTS "${DB}";`);
  } catch {}
}

let exitCode = 0;
try {
  run(PSQL, ['--version'], { capture: true });
  run('pnpm', ['--version'], { capture: true });
  dropDatabase();
  psql('postgres', `CREATE DATABASE "${DB}";`);
  console.log(`Created disposable Phase 2 flow database ${DB}`);

  const url = databaseUrl(DB);
  run(
    'pnpm',
    ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    { env: { DATABASE_URL: url } },
  );

  const flowArgs = [
    '-C',
    'apps/api',
    'exec',
    'tsx',
    'scripts/outreach-v3-phase2-flow-rehearsal.ts',
  ];
  const flowOutput = run('pnpm', flowArgs, {
    env: {
      DATABASE_URL: url,
      ...(output ? { OUTREACH_V3_PHASE2_FLOW_OUTPUT: output } : {}),
    },
    capture: true,
  });
  if (!flowOutput.includes('OUTREACH_V3_PHASE2_FLOW_COMPLETE')) {
    throw new Error('Flow rehearsal exited without OUTREACH_V3_PHASE2_FLOW_COMPLETE');
  }
  console.log(flowOutput);
  if (output && !existsSync(output)) throw new Error(`Flow evidence was not written: ${output}`);

  const deleteOutput = run(
    'pnpm',
    [
      '-C',
      'apps/api',
      'exec',
      'tsx',
      'scripts/outreach-v3-phase2-delete-protection-rehearsal.ts',
    ],
    { env: { DATABASE_URL: url }, capture: true },
  );
  if (!deleteOutput.includes('OUTREACH_V3_PHASE2_DELETE_PROTECTION_COMPLETE')) {
    throw new Error(
      'Delete-protection rehearsal exited without OUTREACH_V3_PHASE2_DELETE_PROTECTION_COMPLETE',
    );
  }
  console.log(deleteOutput);

  console.log('OUTREACH_V3_PHASE2_FLOW_DB_COMPLETE');
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  dropDatabase();
  // Never leave a misleading partial evidence file on a failed run.
  if (exitCode !== 0 && output) rmSync(output, { force: true });
}

process.exit(exitCode);
