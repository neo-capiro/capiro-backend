/**
 * Phase 9 pure interpreters — failure classification + integrity checks.
 * Unit-tested without shell execution.
 */

import {
  PE_PHASE_9_EXTENDED_PROOF_IDS,
  PE_PHASE_9_EXTENDED_PROOF_OWNERS,
  PE_PHASE_9_FORBIDDEN_PATH_SUBSTRINGS,
  pePhase9StepsForScope,
  type PePhase9FailureClass,
  type PePhase9Scope,
  type PePhase9Step,
} from './pe-phase-9-rehearsal-catalog.js';

export interface PePhase9StepOutcome {
  stepId: string;
  exitCode: number;
  /** Truncated stdout/stderr / note for evidence. */
  detail?: string;
  durationMs?: number;
}

export interface PePhase9BaseComparison {
  stepId: string;
  headExitCode: number;
  baseExitCode: number | null;
  /** True when the step's runtime paths are present in origin/main...HEAD diff. */
  touchesChangedRuntimePaths: boolean;
}

export interface PePhase9IntegrityInput {
  /** Relative paths present on the tip tree (or in main...HEAD name-only diff). */
  tipPaths: readonly string[];
  /** Relative paths changed vs main (name-only). */
  changedPaths?: readonly string[];
}

export interface PePhase9IntegrityResult {
  ok: boolean;
  blockers: string[];
  forbiddenHits: string[];
}

export interface PePhase9GateResult {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  classifications: Array<{
    stepId: string;
    classification: PePhase9FailureClass;
    reason: string;
  }>;
}

function backendCatalogErrors(steps: readonly PePhase9Step[]): string[] {
  const errors: string[] = [];
  const expectedSteps = pePhase9StepsForScope('backend');
  const expected = new Map(expectedSteps.map((step) => [step.id, step]));
  if (steps.some((step, index) => step.id !== expectedSteps[index]?.id)) {
    errors.push('backend step order differs from scoped contract');
  }
  const ids = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    const canonical = expected.get(step.id);
    if (!canonical) {
      errors.push(`unexpected backend step: ${step.id}`);
    } else if (JSON.stringify(step) !== JSON.stringify(canonical)) {
      errors.push(`backend step differs from scoped contract: ${step.id}`);
    }
    if (/apps\/web|@capiro\/web|apps\/onboard-web|@capiro\/onboard-web/.test(step.command)) {
      errors.push(`backend command contains frontend dependency: ${step.id}`);
    }
    if (step.cwd?.startsWith('apps/web') || step.cwd?.startsWith('apps/onboard-web')) {
      errors.push(`backend working directory is a frontend: ${step.id}`);
    }
  }
  for (const id of expected.keys()) {
    if (!ids.has(id)) errors.push(`missing backend step: ${id}`);
  }
  return errors;
}

/** Assert catalog invariants used by the permanent harness. */
export function assertPePhase9CatalogHonest(
  scope: PePhase9Scope = 'full',
  steps: readonly PePhase9Step[] = pePhase9StepsForScope(scope),
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || !/^[a-z0-9_]+$/.test(step.id)) {
      errors.push(`invalid step id: ${step.id}`);
    }
    if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.command.trim()) errors.push(`${step.id}: empty command`);
    if (/\*/.test(step.command) && step.kind === 'pe_gate') {
      errors.push(`${step.id}: pe_gate command must not use shell globs`);
    }
    // Never embed secrets
    if (/(password|secret|ghp_|AKIA)/i.test(step.command)) {
      errors.push(`${step.id}: command looks like it embeds a secret`);
    }
  }

  // Required plan pillars must exist
  const requiredKinds: Array<PePhase9Step['kind']> = [
    'install',
    'prisma',
    'typecheck',
    'pe_gate',
    'pe_trust',
    'migration_replay',
    'integrity',
  ];
  for (const k of requiredKinds) {
    if (!steps.some((s) => s.kind === k && s.required)) {
      errors.push(`missing required step kind: ${k}`);
    }
  }

  // A–K gate coverage (H is web; plan lists A–K; we use a,b,c,d,e,f,g,i,j,k + web)
  for (const letter of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j', 'k'] as const) {
    const id = `verify_pe_phase_${letter}`;
    if (!ids.has(id) && letter !== ('h' as typeof letter)) {
      // phase h is web experience — covered by web_pe_tests
      if (!ids.has(id)) errors.push(`missing PE phase gate step: ${id}`);
    }
  }
  if (scope === 'full' && !ids.has('web_pe_tests')) {
    errors.push('missing web_pe_tests (Phase H surface)');
  }
  if (!ids.has('clean_upgrade_migrate_replay')) {
    errors.push('missing clean_upgrade_migrate_replay');
  }

  for (const proofId of PE_PHASE_9_EXTENDED_PROOF_IDS) {
    const owner = PE_PHASE_9_EXTENDED_PROOF_OWNERS[proofId];
    if (!owner?.ownerStepIds?.length) {
      errors.push(`extended proof ${proofId} has no owners`);
      continue;
    }
    for (const o of owner.ownerStepIds) {
      if (!ids.has(o)) errors.push(`extended proof ${proofId} owns missing step ${o}`);
    }
  }

  if (scope === 'backend') {
    errors.push(...backendCatalogErrors(steps));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Classify a failed (or passed) step against optional merge-base results.
 * Branch-introduced failures block the release. Base-proven failures on
 * unchanged paths do not.
 */
export function classifyPePhase9Failure(args: PePhase9BaseComparison): {
  classification: PePhase9FailureClass;
  reason: string;
} {
  const { stepId, headExitCode, baseExitCode, touchesChangedRuntimePaths } = args;
  if (headExitCode === 0) {
    return { classification: 'ok', reason: `${stepId} passed on HEAD` };
  }
  if (baseExitCode === null || baseExitCode === undefined) {
    // No base sample — treat as branch risk (fail closed for required gates)
    return {
      classification: 'branch_introduced',
      reason: `${stepId} failed on HEAD (exit ${headExitCode}); base comparison missing — fail closed`,
    };
  }
  if (baseExitCode === 0) {
    return {
      classification: 'branch_introduced',
      reason: `${stepId} failed on HEAD (exit ${headExitCode}) but passed on merge-base — branch-introduced`,
    };
  }
  // Failed on both base and head
  if (!touchesChangedRuntimePaths) {
    return {
      classification: 'base_proven',
      reason: `${stepId} failed on HEAD and merge-base; runtime paths unchanged vs main — base-proven`,
    };
  }
  return {
    classification: 'branch_introduced',
    reason: `${stepId} failed on HEAD and base but touches changed runtime paths — treat as branch-introduced until disproven`,
  };
}

export function evaluatePePhase9Integrity(input: PePhase9IntegrityInput): PePhase9IntegrityResult {
  const blockers: string[] = [];
  const forbiddenHits: string[] = [];
  const pool = [...input.tipPaths, ...(input.changedPaths ?? [])];
  for (const p of pool) {
    const norm = p.replace(/\\/g, '/');
    for (const frag of PE_PHASE_9_FORBIDDEN_PATH_SUBSTRINGS) {
      if (norm.includes(frag)) {
        forbiddenHits.push(norm);
        blockers.push(`forbidden transport/recovery path present: ${norm} (matched ${frag})`);
      }
    }
  }
  // Duplicate hits ok — unique blockers
  const uniq = [...new Set(blockers)];
  return { ok: uniq.length === 0, blockers: uniq, forbiddenHits: [...new Set(forbiddenHits)] };
}

/**
 * Collapse per-step outcomes + base comparisons into the Phase 9 gate decision.
 * Soft (required=false) failures become warnings unless classified branch_introduced
 * with touchesChangedRuntimePaths (still warning for soft).
 */
export function evaluatePePhase9Gate(args: {
  scope?: PePhase9Scope;
  outcomes: readonly PePhase9StepOutcome[];
  baseComparisons?: readonly PePhase9BaseComparison[];
  integrity: PePhase9IntegrityResult;
  catalogErrors?: string[];
}): PePhase9GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const classifications: PePhase9GateResult['classifications'] = [];
  const scope = args.scope ?? 'full';
  const steps = pePhase9StepsForScope(scope);

  if (scope === 'backend') {
    for (const error of assertPePhase9CatalogHonest(scope, steps).errors) {
      blockers.push(`catalog: ${error}`);
    }
  }

  if (args.catalogErrors?.length) {
    for (const e of args.catalogErrors) blockers.push(`catalog: ${e}`);
  }
  if (!args.integrity.ok) {
    blockers.push(...args.integrity.blockers);
  }

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const baseById = new Map((args.baseComparisons ?? []).map((b) => [b.stepId, b]));
  if (scope === 'backend') blockers.push(...backendOutcomeErrors(args.outcomes));

  for (const outcome of args.outcomes) {
    if (scope === 'backend' && !validExitCode(outcome.exitCode)) continue;
    const step = stepById.get(outcome.stepId);
    if (!step) {
      if (scope === 'backend') blockers.push(`unknown step outcome: ${outcome.stepId}`);
      else warnings.push(`unknown step outcome: ${outcome.stepId}`);
      continue;
    }

    appendPePhase9Outcome(outcome, step, baseById.get(outcome.stepId), {
      blockers,
      warnings,
      classifications,
    });
  }

  // Legacy full callers may pass integrity-only/extended-only subsets. An
  // explicit backend gate always represents the entire selected rehearsal.
  const ranGates = args.outcomes.some((o) => stepById.get(o.stepId)?.kind === 'pe_gate');
  if (scope === 'backend' || ranGates) {
    for (const step of steps) {
      if (!step.required) continue;
      // Disposable postgres steps may be recorded as environment skip by orchestrator
      // (exitCode special); still require an outcome row.
      if (!args.outcomes.some((o) => o.stepId === step.id)) {
        blockers.push(`required step not executed: ${step.id}`);
      }
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    classifications,
  };
}

function validExitCode(exitCode: number): boolean {
  return Number.isInteger(exitCode) && exitCode >= 0;
}

function backendOutcomeErrors(outcomes: readonly PePhase9StepOutcome[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (seen.has(outcome.stepId)) errors.push(`duplicate step outcome: ${outcome.stepId}`);
    seen.add(outcome.stepId);
    if (!validExitCode(outcome.exitCode)) errors.push(`invalid step exit code: ${outcome.stepId}`);
  }
  return errors;
}

function appendPePhase9Outcome(
  outcome: PePhase9StepOutcome,
  step: PePhase9Step,
  base: PePhase9BaseComparison | undefined,
  result: Pick<PePhase9GateResult, 'blockers' | 'warnings' | 'classifications'>,
): void {
  const { blockers, warnings, classifications } = result;
  if (outcome.exitCode === PE_PHASE_9_ENV_SKIP_EXIT) {
    const envClass = classifyEnvironmentSkip(outcome.stepId, outcome.detail ?? 'environment skip');
    classifications.push({ stepId: outcome.stepId, ...envClass });
    if (step.required) blockers.push(`ENV ${envClass.reason}`);
    else warnings.push(`soft-env ${envClass.reason}`);
    return;
  }

  const classified = classifyPePhase9Failure({
    stepId: outcome.stepId,
    headExitCode: outcome.exitCode,
    baseExitCode: base?.baseExitCode ?? null,
    touchesChangedRuntimePaths: base?.touchesChangedRuntimePaths ?? true,
  });
  classifications.push({ stepId: outcome.stepId, ...classified });
  if (outcome.exitCode === 0) return;
  if (!step.required) {
    warnings.push(`soft-fail ${classified.reason}`);
  } else if (classified.classification === 'base_proven') {
    warnings.push(`BASE_PROVEN ${classified.reason}`);
  } else if (classified.classification === 'environment') {
    blockers.push(`ENV ${classified.reason}`);
  } else {
    blockers.push(classified.reason);
    if (outcome.detail) blockers.push(`  detail: ${outcome.detail.slice(0, 400)}`);
  }
}

/**
 * Compute whether a step likely touches changed runtime paths given a path list.
 * Pure heuristic for base-proven classification inputs.
 */
export function stepTouchesChangedPaths(
  step: PePhase9Step,
  changedPaths: readonly string[],
): boolean {
  const norms = changedPaths.map((p) => p.replace(/\\/g, '/'));
  const needles: string[] = [];
  if (step.cwd) needles.push(step.cwd.replace(/\\/g, '/'));
  // Map common pe gates to trees
  if (step.kind === 'pe_gate' || step.kind === 'pe_trust' || step.kind === 'pe_extended') {
    needles.push(
      'apps/api/src/program-element',
      'apps/api/src/acquisition-personnel',
      'apps/api/scripts',
      'packages/shared/src',
    );
  }
  if (step.kind === 'web') needles.push('apps/web/src/pages/program-element');
  if (step.kind === 'migration_replay' || step.kind === 'prisma') {
    needles.push('apps/api/prisma');
  }
  if (needles.length === 0) {
    return norms.length > 0; // avoid false base-proven for unknown
  }
  return needles.some((n) => norms.some((p) => p === n || p.startsWith(n + '/') || p.includes(n)));
}

/** Special exit code used when disposable Postgres / docker is unavailable. */
export const PE_PHASE_9_ENV_SKIP_EXIT = 75;

export function classifyEnvironmentSkip(
  stepId: string,
  detail: string,
): {
  classification: PePhase9FailureClass;
  reason: string;
} {
  return {
    classification: 'environment',
    reason: `${stepId} skipped — disposable environment unavailable: ${detail}`,
  };
}
