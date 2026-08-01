#!/usr/bin/env node
/**
 * Local, GitHub-Actions-independent MeriV2 release preflight.
 *
 * Modes:
 *   development — proves Phase 0-22 code, tests, evals, and disposable DB replay.
 *   release     — additionally requires authenticated Phase 19 browser acceptance
 *                 and synth/diff of the independent AWS operations stacks.
 *
 * This script performs no AWS writes and no shared-database operations.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parse(process.argv.slice(2));
const mode = options.mode ?? 'development';
if (!['development', 'release'].includes(mode)) throw new Error('--mode must be development or release.');
if (mode === 'release' && !options.opsContext) {
  throw new Error('Release mode requires --ops-context=<JSON from collect-meriv2-aws-context.mjs>.');
}
if (mode === 'release' && options.skipDatabase) {
  throw new Error('Release mode cannot skip the Phase 18 database rehearsal.');
}
if (mode === 'release' && options.skipBrowser) {
  throw new Error('Release mode cannot skip authenticated Phase 19 browser acceptance.');
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const sha = (await capture(git, ['rev-parse', 'HEAD'])).trim();
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Current Git SHA could not be resolved.');
const evidenceDir = path.resolve(
  ROOT,
  options.evidenceDir ?? `.deploy-logs/meriv2-release/${sha}`,
);
const steps = [];
let phase18Passed = false;
let phase19Passed = false;
let operationsSynthPassed = false;
let operationsDiffPassed = false;

async function main() {
  await assertCleanCheckout();
  if (!options.offline) await assertCurrentWithMain();
  await mkdir(evidenceDir, { recursive: true });

  if (!options.skipInstall) {
    // Keep the literal command visible for the Phase 17 completeness checker.
    await step('pnpm install --frozen-lockfile', pnpm, ['install', '--frozen-lockfile']);
  }

  for (const packageName of [
    '@capiro/api',
    '@capiro/api-strategy',
    '@capiro/intel-api',
    '@capiro/onboard-api',
    '@capiro/workspace',
  ]) {
    await step(`Generate Prisma client — ${packageName}`, pnpm, [
      '--filter',
      packageName,
      'exec',
      'prisma',
      'generate',
    ]);
  }

  for (const packageName of [
    '@capiro/shared',
    '@capiro/auth',
    '@capiro/strategy-verifier',
    '@capiro/meriv2-core',
  ]) {
    await step(`Build ${packageName}`, pnpm, ['--filter', packageName, 'build']);
  }

  await step('Git whitespace validation', git, ['diff', '--check']);
  await step('Release-scope formatting', pnpm, [
    'exec',
    'prettier',
    '--check',
    'packages/meriv2-core/**/*.{ts,json}',
    'apps/api/src/memory/**/*.ts',
    'apps/api/src/context/**/*.ts',
    'apps/api/scripts/*meriv2*.{ts,mjs,sh}',
    'apps/meriv2-orchestrator/src/meri/**/*.{ts,json}',
    'apps/workspace/src/generation/**/*.ts',
    'apps/api-strategy/src/agents/**/*.ts',
    'apps/web/src/components/trust/**/*.{ts,tsx,css}',
    'apps/web/src/phase19/**/*.{ts,tsx,css}',
    'infra/cdk/**/*.{ts,json}',
    'scripts/*meriv2*.mjs',
    'docs/qa/meriv2*.md',
    'docs/runbooks/meriv2*.md',
    'docs/security/meriv2*.md',
  ]);

  await step('Phase 0-22 development completeness', pnpm, [
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-meriv2-development-completeness.ts',
  ], {
    env: {
      ...process.env,
      MERIV2_COMPLETENESS_EVIDENCE: path.relative(
        ROOT,
        path.join(evidenceDir, 'development-completeness.json'),
      ),
    },
  });
  await step('Phase 20 control-system contract', pnpm, [
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-meriv2-phase20-control-system.ts',
  ]);

  for (const packageName of [
    '@capiro/meriv2-core',
    '@capiro/api',
    '@capiro/workspace',
    '@capiro/web',
    '@capiro/meriv2-orchestrator',
    '@capiro/api-strategy',
    '@capiro/infra-cdk',
  ]) {
    await step(`Typecheck ${packageName}`, pnpm, ['--filter', packageName, 'typecheck']);
  }
  await step('Typecheck full dependency graph', pnpm, ['turbo', 'run', 'typecheck']);

  for (const packageName of [
    '@capiro/meriv2-core',
    '@capiro/meriv2-orchestrator',
    '@capiro/api-strategy',
    '@capiro/api',
    '@capiro/workspace',
    '@capiro/web',
  ]) {
    await step(`Test ${packageName}`, pnpm, ['--filter', packageName, 'test']);
  }
  // The exact release eval command is intentionally explicit.
  await step('MeriV2 evaluation suite — eval:meriv2', pnpm, [
    '--filter',
    '@capiro/meriv2-core',
    'eval:meriv2',
  ]);

  if (!options.skipDatabase) {
    requireCommand(bash, 'bash');
    await step('Phase 18 clean and upgrade database rehearsal', bash, [
      'apps/api/scripts/meriv2-phase18-database-rehearsal.sh',
    ], {
      env: {
        ...process.env,
        PHASE18_EVIDENCE_DIR: path.join(evidenceDir, 'phase18-database'),
        PHASE18_PG_NAME: `meriv2-phase18-${process.pid}`,
      },
    });
    phase18Passed = true;
  }

  if (mode === 'release' && !options.skipBrowser) {
    await step('Phase 19 authenticated browser and accessibility acceptance', process.execPath, [
      'scripts/run-meriv2-phase19-local.mjs',
      '--sha',
      sha,
      '--evidence-dir',
      path.join(evidenceDir, 'phase19-browser'),
    ], {
      env: { ...process.env, PHASE18_ACCEPTED_SHA: sha },
    });
    phase19Passed = true;
  }

  if (options.opsContext) {
    const contextDocument = JSON.parse(
      await readFile(path.resolve(ROOT, options.opsContext), 'utf8'),
    );
    const contexts = contextDocument.contexts;
    if (!contexts || typeof contexts !== 'object') {
      throw new Error('Operations context JSON has no contexts object.');
    }
    const cdkArgs = operationsCdkArgs(contexts, sha);
    await step(
      'Synthesize independent MeriV2 operations stacks dark',
      pnpm,
      ['exec', 'cdk', 'synth', '--app', 'ts-node --prefer-ts-exts bin/meriv2-operations.ts', ...cdkArgs],
      { cwd: path.join(ROOT, 'infra/cdk') },
    );
    operationsSynthPassed = true;

    if (!options.skipAwsDiff) {
      const profile = contextDocument.profile ?? options.profile;
      const diffArgs = [
        'exec',
        'cdk',
        'diff',
        '--app',
        'ts-node --prefer-ts-exts bin/meriv2-operations.ts',
        ...cdkArgs,
      ];
      if (profile) diffArgs.push('--profile', profile);
      await step('Read-only AWS diff for independent MeriV2 operations stacks', pnpm, diffArgs, {
        cwd: path.join(ROOT, 'infra/cdk'),
      });
      operationsDiffPassed = true;
    }
  }

  await assertCleanCheckout();
  const releaseReady =
    mode === 'release' &&
    phase18Passed &&
    phase19Passed &&
    operationsSynthPassed &&
    (operationsDiffPassed || options.skipAwsDiff === true);
  const summary = {
    marker: releaseReady
      ? 'MERIV2_LOCAL_RELEASE_PREFLIGHT_OK'
      : 'MERIV2_LOCAL_DEVELOPMENT_PREFLIGHT_OK',
    mode,
    sha,
    completedAt: new Date().toISOString(),
    stepCount: steps.length,
    phase18Passed,
    phase19Passed,
    operationsSynthPassed,
    operationsDiffPassed,
    releaseReady,
    githubActionsRequired: false,
    awsMutation: false,
    sharedDatabaseTouched: false,
    steps,
  };
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  if (mode === 'release' && !releaseReady) process.exitCode = 2;
}

async function assertCleanCheckout() {
  const raw = await capture(git, ['status', '--porcelain', '--untracked-files=all']);
  const dirty = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.includes('.deploy-logs/'));
  if (dirty.length) {
    throw new Error(`Release checkout is not clean:\n${dirty.join('\n')}`);
  }
}

async function assertCurrentWithMain() {
  await rawStep('Fetch current main', git, ['fetch', 'origin', 'main']);
  const behind = Number((await capture(git, ['rev-list', '--count', 'HEAD..origin/main'])).trim());
  if (behind !== 0) throw new Error(`Release branch is ${behind} commit(s) behind origin/main.`);
  const ancestor = await exitCode(git, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  if (ancestor !== 0) throw new Error('origin/main is not an ancestor of the release head.');
}

function operationsCdkArgs(contexts, releaseSha) {
  const required = [
    'account',
    'region',
    'env',
    'existingClusterArn',
    'existingApiRepositoryName',
    'existingPrivateSubnetIds',
    'existingServiceSecurityGroupId',
    'existingDbSecretArn',
    'existingAppDbSecretArn',
    'existingDatabaseName',
    'existingDataKeyArn',
    'existingSecretsKeyArn',
    'existingAlertsTopicArn',
  ];
  for (const key of required) {
    if (!String(contexts[key] ?? '').trim()) throw new Error(`Operations context is missing ${key}.`);
  }
  const values = {
    ...contexts,
    meriv2ApiImageTag: releaseSha,
    enableMemoryProjectionWorker: 'false',
    enableMeriV2ControlMonitor: 'false',
  };
  return Object.entries(values).flatMap(([key, value]) => [
    '--context',
    `${key}=${String(value)}`,
  ]);
}

async function step(name, command, commandArgs, options = {}) {
  const safe = `${String(steps.length + 1).padStart(2, '0')}-${slug(name)}`;
  const logPath = path.join(evidenceDir, `${safe}.log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  const startedAt = new Date().toISOString();
  console.log(`\n==> ${name}`);
  const result = await execute(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    logPath,
  });
  const record = {
    name,
    command: [command, ...commandArgs].join(' '),
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: result,
    logPath: path.relative(ROOT, logPath),
  };
  steps.push(record);
  if (result !== 0) {
    await writeFile(path.join(evidenceDir, 'failed-step.json'), `${JSON.stringify(record, null, 2)}\n`);
    throw new Error(`${name} failed with exit code ${result}.`);
  }
}

async function rawStep(name, command, commandArgs) {
  console.log(`\n==> ${name}`);
  const code = await execute(command, commandArgs, { cwd: ROOT, env: process.env });
  if (code !== 0) throw new Error(`${name} failed with exit code ${code}.`);
}

async function execute(command, commandArgs, options) {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
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
    const child = spawn(command, commandArgs, {
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
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
  await writeFile(path.join(evidenceDir, 'failure.json'), `${JSON.stringify(payload, null, 2)}\n`).catch(() => undefined);
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
