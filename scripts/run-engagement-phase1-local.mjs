#!/usr/bin/env node
/**
 * Authoritative local Phase 1 closeout. GitHub Actions are not part of the
 * acceptance decision. Completion is emitted only after DB-free validation,
 * authenticated two-process/API/browser proof, background containment, and
 * host/ARM64 image inspection all pass on one exact clean SHA.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const SHA = args.sha ?? (await capture('git', ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(SHA)) {
  throw new Error('Phase 1 requires an exact 40-character SHA');
}
const STATUS = (await capture('git', ['status', '--short'])).trim();
if (STATUS) throw new Error(`Phase 1 requires a clean checkout before validation:\n${STATUS}`);

const EVIDENCE = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/engagement-phase1-${SHA}`);
const LOGS = path.join(EVIDENCE, 'logs');
const FIXTURES = path.join(EVIDENCE, 'fixtures.json');
const TOKEN_DIR = await mkdtemp(path.join(os.tmpdir(), 'capiro-engagement-phase1-'));
const TOKEN_FILE = path.join(TOKEN_DIR, 'bearer-token');
const DB_PORT = String(args.dbPort ?? '55471');
const DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro?schema=public`;
const PSQL_DATABASE_URL = `postgresql://capiro:capiro@127.0.0.1:${DB_PORT}/capiro`;
const CONTAINER = `engagement-phase1-${process.pid}`;
const IMAGE = `capiro-engagement-api:phase1-${SHA.slice(0, 12)}`;
const ARM64_OCI = path.join(EVIDENCE, 'engagement-api-arm64.oci.tar');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
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
required('CLERK_SECRET_KEY');
required('CLERK_JWT_ISSUER');

const commonEnv = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL,
  PSQL_DATABASE_URL,
  WEB_ORIGIN: 'http://127.0.0.1:5173',
  RELEASE_SHA: SHA,
  NOTES_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  NOTES_ENCRYPTION_KEY_VERSION: 'phase1-local',
  OAUTH_TOKEN_ENCRYPTION_KEY: 'ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
  OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'phase1-local',
  OAUTH_STATE_SECRET: 'phase1-local-only-oauth-state-secret-not-production',
  CLERK_WEBHOOK_SIGNING_SECRET:
    process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? 'whsec_phase1_local_only_not_production',
  ENGAGEMENT_PHASE0_CLERK_ORG_ID: clerkOrgId,
  ENGAGEMENT_PHASE0_USER_CLERK_ID: clerkUserId,
  ENGAGEMENT_PHASE0_USER_EMAIL: clerkUserEmail,
  ENGAGEMENT_PHASE0_USER_COOKIE: clerkCookie,
  ENGAGEMENT_PHASE0_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE0_EVIDENCE_DIR: EVIDENCE,
  ENGAGEMENT_PHASE0_BASE_URL: 'http://127.0.0.1:5173',
  ENGAGEMENT_PHASE1_CLERK_ORG_ID: clerkOrgId,
  ENGAGEMENT_PHASE1_USER_COOKIE: clerkCookie,
  ENGAGEMENT_PHASE1_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE1_EVIDENCE_DIR: EVIDENCE,
  ENGAGEMENT_PHASE1_BASE_URL: 'http://127.0.0.1:5173',
  ENGAGEMENT_PHASE1_MAIN_URL: 'http://127.0.0.1:4000',
  ENGAGEMENT_PHASE1_ENGAGEMENT_URL: 'http://127.0.0.1:4500',
  ENGAGEMENT_PHASE1_TOKEN_FILE: TOKEN_FILE,
  VITE_API_BASE_URL: 'http://127.0.0.1:4000',
};
const mainEnv = {
  ...commonEnv,
  CAPIRO_SERVICE_NAME: 'api',
  API_PORT: '4000',
  API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'active',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};
const engagementEnv = {
  ...commonEnv,
  CAPIRO_SERVICE_NAME: 'engagement-api',
  ENGAGEMENT_API_PORT: '4500',
  ENGAGEMENT_API_BIND_HOST: '127.0.0.1',
  ENGAGEMENT_PROCESS_MODE: 'shadow',
  ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'false',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
};

async function main() {
  await mkdir(LOGS, { recursive: true });
  try {
    await run(
      'DB-free exact-head closeout',
      PNPM,
      [
        '--filter',
        '@capiro/api',
        'exec',
        'tsx',
        'scripts/verify-engagement-phase1-runtime.ts',
      ],
      commonEnv,
    );

    await run(
      'Remove stale disposable database',
      DOCKER,
      ['rm', '-f', CONTAINER],
      commonEnv,
      true,
    );
    await run(
      'Start disposable pgvector PostgreSQL 16',
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
      'Apply migration history to disposable database',
      PNPM,
      ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'],
      mainEnv,
    );
    await run(
      'Generate API Prisma client',
      PNPM,
      ['--filter', '@capiro/api', 'exec', 'prisma', 'generate'],
      mainEnv,
    );
    await run(
      'Seed Phase 0/1 fixtures',
      PNPM,
      [
        '--filter',
        '@capiro/api',
        'exec',
        'tsx',
        'scripts/seed-engagement-phase0-browser-fixtures.ts',
      ],
      mainEnv,
    );

    children.push(
      start(
        'main-api',
        PNPM,
        ['--filter', '@capiro/api', 'exec', 'tsx', 'src/main.ts'],
        mainEnv,
      ),
      start(
        'engagement-api',
        PNPM,
        ['--filter', '@capiro/api', 'exec', 'tsx', 'src/engagement-main.ts'],
        engagementEnv,
      ),
      start(
        'web',
        PNPM,
        ['--filter', '@capiro/web', 'dev', '--', '--host', '127.0.0.1'],
        mainEnv,
      ),
    );
    await waitUrl('http://127.0.0.1:4000/health', 120_000);
    await waitUrl('http://127.0.0.1:4500/health', 120_000);
    await waitUrl('http://127.0.0.1:5173/', 120_000);

    await collectHealth();
    const recall = await fetch('http://127.0.0.1:4500/webhooks/recall', {
      method: 'POST',
    });
    if (recall.status !== 404) {
      throw new Error(`Recall route must be absent; got ${recall.status}`);
    }

    await run(
      'Current Engagement browser acceptance',
      process.execPath,
      ['apps/web/scripts/engagement-phase0-browser-acceptance.mjs'],
      mainEnv,
    );
    await run(
      'Authenticated browser routing parity',
      process.execPath,
      ['apps/web/scripts/engagement-phase1-browser-parity.mjs'],
      mainEnv,
    );
    const bearerToken = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (bearerToken.length < 20) throw new Error('Browser token handoff failed');
    await run(
      'Manifest-driven API/auth/write/denial parity',
      PNPM,
      [
        '--filter',
        '@capiro/api',
        'exec',
        'tsx',
        'scripts/engagement-phase1-read-parity.ts',
      ],
      { ...mainEnv, ENGAGEMENT_PHASE1_BEARER_TOKEN: bearerToken },
    );

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await proveBackgroundContainment();
    await buildAndInspectImages();

    const summary = {
      marker: 'ENGAGEMENT_PHASE1_LOCAL_COMPLETE',
      sha: SHA,
      evidenceDir: EVIDENCE,
      phase0Accepted: true,
      dbFreeCloseout: true,
      authenticatedBrowser: true,
      manifestReadParity: true,
      authTenantOwnershipParity: true,
      localWriteInteroperability: true,
      externalActionDenials: true,
      backgroundContainment: true,
      hostImage: IMAGE,
      arm64Artifact: ARM64_OCI,
      sharedDatabaseTouched: false,
      awsMutation: false,
      externalProviderAction: false,
      githubActionsRequired: false,
    };
    await writeFile(
      path.join(EVIDENCE, 'local-runner-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary));
  } finally {
    await cleanup();
  }
}

async function collectHealth() {
  const output = {};
  for (const [name, url] of [
    ['main', 'http://127.0.0.1:4000/health'],
    ['engagement', 'http://127.0.0.1:4500/health'],
  ]) {
    const response = await fetch(url);
    const body = await response.json();
    output[name] = {
      status: response.status,
      serviceHeader: response.headers.get('x-capiro-service'),
      body,
    };
  }
  if (output.engagement.status !== 200) throw new Error('engagement-api health failed');
  if (output.engagement.serviceHeader !== 'engagement-api') {
    throw new Error('engagement-api service header missing');
  }
  const runtime = output.engagement.body?.runtime;
  if (
    runtime?.processMode !== 'shadow' ||
    runtime?.backgroundOwner !== 'disabled' ||
    runtime?.externalActions !== 'disabled' ||
    runtime?.callbacksEnabled !== false ||
    runtime?.recallWebhookEnabled !== false
  ) {
    throw new Error(`engagement-api health posture is armed: ${JSON.stringify(runtime)}`);
  }
  await writeFile(
    path.join(EVIDENCE, 'health.json'),
    `${JSON.stringify(output, null, 2)}\n`,
  );
}

async function proveBackgroundContainment() {
  const source = await readFile(path.join(LOGS, 'engagement-api.log'), 'utf8');
  const disabledLines = source
    .split(/\r?\n/)
    .filter((line) => /disabled by engagement runtime policy/i.test(line));
  const startedLines = source
    .split(/\r?\n/)
    .filter((line) => /worker started|scheduler started|sweep started/i.test(line));
  if (disabledLines.length < 4) {
    throw new Error(
      `Expected background-disable evidence for all worker classes; found ${disabledLines.length}`,
    );
  }
  if (startedLines.length > 0) {
    throw new Error(
      `A background worker reported starting in shadow mode: ${startedLines.join('\n')}`,
    );
  }
  await writeFile(
    path.join(EVIDENCE, 'background-containment.json'),
    `${JSON.stringify({ disabledLines, startedLines, contained: true }, null, 2)}\n`,
  );
}

async function buildAndInspectImages() {
  await run(
    'Build dedicated host-platform image',
    DOCKER,
    ['build', '-f', 'apps/engagement-api/Dockerfile', '-t', IMAGE, '.'],
    commonEnv,
  );
  const rawInspect = await capture(DOCKER, ['image', 'inspect', IMAGE]);
  const inspect = JSON.parse(rawInspect)[0];
  const config = inspect?.Config ?? {};
  const hostInspection = {
    image: IMAGE,
    user: config.User,
    entrypoint: config.Entrypoint,
    cmd: config.Cmd,
    exposedPorts: config.ExposedPorts,
  };
  if (!config.User || config.User === '0' || config.User === 'root') {
    throw new Error('Image runs as root');
  }
  if (!JSON.stringify(config.Entrypoint).includes('entrypoint.sh')) {
    throw new Error('Dedicated entrypoint missing');
  }
  if (!Array.isArray(config.Cmd) || config.Cmd[0] !== 'serve') {
    throw new Error('Image command is not serve');
  }
  if (!config.ExposedPorts?.['4500/tcp']) {
    throw new Error('Image does not expose port 4500');
  }
  await run(
    'Verify compiled engagement entrypoint exists in image',
    DOCKER,
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'test -f /app/apps/api/dist/engagement-main.js',
    ],
    commonEnv,
  );
  const migrate = await run(
    'Verify image refuses migrate',
    DOCKER,
    ['run', '--rm', IMAGE, 'migrate'],
    commonEnv,
    true,
  );
  const unknown = await run(
    'Verify image refuses unknown command',
    DOCKER,
    ['run', '--rm', IMAGE, 'unknown-command'],
    commonEnv,
    true,
  );
  if (migrate !== 64 || unknown !== 64) {
    throw new Error(`Serve-only entrypoint returned migrate=${migrate}, unknown=${unknown}`);
  }

  await run(
    'Build ARM64 OCI artifact',
    DOCKER,
    [
      'buildx',
      'build',
      '--platform',
      'linux/arm64',
      '-f',
      'apps/engagement-api/Dockerfile',
      '--output',
      `type=oci,dest=${ARM64_OCI}`,
      '.',
    ],
    commonEnv,
  );
  const arm64 = await inspectOci(ARM64_OCI);
  if (arm64.architecture !== 'arm64') {
    throw new Error(`ARM64 artifact architecture is ${arm64.architecture}`);
  }
  await writeFile(
    path.join(EVIDENCE, 'image-inspection.json'),
    `${JSON.stringify(
      { host: hostInspection, migrateExit: migrate, unknownExit: unknown, arm64 },
      null,
      2,
    )}\n`,
  );
}

async function inspectOci(filename) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capiro-engagement-oci-'));
  try {
    await run(
      'Extract ARM64 OCI metadata',
      'tar',
      ['-xf', filename, '-C', directory],
      commonEnv,
    );
    const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
    const manifestDigest = index.manifests?.[0]?.digest;
    if (!manifestDigest) throw new Error('OCI index has no manifest');
    const manifest = JSON.parse(await readFile(blobPath(directory, manifestDigest), 'utf8'));
    const config = JSON.parse(
      await readFile(blobPath(directory, manifest.config.digest), 'utf8'),
    );
    return {
      architecture: config.architecture,
      os: config.os,
      user: config.config?.User,
      entrypoint: config.config?.Entrypoint,
      cmd: config.config?.Cmd,
      exposedPorts: config.config?.ExposedPorts,
      manifestDigest,
      configDigest: manifest.config.digest,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function blobPath(directory, digest) {
  const [algorithm, hash] = String(digest).split(':', 2);
  return path.join(directory, 'blobs', algorithm, hash);
}

function start(label, command, commandArgs, env) {
  const logFile = path.join(LOGS, `${label}.log`);
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[${label}] ${text}`);
      appendFile(logFile, text).catch(() => undefined);
    });
  }
  child.once('exit', (code) => {
    if (code && !child.killed) process.stderr.write(`[${label}] exited with ${code}\n`);
  });
  return child;
}

async function run(label, command, commandArgs, env, allowFailure = false) {
  console.log(`\n==> ${label}`);
  const child = spawn(command, commandArgs, {
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
  if (code !== 0 && !allowFailure) {
    throw new Error(`${label} failed with exit code ${code}`);
  }
  return code;
}

async function capture(command, commandArgs) {
  const child = spawn(command, commandArgs, {
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
  if (code !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}

async function waitDatabase() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const code = await run(
      'PostgreSQL readiness probe',
      DOCKER,
      ['exec', CONTAINER, 'pg_isready', '-U', 'capiro', '-d', 'capiro'],
      commonEnv,
      true,
    );
    if (code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Disposable PostgreSQL did not become ready');
}
async function waitUrl(url, timeout) {
  const deadline = Date.now() + timeout;
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

async function cleanup() {
  for (const child of children.reverse()) await terminate(child);
  await run(
    'Remove disposable PostgreSQL',
    DOCKER,
    ['rm', '-f', CONTAINER],
    commonEnv,
    true,
  ).catch(() => undefined);
  await rm(TOKEN_DIR, { recursive: true, force: true }).catch(() => undefined);
}
async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await run(
      'Terminate child process',
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
  if (!value) throw new Error(`${name} is required for authenticated local closeout`);
  return value;
}
function requiredAny(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`One of ${names.join(', ')} is required for authenticated local closeout`);
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

main().catch(async (error) => {
  await mkdir(EVIDENCE, { recursive: true }).catch(() => undefined);
  const payload = {
    marker: 'ENGAGEMENT_PHASE1_LOCAL_FAILED',
    sha: SHA,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    sharedDatabaseTouched: false,
    awsMutation: false,
    externalProviderAction: false,
  };
  await writeFile(
    path.join(EVIDENCE, 'runner-failure.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  await cleanup().catch(() => undefined);
  process.exit(1);
});
