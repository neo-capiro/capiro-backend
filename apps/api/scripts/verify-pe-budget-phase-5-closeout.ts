#!/usr/bin/env tsx
/** One-command Phase 5 release-candidate validation matrix. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const PARSER_ROOT = path.join(REPO_ROOT, 'apps', 'defense-budget-parser');
const includeContainers = process.argv.includes('--include-containers');
const validationDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/capiro';

interface Step {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
  timeoutMs?: number;
}

function resolvePnpm(): { command: string; prefixArgs: string[]; shell?: boolean } {
  const corepackPnpm = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (fs.existsSync(corepackPnpm)) {
    return { command: process.execPath, prefixArgs: [corepackPnpm] };
  }
  const hermesPnpm = 'C:/Users/neoma/AppData/Local/hermes/node/node_modules/corepack/dist/pnpm.js';
  if (fs.existsSync(hermesPnpm)) {
    return { command: process.execPath, prefixArgs: [hermesPnpm] };
  }
  if (process.platform === 'win32') {
    return { command: 'pnpm', prefixArgs: [], shell: true };
  }
  return { command: 'pnpm', prefixArgs: [] };
}

const pnpm = resolvePnpm();
function pnpmStep(name: string, args: string[], cwd = REPO_ROOT): Step {
  return {
    name,
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd,
    shell: pnpm.shell === true,
    timeoutMs: 45 * 60 * 1000,
  };
}

function run(step: Step): void {
  const started = Date.now();
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: 'inherit',
    timeout: step.timeoutMs ?? 45 * 60 * 1000,
    env: {
      ...process.env,
      DATABASE_URL: validationDatabaseUrl,
      LLAMA_CLOUD_API_KEY: '',
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
    },
    shell: step.shell === true,
  });
  if (result.error != null) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.name} failed with exit ${result.status ?? 'null'}`);
  }
  console.log(`<== ${step.name} passed (${Date.now() - started}ms)`);
}

const phase4Args = [
  '--dir',
  'apps/api',
  'exec',
  'tsx',
  'scripts/verify-pe-budget-phase-4-closeout.ts',
  ...(includeContainers ? ['--include-containers'] : []),
];

const steps: Step[] = [
  pnpmStep('Merged Phase 1–4 closeout', phase4Args),
  pnpmStep('Phase 5 family, proof, projection, and architecture tests', [
    '--filter',
    '@capiro/api',
    'verify:pe-budget-phase-5',
  ]),
  pnpmStep(
    'Phase 5 operator command contracts',
    [
      'exec',
      'jest',
      '--runInBand',
      '--forceExit',
      'scripts/non-rdte-phase5-operator-contract.spec.ts',
    ],
    API_ROOT,
  ),
  pnpmStep('Phase 5 strict TypeScript', [
    'exec',
    'tsc',
    '-p',
    'apps/api/tsconfig.non-rdte-phase-5.json',
    '--noEmit',
  ]),
  pnpmStep('Primary Prisma client generation', ['--filter', '@capiro/api', 'prisma:generate']),
  pnpmStep('Primary Prisma schema validation', ['--dir', 'apps/api', 'exec', 'prisma', 'validate']),
  pnpmStep('Non-RDT&E projection Prisma schema validation', [
    '--dir',
    'apps/api',
    'exec',
    'prisma',
    'validate',
    '--schema',
    'prisma/non-rdte-projection/schema.prisma',
  ]),
  pnpmStep('Non-RDT&E projection client generation', [
    '--dir',
    'apps/api',
    'exec',
    'prisma',
    'generate',
    '--schema',
    'prisma/non-rdte-projection/schema.prisma',
  ]),
  pnpmStep('Twenty Phase 5 mutate-fail-restore controls', [
    '--dir',
    'apps/api',
    'exec',
    'tsx',
    'scripts/verify-pe-budget-phase-5-negative-controls.ts',
  ]),
  {
    name: 'Disposable PostgreSQL 16 fresh and upgrade rehearsal',
    command: 'bash',
    args: ['scripts/non-rdte-phase5-migration-rehearsal.sh'],
    cwd: API_ROOT,
    timeoutMs: 45 * 60 * 1000,
  },
  {
    name: 'Locked Python parser environment',
    command: 'uv',
    args: ['sync', '--frozen', '--extra', 'dev'],
    cwd: PARSER_ROOT,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: 'Python parser Ruff lint',
    command: 'uv',
    args: ['run', 'ruff', 'check', '.'],
    cwd: PARSER_ROOT,
  },
  {
    name: 'Python parser Ruff format',
    command: 'uv',
    args: ['run', 'ruff', 'format', '--check', '.'],
    cwd: PARSER_ROOT,
  },
  {
    name: 'Python parser mypy',
    command: 'uv',
    args: ['run', 'mypy', 'src'],
    cwd: PARSER_ROOT,
  },
  {
    name: 'Python parser pytest',
    command: 'uv',
    args: ['run', 'pytest'],
    cwd: PARSER_ROOT,
    timeoutMs: 20 * 60 * 1000,
  },
  pnpmStep('Phase 5 formatting', [
    'exec',
    'prettier',
    '--check',
    'apps/api/src/defense-budget/non-rdte',
    'apps/api/src/defense-budget/procurement',
    'apps/api/src/defense-budget/om',
    'apps/api/src/defense-budget/milcon',
    'apps/api/src/defense-budget/verification/artifact-smoke.spec.ts',
    'apps/api/src/defense-budget/verification/authority-policy-resolution.spec.ts',
    'apps/api/src/defense-budget/verification/verification-containment.spec.ts',
    'apps/api/src/defense-budget/verification/trusted-proof/parser-output-proof.spec.ts',
    'apps/api/src/defense-budget/verification/trusted-proof/parser-output-declaration-binding.spec.ts',
    'apps/api/scripts/inspect-defense-budget-non-rdte.ts',
    'apps/api/scripts/extract-defense-budget-non-rdte.ts',
    'apps/api/scripts/verify-defense-budget-non-rdte.ts',
    'apps/api/scripts/certify-defense-budget-non-rdte.ts',
    'apps/api/scripts/plan-defense-budget-non-rdte-projection.ts',
    'apps/api/scripts/lib/non-rdte-phase5-operator-lib.ts',
    'apps/api/scripts/non-rdte-phase5-operator-contract.spec.ts',
    'apps/api/scripts/verify-pe-budget-phase-5-negative-controls.ts',
    'apps/api/scripts/verify-pe-budget-phase-5-closeout.ts',
    // The projection schema is deliberately absent: prettier cannot infer a
    // parser for .prisma without prettier-plugin-prisma, which is not a
    // dependency, so listing it here fails the step with exit 2 rather than
    // reporting a style problem. The schema is covered by the dedicated
    // `prisma validate` and `prisma generate` steps above.
    'apps/api/tsconfig.non-rdte-phase-5.json',
    'docs/defense-budget/NON-RDTE-INGESTION-V1.md',
    'docs/runbooks/defense-budget-non-rdte-cycle.md',
    'docs/defense-budget/PHASE-5-AUDIT-REPAIR-HANDOFF.md',
  ]),
  {
    name: 'Whitespace and conflict-marker check',
    command: 'git',
    args: ['diff', '--check', 'main...HEAD'],
    cwd: REPO_ROOT,
  },
];

try {
  steps.forEach(run);
  console.log(
    JSON.stringify(
      {
        ok: true,
        phase: 5,
        containersIncluded: includeContainers,
        phase1Through4Closed: true,
        nativeProjectionSchemaValidated: true,
        negativeControls: 20,
        canonicalWritesPerformed: false,
        paidCallsPerformedByCloseout: false,
        awsCallsPerformedByCloseout: false,
        sharedMigrationsApplied: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`\nPhase 5 closeout FAILED: ${(error as Error).message}`);
  process.exit(1);
}
