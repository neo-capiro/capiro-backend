/** Pure backend rehearsal obligations and retained full-mode compatibility. */
import { createHash } from 'node:crypto';
import {
  PE_PHASE_9_BACKEND_EXCLUDED_STEP_IDS,
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  PE_PHASE_9_REHEARSAL_STEPS,
  pePhase9ExtendedProofSteps,
  pePhase9RequiredSteps,
  pePhase9StepsForScope,
  type PePhase9Scope,
} from './pe-phase-9-rehearsal-catalog';
import {
  assertPePhase9CatalogHonest,
  evaluatePePhase9Gate,
  PE_PHASE_9_ENV_SKIP_EXIT,
} from './pe-phase-9-rehearsal';

const backend = pePhase9StepsForScope('backend');
const integrity = { ok: true, blockers: [], forbiddenHits: [] };
const allPass = pePhase9RequiredSteps('backend').map((step) => ({
  stepId: step.id,
  exitCode: 0,
}));

describe('Phase 9 full-mode compatibility', () => {
  const allPass = PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.required).map((s) => ({
    stepId: s.id,
    exitCode: 0,
  }));
  it('preserves the full catalog and default selection exactly', () => {
    expect(pePhase9StepsForScope()).toBe(PE_PHASE_9_REHEARSAL_STEPS);
    expect(pePhase9StepsForScope('full')).toBe(PE_PHASE_9_REHEARSAL_STEPS);
    expect(PE_PHASE_9_REHEARSAL_STEPS).toHaveLength(31);
    expect(pePhase9RequiredSteps()).toHaveLength(29);
    expect(
      createHash('sha256').update(JSON.stringify(PE_PHASE_9_REHEARSAL_STEPS)).digest('hex'),
    ).toBe('f7f1cd24c268410234e40b4f2ffe6450d441574aeb2260ff8f48baf0660f240f');
  });
  it('preserves full-mode subset, unknown and duplicate outcome semantics', () => {
    const integrity = { ok: true, blockers: [], forbiddenHits: [] };
    expect(evaluatePePhase9Gate({ outcomes: [], integrity }).ok).toBe(true);
    const unknown = evaluatePePhase9Gate({
      outcomes: [{ stepId: 'unknown', exitCode: 0 }],
      integrity,
    });
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings).toEqual(['unknown step outcome: unknown']);
    expect(evaluatePePhase9Gate({ outcomes: [...allPass, allPass[0]!], integrity }).ok).toBe(true);
  });
});

describe('Phase 9 backend catalog selection', () => {
  it('excludes exactly the three frontend obligations and retains their remaining order', () => {
    expect(PE_PHASE_9_BACKEND_EXCLUDED_STEP_IDS).toEqual([
      'web_typecheck',
      'web_build',
      'web_pe_tests',
    ]);
    const addedBuildIds = new Set([
      'meriv2_core_build',
      'defense_contracts_build',
      'defense_domain_build',
    ]);
    expect(backend.filter((step) => !addedBuildIds.has(step.id)).map((step) => step.id)).toEqual(
      PE_PHASE_9_REHEARSAL_STEPS.filter(
        (step) => !new Set<string>(PE_PHASE_9_BACKEND_EXCLUDED_STEP_IDS).has(step.id),
      ).map((step) => step.id),
    );
    expect(backend).toHaveLength(31);
    expect(pePhase9RequiredSteps('backend')).toHaveLength(29);
    expect(assertPePhase9CatalogHonest('backend')).toEqual({ ok: true, errors: [] });
  });

  it('changes only install and mixed hygiene commands of the retained full-catalog rows', () => {
    const changedIds = backend
      .filter((step) => PE_PHASE_9_REHEARSAL_STEPS.some((fullStep) => fullStep.id === step.id))
      .filter(
        (step) =>
          JSON.stringify(step) !==
          JSON.stringify(PE_PHASE_9_REHEARSAL_STEPS.find((fullStep) => fullStep.id === step.id)),
      )
      .map((step) => step.id);
    expect(changedIds).toEqual(['install_frozen', 'prettier_pe_surface', 'git_diff_check']);
    expect(backend.some((step) => /apps\/web|@capiro\/web/.test(step.command))).toBe(false);
    expect(backend.some((step) => step.cwd === 'apps/web')).toBe(false);
    expect(backend.find((step) => step.id === 'install_frozen')?.command).toBe(
      "pnpm --filter capiro --filter '@capiro/api...' --filter '@capiro/workspace...' install --frozen-lockfile --fail-if-no-match",
    );
    const diffCommand = backend.find((step) => step.id === 'git_diff_check')?.command;
    expect(diffCommand).toContain('apps/api/scripts/lib/pe-phase-9-runner.ts');
    expect(diffCommand).toContain('apps/api/scripts/lib/pe-phase-9-runner.spec.ts');
  });
});

describe('Phase 9 backend catalog prerequisites', () => {
  it('builds API dependency exports after shared and before API typecheck', () => {
    const ids = backend.map((step) => step.id);
    const sharedIndex = ids.indexOf('shared_build');
    const apiTypecheckIndex = ids.indexOf('api_typecheck');
    expect(ids.slice(sharedIndex, sharedIndex + 4)).toEqual([
      'shared_build',
      'meriv2_core_build',
      'defense_contracts_build',
      'defense_domain_build',
    ]);
    for (const [id, cwd] of [
      ['meriv2_core_build', 'packages/meriv2-core'],
      ['defense_contracts_build', 'packages/defense-contracts'],
      ['defense_domain_build', 'packages/defense-domain'],
    ] as const) {
      expect(ids.indexOf(id)).toBeLessThan(apiTypecheckIndex);
      expect(backend.find((step) => step.id === id)).toMatchObject({
        command: 'pnpm run build',
        cwd,
        required: true,
        kind: 'build',
      });
    }
  });

  it('retains every backend extended-proof owner, migration and disposable-PG requirement', () => {
    expect(pePhase9ExtendedProofSteps('backend')).toEqual(pePhase9ExtendedProofSteps());
    const byId = new Map(backend.map((step) => [step.id, step]));
    for (const proof of PE_PHASE_9_EXTENDED_PROOF_IDS) {
      for (const owner of PE_PHASE_9_EXTENDED_PROOF_OWNERS[proof].ownerStepIds) {
        expect(byId.get(owner)?.required).toBe(true);
      }
    }
    const replay = byId.get('clean_upgrade_migrate_replay');
    expect(replay?.required).toBe(true);
    expect(replay?.disposablePostgresOnly).toBe(true);
    expect(byId.get('migration_guards_offline')?.required).toBe(true);
    expect(byId.get('rls_phase_c_rehearsal')?.disposablePostgresOnly).toBe(true);
  });
});

describe('Phase 9 backend catalog honesty', () => {
  it.each([
    'shared_build',
    'workspace_typecheck',
    'verify_pe_phase_d',
    'clean_upgrade_migrate_replay',
  ])('rejects a backend catalog missing %s', (id) => {
    const result = assertPePhase9CatalogHonest(
      'backend',
      backend.filter((step) => step.id !== id),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(`missing backend step: ${id}`);
  });

  it('rejects a weaker required flag, a frontend command and extra or duplicate rows', () => {
    const weaken = backend.map((step) =>
      step.id === 'clean_upgrade_migrate_replay' ? { ...step, required: false } : step,
    );
    expect(assertPePhase9CatalogHonest('backend', weaken).ok).toBe(false);
    const frontend = backend.map((step) =>
      step.id === 'shared_build' ? { ...step, command: 'pnpm -C apps/web run build' } : step,
    );
    expect(assertPePhase9CatalogHonest('backend', frontend).errors).toContain(
      'backend command contains frontend dependency: shared_build',
    );
    const web = PE_PHASE_9_REHEARSAL_STEPS.find((step) => step.id === 'web_build')!;
    expect(assertPePhase9CatalogHonest('backend', [...backend, web]).errors).toContain(
      'unexpected backend step: web_build',
    );
    expect(assertPePhase9CatalogHonest('backend', [...backend, backend[0]!]).errors).toContain(
      'duplicate step id: install_frozen',
    );
  });

  it('rejects an unsupported scope instead of choosing a weaker default', () => {
    expect(() => pePhase9StepsForScope('frontend' as PePhase9Scope)).toThrow(
      'unsupported Phase 9 scope: frontend',
    );
  });

  it('rejects backend obligations reordered around build prerequisites', () => {
    const reordered = [...backend];
    const buildIndex = reordered.findIndex((step) => step.id === 'meriv2_core_build');
    const typecheckIndex = reordered.findIndex((step) => step.id === 'api_typecheck');
    [reordered[buildIndex], reordered[typecheckIndex]] = [
      reordered[typecheckIndex]!,
      reordered[buildIndex]!,
    ];
    expect(assertPePhase9CatalogHonest('backend', reordered).errors).toContain(
      'backend step order differs from scoped contract',
    );
  });
});

describe('Phase 9 backend gate completeness', () => {
  it('passes only the complete backend required set without frontend outcomes', () => {
    const result = evaluatePePhase9Gate({ scope: 'backend', outcomes: allPass, integrity });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.classifications).toHaveLength(29);
  });

  it('fails empty evidence even when integrity is green', () => {
    const result = evaluatePePhase9Gate({ scope: 'backend', outcomes: [], integrity });
    expect(result.ok).toBe(false);
    expect(result.blockers).toHaveLength(29);
  });

  it.each(pePhase9RequiredSteps('backend').map((step) => step.id))(
    'fails missing required outcome %s',
    (id) => {
      const result = evaluatePePhase9Gate({
        scope: 'backend',
        outcomes: allPass.filter((outcome) => outcome.stepId !== id),
        integrity,
      });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContain(`required step not executed: ${id}`);
    },
  );
});

describe('Phase 9 backend gate outcome validity', () => {
  it.each(['unknown', 'web_typecheck', 'web_build', 'web_pe_tests'])(
    'fails unknown or excluded outcome %s',
    (stepId) => {
      const result = evaluatePePhase9Gate({
        scope: 'backend',
        outcomes: [...allPass, { stepId, exitCode: 0 }],
        integrity,
      });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContain(`unknown step outcome: ${stepId}`);
    },
  );

  it('fails duplicate success outcomes', () => {
    const result = evaluatePePhase9Gate({
      scope: 'backend',
      outcomes: [...allPass, allPass[0]!],
      integrity,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain('duplicate step outcome: install_frozen');
  });

  it.each([NaN, Infinity, -1, 0.5])('fails malformed exit code %s', (exitCode) => {
    const outcomes = allPass.map((outcome) =>
      outcome.stepId === 'install_frozen' ? { ...outcome, exitCode } : outcome,
    );
    const result = evaluatePePhase9Gate({ scope: 'backend', outcomes, integrity });
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain('invalid step exit code: install_frozen');
  });
});

describe('Phase 9 backend gate failure classifications', () => {
  it('blocks skipped required migration even with a supplied failing base', () => {
    const outcomes = allPass.map((outcome) =>
      outcome.stepId === 'clean_upgrade_migrate_replay'
        ? { ...outcome, exitCode: PE_PHASE_9_ENV_SKIP_EXIT, detail: 'disposable Postgres not run' }
        : outcome,
    );
    const result = evaluatePePhase9Gate({
      scope: 'backend',
      outcomes,
      integrity,
      baseComparisons: [
        {
          stepId: 'clean_upgrade_migrate_replay',
          headExitCode: PE_PHASE_9_ENV_SKIP_EXIT,
          baseExitCode: PE_PHASE_9_ENV_SKIP_EXIT,
          touchesChangedRuntimePaths: false,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.some((blocker) => blocker.startsWith('ENV '))).toBe(true);
  });

  it('retains branch failure, base-proven and integrity classifications', () => {
    const outcomes = allPass.map((outcome) =>
      outcome.stepId === 'api_typecheck' ? { ...outcome, exitCode: 1 } : outcome,
    );
    expect(evaluatePePhase9Gate({ scope: 'backend', outcomes, integrity }).ok).toBe(false);
    const baseComparisons = [
      {
        stepId: 'api_typecheck',
        headExitCode: 1,
        baseExitCode: 1,
        touchesChangedRuntimePaths: false,
      },
    ];
    const baseProven = evaluatePePhase9Gate({
      scope: 'backend',
      outcomes,
      integrity,
      baseComparisons,
    });
    expect(baseProven.ok).toBe(true);
    expect(baseProven.warnings.some((warning) => warning.startsWith('BASE_PROVEN '))).toBe(true);
    expect(
      evaluatePePhase9Gate({
        scope: 'backend',
        outcomes: allPass,
        integrity: {
          ok: false,
          blockers: ['forbidden transport'],
          forbiddenHits: ['.github/pe-final-v2.part000'],
        },
      }).ok,
    ).toBe(false);
  });
});
