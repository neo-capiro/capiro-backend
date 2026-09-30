#!/usr/bin/env node
/** Permanent DB-free Phase 3 closeout gate. */
import { openSync, readFileSync, closeSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE3_SCOPE_END = process.env.ENGAGEMENT_PHASE3_SCOPE_END ?? 'HEAD';
const ACCEPTED_PHASE2_HEAD = '3841a5ee58e011be7fb4fb6008adfccf081976d9';

function resolveWhitespaceBase() {
  const explicit = process.env.ENGAGEMENT_PHASE3_WHITESPACE_BASE;
  if (explicit) return explicit;

  // Recovery branches are based on the current mainline, while the original
  // Phase 3 branch was based directly on the accepted Phase 2 head. Use the
  // verified mainline base only for the former so stale historical whitespace
  // cannot fail a closeout; retain the fixed Phase 2 range for the latter.
  try {
    const originMain = execFileSync('git', ['rev-parse', 'origin/main'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const mergeBase = execFileSync('git', ['merge-base', originMain, PHASE3_SCOPE_END], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (mergeBase === originMain) return originMain;
    // main advanced after this branch last merged it (engagement-phase3.yml
    // checks out the PR head, not the merge ref). The merge-base still
    // excludes main's own commits once it contains the accepted Phase 2 head.
    execFileSync('git', ['merge-base', '--is-ancestor', ACCEPTED_PHASE2_HEAD, mergeBase], {
      cwd: ROOT,
    });
    return mergeBase;
  } catch {
    // The fixed accepted head below remains the safe fallback in shallow or
    // detached checkouts without a usable origin/main ref.
  }
  return ACCEPTED_PHASE2_HEAD;
}

const PHASE3_WHITESPACE_BASE = resolveWhitespaceBase();
const scopedOptions = { env: { ENGAGEMENT_PHASE3_SCOPE_END: PHASE3_SCOPE_END } };
const steps = [
  ['Phase 0 prerequisite', 'pnpm', ['verify:engagement-phase-0']],
  ['Phase 1 prerequisite', 'pnpm', ['verify:engagement-phase-1']],
  ['Phase 2 prerequisite', 'pnpm', ['verify:engagement-phase-2']],
  [
    'Phase 3 UI inventory',
    'node',
    ['scripts/engagement-phase3-ui-inventory.spec.mjs'],
    scopedOptions,
  ],
  [
    'Phase 3 preview route generation drift',
    'node',
    ['scripts/engagement-phase3-preview-route-patterns.mjs', '--check'],
  ],
  [
    'Phase 3 web preview-header containment',
    'node',
    ['scripts/verify-engagement-web-no-preview-header.mjs'],
  ],
  [
    'Phase 3 fixture/read/containment contracts',
    'pnpm',
    [
      '-C',
      'apps/api',
      'exec',
      'jest',
      '--runInBand',
      '--forceExit',
      'scripts/seed-engagement-phase3-parity-fixtures.spec.ts',
      'scripts/engagement-phase3-read-materialization.spec.ts',
      'scripts/engagement-phase3-containment-tables.spec.ts',
    ],
    scopedOptions,
  ],
  // F-003: apps/api's broad typecheck is an && chain whose first pre-existing
  // defense-budget TS6059 failure prevents later projects from running. Invoke
  // the Phase 3 acceptance-script project directly so this gate is real.
  [
    'Phase 3 fixture and acceptance-script typecheck',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'tsc', '-p', 'tsconfig.engagement-phase3-fixtures.json', '--noEmit'],
  ],
  [
    'Phase 3 focused web contracts',
    'pnpm',
    [
      '--filter',
      '@capiro/web',
      'exec',
      'vitest',
      'run',
      'src/lib/engagement-api-preview.spec.ts',
      'src/lib/engagement-preview-errors.spec.ts',
      'src/lib/engagement-preview-cache.spec.ts',
      'src/lib/engagement-preview-resilience.spec.ts',
      'src/lib/api-client.test.ts',
      'src/pages/engagement/EngagementApiPreviewIndicator.test.tsx',
      'src/pages/engagement/EngagementPreviewBoundary.test.tsx',
    ],
  ],
  [
    'Phase 3 harness/scope/resilience negative controls',
    'node',
    [
      '--test',
      'apps/web/scripts/engagement-phase3-browser-parity.spec.mjs',
      'apps/web/scripts/engagement-phase3-browser-scenarios.spec.mjs',
      'scripts/engagement-phase3-local-proxy.spec.mjs',
      'scripts/engagement-phase3-faults.spec.mjs',
      'scripts/verify-engagement-phase3-prototype-boundary.spec.mjs',
      'scripts/verify-engagement-phase3-scope.spec.mjs',
      'scripts/engagement-phase3-scope-base.spec.mjs',
    ],
  ],
  [
    'Phase 3 V3/prototype boundary',
    'node',
    ['scripts/verify-engagement-phase3-prototype-boundary.mjs'],
    scopedOptions,
  ],
  [
    'Phase 3 scope and findings',
    'node',
    ['scripts/verify-engagement-phase3-scope.mjs'],
    scopedOptions,
  ],
  ['Phase 3 local runner syntax', 'node', ['--check', 'scripts/run-engagement-phase3-local.mjs']],
  ['Phase 3 local proxy syntax', 'node', ['--check', 'scripts/engagement-phase3-local-proxy.mjs']],
  ['Phase 3 resilience syntax', 'node', ['--check', 'scripts/engagement-phase3-resilience.mjs']],
  [
    'Phase 3 resilience wrapper syntax',
    'node',
    ['--check', 'scripts/run-engagement-phase3-resilience.mjs'],
  ],
  [
    'Phase 3 browser harness syntax',
    'node',
    ['--check', 'apps/web/scripts/engagement-phase3-browser-parity.mjs'],
  ],
  [
    'Phase 3 interaction harness syntax',
    'node',
    ['--check', 'apps/web/scripts/engagement-phase3-browser-interactions.mjs'],
  ],
  [
    'Phase 3 scenario catalog syntax',
    'node',
    ['--check', 'apps/web/scripts/engagement-phase3-browser-scenarios.mjs'],
  ],
  [
    'Phase 3 bearer refresh syntax',
    'node',
    ['--check', 'apps/web/scripts/engagement-phase3-refresh-token.mjs'],
  ],
  [
    'Phase 3 browser+replay wrapper syntax',
    'node',
    ['--check', 'apps/web/scripts/engagement-phase3-browser-parity-with-replay.mjs'],
  ],
  ['Phase 3 read replay syntax', 'node', ['--check', 'scripts/engagement-phase3-api-replay.mjs']],
  [
    'Web production typecheck',
    'pnpm',
    ['--filter', '@capiro/web', 'exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'],
  ],
  ['Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']],
  ['Web complete regression suite', 'pnpm', ['--filter', '@capiro/web', 'test']],
  [
    'Phase 3 committed-range whitespace',
    'git',
    [
      'diff',
      '--check',
      `${PHASE3_WHITESPACE_BASE}..${PHASE3_SCOPE_END}`,
      '--',
      '.',
      ':(exclude)docs/plans/**/*.md',
      ':(exclude).github/**/*.yml',
      ':(exclude).github/**/*.yaml',
    ],
  ],
];

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} ${args.join(' ')} (exit ${result.status})`);
  }
}

function runPhase1WithCompletionMarker() {
  if (process.platform !== 'win32') {
    run('Phase 1 prerequisite', 'pnpm', ['verify:engagement-phase-1']);
    return;
  }

  const logPath = 'C:\\dev\\recovery-phase3-phase1-prerequisite.log';
  const fd = openSync(logPath, 'w');
  const child = spawn('pnpm', ['verify:engagement-phase-1'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  closeSync(fd);
  const deadline = Date.now() + 1_500_000;
  let complete = false;
  let failed = false;
  while (Date.now() < deadline) {
    const output = readFileSync(logPath, 'utf8');
    if (output.includes('ENGAGEMENT_PHASE1_DB_FREE_COMPLETE')) {
      complete = true;
      break;
    }
    if (output.includes('ENGAGEMENT_PHASE1_DB_FREE_FAILED')) {
      failed = true;
      break;
    }
    if (child.exitCode !== null) break;
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }

  if (complete && child.exitCode === null) {
    spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  if (!complete || failed) {
    const output = readFileSync(logPath, 'utf8');
    throw new Error(`Phase 1 prerequisite failed; see ${logPath}\n${output.slice(-8000)}`);
  }
  console.log(`Phase 1 prerequisite completed; evidence: ${logPath}`);
}

try {
  for (const [label, command, args, options] of steps) {
    if (label === 'Phase 1 prerequisite') runPhase1WithCompletionMarker();
    else run(label, command, args, options);
  }
  console.log('\nENGAGEMENT_PHASE3_DB_FREE_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
