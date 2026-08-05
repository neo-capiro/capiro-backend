/** Execute the complete Phase 3 validation matrix outside GitHub Actions. */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
const PYTHON_ROOT = path.join(REPO_ROOT, 'apps', 'defense-budget-parser');
const includeContainers = process.argv.includes('--include-containers');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--include-containers');
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(', ')}`);
  process.exit(2);
}

interface Command {
  name: string;
  command: string;
  args: string[];
  cwd: string;
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const commands: Command[] = [
  {
    name: 'Phase 1 regression',
    command: pnpm,
    args: ['--filter', '@capiro/api', 'verify:pe-budget-phase-1'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Phase 2 regression',
    command: pnpm,
    args: ['--filter', '@capiro/api', 'verify:pe-budget-phase-2'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Phase 3 Jest gate',
    command: pnpm,
    args: ['--filter', '@capiro/api', 'verify:pe-budget-phase-3'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Phase 3 strict TypeScript',
    command: pnpm,
    args: ['exec', 'tsc', '-p', 'apps/api/tsconfig.budget-parser-router.json', '--noEmit'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Prisma generation',
    command: pnpm,
    args: ['--dir', 'apps/api', 'exec', 'prisma', 'generate'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Prisma validation',
    command: pnpm,
    args: ['--dir', 'apps/api', 'exec', 'prisma', 'validate'],
    cwd: REPO_ROOT,
  },
  {
    name: 'Architecture and safety guard',
    command: pnpm,
    args: ['exec', 'tsx', 'scripts/verify-defense-budget-parser-architecture.ts'],
    cwd: API_ROOT,
  },
  {
    name: 'Cross-language contract and hash gate',
    command: pnpm,
    args: ['exec', 'tsx', 'scripts/verify-defense-budget-parser-runtime.ts'],
    cwd: API_ROOT,
  },
  {
      name: 'Python locked dependency sync',
    command: 'uv',
    args: ['sync', '--locked', '--extra', 'dev'],
    cwd: PYTHON_ROOT,
    },
  {
    name: 'Python tests',
    command: 'uv',
    args: ['run', 'pytest'],
    cwd: PYTHON_ROOT,
  },
  {
    name: 'Python Ruff lint',
    command: 'uv',
    args: ['run', 'ruff', 'check', '.'],
    cwd: PYTHON_ROOT,
  },
  {
    name: 'Python Ruff format',
    command: 'uv',
    args: ['run', 'ruff', 'format', '--check', '.'],
    cwd: PYTHON_ROOT,
  },
  {
    name: 'Python typing',
    command: 'uv',
    args: ['run', 'mypy', 'src'],
    cwd: PYTHON_ROOT,
  },
  {
    name: 'Twenty mutate-fail-restore controls',
    command: pnpm,
    args: ['exec', 'tsx', 'scripts/verify-pe-budget-phase-3-negative-controls.ts'],
    cwd: API_ROOT,
  },
  {
    name: 'Prettier',
    command: pnpm,
    args: [
      'exec',
      'prettier',
      '--check',
      'apps/api/src/defense-budget/parser-router',
      'apps/api/src/defense-budget/verification/trusted-proof/parser-output-proof-adapters.ts',
      'apps/api/src/defense-budget/verification/trusted-proof/llamaparse-parser-output-proof-adapter.spec.ts',
      'apps/api/scripts/profile-defense-budget-document.ts',
      'apps/api/scripts/plan-defense-budget-parse.ts',
      'apps/api/scripts/extract-defense-budget-cycle.ts',
      'apps/api/scripts/replay-defense-budget-parser-artifact.ts',
      'apps/api/scripts/verify-defense-budget-parser-architecture.ts',
      'apps/api/scripts/verify-defense-budget-parser-runtime.ts',
      'apps/api/scripts/verify-pe-budget-phase-3-negative-controls.ts',
      'apps/api/scripts/verify-pe-budget-phase-3-closeout.ts',
      'docs/program-elements/enrichment/BUDGET-PARSER-ROUTER-V1.md',
      'docs/program-elements/enrichment/PHASE-3-FINAL-HANDOFF.md',
      'docs/runbooks/defense-budget-parser-router.md',
    ],
    cwd: REPO_ROOT,
  },
  {
    name: 'Git whitespace check',
    command: 'git',
    args: ['diff', '--check', 'main...HEAD'],
    cwd: REPO_ROOT,
  },
];

if (includeContainers) {
  for (const target of ['table', 'layout', 'ocr']) {
    commands.push({
      name: `Docker ${target} target`,
      command: 'docker',
      args: [
        'build',
        '--platform',
        'linux/amd64',
        '--target',
        target,
        '-f',
        'apps/defense-budget-parser/Dockerfile',
        '.',
      ],
      cwd: REPO_ROOT,
    });
  }
}

for (const item of commands) {
  console.log(`\n=== ${item.name} ===`);
  const result = spawnSync(item.command, item.args, {
    cwd: item.cwd,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (result.error) {
    console.error(`${item.name} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${item.name} failed with exit ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nPhase 3 closeout validation passed');
if (!includeContainers) {
  console.log(
    'Container targets were not requested. Run again with --include-containers before final release approval.',
  );
}
process.exit(0);
