/**
 * Phase 9 integrated release rehearsal — ordered step catalog.
 *
 * Closeout plan: prove the exact final branch as one release by running install,
 * prisma, typechecks, PE phase A–K gates, targeted PE suites, prettier, git
 * hygiene, disposable migration replay, and the extended PE proof table.
 *
 * Steps are **named contracts**. The shell/tsx orchestrators execute them;
 * unit tests assert catalog honesty (ids unique, required flags, no secrets).
 */

export type PePhase9StepKind =
  | 'install'
  | 'prisma'
  | 'typecheck'
  | 'build'
  | 'pe_gate'
  | 'pe_trust'
  | 'pe_extended'
  | 'web'
  | 'hygiene'
  | 'migration_replay'
  | 'rls'
  | 'integrity';

export type PePhase9FailureClass =
  /** Fails on HEAD and not on exact merge-base → blocks release. */
  | 'branch_introduced'
  /** Fails on HEAD and on exact merge-base on unchanged runtime paths → record only. */
  | 'base_proven'
  /** Environment / tooling unavailable (docker down, etc.) — document, may block if required. */
  | 'environment'
  | 'ok';

export interface PePhase9Step {
  /** Stable id used in evidence JSON and gate logs. */
  id: string;
  kind: PePhase9StepKind;
  /** Human label for evidence / work-log. */
  title: string;
  /**
   * Shell command fragments relative to monorepo root unless `cwd` is set.
   * Exact tokens — never wildcards for PE gate scripts.
   */
  command: string;
  /** Optional working directory relative to repo root. */
  cwd?: string;
  /**
   * When true, a non-zero exit blocks PE_PHASE_9_OK.
   * Soft steps still run and are recorded.
   */
  required: boolean;
  /** Plan exit-gate bullet this step supports. */
  exitGate?: string;
  /**
   * When true, step may need disposable Postgres only (never shared/prod).
   */
  disposablePostgresOnly?: boolean;
  /**
   * Extended PE proofs (dry-run loader, exact-SHA, outbox, SAM, data-issue, CRM, coverage).
   */
  extendedProof?: boolean;
}

/** Forbidden path substrings that must not appear on the release branch tip. */
export const PE_PHASE_9_FORBIDDEN_PATH_SUBSTRINGS = [
  'pe-final-v2.part',
  'program-elements-final-patch.part',
  'remaining-transfer-instructions',
  'program-elements-final-closeout-source.yml',
  'pe-trust-phase-d-source',
  'PLACEHOLDER',
] as const;

/**
 * Ordered integrated rehearsal steps matching the Phase 9 plan work list.
 * Commands use pnpm/tsx with exact package script names already registered on the branch.
 */
export const PE_PHASE_9_REHEARSAL_STEPS: readonly PePhase9Step[] = [
  {
    id: 'install_frozen',
    kind: 'install',
    title: 'pnpm install --frozen-lockfile',
    command: 'pnpm install --frozen-lockfile',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'prisma_validate',
    kind: 'prisma',
    title: 'Prisma validate',
    command: 'pnpm exec prisma validate',
    cwd: 'apps/api',
    required: true,
    exitGate: 'no_migration_drift',
  },
  {
    id: 'prisma_generate',
    kind: 'prisma',
    title: 'Prisma generate',
    command: 'pnpm exec prisma generate',
    cwd: 'apps/api',
    required: true,
    exitGate: 'no_migration_drift',
  },
  {
    id: 'shared_build',
    kind: 'build',
    title: 'packages/shared build',
    command: 'pnpm run build',
    cwd: 'packages/shared',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'shared_typecheck',
    kind: 'typecheck',
    title: 'packages/shared typecheck',
    command: 'pnpm run typecheck',
    cwd: 'packages/shared',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'api_typecheck',
    kind: 'typecheck',
    title: 'API typecheck (includes PE phase-a tsconfigs via package script)',
    command: 'pnpm run typecheck',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'workspace_typecheck',
    kind: 'typecheck',
    title: 'Workspace typecheck (after local prisma generate + auth package build)',
    command:
      'pnpm run prisma:generate && pnpm --filter @capiro/auth run build && pnpm run typecheck',
    cwd: 'apps/workspace',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'web_typecheck',
    kind: 'typecheck',
    title: 'Web typecheck',
    command: 'pnpm run typecheck',
    cwd: 'apps/web',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'web_build',
    kind: 'build',
    title: 'Web production build',
    command: 'pnpm run build',
    cwd: 'apps/web',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'typecheck_pe_scripts',
    kind: 'typecheck',
    title: 'PE production-script typecheck',
    command: 'pnpm run typecheck:pe-scripts',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_a',
    kind: 'pe_gate',
    title: 'Phase A safety',
    command: 'pnpm run verify:pe-phase-a',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_b',
    kind: 'pe_gate',
    title: 'Phase B ingestion/units',
    command: 'pnpm run verify:pe-phase-b',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_c',
    kind: 'pe_gate',
    title: 'Phase C read/watch/RLS unit',
    command: 'pnpm run verify:pe-phase-c',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_d',
    kind: 'pe_gate',
    title: 'Phase D canonical write / outbox',
    command: 'pnpm run verify:pe-phase-d',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_e',
    kind: 'pe_gate',
    title: 'Phase E exact-SHA loaders',
    command: 'pnpm run verify:pe-phase-e',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
    extendedProof: true,
  },
  {
    id: 'verify_pe_phase_f',
    kind: 'pe_gate',
    title: 'Phase F SAM / watermark / partial-window',
    command: 'pnpm run verify:pe-phase-f',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
    extendedProof: true,
  },
  {
    id: 'verify_pe_phase_g',
    kind: 'pe_gate',
    title: 'Phase G funding claim / track-aware read',
    command: 'pnpm run verify:pe-phase-g',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'verify_pe_phase_i',
    kind: 'pe_gate',
    title: 'Phase I data-issue + CRM policy',
    command: 'pnpm run verify:pe-phase-i',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
    extendedProof: true,
  },
  {
    id: 'verify_pe_phase_j',
    kind: 'pe_gate',
    title: 'Phase J grounding / coverage honesty',
    command: 'pnpm run verify:pe-phase-j',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
    extendedProof: true,
  },
  {
    id: 'verify_pe_phase_k',
    kind: 'pe_trust',
    title: 'Phase K permanent trust gates',
    command: 'pnpm run verify:pe-phase-k',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'test_pe_trust',
    kind: 'pe_trust',
    title: 'test:pe-trust',
    command: 'pnpm run test:pe-trust',
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'full_pe_api_tests',
    kind: 'pe_extended',
    title:
      'Full PE API jest surface (program-element + PE scripts + closeout CRM personnel services; not unrelated acq extractors)',
    command:
      "pnpm exec jest --runInBand --forceExit --testPathPattern='src/program-element|scripts/lib/pe-|scripts/sam-opportunity|scripts/sync-sam-opportunities|scripts/drain-pe|scripts/backfill-pe|scripts/send-pe|src/acquisition-personnel/contact-use.policy|src/acquisition-personnel/acquisition-personnel-read.service|src/acquisition-personnel/acquisition-personnel.controller'",
    cwd: 'apps/api',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'workspace_pe_tests',
    kind: 'pe_extended',
    title: 'Workspace PE grounding helpers (domain-grounding; PE resolver unit after generate)',
    command:
      'pnpm run prisma:generate && pnpm --filter @capiro/auth run build && pnpm exec jest --runInBand --forceExit --testPathPattern=domain-grounding.helpers.spec',
    cwd: 'apps/workspace',
    required: true,
    exitGate: 'zero_branch_failure',
    extendedProof: true,
  },
  {
    id: 'web_pe_tests',
    kind: 'web',
    title: 'Targeted Program Element web vitest',
    command: 'pnpm exec vitest run --testTimeout=20000 --hookTimeout=20000 src/pages/program-element',
    cwd: 'apps/web',
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'prettier_pe_surface',
    kind: 'hygiene',
    title: 'Prettier check on PE-touched packages (check only; soft)',
    // Globs only in prettier path args (hygiene), never in pe_gate scripts.
    command:
      "pnpm exec prettier --check 'apps/api/src/program-element/**/*.{ts,tsx}' 'apps/api/scripts/lib/pe-*.ts' 'apps/api/scripts/verify-pe-*.ts' 'apps/web/src/pages/program-element/**/*.{ts,tsx}' 'packages/shared/src/**/*.{ts,tsx}'",
    required: false,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'git_diff_check',
    kind: 'hygiene',
    title: 'git diff --check on PE product runtime paths introduced by closeout',
    command:
      "git diff --check origin/main...HEAD -- apps/api/src/program-element apps/api/scripts/lib/pe-phase-9-rehearsal-catalog.ts apps/api/scripts/lib/pe-phase-9-rehearsal.ts apps/api/scripts/lib/pe-phase-9-rehearsal.spec.ts apps/api/scripts/verify-pe-phase-9.ts apps/api/scripts/pe-phase-9-migration-replay.sh apps/web/src/pages/program-element packages/shared/src/funding-claim.ts packages/shared/src/defense-budget-line.ts packages/shared/src/pe-source-coverage.ts apps/workspace/src/generation/domain-grounding.helpers.ts apps/workspace/src/generation/domain-grounding.helpers.spec.ts",
    required: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'transport_absent',
    kind: 'integrity',
    title: 'No temporary workflows / patch payloads / recovery artifacts on tip',
    command: 'pnpm -C apps/api exec tsx scripts/verify-pe-phase-9.ts --integrity-only',
    required: true,
    exitGate: 'no_transport_artifacts',
  },
  {
    id: 'migration_guards_offline',
    kind: 'migration_replay',
    title: 'Migration guards + prisma validate/generate',
    // pnpm run strips a lone `--`; pass flags directly to tsx.
    command: 'pnpm exec tsx scripts/verify-pe-migration-guards.ts --validate-generate',
    cwd: 'apps/api',
    required: true,
    exitGate: 'no_migration_drift',
  },
  {
    id: 'clean_upgrade_migrate_replay',
    kind: 'migration_replay',
    title: 'Clean + production-equivalent upgrade migrate replay (disposable Postgres)',
    command: 'bash apps/api/scripts/pe-phase-9-migration-replay.sh',
    required: true,
    disposablePostgresOnly: true,
    exitGate: 'no_migration_drift',
  },
  {
    id: 'rls_phase_c_rehearsal',
    kind: 'rls',
    title: 'Phase C RLS application-role rehearsal (disposable Postgres)',
    command: 'bash apps/api/scripts/pe-phase-c-rls-rehearsal.sh',
    required: false,
    disposablePostgresOnly: true,
    exitGate: 'zero_branch_failure',
  },
  {
    id: 'extended_loader_dry_run_matrix',
    kind: 'pe_extended',
    title: 'Dry-run loader + exact-SHA + outbox + SAM + data-issue + CRM + coverage (via A–K proofs)',
    command: 'pnpm -C apps/api exec tsx scripts/verify-pe-phase-9.ts --extended-proofs-only',
    required: true,
    extendedProof: true,
    exitGate: 'zero_branch_failure',
  },
] as const;

export function pePhase9StepIds(): string[] {
  return PE_PHASE_9_REHEARSAL_STEPS.map((s) => s.id);
}

export function pePhase9RequiredSteps(): PePhase9Step[] {
  return PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.required);
}

export function pePhase9ExtendedProofSteps(): PePhase9Step[] {
  return PE_PHASE_9_REHEARSAL_STEPS.filter((s) => s.extendedProof);
}

/** Extended PE proofs required by the Phase 9 plan "Also run" list. */
export const PE_PHASE_9_EXTENDED_PROOF_IDS = [
  'dry_run_loader_manifests',
  'exact_sha_replay',
  'outbox_retry',
  'sam_partial_window',
  'data_issue_non_mutation',
  'crm_policy_matrix',
  'coverage_honesty_snapshots',
] as const;

export type PePhase9ExtendedProofId = (typeof PE_PHASE_9_EXTENDED_PROOF_IDS)[number];

/**
 * Maps plan "Also run" proofs onto the concrete verify scripts that own them.
 * Evidence must cite these — never invent parallel dark loaders.
 */
export const PE_PHASE_9_EXTENDED_PROOF_OWNERS: Record<
  PePhase9ExtendedProofId,
  { ownerStepIds: string[]; description: string }
> = {
  dry_run_loader_manifests: {
    ownerStepIds: ['verify_pe_phase_e', 'verify_pe_phase_b'],
    description: 'Exact-SHA loader contract + defense-budget dry-run/commit mode fixtures',
  },
  exact_sha_replay: {
    ownerStepIds: ['verify_pe_phase_e'],
    description: 'verify:pe-phase-e + pe-exact-sha-loader-contract (identical SHA atomicity)',
  },
  outbox_retry: {
    ownerStepIds: ['verify_pe_phase_d'],
    description: 'program-element-change-outbox + drain-pe-change-outbox retry durability',
  },
  sam_partial_window: {
    ownerStepIds: ['verify_pe_phase_f'],
    description: 'SAM matcher + sync-run watermark incomplete/partial window fail-closed',
  },
  data_issue_non_mutation: {
    ownerStepIds: ['verify_pe_phase_i'],
    description: 'Data issue resolve must not mutate canonical PE year markers',
  },
  crm_policy_matrix: {
    ownerStepIds: ['verify_pe_phase_i'],
    description: 'contact-use.policy + linkCrmContact blocked/allowed matrix',
  },
  coverage_honesty_snapshots: {
    ownerStepIds: ['verify_pe_phase_j', 'workspace_pe_tests'],
    description: 'defense-budget grounding + source coverage fail-closed & Workspace domain-grounding helpers',
  },
};
