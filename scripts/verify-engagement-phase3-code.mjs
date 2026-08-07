#!/usr/bin/env node
/** Permanent DB-free Phase 3 closeout gate. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['Phase 0 prerequisite', 'pnpm', ['verify:engagement-phase-0']],
  ['Phase 1 prerequisite', 'pnpm', ['verify:engagement-phase-1']],
  ['Phase 2 prerequisite', 'pnpm', ['verify:engagement-phase-2']],
  ['Phase 3 UI inventory', 'node', ['scripts/engagement-phase3-ui-inventory.spec.mjs']],
  ['Phase 3 preview route generation drift', 'node', ['scripts/engagement-phase3-preview-route-patterns.mjs', '--check']],
  ['Phase 3 web preview-header containment', 'node', ['scripts/verify-engagement-web-no-preview-header.mjs']],
  [
    'Phase 3 fixture contract',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'jest', '--runInBand', '--forceExit', 'scripts/seed-engagement-phase3-parity-fixtures.spec.ts'],
  ],
  // F-003: apps/api's broad typecheck is an && chain whose first pre-existing
  // defense-budget TS6059 failure prevents later projects from running. Invoke
  // the Phase 3 fixture/binder project directly so this gate is real.
  [
    'Phase 3 fixture/auth-binder typecheck',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'tsc', '-p', 'tsconfig.engagement-phase3-fixtures.json', '--noEmit'],
  ],
  [
    'Phase 3 focused web contracts',
    'pnpm',
    [
      '--filter', '@capiro/web', 'exec', 'vitest', 'run',
      'src/lib/engagement-api-preview.spec.ts',
      'src/lib/engagement-preview-errors.spec.ts',
      'src/lib/engagement-preview-cache.spec.ts',
      'src/lib/api-client.test.ts',
      'src/pages/engagement/EngagementApiPreviewIndicator.test.tsx',
      'src/pages/engagement/EngagementPreviewBoundary.test.tsx',
    ],
  ],
  [
    'Phase 3 harness unit and negative controls',
    'node',
    [
      '--test',
      'apps/web/scripts/engagement-phase3-browser-parity.spec.mjs',
      'scripts/engagement-phase3-local-proxy.spec.mjs',
      'scripts/verify-engagement-phase3-prototype-boundary.spec.mjs',
    ],
  ],
  ['Phase 3 V3/prototype boundary', 'node', ['scripts/verify-engagement-phase3-prototype-boundary.mjs']],
  ['Phase 3 local runner syntax', 'node', ['--check', 'scripts/run-engagement-phase3-local.mjs']],
  ['Phase 3 local proxy syntax', 'node', ['--check', 'scripts/engagement-phase3-local-proxy.mjs']],
  ['Phase 3 browser harness syntax', 'node', ['--check', 'apps/web/scripts/engagement-phase3-browser-parity.mjs']],
  ['Phase 3 browser+replay wrapper syntax', 'node', ['--check', 'apps/web/scripts/engagement-phase3-browser-parity-with-replay.mjs']],
  ['Phase 3 read replay syntax', 'node', ['--check', 'scripts/engagement-phase3-api-replay.mjs']],
  ['Web production typecheck', 'pnpm', ['--filter', '@capiro/web', 'exec', 'tsc', '-p', 'tsconfig.json', '--noEmit']],
  ['Web production build', 'pnpm', ['--filter', '@capiro/web', 'build']],
  ['Web complete regression suite', 'pnpm', ['--filter', '@capiro/web', 'test']],
  ['Phase 3 committed-range whitespace', 'git', ['diff', '--check', '3841a5ee58e011be7fb4fb6008adfccf081976d9..HEAD']],
];

function run(label, command, args) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} ${args.join(' ')} (exit ${result.status})`);
  }
}

try {
  for (const [label, command, args] of steps) run(label, command, args);
  console.log('\nENGAGEMENT_PHASE3_DB_FREE_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
