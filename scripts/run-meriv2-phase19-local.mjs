#!/usr/bin/env node
/**
 * Local, GitHub-Actions-independent Phase 19 runner.
 *
 * Creates a disposable pgvector database, applies the exact checkout's
 * migrations, seeds application-valid fixtures, starts the real API and Web
 * applications, runs the four-actor Clerk/Chrome acceptance matrix, and tears
 * everything down. It never touches a shared database or AWS.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha =
  args.sha ?? process.env.PHASE19_SHA ?? (await capture('git', ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Phase 19 requires an exact 40-character SHA.');

const evidenceDir = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/meriv2-phase19-${sha}`);
const fixtureFile = path.join(evidenceDir, 'fixtures.json');
const databaseUrl = 'postgresql://capiro:capiro@127.0.0.1:55459/capiro?schema=public';
const psqlUrl = 'postgresql://capiro:capiro@127.0.0.1:55459/capiro';
const containerName = `meriv2-phase19-${process.pid}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const children = [];

const requiredSecrets = [
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'CLERK_JWT_ISSUER',
  'VITE_CLERK_PUBLISHABLE_KEY',
  'PHASE19_CLERK_ORG_ID',
  'PHASE19_PROPOSER_CLERK_USER_ID',
  'PHASE19_PROPOSER_EMAIL',
  'PHASE19_PROPOSER_COOKIE',
  'PHASE19_REVIEWER_CLERK_USER_ID',
  'PHASE19_REVIEWER_EMAIL',
  'PHASE19_REVIEWER_COOKIE',
  'PHASE19_CLIENT_REVIEWER_CLERK_USER_ID',
  'PHASE19_CLIENT_REVIEWER_EMAIL',
  'PHASE19_CLIENT_REVIEWER_COOKIE',
  'PHASE19_DENIED_CLERK_USER_ID',
  'PHASE19_DENIED_EMAIL',
  'PHASE19_DENIED_COOKIE',
  'PHASE18_ACCEPTED_SHA',
];
const preparedStates = [
  'PHASE19_LIVE_CONTEXT_PATH',
  'PHASE19_LIVE_CONTEXT_EXPECT',
  'PHASE19_LIVE_SHADOW_PATH',
  'PHASE19_LIVE_SHADOW_EXPECT',
  'PHASE19_LIVE_ENFORCE_PATH',
  'PHASE19_LIVE_ENFORCE_EXPECT',
  'PHASE19_LIVE_CHAT_PATH',
  'PHASE19_LIVE_CHAT_EXPECT',
  'PHASE19_LIVE_EDITOR_PATH',
  'PHASE19_LIVE_EDITOR_EXPECT',
  'PHASE19_LIVE_WORKSPACE_PATH',
  'PHASE19_LIVE_WORKSPACE_EXPECT',
  'PHASE19_LIVE_STRATEGY_PATH',
  'PHASE19_LIVE_STRATEGY_EXPECT',
  'PHASE19_LIVE_EXPORT_PATH',
  'PHASE19_LIVE_EXPORT_EXPECT',
  'PHASE19_LIVE_PROPOSAL_PATH',
  'PHASE19_LIVE_PROPOSAL_EXPECT',
];

async function main() {
  for (const name of [...requiredSecrets, ...preparedStates]) required(name);
  if (process.env.PHASE18_ACCEPTED_SHA.trim() !== sha) {
    throw new Error('PHASE18_ACCEPTED_SHA must equal the exact checkout SHA.');
  }
  await mkdir(evidenceDir, { recursive: true });

  const env = {
    ...process.env,
    CI: 'true',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: databaseUrl,
    PSQL_DATABASE_URL: psqlUrl,
    PHASE19_FIXTURE_FILE: fixtureFile,
    PHASE19_EVIDENCE_DIR: evidenceDir,
    PHASE19_BASE_URL: 'http://127.0.0.1:5173',
    PHASE19_API_TARGET: 'http://127.0.0.1:4000',
    VITE_API_BASE_URL: 'http://127.0.0.1:4000',
    WEB_ORIGIN: 'http://127.0.0.1:5173',
    API_PORT: '4000',
    API_BIND_HOST: '127.0.0.1',
    // This is a disposable, isolated database. Selecting all here is intentional:
    // it proves the tenant-canary code path instead of silently exercising the
    // dark fallback after Phase 22 introduced MEMORY_GOVERNANCE_TENANTS.
    MEMORY_GOVERNANCE_TENANTS: 'all',
    MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
    MEMORY_GOVERNANCE_ENFORCE: 'enforce',
    MEMORY_GOVERNANCE_CENTER: 'enforce',
    MEMORY_CLIENT_REVIEW: 'enforce',
    MERIV2_CONTEXT_PACKET_V2: 'enforce',
    MEMORY_AUTOLEARN_GOVERNED: 'false',
    MERI_POLICY_PACK_SOURCE: 'off',
    MERI_POLICY_PACK_TENANTS: '',
    MERI_RELEASE_GATE: 'off',
    MERI_RELEASE_GATE_TENANTS: '',
    MERI_RELEASE_GATE_SURFACES: '',
    NOTES_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    NOTES_ENCRYPTION_KEY_VERSION: 'phase19-local',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'phase19-local',
    OAUTH_STATE_SECRET: 'phase19-local-only-oauth-state-secret-not-production',
    PHASE19_SHA: sha,
  };

  try {
    await run('Remove stale Phase 19 container', docker, ['rm', '-f', containerName], {
      allowFailure: true,
      env,
    });
    await run(
      'Start disposable pgvector PostgreSQL',
      docker,
      [
        'run',
        '-d',
        '--name',
        containerName,
        '-e',
        'POSTGRES_USER=capiro',
        '-e',
        'POSTGRES_PASSWORD=capiro',
        '-e',
        'POSTGRES_DB=capiro',
        '-p',
        '55459:5432',
        'pgvector/pgvector:pg16',
      ],
      { env },
    );
    await waitForDatabase(env);

    await run(
      'Apply all API migrations',
      pnpm,
      ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'],
      { env },
    );
    await run(
      'Seed application-valid Phase 19 fixtures',
      pnpm,
      ['--filter', '@capiro/api', 'exec', 'tsx', 'scripts/seed-meriv2-phase19-browser-fixtures.ts'],
      { env },
    );

    const api = start('api', pnpm, ['--filter', '@capiro/api', 'dev'], env);
    const web = start(
      'web',
      pnpm,
      ['--filter', '@capiro/web', 'dev', '--', '--host', '127.0.0.1'],
      env,
    );
    children.push(api, web);
    await waitForUrl('http://127.0.0.1:4000/health', 120_000);
    await waitForUrl('http://127.0.0.1:5173/', 120_000);

    await run(
      'Run authenticated browser and accessibility acceptance',
      process.execPath,
      ['apps/web/scripts/meriv2-phase19-browser-acceptance.mjs'],
      { env },
    );

    const summary = {
      marker: 'MERIV2_PHASE19_LOCAL_COMPLETE',
      sha,
      evidenceDir,
      sharedDatabaseTouched: false,
      awsMutation: false,
    };
    await writeFile(
      path.join(evidenceDir, 'local-runner-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary));
  } finally {
    await cleanup();
  }
}

async function waitForDatabase(env) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const code = await run(
      'PostgreSQL readiness probe',
      docker,
      ['exec', containerName, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      { allowFailure: true, quiet: true, env },
    );
    if (code === 0) return;
    await sleep(1000);
  }
  throw new Error('Disposable PostgreSQL did not become ready.');
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status} ${response.statusText}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

function start(label, command, commandArgs, env) {
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${label}] `;
  child.stdout.on('data', (chunk) => process.stdout.write(prefix + chunk.toString()));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix + chunk.toString()));
  child.once('exit', (code) => {
    if (code && !child.killed) process.stderr.write(`${prefix}exited with code ${code}\n`);
  });
  return child;
}

async function run(label, command, commandArgs, options = {}) {
  if (!options.quiet) console.log(`\n==> ${label}`);
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: options.quiet ? 'ignore' : 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${label} failed with exit code ${code}.`);
  }
  return code;
}

async function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' && command === 'git' ? 'git.exe' : command,
      commandArgs,
      {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed: ${stderr}`));
    });
  });
}

async function cleanup() {
  for (const child of children.reverse()) await terminate(child);
  await run('Remove disposable Phase 19 PostgreSQL', docker, ['rm', '-f', containerName], {
    allowFailure: true,
    quiet: true,
  }).catch(() => undefined);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await run(
      'Terminate local child process',
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        allowFailure: true,
        quiet: true,
      },
    ).catch(() => undefined);
  } else {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5000).then(() => child.kill('SIGKILL')),
    ]);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for local Phase 19 acceptance.`);
  return value;
}

function parse(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    output[key] = value;
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  const payload = {
    marker: 'MERIV2_PHASE19_LOCAL_FAILED',
    sha,
    error: error instanceof Error ? error.message : String(error),
    sharedDatabaseTouched: false,
    awsMutation: false,
  };
  await writeFile(
    path.join(evidenceDir, 'local-runner-failure.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
