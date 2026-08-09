#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_SHA =
  process.env.OUTREACH_V3_PHASE3_BASE_SHA ||
  '89b0a8e08e1cfcc7210a8684335faf6f8405bdf2';
const DUMMY_DATABASE_URL =
  'postgresql://phase3:phase3@127.0.0.1:1/phase3?schema=public';

const reasoningSpecs = [
  'src/outreach-v3/reasoning/outreach-v3-reasoning.guard.spec.ts',
  'src/outreach-v3/reasoning/outreach-v3-phase3-architecture.spec.ts',
  'src/outreach-v3/reasoning/outreach-v3-phase3-migration.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-runtime-boundary.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-credential-boundary.spec.ts',
  'src/outreach-v3/reasoning/openai-outreach-reasoning.provider.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-context.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-turn-claim.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-history.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-contract-eval.spec.ts',
];

const steps = [
  [
    'Canonical API Prisma client generation',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'prisma', 'generate', '--schema', 'prisma/schema.prisma'],
    { DATABASE_URL: DUMMY_DATABASE_URL },
  ],
  [
    'Phase 3 focused reasoning/runtime tests + 100-case contract eval',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'jest', '--runInBand', '--forceExit', ...reasoningSpecs],
  ],
  [
    'Phase 3 focused TypeScript project',
    'pnpm',
    ['-C', 'apps/api', 'exec', 'tsc', '-p', 'tsconfig.outreach-v3-phase3.json', '--noEmit'],
  ],
  [
    'Phase 3 focused Prisma projection validation',
    'pnpm',
    [
      '-C',
      'apps/api',
      'exec',
      'prisma',
      'validate',
      '--schema',
      'prisma/outreach-v3-phase3/schema.prisma',
    ],
    { DATABASE_URL: DUMMY_DATABASE_URL },
  ],
  ['Phase 3 DB rehearsal syntax', 'node', ['--check', 'scripts/verify-outreach-v3-phase3-db.mjs']],
  ['Phase 2 state-substrate regression', 'pnpm', ['verify:outreach-v3-phase-2']],
  ['Engagement Phase 3 current-product regression', 'pnpm', ['verify:engagement-phase-3']],
  ['API production build', 'pnpm', ['--filter', '@capiro/api', 'build']],
  ['Phase 3 committed-diff whitespace', 'git', ['diff', '--check', `${BASE_SHA}..HEAD`]],
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
    throw new Error(
      `${label} failed: ${command} ${args.join(' ')} (exit ${result.status})`,
    );
  }
}

try {
  for (const [label, command, args, extraEnv] of steps) {
    run(label, command, args, extraEnv);
  }
  console.log('\nOUTREACH_V3_PHASE3_DB_FREE_COMPLETE');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
