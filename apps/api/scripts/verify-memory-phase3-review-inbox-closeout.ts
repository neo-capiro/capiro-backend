import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveMemoryPhase2Pnpm,
  runMemoryPhase2Command,
} from './lib/memory-phase2-command-runner.js';

function resolveApiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma/schema.prisma'))) return cwd;
  const monorepoApi = resolve(cwd, 'apps/api');
  if (existsSync(resolve(monorepoApi, 'prisma/schema.prisma'))) return monorepoApi;
  throw new Error(`Could not resolve apps/api from ${cwd}.`);
}

const apiRoot = resolveApiRoot();
const repoRoot = resolve(apiRoot, '../..');
const pnpm = resolveMemoryPhase2Pnpm();

const apiTests = [
  'src/memory/memory-review-notification.helpers.spec.ts',
  'scripts/lib/memory-phase2-notification-outbox-contract.spec.ts',
  'scripts/lib/memory-phase2-notification-assignment-contract.spec.ts',
  'scripts/lib/memory-phase2-notification-dispatcher-contract.spec.ts',
  'src/memory/memory-authorization.helpers.spec.ts',
  'src/memory/memory-authorization.admin-capability.spec.ts',
  'src/memory/memory-candidate-review.service.spec.ts',
  'src/memory/immutable-memory-version.service.spec.ts',
  'src/memory/memory-review-workflow.service.spec.ts',
  'src/memory/memory-settings-review-readiness.service.spec.ts',
  'src/memory/memory-review-inbox.helpers.spec.ts',
  'src/memory/memory-review-inbox.service.spec.ts',
  'src/memory/memory-review-admin-inbox.service.spec.ts',
  'src/memory/memory-review-inbox.controller.spec.ts',
  'src/reviews/memory-review-compatibility-guard.service.spec.ts',
  'scripts/lib/memory-phase3-review-inbox-contract.spec.ts',
  'scripts/lib/memory-admin-self-approval-contract.spec.ts',
];

function main(): void {
  requireDisposableDatabaseUrl('MEMORY_PHASE2_CLEAN_DATABASE_URL');
  requireDisposableDatabaseUrl('MEMORY_PHASE2_UPGRADE_DATABASE_URL');
  if (
    String(process.env.MEMORY_REVIEW_EMAIL_DELIVERY ?? '')
      .trim()
      .toLowerCase() === 'enforce'
  ) {
    throw new Error(
      'Unset MEMORY_REVIEW_EMAIL_DELIVERY before local Memory Review closeout.',
    );
  }

  runPnpm([
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-memory-phase2-notification-closeout.ts',
  ]);
  runPnpm(['--filter', '@capiro/shared', 'build']);
  runPnpm(['--filter', '@capiro/meriv2-core', 'build']);
  runPnpm([
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-memory-phase3-review-inbox-database.ts',
  ]);
  runPnpm([
    '--filter',
    '@capiro/api',
    'exec',
    'tsx',
    'scripts/verify-memory-admin-self-approval-database.ts',
  ]);
  runPnpm([
    '--filter',
    '@capiro/api',
    'exec',
    'tsc',
    '-p',
    'tsconfig.memory-review-phase3.json',
    '--noEmit',
    '--pretty',
    'false',
  ]);
  runPnpm([
    '--filter',
    '@capiro/api',
    'exec',
    'jest',
    '--runInBand',
    '--forceExit',
    ...apiTests,
  ]);
  runPnpm([
    '--filter',
    '@capiro/web',
    'exec',
    'vitest',
    'run',
    'src/components/MemoryReviewInbox.phase3.test.tsx',
    'src/components/MemoryFileEditor.phase3.test.ts',
    '--testTimeout=20000',
    '--hookTimeout=20000',
  ]);
  runPnpm(['--filter', '@capiro/web', 'build']);

  process.stdout.write('MEMORY_PHASE3_REVIEW_INBOX_CLOSEOUT_COMPLETE\n');
  process.stdout.write('MEMORY_ADMIN_SELF_APPROVAL_CLOSEOUT_COMPLETE\n');
}

function runPnpm(args: string[]): void {
  const result = runMemoryPhase2Command({
    command: pnpm.command,
    args: [...pnpm.prefixArgs, ...args],
    cwd: repoRoot,
    shell: pnpm.shell,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function requireDisposableDatabaseUrl(name: string): void {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  const databaseName = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((component) => decodeURIComponent(component))
    .at(-1)
    ?.toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase()) ||
    !databaseName?.includes('memory_phase2')
  ) {
    throw new Error(
      `${name} must target a disposable local PostgreSQL database named with memory_phase2.`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
