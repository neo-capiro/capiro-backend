#!/usr/bin/env node
/**
 * Isolated runtime for the mandatory Phase 1 post-acceptance proof.
 *
 * The primary closeout tears down its disposable services before returning.
 * This stage creates a fresh database, starts both API processes and the
 * unchanged web application, reruns the hardened authenticated browser proof,
 * then replays its requests and proves real seeded-record parity.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpawn } from './lib/resolve-tool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const SHA = args.sha ?? (await capture('git', ['rev-parse', 'HEAD'])).trim();
const actualSha = (await capture('git', ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(SHA) || SHA !== actualSha) {
  throw new Error(`Post-acceptance runtime requires exact HEAD ${actualSha}; got ${SHA}`);
}
const status = (await capture('git', ['status', '--short'])).trim();
if (status) throw new Error(`Post-acceptance runtime requires a clean checkout:\n${status}`);
const counts = (await capture('git', [
  'rev-list',
  '--left-right',
  '--count',
  'origin/main...HEAD',
]))
  .trim()
  .split(/\s+/)
  .map(Number);
if ((counts[0] ?? Number.NaN) !== 0) {
  throw new Error(`Branch is ${String(counts[0])} commit(s) behind origin/main`);
}

const EVIDENCE = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/engagement-phase1-${SHA}`);
const LOGS = path.join(EVIDENCE, 'logs');
const FIXTURES = path.join(EVIDENCE, 'fixtures.json');
const TOKEN_DIR = await mkdtemp(path.join(os.tmpdir(), 'capiro-engagement-phase1-post-'));
const TOKEN_FILE = path.join(TOKEN_DIR, 'bearer-token');
const DB_PORT = String(args.postDbPort ?? '55473');
const MAIN_PORT = String(args.postMainPort ?? '4000');
const SHADOW_PORT = String(args.postShadowPort ?? '4500');
const WEB_PORT = String(args.postWebPort ?? '5173');
const DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro?schema=public`;
const PSQL_DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro`;
const CONTAINER = `engagement-phase1-post-${process.pid}`;
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const children = [];

const clerkOrgId = requiredAny(
  'ENGAGEMENT_PHASE1_CLERK_ORG_ID',
  'ENGAGEMENT_PHASE0_CLERK_ORG_ID',
);
const clerkUserId = requiredAny(
  'ENGAGEMENT_PHASE1_USER_CLERK_ID',
  'ENGAGEMENT_PHASE0_USER_CLERK_ID',
);
const clerkUserEmail = requiredAny(
  'ENGAGEMENT_PHASE1_USER_EMAIL',
  'ENGAGEMENT_PHASE0_USER_EMAIL',
);
const clerkCookie = requiredAny(
  'ENGAGEMENT_PHASE1_USER_COOKIE',
  'ENGAGEMENT_PHASE0_USER_COOKIE',
);
const clerkPublishableKey = requiredAny(
  'VITE_CLERK_PUBLISHABLE_KEY',
  'CLERK_PUBLISHABLE_KEY',
);
required('CLERK_SECRET_KEY');
required('CLERK_JWT_ISSUER');

const commonEnv = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL,
  PSQL_DATABASE_URL,
  WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
  RELEASE_SHA: SHA,
  NOTES_ENCRYPTION_KEY:
    process.env.NOTES_ENCRYPTION_KEY ??
    'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  NOTES_ENCRYPTION_KEY_VERSION: process.env.NOTES_ENCRYPTION_KEY_VERSION ?? 'phase1-local',
  OAUTH_TOKEN_ENCRYPTION_KEY:
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY ??
    'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
  OAUTH_TOKEN_ENCRYPTION_KEY_VERSION:
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY_VERSION ?? 'phase1-local',
  OAUTH_STATE_SECRET:
    process.env.OAUTH_STATE_SECRET ?? 'phase1-local-only-oauth-state-secret-not-production',
  CLERK_WEBHOOK_SIGNING_SECRET:
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? 'whsec_phase1_local_only_not_production',
  ENGAGEMENT_PHASE0_CLERK_ORG_ID: clerkOrgId,
  ENGAGEMENT_PHASE0_USER_CLERK_ID: clerkUserId,
  ENGAGEMENT_PHASE0_USER_EMAIL: clerkUserEmail,
  ENGAGEMENT_PHASE0_USER_COOKIE: clerkCookie,
  ENGAGEMENT_PHASE0_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE1_CLERK_ORG_ID: clerkOrgId,
  ENGAGEMENT_PHASE1_USER_CLERK_ID: clerkUserId,
  ENGAGEMENT_PHASE1_USER_EMAIL: clerkUserEmail,
  ENGAGEMENT_PHASE1_USER_COOKIE: clerkCookie,
  ENGAGEMENT_PHASE1_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE1_EVIDENCE_DIR: EVIDENCE,
  ENGAGEMENT_PHASE1_EXPECTED_SHA: SHA,
  ENGAGEMENT_PHASE1_TOKEN_FILE: TOKEN_FILE,
  ENGAGEMENT_PHASE1_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
  ENGAGEMENT_PHASE1_MAIN_URL: `http://127.0.0.1:${MAIN_PORT}`,
  ENGAGEMENT_PHASE1_ENGAGEMENT_URL: `http://127.0.0.1:${SHADOW_PORT}`,
  VITE_API_BASE_URL: `http://127.0.0.1:${MAIN_PORT}`,
  VITE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
  CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY ?? clerkPublishableKey,
};
const mainEnv = {
  ...commonEnv,
  CAPIRO_SERVICE_NAME: 'api',
  API_PORT: MAIN_PORT,
  API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'active',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};
const shadowEnv = {
  ...commonEnv,
  CAPIRO_SERVICE_NAME: 'engagement-api',
  ENGAGEMENT_API_PORT: SHADOW_PORT,
  ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};

try {
  await mkdir(LOGS, { recursive: true });
  await run(
    'Remove stale post-acceptance database',
    DOCKER,
    ['rm', '-f', CONTAINER],
    commonEnv,
    true,
  );
  await run(
    'Start post-acceptance pgvector PostgreSQL',
    DOCKER,
    [
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'POSTGRES_USER=capiro',
      '-e',
      'POSTGRES_PASSWORD=capiro',
      '-e',
      'POSTGRES_DB=capiro',
      '-p',
      `${DB_PORT}:5432`,
      'pgvector/pgvector:pg16',
    ],
    commonEnv,
  );
  await waitDatabase();
  await run(
    'Apply migrations to post-acceptance database',
    'pnpm',
    ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'],
    mainEnv,
  );
  await run(
    'Seed post-acceptance Engagement fixtures',
    'pnpm',
    [
      '--filter',
      '@capiro/api',
      'exec',
      'tsx',
      'scripts/seed-engagement-phase0-browser-fixtures.ts',
    ],
    mainEnv,
  );
  await run(
    'Build exact-head API entrypoints for post-acceptance',
    'pnpm',
    ['--filter', '@capiro/api', 'run', 'build'],
    mainEnv,
  );

  children.push(
    start('post-main-api', process.execPath, ['apps/api/dist/main.js'], mainEnv),
    start('post-engagement-api', process.execPath, ['apps/api/dist/engagement-main.js'], shadowEnv),
    start(
      'post-web',
      'pnpm',
      ['--filter', '@capiro/web', 'dev', '--', '--host', '127.0.0.1', '--port', WEB_PORT],
      mainEnv,
    ),
  );
  await waitUrl(`http://127.0.0.1:${MAIN_PORT}/health`, 120_000);
  await waitUrl(`http://127.0.0.1:${SHADOW_PORT}/health`, 120_000);
  await waitUrl(`http://127.0.0.1:${WEB_PORT}/`, 120_000);

  await run(
    'Rerun hardened authenticated browser proof',
    process.execPath,
    [path.join(ROOT, 'apps/web/scripts/engagement-phase1-browser-parity.mjs')],
    commonEnv,
  );
  await run(
    'Successful-response and real-record verifier',
    process.execPath,
    [path.join(ROOT, 'apps/web/scripts/engagement-phase1-post-acceptance.mjs'), ...args],
    commonEnv,
  );
  console.log('ENGAGEMENT_PHASE1_POST_RUNTIME_COMPLETE');
} finally {
  for (const child of children.reverse()) await terminate(child);
  await run(
    'Remove post-acceptance PostgreSQL',
    DOCKER,
    ['rm', '-f', CONTAINER],
    commonEnv,
    true,
  ).catch(() => undefined);
  await rm(TOKEN_DIR, { recursive: true, force: true }).catch(() => undefined);
}

function start(label, command, commandArgs, env) {
  const resolved = resolveCommand(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(LOGS, `${label}.log`);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[${label}] ${text}`);
      appendFile(logFile, text).catch(() => undefined);
    });
  }
  return child;
}

async function run(label, command, commandArgs, env, allowFailure = false) {
  console.log(`\n==> ${label}`);
  const resolved = resolveCommand(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0 && !allowFailure) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function capture(command, commandArgs) {
  const resolved = resolveCommand(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed: ${stderr}`);
  return stdout;
}

function resolveCommand(command, commandArgs) {
  if (command === 'pnpm' || command === 'pnpm.cmd') return resolveSpawn('pnpm', commandArgs);
  if (command === 'git' || command === 'git.exe') return resolveSpawn('git', commandArgs);
  if (command === 'docker' || command === 'docker.exe') return resolveSpawn('docker', commandArgs);
  return { command, args: commandArgs };
}

async function waitDatabase() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const code = await run(
      'Post-acceptance PostgreSQL readiness probe',
      DOCKER,
      ['exec', CONTAINER, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      commonEnv,
      true,
    );
    if (code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Post-acceptance PostgreSQL did not become ready');
}

async function waitUrl(url, timeoutMs) {
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await run(
      'Terminate post-acceptance process',
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      commonEnv,
      true,
    ).catch(() => undefined);
  } else {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => child.kill('SIGKILL')),
    ]);
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the post-acceptance runtime`);
  return value;
}

function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required for the post-acceptance runtime`);
}

function parse(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    output[key] = value;
  }
  return output;
}
