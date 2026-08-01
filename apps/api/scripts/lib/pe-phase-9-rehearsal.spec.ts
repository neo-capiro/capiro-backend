/**
 * Phase 9 integrated release rehearsal unit tests (pure).
 */
import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  PE_PHASE_9_FORBIDDEN_PATH_SUBSTRINGS,
  PE_PHASE_9_REHEARSAL_STEPS,
  pePhase9ExtendedProofSteps,
  pePhase9RequiredSteps,
  pePhase9StepIds,
} from './pe-phase-9-rehearsal-catalog';
import {
  assertPePhase9CatalogHonest,
  classifyPePhase9Failure,
  evaluatePePhase9Gate,
  evaluatePePhase9Integrity,
  stepTouchesChangedPaths,
} from './pe-phase-9-rehearsal';

describe('pe-phase-9-rehearsal catalog', () => {
  it('is honest: unique ids, required kinds, extended proof owners', () => {
    const r = assertPePhase9CatalogHonest();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('names exact pe phase verify scripts without pe_gate globs', () => {
    for (const step of PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.kind === 'pe_gate')) {
      expect(step.command).toMatch(/verify:pe-phase-[a-k]/);
      expect(step.command).not.toMatch(/\*/);
    }
  });

  it('covers plan A–K surfaces including web (H) and K trust', () => {
    const ids = new Set(pePhase9StepIds());
    for (const letter of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j', 'k']) {
      expect(ids.has(`verify_pe_phase_${letter}`)).toBe(true);
    }
    expect(ids.has('web_pe_tests')).toBe(true);
    expect(ids.has('test_pe_trust')).toBe(true);
    expect(ids.has('clean_upgrade_migrate_replay')).toBe(true);
    expect(ids.has('transport_absent')).toBe(true);
  });

  it('lists every plan extended proof with owners', () => {
    expect(PE_PHASE_9_EXTENDED_PROOF_IDS.length).toBe(7);
    for (const id of PE_PHASE_9_EXTENDED_PROOF_IDS) {
      expect(PE_PHASE_9_EXTENDED_PROOF_OWNERS[id].ownerStepIds.length).toBeGreaterThan(0);
    }
    expect(pePhase9ExtendedProofSteps().length).toBeGreaterThan(0);
    expect(pePhase9RequiredSteps().every((s) => s.required)).toBe(true);
  });

  it('forbids transport path substrings', () => {
    expect(PE_PHASE_9_FORBIDDEN_PATH_SUBSTRINGS).toEqual(
      expect.arrayContaining([
        'pe-final-v2.part',
        'remaining-transfer-instructions',
        'program-elements-final-closeout-source.yml',
      ]),
    );
  });
});

describe('classifyPePhase9Failure', () => {
  it('ok when head passes', () => {
    expect(
      classifyPePhase9Failure({
        stepId: 'x',
        headExitCode: 0,
        baseExitCode: 1,
        touchesChangedRuntimePaths: true,
      }).classification,
    ).toBe('ok');
  });

  it('branch_introduced when head fails and base passes', () => {
    expect(
      classifyPePhase9Failure({
        stepId: 'x',
        headExitCode: 1,
        baseExitCode: 0,
        touchesChangedRuntimePaths: false,
      }).classification,
    ).toBe('branch_introduced');
  });

  it('base_proven when both fail and paths unchanged', () => {
    expect(
      classifyPePhase9Failure({
        stepId: 'x',
        headExitCode: 2,
        baseExitCode: 2,
        touchesChangedRuntimePaths: false,
      }).classification,
    ).toBe('base_proven');
  });

  it('branch_introduced when both fail but paths changed', () => {
    expect(
      classifyPePhase9Failure({
        stepId: 'x',
        headExitCode: 2,
        baseExitCode: 2,
        touchesChangedRuntimePaths: true,
      }).classification,
    ).toBe('branch_introduced');
  });

  it('branch_introduced fail-closed when base comparison missing', () => {
    expect(
      classifyPePhase9Failure({
        stepId: 'x',
        headExitCode: 1,
        baseExitCode: null,
        touchesChangedRuntimePaths: false,
      }).classification,
    ).toBe('branch_introduced');
  });
});

describe('evaluatePePhase9Integrity', () => {
  it('passes clean tip', () => {
    const r = evaluatePePhase9Integrity({
      tipPaths: ['apps/api/src/program-element/foo.ts', 'docs/program-elements/final-closeout-work-log.md'],
    });
    expect(r.ok).toBe(true);
  });

  it('blocks transport part files', () => {
    const r = evaluatePePhase9Integrity({
      tipPaths: ['.github/pe-final-v2.part000', 'apps/api/package.json'],
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.some((b) => b.includes('pe-final-v2.part'))).toBe(true);
  });

  it('blocks source-export workflow', () => {
    const r = evaluatePePhase9Integrity({
      changedPaths: ['.github/workflows/program-elements-final-closeout-source.yml'],
      tipPaths: [],
    });
    expect(r.ok).toBe(false);
  });
});

describe('evaluatePePhase9Gate', () => {
  const allPass = PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.required).map((s) => ({
    stepId: s.id,
    exitCode: 0,
  }));

  it('PASS when required outcomes green and integrity ok', () => {
    const r = evaluatePePhase9Gate({
      outcomes: allPass,
      integrity: { ok: true, blockers: [], forbiddenHits: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('FAIL on branch-introduced required failure', () => {
    const outcomes = allPass.map((o) =>
      o.stepId === 'verify_pe_phase_d' ? { ...o, exitCode: 1, detail: 'boom' } : o,
    );
    const r = evaluatePePhase9Gate({
      outcomes,
      baseComparisons: [
        {
          stepId: 'verify_pe_phase_d',
          headExitCode: 1,
          baseExitCode: 0,
          touchesChangedRuntimePaths: true,
        },
      ],
      integrity: { ok: true, blockers: [], forbiddenHits: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.blockers.some((b) => b.includes('branch-introduced'))).toBe(true);
  });

  it('PASS WITH base_proven warning when both fail on unchanged paths', () => {
    const outcomes = allPass.map((o) =>
      o.stepId === 'api_typecheck' ? { ...o, exitCode: 1 } : o,
    );
    const r = evaluatePePhase9Gate({
      outcomes,
      baseComparisons: [
        {
          stepId: 'api_typecheck',
          headExitCode: 1,
          baseExitCode: 1,
          touchesChangedRuntimePaths: false,
        },
      ],
      integrity: { ok: true, blockers: [], forbiddenHits: [] },
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('BASE_PROVEN'))).toBe(true);
  });

  it('FAIL on integrity transport residue even if tests green', () => {
    const r = evaluatePePhase9Gate({
      outcomes: allPass,
      integrity: {
        ok: false,
        blockers: ['forbidden transport'],
        forbiddenHits: ['.github/pe-final-v2.part000'],
      },
    });
    expect(r.ok).toBe(false);
  });
});

describe('stepTouchesChangedPaths', () => {
  it('detects pe gate vs pe tree changes', () => {
    const step = PE_PHASE_9_REHEARSAL_STEPS.find((s) => s.id === 'verify_pe_phase_i')!;
    expect(
      stepTouchesChangedPaths(step, ['apps/api/src/program-element/program-element-data-issue.service.ts']),
    ).toBe(true);
    expect(stepTouchesChangedPaths(step, ['README.md'])).toBe(false);
  });
});
