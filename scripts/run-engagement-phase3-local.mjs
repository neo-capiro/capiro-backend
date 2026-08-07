#!/usr/bin/env node
/**
 * Authoritative local Phase 3 dual-mode acceptance runner.
 *
 * One disposable pgvector database, one main API, one shadow engagement-api,
 * one unchanged web SPA, and one localhost proxy that reproduces the Phase 2
 * ALB header rule. The browser harness creates isolated main and preview
 * contexts against the same fixture rows.
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhase3Proxy } from './engagement-phase3-local-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const ACTUAL_SHA = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const SHA = args.sha ?? ACTUAL_SHA;
if (!/^[0-9a-f]{40}$/i.test(SHA)) throw new Error('Phase 3 requires an exact 40-character SHA');
if (SHA !== ACTUAL_SHA) throw new Error(`--sha ${SHA} does not match checked-out HEAD ${ACTUAL_SHA}`);
const STATUS = (await capture('git', ['status', '--short'])).trim();
if (STATUS) throw new Error(`Phase 3 local acceptance requires a clean checkout:\n${STATUS}`);

const EVIDENCE = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/engagement-phase3-${SHA}`);
const LOGS = path.join(EVIDENCE, 'logs');
const FIXTURES = path.join(EVIDENCE, 'fixtures.json');
const TOKEN_FILE = path.join(EVIDENCE, 'admin-bearer-token');
const DB_PORT = String(args.dbPort ?? 55474);
const MAIN_PORT = String(args.mainPort ?? 4000);
const ENGAGEMENT_PORT = String(args.engagementPort ?? 4500);
const PROXY_PORT = String(args.proxyPort ?? 4600);
const WEB_PORT = String(args.webPort ?? 5173);
const DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro?schema=public`;
const CONTAINER = `engagement-phase3-${process.pid}`;
const children = [];
const proxyDecisions = [];
let proxy;

const clerkPublishableKey = requiredAny('VITE_CLERK_PUBLISHABLE_KEY', 'CLERK_PUBLISHABLE_KEY');
required('CLERK_SECRET_KEY');
required('CLERK_JWT_ISSUER');
required('ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID');
required('ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID');

const commonEnv = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL,
  RELEASE_SHA: SHA,
  WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
  NOTES_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  NOTES_ENCRYPTION_KEY_VERSION: 'phase3-local',
  OAUTH_TOKEN_ENCRYPTION_KEY: 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
  OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'phase3-local',
  OAUTH_STATE_SECRET: 'phase3-local-only-oauth-state-secret-not-production',
  CLERK_WEBHOOK_SIGNING_SECRET:
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? 'whsec_phase3_local_only_not_production',
  ENGAGEMENT_PHASE3_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE3_EVIDENCE_DIR: EVIDENCE,
  ENGAGEMENT_PHASE3_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
  ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE: TOKEN_FILE,
  VITE_API_BASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
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
  ENGAGEMENT_API_PORT: ENGAGEMENT_PORT,
  ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Phase 3 local browser acceptance`);
  return value;
}

function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required for Phase 3 local browser acceptance`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`Unknown argument ${arg}`);
    const [name, inline] = arg.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    const key = name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    result[key] = /^\d+$/.test(value) && key !== 'sha' ? Number(value) : value;
  }
  return result;
}

async function capture(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${commandArgs.join(' ')} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

async function run(label, command, commandArgs, env = commonEnv, allowFailure = false) {
  console.log(`==> ${label}`);
  const logFile = path.join(LOGS, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('exit', async (code) => {
      await writeFile(logFile, output).catch(() => undefined);
      if (code === 0 || allowFailure) resolve({ code, output });
      else reject(new Error(`${label} failed with exit ${code}`));
    });
  });
}

async function startChild(label, command, commandArgs, env) {
  const logFile = path.join(LOGS, `${label}.log`);
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => appendFile(logFile, chunk).catch(() => undefined));
  child.stderr.on('data', (chunk) => appendFile(logFile, chunk).catch(() => undefined));
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`${label} exited with ${code}; see ${logFile}`);
  });
  return child;
}

async function waitForHttp(url, accepted = (status) => status < 500, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      last = response.status;
      if (accepted(response.status)) return response.status;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}; last=${String(last)}`);
}

async function waitDatabase() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await run(
      'postgres-ready-probe',
      process.platform === 'win32' ? 'docker.exe' : 'docker',
      ['exec', CONTAINER, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      commonEnv,
      true,
    );
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Disposable PostgreSQL did not become ready');
}

async function stopChildren() {
  for (const child of children.reverse()) {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (child.exitCode == null) child.kill('SIGKILL');
    }
  }
}

async function main() {
  await mkdir(LOGS, { recursive: true });
  const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';

  try {
    await run('remove-stale-postgres', docker, ['rm', '-f', CONTAINER], commonEnv, true);
    await run('start-postgres', docker, [
      'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_USER=capiro',
      '-e', 'POSTGRES_PASSWORD=capiro',
      '-e', 'POSTGRES_DB=capiro',
      '-p', `${DB_PORT}:5432`,
      'pgvector/pgvector:pg16',
    ]);
    await waitDatabase();

    await run('prisma-generate', 'pnpm', ['--filter', '@capiro/api', 'exec', 'prisma', 'generate']);
    await run('migrate-disposable-database', 'pnpm', ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy']);
    await run('seed-phase3-fixtures', 'pnpm', [
      '-C', 'apps/api', 'exec', 'tsx', 'scripts/seed-engagement-phase3-parity-fixtures.ts', '--apply', '--verify',
    ]);
    await run('bind-phase3-auth', 'pnpm', [
      '-C', 'apps/api', 'exec', 'tsx', 'scripts/bind-engagement-phase3-auth-fixtures.ts',
    ]);
    await run('build-api', 'pnpm', ['--filter', '@capiro/api', 'build']);

    await startChild('main-api', 'node', ['apps/api/dist/main.js'], mainEnv);
    await startChild('engagement-api', 'node', ['apps/api/dist/engagement-main.js'], shadowEnv);
    await waitForHttp(`http://127.0.0.1:${MAIN_PORT}/api/health`, () => true);
    await waitForHttp(`http://127.0.0.1:${ENGAGEMENT_PORT}/health`, (status) => status < 500);

    proxy = createPhase3Proxy({
      port: Number(PROXY_PORT),
      mainPort: Number(MAIN_PORT),
      engagementPort: Number(ENGAGEMENT_PORT),
      onDecision: (entry) => proxyDecisions.push(entry),
    });
    await proxy.listen();

    await startChild(
      'web',
      'pnpm',
      ['--filter', '@capiro/web', 'dev', '--', '--host', '127.0.0.1', '--port', WEB_PORT],
      commonEnv,
    );
    await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`, (status) => status === 200, 90_000);

    await run('phase3-browser-parity', 'node', ['apps/web/scripts/engagement-phase3-browser-parity.mjs']);

    const previewDecisions = proxyDecisions.filter((entry) => entry.owner === 'engagement-api');
    const mainDecisions = proxyDecisions.filter((entry) => entry.owner === 'main-api');
    if (!previewDecisions.length) throw new Error('Local proxy observed no preview route decisions');
    if (!mainDecisions.length) throw new Error('Local proxy observed no main route decisions');
    await writeFile(
      path.join(EVIDENCE, 'proxy-routing.json'),
      `${JSON.stringify({ previewDecisions, mainDecisionCount: mainDecisions.length }, null, 2)}\n`,
    );

    await writeFile(
      path.join(EVIDENCE, 'local-runner-summary.json'),
      `${JSON.stringify(
        {
          marker: 'ENGAGEMENT_PHASE3_LOCAL_COMPLETE',
          sha: SHA,
          database: 'disposable-pgvector-postgresql-16',
          mainPort: Number(MAIN_PORT),
          engagementPort: Number(ENGAGEMENT_PORT),
          proxyPort: Number(PROXY_PORT),
          webPort: Number(WEB_PORT),
          previewRoutingObserved: previewDecisions.length > 0,
          normalRoutingObserved: mainDecisions.length > 0,
          externalActionsEnabled: false,
          callbacksEnabled: false,
          recallEnabled: false,
          backgroundOwner: 'disabled',
        },
        null,
        2,
      )}\n`,
    );
    console.log('ENGAGEMENT_PHASE3_LOCAL_COMPLETE');
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    await stopChildren();
    await run(
      'cleanup-phase3-fixtures',
      'pnpm',
      ['-C', 'apps/api', 'exec', 'tsx', 'scripts/seed-engagement-phase3-parity-fixtures.ts', '--cleanup'],
      commonEnv,
      true,
    ).catch(() => undefined);
    await run('remove-postgres', docker, ['rm', '-f', CONTAINER], commonEnv, true).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
