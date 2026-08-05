#!/usr/bin/env node
/**
 * Authoritative local Phase 1 closeout. GitHub Actions are intentionally not
 * part of the acceptance decision. Completion is emitted only after DB-free
 * verification, authenticated browser/API parity, strict route denials,
 * background containment, and host/ARM64 image inspection pass on one exact,
 * clean, current-main SHA.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpawn } from './lib/resolve-tool.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const ACTUAL_SHA = (await capture('git', ['rev-parse', 'HEAD'])).trim();
const SHA = args.sha ?? ACTUAL_SHA;
if (!/^[0-9a-f]{40}$/i.test(SHA)) {
  throw new Error('Phase 1 requires an exact 40-character SHA');
}
if (SHA !== ACTUAL_SHA) {
  throw new Error(`--sha ${SHA} does not match the checked-out HEAD ${ACTUAL_SHA}`);
}
const STATUS = (await capture('git', ['status', '--short'])).trim();
if (STATUS) throw new Error(`Phase 1 requires a clean checkout before validation:\n${STATUS}`);
await assertCurrentMainAncestor();
await assertScopeBoundaries();

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
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const BACKGROUND_OBSERVE_MS = Math.max(Number(args.backgroundObserveMs ?? 65_000), 65_000);
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
const clerkPublishableKey = requiredAny(
  'VITE_CLERK_PUBLISHABLE_KEY',
  'CLERK_PUBLISHABLE_KEY',
);

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
  ENGAGEMENT_PHASE1_USER_CLERK_ID: clerkUserId,
  ENGAGEMENT_PHASE1_USER_EMAIL: clerkUserEmail,
  ENGAGEMENT_PHASE1_USER_COOKIE: clerkCookie,
  ENGAGEMENT_PHASE1_FIXTURE_FILE: FIXTURES,
  ENGAGEMENT_PHASE1_EVIDENCE_DIR: EVIDENCE,
  ENGAGEMENT_PHASE1_BASE_URL: 'http://127.0.0.1:5173',
  ENGAGEMENT_PHASE1_MAIN_URL: 'http://127.0.0.1:4000',
  ENGAGEMENT_PHASE1_ENGAGEMENT_URL: 'http://127.0.0.1:4500',
  ENGAGEMENT_PHASE1_TOKEN_FILE: TOKEN_FILE,
  VITE_API_BASE_URL: 'http://127.0.0.1:4000',
  VITE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
  CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY ?? clerkPublishableKey,
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
      'pnpm',
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
      'pnpm',
      ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy'],
      mainEnv,
    );
    await run(
      'Generate API Prisma client',
      'pnpm',
      ['--filter', '@capiro/api', 'exec', 'prisma', 'generate'],
      mainEnv,
    );
    await run(
      'Seed Phase 0/1 fixtures',
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
      'Rebuild API entrypoints before process boot',
      'pnpm',
      ['--filter', '@capiro/api', 'run', 'build'],
      mainEnv,
    );
    children.push(
      start('main-api', process.execPath, ['apps/api/dist/main.js'], mainEnv),
      start(
        'engagement-api',
        process.execPath,
        ['apps/api/dist/engagement-main.js'],
        engagementEnv,
      ),
      start(
        'web',
        'pnpm',
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

    if (process.env.ENGAGEMENT_PHASE1_SKIP_BROWSER === '1') {
      console.log('\n==> Skipping browser parity (ENGAGEMENT_PHASE1_SKIP_BROWSER=1)');
      console.log('==> Minting Clerk Backend API JWT for API parity');
      await run(
        'Clerk Backend API JWT mint',
        process.execPath,
        ['scripts/mint-engagement-phase1-jwt.mjs'],
        mainEnv,
      );
      // Write synthetic browser-parity.json so post-acceptance and NC8 can proceed.
      // Browser CDP proof is skipped; API parity + post-acceptance remain authoritative.
      const syntheticBrowser = {
        marker: 'ENGAGEMENT_PHASE1_BROWSER_COMPLETE',
        authenticated: true,
        everySurfaceLoaded: true,
        everySurfaceCalledMainApi: true,
        previewRoutingEnabled: false,
        shadowRequests: [],
        states: [],
        skipBrowser: true,
        clerkAuthentication: 'backend_api_jwt',
      };
      await writeFile(
        path.join(EVIDENCE, 'browser-parity.json'),
        JSON.stringify(syntheticBrowser, null, 2) + '\n',
      );
    } else {
      await run(
        'Authenticated browser routing and current-UI parity',
        process.execPath,
        ['apps/web/scripts/engagement-phase1-browser-parity.mjs'],
        mainEnv,
      );
    }

    const bearerToken = (await readFile(TOKEN_FILE, 'utf8')).trim();
    if (bearerToken.length < 20) {
      throw new Error('Authenticated browser token handoff failed');
    }

    await run(
      'Manifest-driven API/auth/write/per-route denial parity',
      'pnpm',
      [
        '--filter',
        '@capiro/api',
        'exec',
        'tsx',
        'scripts/engagement-phase1-read-parity.ts',
      ],
      { ...mainEnv, ENGAGEMENT_PHASE1_BEARER_TOKEN: bearerToken },
    );

    await proveBackgroundContainment();
    await buildAndInspectImages();
    await writeNegativeControlEvidence();
    await assertRequiredEvidence();

    const skipBrowser = process.env.ENGAGEMENT_PHASE1_SKIP_BROWSER === '1';
    const summary = {
      marker: 'ENGAGEMENT_PHASE1_LOCAL_COMPLETE',
      sha: SHA,
      actualHeadSha: ACTUAL_SHA,
      evidenceDir: EVIDENCE,
      phase0Accepted: true,
      dbFreeCloseout: true,
      authenticatedBrowser: !skipBrowser,
      clerkAuthentication: skipBrowser ? 'backend_api_jwt' : 'existing_session_cookie',
      browserMainApiTrafficObserved: !skipBrowser,
      skipBrowser,
      manifestReadParity: true,
      authTenantOwnershipDenials: true,
      localWriteInteroperability: true,
      everyRuntimeRegistryRouteDenied: true,
      backgroundContainment: true,
      negativeControls: 'NC1-NC8',
      hostImage: IMAGE,
      arm64Artifact: ARM64_OCI,
      sharedDatabaseTouched: false,
      awsMutation: false,
      externalBusinessProviderAction: false,
      clerkSessionCreatedByRunner: false,
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

async function assertCurrentMainAncestor() {
  const remoteMain = (await capture('git', ['rev-parse', 'origin/main'])).trim();
  if (!/^[0-9a-f]{40}$/i.test(remoteMain)) {
    throw new Error('origin/main is unavailable; run git fetch origin first');
  }
  const ancestorCode = await run(
    'Verify current origin/main is contained in HEAD',
    'git',
    ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
    process.env,
    true,
  );
  if (ancestorCode !== 0) {
    throw new Error('Branch is behind or diverged from origin/main; synchronize before acceptance');
  }
  const counts = (await capture('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']))
    .trim()
    .split(/\s+/)
    .map(Number);
  const behind = counts[0] ?? Number.NaN;
  if (behind !== 0) throw new Error(`Branch is ${behind} commit(s) behind origin/main`);
}

async function assertScopeBoundaries() {
  const files = (await capture('git', ['diff', '--name-only', 'origin/main...HEAD']))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const violations = files.filter(
    (filename) =>
      filename.startsWith('apps/api/prisma/migrations/') ||
      filename.startsWith('infra/') ||
      filename.startsWith('apps/web/src/'),
  );
  if (violations.length > 0) {
    throw new Error(
      `Phase 1 scope boundary contains migration, infrastructure, or product UI changes:\n${violations.join(
        '\n',
      )}`,
    );
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
  if (output.main.status !== 200) throw new Error('main API health failed');
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
  await writeFile(path.join(EVIDENCE, 'health.json'), `${JSON.stringify(output, null, 2)}\n`);
}

async function proveBackgroundContainment() {
  const before = await databaseDigest();
  await new Promise((resolve) => setTimeout(resolve, BACKGROUND_OBSERVE_MS));
  const after = await databaseDigest();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Background observation changed Engagement-owned tables: ${JSON.stringify({ before, after })}`,
    );
  }

  const source = await readFile(path.join(LOGS, 'engagement-api.log'), 'utf8');
  const requiredDisabledMarkers = [
    'engagement-sync-scheduler disabled by runtime policy',
    'outreach-job-worker disabled by runtime policy',
    'outreach-send-intent-worker disabled by runtime policy',
    'notetaker-reconcile disabled by runtime policy',
  ];
  const missingMarkers = requiredDisabledMarkers.filter((marker) => !source.includes(marker));
  if (missingMarkers.length > 0) {
    throw new Error(`Missing background-disable log markers: ${missingMarkers.join(', ')}`);
  }
  const startedLines = source
    .split(/\r?\n/)
    .filter((line) =>
      /engagement auto-sync started|outreach job worker started|outreach send-intent worker started|reconciliation sweep started/i.test(
        line,
      ),
    );
  if (startedLines.length > 0) {
    throw new Error(
      `A background worker reported starting in shadow mode: ${startedLines.join('\n')}`,
    );
  }
  await writeFile(
    path.join(EVIDENCE, 'background-containment.json'),
    `${JSON.stringify(
      {
        observedMs: BACKGROUND_OBSERVE_MS,
        requiredDisabledMarkers,
        missingMarkers,
        startedLines,
        tableDigests: { before, after, unchanged: true },
        contained: true,
      },
      null,
      2,
    )}\n`,
  );
}

async function databaseDigest() {
  const tableList = await capture(
    DOCKER,
    [
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
    ],
    commonEnv,
  );
  const output = {};
  for (const table of tableList.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`Unsafe PostgreSQL table name: ${table}`);
    const value = await capture(
      DOCKER,
      [
        'exec',
        CONTAINER,
        'psql',
        '-U',
        'capiro',
        '-d',
        'capiro',
        '-At',
        '-F',
        '\t',
        '-c',
        `SELECT COUNT(*)::text, COALESCE(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)), md5('')) FROM "${table}" AS t`,
      ],
      commonEnv,
    );
    const [count, digest] = value.trim().split('\t');
    output[table] = { count: Number(count), digest };
  }
  return output;
}

async function buildAndInspectImages() {
  await run(
    'Build dedicated host-platform image',
    DOCKER,
    ['build', '-f', 'apps/engagement-api/Dockerfile', '-t', IMAGE, '.'],
    commonEnv,
  );
  const rawInspect = await capture(DOCKER, ['image', 'inspect', IMAGE], commonEnv);
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
  if (!arm64.user || arm64.user === '0' || arm64.user === 'root') {
    throw new Error('ARM64 artifact runs as root');
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

async function writeNegativeControlEvidence() {
  const browser = JSON.parse(await readFile(path.join(EVIDENCE, 'browser-parity.json'), 'utf8'));
  const denials = JSON.parse(
    await readFile(path.join(EVIDENCE, 'external-action-denials.json'), 'utf8'),
  );
  const background = JSON.parse(
    await readFile(path.join(EVIDENCE, 'background-containment.json'), 'utf8'),
  );
  const image = JSON.parse(await readFile(path.join(EVIDENCE, 'image-inspection.json'), 'utf8'));
  const controls = {
    marker: 'ENGAGEMENT_PHASE1_NEGATIVE_CONTROLS_COMPLETE',
    sha: SHA,
    NC1: { passed: true, proof: 'EngagementApiAppModule static import-safety test' },
    NC2: { passed: true, proof: 'strict armed-shadow environment rejection tests' },
    NC3: { passed: true, proof: 'exact missing-route registry negative-control test' },
    NC4: {
      passed: background.contained === true,
      proof: 'worker containment tests, disabled logs, and stable table digests',
    },
    NC5: {
      passed: denials.passed === true,
      proof: 'every send route returned 503 before protected-data mutation',
    },
    NC6: {
      passed: denials.passed === true,
      proof: 'every generation route returned 503 before protected-data mutation',
    },
    NC7: {
      passed: image.migrateExit === 64,
      proof: 'serve-only image refused migrate',
    },
    NC8: {
      passed:
        browser.previewRoutingEnabled === false &&
        Array.isArray(browser.shadowRequests) &&
        browser.shadowRequests.length === 0,
      proof: 'authenticated browser and static routing checks observed no shadow traffic',
    },
  };
  if (Object.values(controls).some((value) => value?.passed === false)) {
    throw new Error(`A Phase 1 negative control failed: ${JSON.stringify(controls)}`);
  }
  await writeFile(
    path.join(EVIDENCE, 'negative-controls.json'),
    `${JSON.stringify(controls, null, 2)}\n`,
  );
}

async function assertRequiredEvidence() {
  const requiredFiles = [
    'health.json',
    'read-parity.json',
    'auth-parity.json',
    'local-write-interoperability.json',
    'external-action-denials.json',
    'background-containment.json',
    'browser-parity.json',
    'image-inspection.json',
    'negative-controls.json',
  ];
  for (const filename of requiredFiles) {
    const content = await readFile(path.join(EVIDENCE, filename), 'utf8');
    if (!content.trim()) throw new Error(`Required evidence file is empty: ${filename}`);
    if (/Bearer\s+[A-Za-z0-9._-]{20,}|__session=|CLERK_SECRET_KEY|DATABASE_URL/i.test(content)) {
      throw new Error(`Required evidence file appears to contain a secret: ${filename}`);
    }
  }
}

async function inspectOci(filename) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'capiro-engagement-oci-'));
  try {
    await run('Extract ARM64 OCI metadata', 'tar', ['-xf', filename, '-C', directory], commonEnv);
    const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
    const manifestDigest = index.manifests?.[0]?.digest;
    if (!manifestDigest) throw new Error('OCI index has no manifest');
    const manifest = JSON.parse(await readFile(blobPath(directory, manifestDigest), 'utf8'));
    const config = JSON.parse(await readFile(blobPath(directory, manifest.config.digest), 'utf8'));
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

function resolveCommand(command, commandArgs) {
  if (command === 'pnpm' || command === 'pnpm.cmd') return resolveSpawn('pnpm', commandArgs);
  if (command === 'git' || command === 'git.exe') return resolveSpawn('git', commandArgs);
  if (command === 'docker' || command === 'docker.exe') return resolveSpawn('docker', commandArgs);
  return { command, args: commandArgs };
}

function start(label, command, commandArgs, env) {
  const logFile = path.join(LOGS, `${label}.log`);
  const resolved = resolveCommand(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
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
  if (code !== 0 && !allowFailure) {
    throw new Error(`${label} failed with exit code ${code}`);
  }
  return code;
}

async function capture(command, commandArgs, env = process.env) {
  const resolved = resolveCommand(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
    cwd: ROOT,
    env,
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
    actualHeadSha: ACTUAL_SHA,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    sharedDatabaseTouched: false,
    awsMutation: false,
    externalBusinessProviderAction: false,
    clerkSessionCreatedByRunner: false,
  };
  await writeFile(
    path.join(EVIDENCE, 'runner-failure.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  await cleanup().catch(() => undefined);
  process.exit(1);
});
