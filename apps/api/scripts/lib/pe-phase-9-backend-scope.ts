/** Backend-only obligations projected from the retained full rehearsal catalog. */
import type { PePhase9Step } from './pe-phase-9-rehearsal-catalog.js';

export const PE_PHASE_9_BACKEND_EXCLUDED_STEP_IDS = [
  'web_typecheck',
  'web_build',
  'web_pe_tests',
] as const;

/** API typecheck resolves these retained packages through their built exports. */
const BACKEND_PREREQUISITE_STEPS: readonly PePhase9Step[] = [
  {
    id: 'meriv2_core_build',
    kind: 'build',
    title: 'packages/meriv2-core build before API typecheck',
    command: 'pnpm run build',
    cwd: 'packages/meriv2-core',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'defense_contracts_build',
    kind: 'build',
    title: 'packages/defense-contracts build before API typecheck',
    command: 'pnpm run build',
    cwd: 'packages/defense-contracts',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'defense_domain_build',
    kind: 'build',
    title: 'packages/defense-domain build before API typecheck',
    command: 'pnpm run build',
    cwd: 'packages/defense-domain',
    required: true,
    exitGate: 'zero_branch_failure',
  },
];

function backendStep(step: PePhase9Step): PePhase9Step {
  if (step.id === 'install_frozen') {
    return {
      ...step,
      title: 'Frozen install of root tooling and API/Workspace dependency closures',
      command:
        "pnpm --filter capiro --filter '@capiro/api...' --filter '@capiro/workspace...' install --frozen-lockfile --fail-if-no-match",
    };
  }
  if (step.id === 'prettier_pe_surface') {
    return {
      ...step,
      command: step.command.replace(" 'apps/web/src/pages/program-element/**/*.{ts,tsx}'", ''),
    };
  }
  if (step.id === 'git_diff_check') {
    return {
      ...step,
      command:
        step.command.replace(' apps/web/src/pages/program-element', '') +
        ' apps/api/scripts/lib/pe-phase-9-backend-scope.ts apps/api/scripts/lib/pe-phase-9-backend-scope.spec.ts apps/api/scripts/lib/pe-phase-9-runner.ts apps/api/scripts/lib/pe-phase-9-runner.spec.ts apps/api/scripts/lib/pe-phase-9-runner.test-support.ts apps/api/scripts/lib/pe-phase-9-evidence.ts',
    };
  }
  return step;
}

/** Include dependencies, never frontend reverse dependents; retain all backend gates. */
export function pePhase9BackendSteps(steps: readonly PePhase9Step[]): readonly PePhase9Step[] {
  const excluded = new Set<string>(PE_PHASE_9_BACKEND_EXCLUDED_STEP_IDS);
  return steps
    .filter((step) => !excluded.has(step.id))
    .map(backendStep)
    .flatMap((step) =>
      step.id === 'shared_build' ? [step, ...BACKEND_PREREQUISITE_STEPS] : [step],
    );
}
