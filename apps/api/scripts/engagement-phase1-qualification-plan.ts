/** Pure command planning; importing this module performs no I/O. */
export type EngagementPhase1Scope = 'full' | 'backend-only' | 'frontend-only';

export type EngagementPhase1Step =
  | {
      kind: 'command';
      label: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | { kind: 'required-file'; relativePath: string }
  | { kind: 'web-preview-routing' };

/** Explicit intent is required; no arguments are ignored by this verifier. */
export function engagementPhase1Scope(args: readonly string[]): EngagementPhase1Scope {
  if (
    !Array.isArray(args) ||
    args.filter((arg) => arg === '--run').length !== 1 ||
    args.some((arg) => !['--run', '--backend-only', '--frontend-only'].includes(arg)) ||
    args.filter((arg) => arg !== '--run').length > 1
  ) {
    throw new Error('Use exactly one --run and at most one --backend-only or --frontend-only');
  }
  return args.includes('--backend-only') ? 'backend-only' : args.includes('--frontend-only') ? 'frontend-only' : 'full';
}

function requireScope(scope: EngagementPhase1Scope): void {
  if (!['full', 'backend-only', 'frontend-only'].includes(scope)) throw new Error(`Unknown Phase 1 scope: ${scope}`);
}

export function engagementPhase1Marker(
  scope: EngagementPhase1Scope,
  result: 'complete' | 'failed',
): string {
  requireScope(scope);
  if (result !== 'complete' && result !== 'failed') throw new Error('Unknown Phase 1 result');
  if (scope !== 'full') {
    return `[engagement-phase1] ${scope === 'backend-only' ? 'BACKEND' : 'FRONTEND'} ${result === 'complete' ? 'COMPLETE' : 'FAILED'}`;
  }
  return `ENGAGEMENT_PHASE1_DB_FREE_${result === 'complete' ? 'COMPLETE' : 'FAILED'}`;
}

export function engagementPhase1QualificationPlan(
  scope: EngagementPhase1Scope,
  gitCommand: string,
  testTargets: readonly string[],
): EngagementPhase1Step[] {
  requireScope(scope);
  const steps: EngagementPhase1Step[] = [];
  const command = (
    label: string,
    executable: string,
    args: string[],
    env?: Record<string, string>,
  ): void => {
    steps.push({ kind: 'command', label, command: executable, args, ...(env ? { env } : {}) });
  };
  const webSteps = (): void => {
    command('Web typecheck', 'pnpm', ['--filter', '@capiro/web', 'run', 'typecheck']);
    command('Web regression suite', 'pnpm', ['--filter', '@capiro/web', 'test']);
    // The original scanner reads apps/web/src, so it belongs to the web scope.
    steps.push({ kind: 'web-preview-routing' });
  };
  if (scope === 'frontend-only') {
    webSteps();
    return steps;
  }

  command('Locked dependency install', 'pnpm', ['install', '--frozen-lockfile']);
  for (const pkg of [
    '@capiro/api',
    '@capiro/intel-api',
    '@capiro/workspace',
    '@capiro/onboard-api',
    '@capiro/api-strategy',
  ]) {
    command(`Generate Prisma client: ${pkg}`, 'pnpm', ['--filter', pkg, 'exec', 'prisma', 'generate']);
  }

  for (const pkg of [
    '@capiro/shared',
    '@capiro/defense-contracts',
    '@capiro/defense-domain',
    '@capiro/auth',
    // Keep the original shared prerequisite in both scopes.
    '@capiro/strategy-verifier',
    '@capiro/meriv2-core',
  ]) {
    command(`Build workspace package: ${pkg}`, 'pnpm', ['--filter', pkg, 'run', 'build']);
  }

  command('Phase 0 contract prerequisite', 'pnpm', [
    '--filter',
    '@capiro/api',
    'run',
    'verify:engagement-phase-0',
  ]);
  command(
    'Phase 1 manifests, runtime, route, timer, provider, bootstrap, health, and image-entrypoint tests',
    'pnpm',
    // Preserve the in-band 6 GB heap and exact existing test target identities.
    ['--filter', '@capiro/api', 'exec', 'jest', '--runInBand', '--forceExit', ...testTargets],
    { NODE_OPTIONS: '--max-old-space-size=6144' },
  );
  command('Build API entrypoints', 'pnpm', ['--filter', '@capiro/api', 'run', 'build']);

  for (const relativePath of [
    'apps/api/dist/main.js',
    'apps/api/dist/engagement-main.js',
    'apps/engagement-api/Dockerfile',
    'apps/engagement-api/scripts/entrypoint.sh',
  ]) {
    steps.push({ kind: 'required-file', relativePath });
  }

  // The complete monorepo typecheck may contain unrelated main-branch failures;
  // retain the original production API type surface in both scopes.
  command('API production typecheck', 'pnpm', [
    '--filter',
    '@capiro/api',
    'exec',
    'tsc',
    '-p',
    'tsconfig.build.json',
    '--noEmit',
  ]);
  if (scope === 'full') {
    webSteps();
  }
  command('Committed diff whitespace validation', gitCommand, [
    'diff',
    '--check',
    'origin/main...HEAD',
    '--',
    '.',
    ':(exclude)docs/plans/**/*.md',
  ]);
  return steps;
}
