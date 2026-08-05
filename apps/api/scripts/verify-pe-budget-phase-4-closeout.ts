/** One-command Phase 4 release-candidate validation matrix. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const includeContainers = process.argv.includes('--include-containers');

interface Step {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  shell?: boolean;
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

function pnpmStep(name: string, args: string[], cwd: string = REPO_ROOT): Step {
  return {
    name,
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd,
    shell: pnpm.shell === true,
  };
}

function run(step: Step): void {
  const started = Date.now();
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    stdio: 'inherit',
    timeout: 45 * 60 * 1000,
    env: { ...process.env },
    shell: step.shell === true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${step.name} failed with exit ${result.status ?? 'null'}`);
  }
  console.log(`<== ${step.name} passed (${Date.now() - started}ms)`);
}

const phase3Args = [
  '--dir',
  'apps/api',
  'exec',
  'tsx',
  'scripts/verify-pe-budget-phase-3-closeout.ts',
  ...(includeContainers ? ['--include-containers'] : []),
];

const steps: Step[] = [
  pnpmStep('Merged Phase 1–3 closeout', phase3Args),
  pnpmStep('Phase 4 semantic, cycle, projection, command, and safety tests', [
    '--filter',
    '@capiro/api',
    'verify:pe-budget-phase-4',
  ]),
  pnpmStep('Phase 4 strict TypeScript', [
    'exec',
    'tsc',
    '-p',
    'apps/api/tsconfig.rdte-phase-4.json',
    '--noEmit',
  ]),
  pnpmStep('Prisma generation', ['--filter', '@capiro/api', 'prisma:generate']),
  pnpmStep('Prisma schema validation', ['--dir', 'apps/api', 'exec', 'prisma', 'validate']),
  pnpmStep('Twenty Phase 4 mutate-fail-restore controls', [
    '--dir',
    'apps/api',
    'exec',
    'tsx',
    'scripts/verify-pe-budget-phase-4-negative-controls.ts',
  ]),
  {
    name: 'Disposable PostgreSQL 16 fresh and upgrade rehearsal',
    command: 'bash',
    args: ['scripts/rdte-phase-4-migration-rehearsal.sh'],
    cwd: API_ROOT,
  },
  pnpmStep('Phase 4 formatting', [
    'exec',
    'prettier',
    '--check',
    'apps/api/src/defense-budget/rdte',
    'apps/api/scripts/build-rdte-cycle.ts',
    'apps/api/scripts/report-rdte-cycle.ts',
    'apps/api/scripts/plan-rdte-canonical-projection.ts',
    'apps/api/scripts/verify-rdte-phase-4-safety.ts',
    'apps/api/scripts/verify-pe-budget-phase-4-negative-controls.ts',
    'apps/api/scripts/verify-pe-budget-phase-4-closeout.ts',
    'apps/api/tsconfig.rdte-phase-4.json',
    'docs/program-elements/enrichment/RDTE-PHASE-4-FINAL-CLOSEOUT.md',
    'docs/runbooks/rdte-phase-4-annual-build.md',
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
        phase: 4,
        containersIncluded: includeContainers,
        canonicalWritesPerformed: false,
        paidCallsPerformedByCloseout: false,
        sharedMigrationsApplied: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`\nPhase 4 closeout FAILED: ${(error as Error).message}`);
  process.exit(1);
}
