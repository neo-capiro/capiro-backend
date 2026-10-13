import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as catalog from './pe-phase-9-rehearsal-catalog.js';
import {
  API_PACKAGE,
  BASE_SHA,
  HEAD_SHA,
  MAIN_SHA,
  evidence,
  exerciseCli,
  expectSuccess,
} from './pe-phase-9-runner.test-support.js';

describe('Phase 9 integrated operator compatibility', () => {
  it.each([[], ['--full'], ['--run']].map((argv) => ({ argv })))(
    'preserves the integrated operator for $argv',
    ({ argv }) => {
      const result = exerciseCli(argv);
      expectSuccess(result, 'PE_PHASE_9_OK');
      const json = evidence(result);
      expect(Object.keys(json)).toEqual([
        'phase',
        'kind',
        'headSha',
        'mergeBase',
        'mainSha',
        'generatedAt',
        'integrity',
        'outcomes',
        'baseComparisons',
        'gate',
        'extendedProofs',
        'note',
      ]);
      expect(json.kind).toBe('integrated_release_rehearsal');
      expect(json.outcomes.map((row: { stepId: string }) => row.stepId)).toEqual(
        catalog.pePhase9StepIds(),
      );
      expect(result.commands.filter((call) => call.cwd === '/fixture/apps/web')).toHaveLength(3);
      expect(result.logs).not.toContain('PE_PHASE_9_BACKEND_OK');
    },
  );
});

describe('Phase 9 backend scope activation', () => {
  it('executes the backend dependency closure and emits distinct, incomplete-release evidence', () => {
    const result = exerciseCli(['--backend-only', '--run']);
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    const json = evidence(result, 'backend');
    expect(json).toMatchObject({
      phase: 9,
      kind: 'backend_release_rehearsal',
      scope: 'backend',
      fullReleaseQualified: false,
    });
    expect(json.excludedFrontendSteps).toEqual(['web_typecheck', 'web_build', 'web_pe_tests']);
    expect(json.outcomes).toHaveLength(31);
    expect(json.gate.classifications).toHaveLength(31);
    expect(catalog.pePhase9RequiredSteps('backend')).toHaveLength(29);
    expect(result.commands).toHaveLength(29);
    expect(json.outcomes.map((row: { stepId: string }) => row.stepId)).toEqual(
      catalog.pePhase9StepIds('backend'),
    );
    expect(
      result.commands.every(
        (call) => !/apps\/web|onboard-web|@capiro\/web/.test(`${call.cwd} ${call.command}`),
      ),
    ).toBe(true);
    expect(result.commands.slice(4, 7).map((call) => [call.cwd, call.command])).toEqual([
      ['/fixture/packages/meriv2-core', 'pnpm run build'],
      ['/fixture/packages/defense-contracts', 'pnpm run build'],
      ['/fixture/packages/defense-domain', 'pnpm run build'],
    ]);
    expect(
      result.writes.has(
        '/fixture/docs/verification/program-elements-trust/phase-9/phase-9-rehearsal-summary.json',
      ),
    ).toBe(false);
    expect(result.logs).not.toContain('PE_PHASE_9_OK');
    expect(json.note).toContain('independent REVIEW');
  });

  it.each(['--dry-run', '--catalog-only', '--integrity-only', '--extended-proofs-only'])(
    'keeps backend %s free of shell commands and evidence writes',
    (mode) => {
      const result = exerciseCli(['--backend-only', mode]);
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBeUndefined();
      expect(result.commands).toEqual([]);
      expect(result.spawns.every((call) => call.command === 'git')).toBe(true);
      expect(result.writes.size).toBe(0);
      expect(result.logs.some((line) => line.includes('apps/web'))).toBe(false);
      if (mode === '--dry-run') expect(result.logs).toContain('steps=31 required=29');
      if (mode === '--catalog-only') expect(result.logs).toEqual(['PE_PHASE_9_BACKEND_CATALOG_OK']);
    },
  );
});

describe('Phase 9 operator arguments and permanent registration', () => {
  it.each(
    [
      ['--backend-only', '--full'],
      ['--scope', 'backend'],
      ['--backend-only=true'],
      ['--base-sha'],
      ['--base-sha='],
      ['--evidence-dir'],
      ['--evidence-dir='],
      ['unexpected'],
    ].map((argv) => ({ argv })),
  )('rejects malformed or conflicting arguments $argv before any effect', ({ argv }) => {
    const result = exerciseCli(argv);
    expect(result.error).toBeDefined();
    expect(result.commands).toEqual([]);
    expect(result.spawns).toEqual([]);
    expect(result.writes.size).toBe(0);
  });

  it('activates the backend package aliases and permanent production-script checks', () => {
    expect(API_PACKAGE.scripts['verify:pe-phase-9']).toBe('tsx scripts/verify-pe-phase-9.ts --run');
    expect(API_PACKAGE.scripts['verify:pe-phase-9:backend']).toBe(
      'tsx scripts/verify-pe-phase-9.ts --backend-only --run',
    );
    expect(API_PACKAGE.scripts['verify:pe-phase-9:backend:dry-run']).toBe(
      'tsx scripts/verify-pe-phase-9.ts --backend-only --dry-run',
    );
    expect(API_PACKAGE.scripts['test:pe-trust']).toContain('scripts/lib/pe-phase-9-runner.spec.ts');
    const typecheck = JSON.parse(
      readFileSync(resolve(__dirname, '../../tsconfig.pe-scripts.json'), 'utf8'),
    );
    expect(typecheck.include).toEqual(
      expect.arrayContaining([
        'scripts/lib/pe-phase-9-runner.ts',
        'scripts/lib/pe-phase-9-runner.spec.ts',
        'scripts/lib/pe-phase-9-runner.test-support.ts',
      ]),
    );
    const sources = readFileSync(resolve(__dirname, 'pe-production-scripts.ts'), 'utf8');
    expect(sources).toContain("'scripts/lib/pe-phase-9-runner.ts'");
    expect(sources).toContain("'scripts/lib/pe-phase-9-runner.spec.ts'");
    expect(sources).toContain("'scripts/lib/pe-phase-9-runner.test-support.ts'");
  });
});

describe('Phase 9 actual operator execution and failure classification', () => {
  it.each([true, false])(
    'blocks required migration without executing disposable commands, docker=%s',
    (dockerAvailable) => {
      const result = exerciseCli(
        ['--backend-only', ...(dockerAvailable ? ['--skip-disposable-pg'] : [])],
        { dockerAvailable },
      );
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(1);
      expect(result.errors).toContain('PE_PHASE_9_BACKEND_FAIL');
      expect(
        result.commands.some((call) =>
          /^bash .*?(migration-replay|rls-rehearsal)\.sh$/.test(call.command),
        ),
      ).toBe(false);
      const json = evidence(result, 'backend');
      expect(json.gate.ok).toBe(false);
      expect(
        json.outcomes.find(
          (row: { stepId: string }) => row.stepId === 'clean_upgrade_migrate_replay',
        ).exitCode,
      ).toBe(75);
      expect(json.gate.blockers.some((line: string) => line.startsWith('ENV '))).toBe(true);
    },
  );

  it('permits the explicitly provided disposable PG fixture when docker is unavailable', () => {
    const result = exerciseCli(['--backend-only'], {
      dockerAvailable: false,
      env: { PE_PHASE_9_PGHOST: '127.0.0.1' },
    });
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    expect(
      result.commands.filter((call) =>
        /^bash .*?(migration-replay|rls-rehearsal)\.sh$/.test(call.command),
      ),
    ).toHaveLength(2);
  });
});

describe('Phase 9 backend proof and integrity failures', () => {
  it('blocks a failed proof owner and the resulting extended proof matrix', () => {
    const result = exerciseCli(['--backend-only'], {
      failure: (call) => (call.command === 'pnpm run verify:pe-phase-e' ? 17 : undefined),
    });
    expect(result.exitCode).toBe(1);
    const json = evidence(result, 'backend');
    const owner = json.outcomes.find(
      (row: { stepId: string }) => row.stepId === 'verify_pe_phase_e',
    );
    expect(owner).toMatchObject({ exitCode: 17, detail: 'fixture stdout\nfixture stderr' });
    expect(
      json.outcomes.find(
        (row: { stepId: string }) => row.stepId === 'extended_loader_dry_run_matrix',
      ),
    ).toMatchObject({ exitCode: 1 });
    expect(json.gate.blockers.some((line: string) => line.includes('owner gate not green'))).toBe(
      true,
    );
    expect(result.logs).not.toContain('PE_PHASE_9_BACKEND_OK');
  });

  it('records soft failures as warnings while retaining the complete backend proof set', () => {
    const result = exerciseCli(['--backend-only'], {
      failure: (call) => (call.command.includes('prettier --check') ? 2 : undefined),
    });
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    const json = evidence(result, 'backend');
    expect(json.gate.warnings.some((line: string) => line.startsWith('soft-fail '))).toBe(true);
    expect(json.outcomes).toHaveLength(31);
  });

  it('blocks transport residue even when every mocked shell succeeds', () => {
    const result = exerciseCli(['--backend-only'], { tipPaths: ['.github/pe-final-v2.part000'] });
    expect(result.exitCode).toBe(1);
    const json = evidence(result, 'backend');
    expect(json.integrity.ok).toBe(false);
    expect(
      json.outcomes.find((row: { stepId: string }) => row.stepId === 'transport_absent').exitCode,
    ).toBe(1);
    expect(json.gate.blockers.some((line: string) => line.includes('forbidden transport'))).toBe(
      true,
    );
  });
});

describe('Phase 9 backend base-result classification', () => {
  it.each([
    ['README.md', true],
    ['apps/api/src/program-element/example.ts', false],
  ] as const)(
    'preserves base-result classification for changed path %s',
    (changedPath, shouldPass) => {
      const result = exerciseCli(['--backend-only', '--base-sha', BASE_SHA], {
        changedPaths: [changedPath],
        baseResults: { api_typecheck: 3 },
        env: { PE_PHASE_9_BASE_RESULTS_JSON: '/fixture/base-results.json' },
        failure: (call) =>
          call.command === 'pnpm run typecheck' && call.cwd === '/fixture/apps/api' ? 3 : undefined,
      });
      const json = evidence(result, 'backend');
      expect(json.gate.ok).toBe(shouldPass);
      expect(json.baseComparisons).toContainEqual({
        stepId: 'api_typecheck',
        headExitCode: 3,
        baseExitCode: 3,
        touchesChangedRuntimePaths: !shouldPass,
      });
      expect(result.exitCode).toBe(shouldPass ? undefined : 1);
      expect(result.commands.some((call) => /git (checkout|worktree)/.test(call.command))).toBe(
        false,
      );
    },
  );
});

describe('Phase 9 shell adapter timeout and environment contracts', () => {
  it('preserves command timeout classes and default environment on the real shell adapter', () => {
    const result = exerciseCli(['--backend-only', '--skip-install']);
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    expect(
      result.commands.find((call) =>
        call.command.includes("jest --runInBand --forceExit --testPathPattern='"),
      )?.timeout,
    ).toBe(25 * 60_000);
    expect(
      result.commands.find(
        (call) => call.command === 'bash apps/api/scripts/pe-phase-9-migration-replay.sh',
      )?.timeout,
    ).toBe(30 * 60_000);
    expect(
      result.commands.find(
        (call) => call.command === 'bash apps/api/scripts/pe-phase-c-rls-rehearsal.sh',
      )?.timeout,
    ).toBe(30 * 60_000);
    expect(
      result.commands.find((call) => call.command === 'pnpm exec prisma validate')?.timeout,
    ).toBe(15 * 60_000);
    expect(result.commands.every((call) => call.shell === '/bin/bash' && call.env.CI === '1')).toBe(
      true,
    );
    expect(result.commands[0]!.env.DATABASE_URL).toBe(
      'postgresql://capiro:capiro@127.0.0.1:5432/capiro?schema=public',
    );
    expect(
      evidence(result, 'backend').outcomes.find(
        (row: { stepId: string }) => row.stepId === 'install_frozen',
      ),
    ).toMatchObject({ exitCode: 0, detail: 'skip-install flag' });
  });
});

describe('Phase 9 shell adapter portability and evidence contracts', () => {
  it('retains Windows pnpm rewriting and caller environment without touching the host environment', () => {
    const result = exerciseCli(['--backend-only'], {
      platform: 'win32',
      env: {
        PE_PHASE_9_NODE: 'C:/fixture/node.exe',
        PE_PHASE_9_PNPM_JS: 'C:/fixture/pnpm.js',
        CI: 'fixture',
        DATABASE_URL: 'fixture://disposable',
      },
    });
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    expect(result.commands[0]!.command).toMatch(
      /^"C:\/fixture\/node\.exe" "C:\/fixture\/pnpm\.js" --filter capiro /,
    );
    expect(
      result.commands.every(
        (call) =>
          call.shell === 'bash' &&
          call.env.CI === 'fixture' &&
          call.env.DATABASE_URL === 'fixture://disposable',
      ),
    ).toBe(true);
    expect(result.commands[0]!.env).toMatchObject({
      NODE_EXE: 'C:/fixture/node.exe',
      PNPM_JS: 'C:/fixture/pnpm.js',
    });
  });

  it('honors API-relative cwd, explicit evidence directory and bounded command output', () => {
    const result = exerciseCli(['--backend-only', '--evidence-dir=/fixture/custom'], {
      cwd: '/fixture/apps/api',
      output: 'x'.repeat(3_000),
    });
    expectSuccess(result, 'PE_PHASE_9_BACKEND_OK');
    const json = JSON.parse(result.writes.get('/fixture/custom/phase-9-rehearsal-summary.json')!);
    expect(json.headSha).toBe(HEAD_SHA);
    expect(json.mainSha).toBe(MAIN_SHA);
    expect(json.mergeBase).toBe(BASE_SHA);
    expect(
      json.outcomes.find((row: { stepId: string }) => row.stepId === 'prisma_validate').detail,
    ).toHaveLength(2_000);
    expect(result.writes.get('/fixture/custom/README.md')).toContain(
      'This evidence does not qualify the full release.',
    );
    expect(result.writes.size).toBe(2);
  });
});
