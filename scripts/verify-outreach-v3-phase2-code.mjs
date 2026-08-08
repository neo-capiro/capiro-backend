#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_SHA = process.env.OUTREACH_V3_PHASE2_BASE_SHA || 'cf0aa80d8d16fbd1e775fc054e8de34570535e23';
const DUMMY_DATABASE_URL = 'postgresql://phase2:phase2@127.0.0.1:1/phase2?schema=public';

const steps = [
  [
    'Phase 2 focused state/service/architecture tests',
    'pnpm',
    [
      '-C',
      'apps/api',
      'exec',
      'jest',
      '--runInBand',
      '--forceExit',
      'src/outreach-v3/state/outreach-campaign-state.spec.ts',
      'src/outreach-v3/state/outreach-command-contract.spec.ts',
      'src/outreach-v3/services/outreach-command-engine.service.spec.ts',
      'src/outreach-v3/services/outreach-command-proposal.service.spec.ts',
      'src/outreach-v3/api/outreach-v3-state.guard.spec.ts',
      'src/outreach-v3/outreach-v3-phase2-architecture.spec.ts',
      'src/capabilities/capability-authorization.service.spec.ts',
    ],
  ],
  [
    'Phase 2 focused TypeScript project',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'tsc', '-p', 'tsconfig.outreach-v3-phase2.json', '--noEmit'],
  ],
  [
    'Phase 2 focused Prisma projection validation',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'prisma', 'validate', '--schema', 'prisma/outreach-v3-phase2/schema.prisma'],
    { DATABASE_URL: DUMMY_DATABASE_URL },
  ],
  ['Phase 2 DB rehearsal syntax', 'node', ['--check', 'scripts/verify-outreach-v3-phase2-db.mjs']],
  ['Phase 1 ownership regression', 'node', ['scripts/engagement-runtime-ownership.mjs']],
  ['Phase 1 architecture regression', 'node', ['scripts/verify-outreach-v3-p1-architecture.mjs']],
  ['API production build', 'pnpm', ['--filter', '@capiro/api', 'build']],
  ['Phase 2 committed-diff whitespace', 'git', ['diff', '--check', `${BASE_SHA}..HEAD`]],
];

function run(label, command, args, extraEnv = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${command} ${args.join(' ')} (exit ${result.status})`);
  }
}

try {
  for (const [label, command, args, extraEnv] of steps) {
    run(label, command, args, extraEnv);
  }
  console.log('\nOUTREACH_V3_PHASE2_DB_FREE_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
