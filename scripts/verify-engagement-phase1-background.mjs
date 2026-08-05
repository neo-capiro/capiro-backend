#!/usr/bin/env node
/**
 * Mandatory second-stage Phase 1 background proof.
 *
 * The full runner already validates the complete product contract. This stage
 * starts a fresh disposable database and shadow runtime, removes the prior
 * success summary, and restores it only after JSON-encoded table digests remain
 * byte-identical across a full worker interval.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpawn } from './lib/resolve-tool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const ACTUAL_SHA = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const SHA = args.sha ?? ACTUAL_SHA;
if (!/^[0-9a-f]{40}$/i.test(SHA) || SHA !== ACTUAL_SHA) {
  throw new Error(`Strict background proof requires exact HEAD ${ACTUAL_SHA}; got ${SHA}`);
}
const status = (await capture('git', ['status', '--short'])).trim();
if (status) throw new Error(`Strict background proof requires a clean checkout:\n${status}`);
const behind = Number(
  (await capture('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']))
    .trim()
    .split(/\s+/)[0],
);
if (behind !== 0) throw new Error(`Branch is ${behind} commit(s) behind origin/main`);

const EVIDENCE = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/engagement-phase1-${SHA}`);
const SUMMARY = path.join(EVIDENCE, 'local-runner-summary.json');
const BACKGROUND = path.join(EVIDENCE, 'background-containment.json');
const NEGATIVE = path.join(EVIDENCE, 'negative-controls.json');
const LOGS = path.join(EVIDENCE, 'logs');
const STRICT_LOG = path.join(LOGS, 'engagement-api-strict-background.log');
const DB_PORT = String(args.strictDbPort ?? '55472');
const DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro?schema=public`;
const PSQL_DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro`;
const CONTAINER = `engagement-phase1-background-${process.pid}`;
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const OBSERVE_MS = Math.max(Number(args.backgroundObserveMs ?? 65_000), 65_000);
let child;
let priorSummary;

const env = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL,
  PSQL_DATABASE_URL,
  WEB_ORIGIN: 'http://127.0.0.1:5173',
  RELEASE_SHA: SHA,
  CAPIRO_SERVICE_NAME: 'engagement-api',
  ENGAGEMENT_API_PORT: '4501',
  ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
  NOTES_ENCRYPTION_KEY:
    process.env.NOTES_ENCRYPTION_KEY ??
    'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  NOTES_ENCRYPTION_KEY_VERSION:
    process.env.NOTES_ENCRYPTION_KEY_VERSION ?? 'phase1-local',
  OAUTH_TOKEN_ENCRYPTION_KEY:
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY ??
    'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
  OAUTH_TOKEN_ENCRYPTION_KEY_VERSION:
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY_VERSION ?? 'phase1-local',
  OAUTH_STATE_SECRET:
    process.env.OAUTH_STATE_SECRET ?? 'phase1-local-only-oauth-state-secret-not-production',
  CLERK_WEBHOOK_SIGNING_SECRET:
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? 'whsec_phase1_local_only_not_production',
};

try {
  await mkdir(LOGS, { recursive: true });
  priorSummary = JSON.parse(await readFile(SUMMARY, 'utf8'));
  if (priorSummary.marker !== 'ENGAGEMENT_PHASE1_LOCAL_COMPLETE') {
    throw new Error('Primary local closeout did not produce its completion marker');
  }
  if (priorSummary.sha !== SHA || priorSummary.actualHeadSha !== SHA) {
    throw new Error('Primary local summary SHA does not match the strict proof SHA');
  }

  // A stale primary success marker must not survive a failed strict stage.
  await rm(SUMMARY, { force: true });

  await run('Remove stale strict-background database', DOCKER, ['rm', '-f', CONTAINER], true);
  await run('Start strict-background pgvector PostgreSQL', DOCKER, [
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
  ]);
  await waitDatabase();
  await run('Apply migrations to strict-background database', 'pnpm', [
    '--filter',
    '@capiro/api',
    'exec',
    'prisma',
    'migrate',
    'deploy',
  ]);

  child = startShadow();
  await waitUrl('http://127.0.0.1:4501/health', 120_000);
  const health = await fetch('http://127.0.0.1:4501/health');
  const healthBody = await health.json();
  if (
    health.status !== 200 ||
    health.headers.get('x-capiro-service') !== 'engagement-api' ||
    healthBody?.runtime?.processMode !== 'shadow' ||
    healthBody?.runtime?.backgroundOwner !== 'disabled'
  ) {
    throw new Error(`Strict shadow health posture failed: ${JSON.stringify(healthBody)}`);
  }

  const before = await tableDigests();
  await new Promise((resolve) => setTimeout(resolve, OBSERVE_MS));
  const after = await tableDigests();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Strict background table digests changed: ${JSON.stringify({ before, after })}`,
    );
  }

  const log = await readFile(STRICT_LOG, 'utf8');
  const requiredDisabledMarkers = [
    'engagement-sync-scheduler disabled by runtime policy',
    'outreach-job-worker disabled by runtime policy',
    'outreach-send-intent-worker disabled by runtime policy',
    'notetaker-reconcile disabled by runtime policy',
  ];
  const missingMarkers = requiredDisabledMarkers.filter((marker) => !log.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`Strict background logs lack: ${missingMarkers.join(', ')}`);
  }
  const startedLines = log
    .split(/\r?\n/)
    .filter((line) =>
      /engagement auto-sync started|outreach job worker started|outreach send-intent worker started|reconciliation sweep started/i.test(
        line,
      ),
    );
  if (startedLines.length > 0) {
    throw new Error(`Strict shadow worker-start log detected: ${startedLines.join('\n')}`);
  }

  const proof = {
    marker: 'ENGAGEMENT_PHASE1_STRICT_BACKGROUND_COMPLETE',
    sha: SHA,
    observedMs: OBSERVE_MS,
    digestEncoding: 'postgres_json_build_object',
    tableCount: Object.keys(before).length,
    tableDigests: { before, after, unchanged: true },
    requiredDisabledMarkers,
    missingMarkers,
    startedLines,
    health: {
      status: health.status,
      serviceHeader: health.headers.get('x-capiro-service'),
      runtime: healthBody.runtime,
    },
    contained: true,
  };
  await writeFile(BACKGROUND, `${JSON.stringify(proof, null, 2)}\n`);
  await writeFile(
    path.join(EVIDENCE, 'background-containment-strict.json'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );

  const negative = JSON.parse(await readFile(NEGATIVE, 'utf8'));
  negative.NC4 = {
    passed: true,
    proof: 'strict 65-second JSON table digests, exact disabled logs, and no worker-start logs',
  };
  negative.strictBackground = true;
  await writeFile(NEGATIVE, `${JSON.stringify(negative, null, 2)}\n`);

  const finalSummary = {
    ...priorSummary,
    marker: 'ENGAGEMENT_PHASE1_LOCAL_COMPLETE',
    strictBackgroundContainment: true,
    strictBackgroundMarker: proof.marker,
    strictBackgroundDigestEncoding: proof.digestEncoding,
    strictBackgroundObservedMs: OBSERVE_MS,
  };
  await writeFile(SUMMARY, `${JSON.stringify(finalSummary, null, 2)}\n`);
  console.log('ENGAGEMENT_PHASE1_STRICT_BACKGROUND_COMPLETE');
} catch (error) {
  await rm(SUMMARY, { force: true }).catch(() => undefined);
  await writeFile(
    path.join(EVIDENCE, 'strict-background-failure.json'),
    `${JSON.stringify(
      {
        marker: 'ENGAGEMENT_PHASE1_STRICT_BACKGROUND_FAILED',
        sha: SHA,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  ).catch(() => undefined);
  throw error;
} finally {
  await terminate(child).catch(() => undefined);
  await run('Remove strict-background PostgreSQL', DOCKER, ['rm', '-f', CONTAINER], true).catch(
    () => undefined,
  );
}

async function tableDigests() {
  const rawTables = await capture(DOCKER, [
    'exec',
    CONTAINER,
    'psql',
    '-U',
    'capiro',
    '-d',
    'capiro',
    '-At',
    '-c',
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND (table_name LIKE 'engagement_%' OR table_name LIKE 'outreach_%' OR table_name LIKE 'meeting_%' OR table_name LIKE 'mail_%' OR table_name='meetings') ORDER BY table_name`,
  ]);
  const output = {};
  for (const table of rawTables.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`Unsafe table name: ${table}`);
    const raw = await capture(DOCKER, [
      'exec',
      CONTAINER,
      'psql',
      '-U',
      'capiro',
      '-d',
      'capiro',
      '-At',
      '-c',
      `SELECT json_build_object('count', COUNT(*)::bigint, 'digest', COALESCE(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)), md5('')))::text FROM "${table}" AS t`,
    ]);
    const parsed = JSON.parse(raw.trim());
    if (!Number.isFinite(Number(parsed.count)) || !/^[0-9a-f]{32}$/i.test(parsed.digest)) {
      throw new Error(`Invalid digest payload for ${table}: ${raw.trim()}`);
    }
    output[table] = { count: Number(parsed.count), digest: parsed.digest };
  }
  return output;
}

function startShadow() {
  const childProcess = spawn(process.execPath, ['apps/api/dist/engagement-main.js'], {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [childProcess.stdout, childProcess.stderr]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[strict-engagement-api] ${text}`);
      appendFile(STRICT_LOG, text).catch(() => undefined);
    });
  }
  return childProcess;
}

async function run(label, command, commandArgs, allowFailure = false) {
  console.log(`\n==> ${label}`);
  const resolved = resolve(command, commandArgs);
  const process = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((resolveExit, reject) => {
    process.once('error', reject);
    process.once('exit', (value) => resolveExit(value ?? 1));
  });
  if (code !== 0 && !allowFailure) throw new Error(`${label} failed with exit code ${code}`);
  return code;
}

async function capture(command, commandArgs) {
  const resolved = resolve(command, commandArgs);
  const process = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  process.stdout.on('data', (chunk) => (stdout += chunk));
  process.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolveExit, reject) => {
    process.once('error', reject);
    process.once('exit', (value) => resolveExit(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} failed: ${stderr}`);
  return stdout;
}

function resolve(command, commandArgs) {
  if (command === 'pnpm') return resolveSpawn('pnpm', commandArgs);
  if (command === 'git') return resolveSpawn('git', commandArgs);
  if (command === 'docker' || command === 'docker.exe') return resolveSpawn('docker', commandArgs);
  return { command, args: commandArgs };
}

async function waitDatabase() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const code = await run(
      'Strict PostgreSQL readiness probe',
      DOCKER,
      ['exec', CONTAINER, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      true,
    );
    if (code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Strict-background PostgreSQL did not become ready');
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

async function terminate(process) {
  if (!process || process.exitCode !== null) return;
  if (globalThis.process.platform === 'win32') {
    await run('Terminate strict shadow process', 'taskkill.exe', [
      '/PID',
      String(process.pid),
      '/T',
      '/F',
    ], true);
  } else {
    process.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => process.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)).then(() => process.kill('SIGKILL')),
    ]);
  }
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
