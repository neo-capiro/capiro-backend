#!/usr/bin/env tsx
/**
 * Independent closeout runner for the 2026-08-09 Phase 1-7 audit repairs.
 *
 * This is intentionally stricter than any one phase's fast gate. It chains the
 * exact trust-boundary checks repaired in this branch so a reviewer cannot call
 * the work complete after running only Jest or only a migration replay.
 *
 * No shared environment is contacted. All database rehearsals create and
 * destroy disposable PostgreSQL containers; vendor credentials are blanked.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

interface Step {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  shell?: boolean;
}

function resolvePnpm(): { command: string; prefixArgs: string[]; shell?: boolean } {
  const bundled = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (fs.existsSync(bundled)) return { command: process.execPath, prefixArgs: [bundled] };
  return process.platform === 'win32'
    ? { command: 'pnpm', prefixArgs: [], shell: true }
    : { command: 'pnpm', prefixArgs: [] };
}

const pnpm = resolvePnpm();
function pnpmStep(name: string, args: string[], cwd = REPO_ROOT): Step {
  return {
    name,
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd,
    shell: pnpm.shell,
  };
}

const steps: Step[] = [
  // Phase 3's original defect class was build-green/runtime-dead containers.
  // Include containers here; a closeout that omits them is not acceptance.
  pnpmStep('Phase 3 complete closeout including runtime container smoke', [
    '--dir',
    'apps/api',
    'exec',
    'tsx',
    'scripts/verify-pe-budget-phase-3-closeout.ts',
    '--include-containers',
  ]),

  pnpmStep('Phase 4 complete closeout', [
    '--dir',
    'apps/api',
    'exec',
    'tsx',
    'scripts/verify-pe-budget-phase-4-closeout.ts',
    '--include-containers',
  ]),

  pnpmStep('Phase 5 complete closeout', [
    '--dir',
    'apps/api',
    'exec',
    'tsx',
    'scripts/verify-pe-budget-phase-5-closeout.ts',
    '--include-containers',
  ]),

  pnpmStep('Phase 6 permanent gate', ['--filter', '@capiro/api', 'verify:pe-budget-phase-6']),
  {
    name: 'Phase 6 exact certification/projection database rehearsal',
    command: 'bash',
    args: ['scripts/phase6-projection-rehearsal.sh'],
    cwd: API_ROOT,
  },
  {
    name: 'Phase 6 exact producer persistence rehearsal',
    command: 'bash',
    args: ['scripts/phase6-producer-rehearsal.sh'],
    cwd: API_ROOT,
  },

  pnpmStep('Phase 7 permanent gate and 32 negative controls', [
    '--filter',
    '@capiro/api',
    'verify:pe-budget-phase-7',
  ]),
  {
    name: 'Phase 7 canonical schema fresh/upgrade rehearsal',
    command: 'bash',
    args: ['scripts/pe-budget-phase7-migration-rehearsal.sh'],
    cwd: API_ROOT,
  },
  {
    name: 'Phase 7 exact-plan least-privilege role rehearsal',
    command: 'bash',
    args: ['scripts/pe-budget-phase7-exact-plan-grant-rehearsal.sh'],
    cwd: API_ROOT,
  },

  pnpmStep('Phase 7 strict TypeScript', [
    'exec',
    'tsc',
    '-p',
    'apps/api/tsconfig.phase7.json',
    '--noEmit',
  ]),
  pnpmStep('Phase 6 strict TypeScript', [
    'exec',
    'tsc',
    '-p',
    'apps/api/tsconfig.phase6.json',
    '--noEmit',
  ]),
  {
    name: 'Changed-tree whitespace/conflict-marker check',
    command: 'git',
    args: ['diff', '--check', 'main...HEAD'],
    cwd: REPO_ROOT,
  },
];

const env = {
  ...process.env,
  LLAMA_CLOUD_API_KEY: '',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_SESSION_TOKEN: '',
  PE_LEGACY_BUDGET_WRITES: 'off',
};

for (const step of steps) {
  const startedAt = Date.now();
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd ?? REPO_ROOT,
    stdio: 'inherit',
    shell: step.shell === true,
    timeout: step.timeoutMs ?? 60 * 60 * 1000,
    env,
  });
  if (result.error) {
    console.error(`${step.name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${step.name} failed with exit ${result.status ?? 'null'}`);
    process.exit(result.status ?? 1);
  }
  console.log(`<== passed (${Date.now() - startedAt}ms)`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      scope: 'defense-budget-phases-1-through-7-audit-repairs',
      containerRuntimeSmoke: true,
      phase6ExactCertificationBinding: true,
      phase7ExactProducerPlanBinding: true,
      directLegacyWritesDefaultOff: true,
      snapshotOverrideOverlayCovered: true,
      disposableDatabaseOnly: true,
      paidProviderCalls: false,
      awsMutations: false,
      sharedDatabaseMutations: false,
      note:
        'Code/disposable closeout only. Production-scale SLO, live canary, real activation and independent human approval remain separate operational release gates.',
    },
    null,
    2,
  ),
);
