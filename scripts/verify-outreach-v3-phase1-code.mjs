#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  ['ownership negative controls', 'node', ['--test', 'scripts/engagement-runtime-ownership.spec.mjs']],
  ['architecture negative controls', 'node', ['--test', 'scripts/verify-outreach-v3-p1-architecture.spec.mjs']],
  ['route-parser controls', 'node', ['--test', 'scripts/verify-outreach-v3-p1-route-parity.spec.mjs']],
  ['runtime ownership contract', 'node', ['scripts/engagement-runtime-ownership.mjs']],
  ['callback route parity', 'node', ['scripts/verify-outreach-v3-p1-route-parity.mjs']],
  ['architecture and scope gate', 'node', ['scripts/verify-outreach-v3-p1-architecture.mjs']],
  ['owner rehearsals', 'node', ['scripts/run-outreach-v3-p1-owner-rehearsal.mjs']],
  [
    'focused Phase 1 tests',
    'pnpm',
    [
      '-C',
      'apps/api',
      'exec',
      'jest',
      '--runInBand',
      '--forceExit',
      'src/engagement-api.app.module.spec.ts',
      'src/engagement/engagement-dependency-manifest.spec.ts',
      'src/engagement/ai-credential-resolver.service.spec.ts',
      'src/engagement/internal-ai-credentials.controller.spec.ts',
      'src/capabilities/capability-authorization.service.spec.ts',
      'src/capabilities/capability-registry.spec.ts',
      'src/capabilities/proof-capabilities.spec.ts',
      'src/meeting-capture/meeting-capture-persistence.service.spec.ts',
      'src/outreach-review/outreach-review-transactions.service.spec.ts',
      'src/engagement-workers/engagement-workers.spec.ts',
      'src/engagement/runtime',
      'src/engagement/engagement-sync-scheduler.service.spec.ts',
      'src/engagement/outreach-job.service.spec.ts',
      'src/engagement/outreach-send-intent.service.spec.ts',
      'src/engagement/notetaker/notetaker.service.spec.ts',
      'src/intelligence/alert-memo/alert-memo.service.spec.ts',
      'src/intelligence/alert-memo/district-brief.service.spec.ts',
      'src/intelligence/alert-memo/hearing-recap.service.spec.ts',
    ],
  ],
  [
    'Phase 1 TypeScript project',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'tsc', '-p', 'tsconfig.outreach-v3-phase1.json', '--noEmit'],
  ],
  ['Phase 3 regression', 'pnpm', ['verify:engagement-phase-3']],
  ['API production build', 'pnpm', ['--filter', '@capiro/api', 'build']],
  ['Phase 1 whitespace', 'git', ['diff', '--check', '46e029dad5c27bf44c7920cd5a4000716621671f..HEAD']],
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
  console.log('\nOUTREACH_V3_PHASE1_DB_FREE_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
