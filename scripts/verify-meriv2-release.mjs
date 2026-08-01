#!/usr/bin/env node
/**
 * Local MeriV2 release matrix — GitHub Actions independent.
 *
 * `development` runs locked install, generation, builds, formatting, static
 * development completeness, typechecks, tests, evals, and the Phase 18 clean +
 * upgrade PostgreSQL rehearsal.
 *
 * `release` additionally runs the authenticated Phase 19 Clerk/browser matrix
 * and synthesizes/diffs the independent MeriV2 operational stacks. The diff is
 * read-only and receives identifiers from a separately collected context JSON.
 * No command here deploys, migrates a shared database, changes a feature flag,
 * reads secret values, or sends anything.
 */
import { spawn } from 'node:child_process';
import { resolveSpawn, toolAvailable } from './lib/resolve-tool.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const mode = args.mode ?? 'development';
if (mode !== 'development' && mode !== 'release') {
  throw new Error('--mode must be development or release.');
}
// Logical tool tokens. resolveSpawn() maps each to a directly spawnable binary
// at launch time, so these gates keep shell: false on every platform.
const pnpm = 'pnpm';
const git = 'git';
const docker = 'docker';
const psql = 'psql';
const actionlint = 'actionlint';
const sha = (await capture(git, ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Could not resolve an exact checkout SHA.');
const evidenceDir = path.resolve(ROOT, args.evidenceDir ?? `.artifacts/meriv2-release-${sha}`);
const steps = [];
const commonEnv = {
  ...process.env,
  CI: 'true',
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
  MERIV2_COMPLETENESS_EVIDENCE: path.join(
    path.relative(ROOT, evidenceDir),
    'development-completeness.json',
  ),
};

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  await assertCleanCheckout();
  await assertCurrentWithMain();
  await requireCommand(git, 'git');
  await requireCommand(pnpm, 'pnpm');
  await requireCommand(docker, 'docker');
  await requireCommand(psql, 'psql');

  if (!args.skipInstall) {
    await gate('install-locked-dependencies', pnpm, ['install', '--frozen-lockfile']);
  }

  for (const pkg of [
    '@capiro/api',
    '@capiro/api-strategy',
    '@capiro/intel-api',
    '@capiro/onboard-api',
    '@capiro/workspace',
  ]) {
    await gate(`prisma-generate-${slug(pkg)}`, pnpm, [
      '--filter',
      pkg,
      'exec',
      'prisma',
      'generate',
    ]);
  }

  for (const pkg of [
    '@capiro/shared',
    '@capiro/auth',
    '@capiro/strategy-verifier',
    '@capiro/meriv2-core',
  ]) {
    await gate(`build-${slug(pkg)}`, pnpm, ['--filter', pkg, 'build']);
  }

  await gate('format-phase-scope', pnpm, [
    'exec',
    'prettier',
    '--check',
    'packages/meriv2-core/**/*.{ts,json}',
    'apps/meriv2-orchestrator/**/*.{ts,cjs,json}',
    'apps/api/src/memory/**/*.ts',
    'apps/api/src/context/**/*.ts',
    'apps/api/src/meri/meri-policy-pack*.ts',
    'apps/workspace/src/generation/**/*.ts',
    'apps/api-strategy/src/agents/**/*.ts',
    'apps/web/src/components/Memory*.{ts,tsx,css}',
    'apps/web/src/components/trust/**/*.{ts,tsx,css}',
    'apps/web/src/pages/settings/PolicyPacksPage*.tsx',
    'infra/cdk/bin/meriv2-operations.ts',
    'infra/cdk/lib/memory-projection-worker-stack.ts',
    'infra/cdk/lib/meriv2-control-stack.ts',
    'infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts',
    'scripts/*meriv2*.mjs',
    'docs/qa/meriv2-*.md',
    'docs/runbooks/meriv2-*.md',
    'docs/security/meriv2-*.md',
  ]);
  await gate('git-diff-whitespace', git, ['diff', '--check']);

  if (!args.offline && (await commandExists(actionlint))) {
    await gate('actionlint', actionlint, [
      '.github/workflows/memory-governance-ci.yml',
      '.github/workflows/meriv2-phase17-ci.yml',
      '.github/workflows/meriv2-phase18-database-rehearsal.yml',
      '.github/workflows/meriv2-phase19-browser-acceptance.yml',
      '.github/workflows/meriv2-phase20-control-system.yml',
    ]);
  }

  await gate('development-completeness', pnpm, [
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-meriv2-development-completeness.ts',
  ]);
  await gate('phase20-control-contract', pnpm, [
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-meriv2-phase20-control-system.ts',
  ]);

  for (const pkg of [
    '@capiro/meriv2-core',
    '@capiro/api',
    '@capiro/workspace',
    '@capiro/web',
    '@capiro/meriv2-orchestrator',
    '@capiro/api-strategy',
    '@capiro/infra-cdk',
  ]) {
    await gate(`typecheck-${slug(pkg)}`, pnpm, ['--filter', pkg, 'typecheck']);
  }
  await gate('typecheck-full-repository', pnpm, ['turbo', 'run', 'typecheck']);

  for (const pkg of [
    '@capiro/meriv2-core',
    '@capiro/meriv2-orchestrator',
    '@capiro/api-strategy',
    '@capiro/api',
    '@capiro/workspace',
    '@capiro/web',
  ]) {
    await gate(`test-${slug(pkg)}`, pnpm, ['--filter', pkg, 'test']);
  }
  await gate('meriv2-evaluations', pnpm, ['--filter', '@capiro/meriv2-core', 'eval:meriv2']);

  if (!args.skipDatabase) {
    await gate(
      'phase18-database-rehearsal',
      'bash',
      ['apps/api/scripts/meriv2-phase18-database-rehearsal.sh'],
      {
        ...commonEnv,
        PHASE18_EVIDENCE_DIR: path.join(evidenceDir, 'phase18'),
      },
    );
  }

  if (mode === 'release') {
    if (args.skipBrowser) {
      throw new Error('Release mode does not permit --skip-browser.');
    }
    await gate(
      'phase19-authenticated-browser',
      process.execPath,
      [
        'scripts/run-meriv2-phase19-local.mjs',
        '--sha',
        sha,
        '--evidence-dir',
        path.join(evidenceDir, 'phase19'),
      ],
      commonEnv,
    );

    const contextFile = args.opsContext ?? process.env.MERIV2_OPERATIONS_CONTEXT_FILE;
    if (!contextFile) {
      throw new Error(
        'Release mode requires --ops-context <read-only context JSON>; generate it with pnpm collect:meriv2-aws-context.',
      );
    }
    const operations = JSON.parse(await readFile(path.resolve(ROOT, contextFile), 'utf8'));
    const cdkArgs = operationsCdkArgs(operations.contexts, sha);
    await gate(
      'operations-cdk-synth',
      pnpm,
      [
        '--filter',
        '@capiro/infra-cdk',
        'exec',
        'cdk',
        'synth',
        '--app',
        'ts-node --prefer-ts-exts bin/meriv2-operations.ts',
        ...cdkArgs,
      ],
      commonEnv,
    );
    if (args.skipAwsDiff) {
      throw new Error('Release mode does not permit --skip-aws-diff.');
    }
    await gate(
      'operations-cdk-diff-read-only',
      pnpm,
      [
        '--filter',
        '@capiro/infra-cdk',
        'exec',
        'cdk',
        'diff',
        '--app',
        'ts-node --prefer-ts-exts bin/meriv2-operations.ts',
        '--profile',
        args.profile ?? 'capiro-dev',
        ...cdkArgs,
      ],
      commonEnv,
    );
  }

  await assertCleanCheckout();
  const summary = {
    marker: 'MERIV2_LOCAL_RELEASE_PREFLIGHT_OK',
    mode,
    sha,
    completedAt: new Date().toISOString(),
    githubActionsRequired: false,
    awsMutation: false,
    sharedDatabaseTouched: false,
    steps,
  };
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

function operationsCdkArgs(contexts, releaseSha) {
  const required = [
    'account',
    'region',
    'env',
    'existingClusterArn',
    'existingApiRepositoryName',
    'existingApiImageDigest',
    'existingPrivateSubnetIds',
    'existingServiceSecurityGroupId',
    'existingDbSecretArn',
    'existingAppDbSecretArn',
    'existingDatabaseName',
    'existingDataKeyArn',
    'existingSecretsKeyArn',
    'existingAlertsTopicArn',
  ];
  if (!contexts || typeof contexts !== 'object') {
    throw new Error('The operations context document has no contexts object.');
  }
  for (const name of required) {
    if (!String(contexts[name] ?? '').trim()) {
      throw new Error(`Operations context is missing ${name}.`);
    }
  }
  const digest = String(contexts.existingApiImageDigest).trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) {
    throw new Error('Operations context existingApiImageDigest is not an immutable digest.');
  }
  const values = {
    ...contexts,
    releaseSha,
    meriv2ApiImageDigest: digest,
    enableMemoryProjectionWorker: 'false',
    enableMeriV2ControlMonitor: 'false',
  };
  return Object.entries(values).flatMap(([key, value]) => ['--context', `${key}=${value}`]);
}

async function gate(name, command, commandArgs, env = commonEnv) {
  console.log(`\n==> ${name}`);
  const startedAt = new Date().toISOString();
  const logPath = path.join(
    evidenceDir,
    `${String(steps.length + 1).padStart(2, '0')}-${name}.log`,
  );
  const code = await execute(command, commandArgs, { cwd: ROOT, env, logPath });
  const result = {
    name,
    command: [command, ...commandArgs].join(' '),
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: code,
    logPath: path.relative(ROOT, logPath),
  };
  steps.push(result);
  if (code !== 0) throw new Error(`${name} failed with exit code ${code}.`);
}

async function assertCleanCheckout() {
  const dirty = (await capture(git, ['status', '--porcelain'])).trim();
  if (dirty) throw new Error(`The checkout is not clean:\n${dirty}`);
}

async function assertCurrentWithMain() {
  if (args.offline) return;
  const remote = args.remote ?? 'origin';
  await execute(git, ['fetch', remote, 'main', '--quiet'], { cwd: ROOT, env: process.env });
  const behind = Number(
    (await capture(git, ['rev-list', '--count', `HEAD..${remote}/main`])).trim(),
  );
  if (!Number.isFinite(behind) || behind !== 0) {
    throw new Error(`The checkout is ${behind} commit(s) behind ${remote}/main.`);
  }
}

async function commandExists(command) {
  return toolAvailable(command);
}

async function execute(command, commandArgs, options) {
  let log = '';
  const resolved = resolveSpawn(command, commandArgs);
  const child = spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const forward = (target) => (chunk) => {
    const value = chunk.toString();
    log += value;
    target.write(value);
  };
  child.stdout.on('data', forward(process.stdout));
  child.stderr.on('data', forward(process.stderr));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (value) => resolve(value ?? 1));
  });
  if (options.logPath) await writeFile(options.logPath, log, 'utf8');
  return code;
}

async function capture(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const resolved = resolveSpawn(command, commandArgs);
    const child = spawn(resolved.command, resolved.args, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

async function exitCode(command, commandArgs) {
  return execute(command, commandArgs, { cwd: ROOT, env: process.env });
}

function requireCommand(command, label) {
  if (!command) throw new Error(`${label} is required.`);
}

function parse(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inline] = arg.slice(2).split('=', 2);
    const key = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (['skipInstall', 'skipDatabase', 'skipBrowser', 'skipAwsDiff', 'offline'].includes(key)) {
      parsed[key] = true;
      continue;
    }
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`);
    parsed[key] = value;
  }
  return parsed;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

main().catch(async (error) => {
  await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
  const payload = {
    marker: 'MERIV2_LOCAL_RELEASE_PREFLIGHT_FAILED',
    mode,
    sha,
    error: error instanceof Error ? error.message : String(error),
    completedAt: new Date().toISOString(),
    githubActionsRequired: false,
    awsMutation: false,
    sharedDatabaseTouched: false,
    steps,
  };
  await writeFile(
    path.join(evidenceDir, 'failure.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  ).catch(() => undefined);
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
