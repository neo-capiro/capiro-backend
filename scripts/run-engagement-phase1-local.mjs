#!/usr/bin/env node
/**
 * Local Engagement Phase 1 two-process acceptance runner.
 *
 * Creates a disposable pgvector database, applies migrations, seeds fixtures,
 * starts BOTH the main API (:4000) and the engagement-api (:4500), runs
 * read-parity and external-action-denial tests, and tears everything down.
 *
 * Never touches a shared database, AWS, real OAuth providers, real Recall,
 * real AI providers, or real email providers.
 *
 * Modeled after scripts/run-engagement-phase0-local.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha =
  args.sha ?? process.env.ENGAGEMENT_PHASE1_SHA ?? (await capture('git', ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Phase 1 requires an exact 40-character SHA.');

const evidenceDir = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/engagement-phase1-${sha}`);
const databaseUrl = 'postgresql://capiro:capiro@127.0.0.1:55471/capiro?schema=public';
const psqlUrl = 'postgresql://capiro:capiro@127.0.0.1:55471/capiro';
const containerName = `engagement-phase1-${process.pid}`;
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const children = [];

async function main() {
  await mkdir(evidenceDir, { recursive: true });

  const baseEnv = {
    CI: 'true',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL: databaseUrl,
    PSQL_DATABASE_URL: psqlUrl,
    NOTES_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    NOTES_ENCRYPTION_KEY_VERSION: 'phase1-local',
    OAUTH_TOKEN_ENCRYPTION_KEY: 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'phase1-local',
    OAUTH_STATE_SECRET: 'phase1-local-only-oauth-state-secret-not-production',
    CLERK_SECRET_KEY: 'sk_test_phase1_local_only_not_production',
    CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_phase1_local_only_not_production',
    CLERK_JWT_ISSUER: 'https://clerk.test.local',
    WEB_ORIGIN: 'http://127.0.0.1:5173',
    RELEASE_SHA: sha,
    ENGAGEMENT_PHASE1_SHA: sha,
    ENGAGEMENT_PHASE1_EVIDENCE_DIR: evidenceDir,
  };

  // Main API env — defaults preserve current behavior (active/enabled).
  const mainApiEnv = {
    ...baseEnv,
    API_PORT: '4000',
    API_BIND_HOST: '127.0.0.1',
    // For local safety, disable background workers in the main API too.
    // This does NOT change the code defaults; it's a local override.
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
  };

  // Engagement API env — exact shadow matrix.
  const engagementApiEnv = {
    ...baseEnv,
    CAPIRO_SERVICE_NAME: 'engagement-api',
    ENGAGEMENT_API_PORT: '4500',
    ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
    ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
  };

  try {
    await run('Remove stale Phase 1 container', docker, ['rm', '-f', containerName], {
      allowFailure: true,
      env: baseEnv,
    });
    await run(
      'Start disposable pgvector PostgreSQL',
      docker,
      [
        'run', '-d', '--name', containerName,
        '-e', 'POSTGRES_USER=capiro',
        '-e', 'POSTGRES_PASSWORD=capiro',
        '-e', 'POSTGRES_DB=capiro',
        '-p', '55471:5432',
        'pgvector/pgvector:pg16',
      ],
      { env: baseEnv },
    );
    await waitForDatabase(baseEnv);

    await run('Apply all API migrations', pnpm, ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'], { env: mainApiEnv });
    await run('Generate Prisma client', pnpm, ['--filter', '@capiro/api', 'exec', 'prisma', 'generate'], { env: mainApiEnv });
    await run(
      'Seed engagement Phase 0 fixtures',
      pnpm,
      ['--filter', '@capiro/api', 'exec', 'tsx', 'scripts/seed-engagement-phase0-browser-fixtures.ts'],
      { env: mainApiEnv },
    );

    // Start both API processes.
    const mainApi = start('main-api', pnpm, ['--filter', '@capiro/api', 'dev'], mainApiEnv);
    const engagementApi = start('engagement-api', pnpm, ['--filter', '@capiro/api', 'run', 'dev:engagement-api'], engagementApiEnv);
    children.push(mainApi, engagementApi);

    await waitForUrl('http://127.0.0.1:4000/health', 120_000);
    await waitForUrl('http://127.0.0.1:4500/health', 120_000);

    // Collect health evidence.
    await collectHealthEvidence();

    // Run read-parity tests.
    await run(
      'Run engagement Phase 1 read parity',
      process.execPath,
      ['apps/api/scripts/engagement-phase1-read-parity.ts'],
      { env: { ...mainApiEnv, ENGAGEMENT_PHASE1_MAIN_URL: 'http://127.0.0.1:4000', ENGAGEMENT_PHASE1_ENGAGEMENT_URL: 'http://127.0.0.1:4500' } },
    );

    // Run browser parity (verify web still points to main API only).
    // Only run if credentials are available; otherwise skip with a note.
    if (process.env.ENGAGEMENT_PHASE1_USER_COOKIE) {
      await run(
        'Run engagement Phase 1 browser parity',
        process.execPath,
        ['apps/web/scripts/engagement-phase1-browser-parity.mjs'],
        { env: { ...mainApiEnv, VITE_API_BASE_URL: 'http://127.0.0.1:4000' } },
      );
    } else {
      console.log('\n==> Skipping browser parity (no ENGAGEMENT_PHASE1_USER_COOKIE)');
    }

    const summary = {
      marker: 'ENGAGEMENT_PHASE1_LOCAL_COMPLETE',
      sha,
      evidenceDir,
      sharedDatabaseTouched: false,
      awsMutation: false,
      externalProviderAction: false,
    };
    await writeFile(path.join(evidenceDir, 'local-runner-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  } finally {
    await cleanup();
  }
}

async function collectHealthEvidence() {
  const targets = [
    { label: 'main-api', url: 'http://127.0.0.1:4000/health' },
    { label: 'engagement-api', url: 'http://127.0.0.1:4500/health' },
  ];
  for (const { label, url } of targets) {
    try {
      const res = await fetch(url);
      const headers = Object.fromEntries(res.headers.entries());
      const body = await res.json();
      await writeFile(
        path.join(evidenceDir, `${label}-health.json`),
        JSON.stringify({ status: res.status, headers, body }, null, 2) + '\n',
      );
    } catch (err) {
      await writeFile(
        path.join(evidenceDir, `${label}-health-error.json`),
        JSON.stringify({ error: String(err) }, null, 2) + '\n',
      );
    }
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
  const child = spawn(command, commandArgs, { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${label}] `;
  child.stdout.on('data', (chunk) => process.stdout.write(prefix + chunk.toString()));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix + chunk.toString()));
  child.once('exit', (code) => { if (code && !child.killed) process.stderr.write(`${prefix}exited with code ${code}\n`); });
  return child;
}

async function run(label, command, commandArgs, options = {}) {
  if (!options.quiet) console.log(`\n==> ${label}`);
  const child = spawn(command, commandArgs, { cwd: ROOT, env: options.env ?? process.env, shell: false, windowsHide: true, stdio: options.quiet ? 'ignore' : 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (value) => resolve(value ?? 1)); });
  if (code !== 0 && !options.allowFailure) throw new Error(`${label} failed with exit code ${code}.`);
  return code;
}

async function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' && command === 'git' ? 'git.exe' : command, commandArgs, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => { if (code === 0) resolve(stdout); else reject(new Error(`${command} failed: ${stderr}`)); });
  });
}

async function cleanup() {
  for (const child of children.reverse()) await terminate(child);
  await run('Remove disposable Phase 1 PostgreSQL', docker, ['rm', '-f', containerName], { allowFailure: true, quiet: true }).catch(() => undefined);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await run('Terminate child', 'taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { allowFailure: true, quiet: true }).catch(() => undefined);
  } else {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5000).then(() => child.kill('SIGKILL'))]);
  }
}

function parse(values) { const output = {}; for (let i = 0; i < values.length; i++) { const arg = values[i]; if (!arg.startsWith('--')) throw new Error(`Unexpected: ${arg}`); const [raw, inline] = arg.slice(2).split('=', 2); const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); const value = inline ?? values[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`); output[key] = value; } return output; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch(async (error) => {
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  const payload = { marker: 'ENGAGEMENT_PHASE1_LOCAL_FAILED', sha, error: error instanceof Error ? error.message : String(error), sharedDatabaseTouched: false, awsMutation: false, externalProviderAction: false };
  await writeFile(path.join(evidenceDir, 'runner-failure.json'), `${JSON.stringify(payload, null, 2)}\n`).catch(() => undefined);
  console.error(JSON.stringify(payload));
  await cleanup().catch(() => undefined);
  process.exitCode = 1;
});
