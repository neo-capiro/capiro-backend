/** Ordered Phase 9 execution with explicit shell and environment ports. */
import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  type PePhase9Step,
} from './pe-phase-9-rehearsal-catalog.js';
import {
  PE_PHASE_9_ENV_SKIP_EXIT,
  stepTouchesChangedPaths,
  type PePhase9BaseComparison,
  type PePhase9IntegrityResult,
  type PePhase9StepOutcome,
} from './pe-phase-9-rehearsal.js';

export interface PePhase9RunPorts {
  log(message: string): void;
  disposableAvailable(): boolean;
  runShell(step: PePhase9Step, timeoutMs: number): Omit<PePhase9StepOutcome, 'stepId'>;
}

export interface PePhase9RunInput {
  steps: readonly PePhase9Step[];
  integrity: PePhase9IntegrityResult;
  skipInstall: boolean;
  skipDisposablePg: boolean;
  ports: PePhase9RunPorts;
}

function skippedOutcome(step: PePhase9Step, input: PePhase9RunInput): PePhase9StepOutcome | null {
  const reason =
    input.skipInstall && step.id === 'install_frozen'
      ? 'skip-install flag'
      : input.skipDisposablePg && step.disposablePostgresOnly
        ? 'skip-disposable-pg flag'
        : null;
  if (!reason) return null;
  input.ports.log(`SKIP ${step.id}: ${reason}`);
  return {
    stepId: step.id,
    exitCode: step.required && step.disposablePostgresOnly ? PE_PHASE_9_ENV_SKIP_EXIT : 0,
    detail: reason,
  };
}

function extendedOutcome(
  outcomes: readonly PePhase9StepOutcome[],
): Omit<PePhase9StepOutcome, 'stepId'> {
  const notes: string[] = [];
  let ok = true;
  for (const id of PE_PHASE_9_EXTENDED_PROOF_IDS) {
    const owner = PE_PHASE_9_EXTENDED_PROOF_OWNERS[id];
    if (
      !owner.ownerStepIds.every((sid) => outcomes.some((o) => o.stepId === sid && o.exitCode === 0))
    ) {
      ok = false;
      notes.push(`${id}: owner gate not green`);
    } else {
      notes.push(`${id}: ok via ${owner.ownerStepIds.join(',')}`);
    }
  }
  return { exitCode: ok ? 0 : 1, detail: notes.join(' | ') };
}

function timeoutFor(step: PePhase9Step): number {
  if (step.kind === 'migration_replay' || step.kind === 'rls') return 30 * 60_000;
  if (step.id === 'full_pe_api_tests' || step.id === 'web_build') return 25 * 60_000;
  return 15 * 60_000;
}

function executeStep(
  step: PePhase9Step,
  input: PePhase9RunInput,
  outcomes: readonly PePhase9StepOutcome[],
): PePhase9StepOutcome {
  const { ports, integrity } = input;
  const skip = skippedOutcome(step, input);
  if (skip) return skip;
  if (step.disposablePostgresOnly && !ports.disposableAvailable()) {
    ports.log(`ENV_SKIP ${step.id}: docker unavailable and PE_PHASE_9_PGHOST unset`);
    return { stepId: step.id, exitCode: PE_PHASE_9_ENV_SKIP_EXIT, detail: 'docker unavailable' };
  }
  if (step.id === 'transport_absent') {
    ports.log(`RUN ${step.id} (in-process integrity)`);
    return {
      stepId: step.id,
      exitCode: integrity.ok ? 0 : 1,
      detail: integrity.ok ? 'clean' : integrity.blockers.join('; '),
    };
  }
  if (step.id === 'extended_loader_dry_run_matrix') {
    ports.log(`RUN ${step.id} (in-process extended map)`);
    return { stepId: step.id, ...extendedOutcome(outcomes) };
  }
  ports.log(`RUN ${step.id}: ${step.command}`);
  const result = ports.runShell(step, timeoutFor(step));
  ports.log(`  exit=${result.exitCode} durationMs=${result.durationMs}`);
  if (result.exitCode !== 0) {
    ports.log(`  detail_tail:\n${(result.detail ?? '').split('\n').slice(-30).join('\n')}`);
  }
  return {
    stepId: step.id,
    exitCode: result.exitCode,
    detail: result.detail,
    durationMs: result.durationMs,
  };
}

/** The caller supplies the selected catalog; no command is executed by this module itself. */
export function runPePhase9Steps(input: PePhase9RunInput): PePhase9StepOutcome[] {
  const outcomes: PePhase9StepOutcome[] = [];
  for (const step of input.steps) outcomes.push(executeStep(step, input, outcomes));
  return outcomes;
}

/** Preserve failure/base classification without checking out or running the base tree. */
export function pePhase9BaseComparisons(input: {
  steps: readonly PePhase9Step[];
  outcomes: PePhase9StepOutcome[];
  changedPaths: readonly string[];
  compareWithBase: boolean;
  injectedBaseResults: Record<string, number>;
}): PePhase9BaseComparison[] {
  const comparisons: PePhase9BaseComparison[] = [];
  if (input.compareWithBase) {
    for (const outcome of input.outcomes) {
      const step = input.steps.find((s) => s.id === outcome.stepId);
      if (
        !step?.required ||
        outcome.exitCode === 0 ||
        outcome.exitCode === PE_PHASE_9_ENV_SKIP_EXIT
      )
        continue;
      const baseExit = input.injectedBaseResults[step.id];
      comparisons.push({
        stepId: step.id,
        headExitCode: outcome.exitCode,
        baseExitCode: typeof baseExit === 'number' ? baseExit : null,
        touchesChangedRuntimePaths: stepTouchesChangedPaths(step, input.changedPaths),
      });
    }
  }
  for (const outcome of input.outcomes) {
    const step = input.steps.find((s) => s.id === outcome.stepId);
    if (
      !step?.required ||
      !step.disposablePostgresOnly ||
      outcome.exitCode !== PE_PHASE_9_ENV_SKIP_EXIT
    )
      continue;
    outcome.detail = `${outcome.detail ?? ''}; required disposable Postgres step skipped`.trim();
    comparisons.push({
      stepId: step.id,
      headExitCode: outcome.exitCode,
      baseExitCode: null,
      touchesChangedRuntimePaths: true,
    });
  }
  return comparisons;
}
