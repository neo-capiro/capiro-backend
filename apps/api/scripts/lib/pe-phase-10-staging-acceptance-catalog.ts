/**
 * Phase 10 pre-merge acceptance — step catalog (closeout).
 *
 * Operator reality (2026-07-31): sole shared app env is workflow env=dev /
 * ECS cluster `capiro-dev` (serves live app = prod path). There is no usable
 * separate staging cluster. Plan language “staging acceptance” means pre-merge
 * acceptance on that authorized live plane when Neo sets PE_CLOSEOUT_STAGING_OK
 * and (for mutate) PE_CLOSEOUT_STAGING_MUTATE.
 *
 * Live shared-environment mutate/deploy/migrate is NEVER implied by listing a
 * step here. Mutating steps require PE_CLOSEOUT_STAGING_MUTATE=yes AND a healthy
 * inventory; default path is discover + evidence only (read-only AWS).
 */

export type PePhase10StepKind =
  | 'auth'
  | 'git'
  | 'aws_inventory'
  | 'image'
  | 'local_preflight'
  | 'deploy'
  | 'migrate'
  | 'runtime_check'
  | 'security'
  | 'rollback'
  | 'integrity'
  | 'evidence';

export type PePhase10FailureClass =
  | 'ok'
  | 'branch_introduced'
  | 'base_proven'
  | 'env_blocked'
  | 'auth_refused'
  | 'operator_policy';

export interface PePhase10Step {
  id: string;
  kind: PePhase10StepKind;
  /** Human summary for records. */
  title: string;
  /**
   * Shell command when the orchestrator executes the step.
   * Empty string = pure/in-process evaluation only.
   */
  command: string;
  /**
   * Required for PE_PHASE_10_OK (full gate). Soft steps contribute warnings.
   * Env-blocked required steps refuse PE_PHASE_10_OK but allow a complete
   * blocked acceptance record (exit PE_PHASE_10_BLOCKED) only when the
   * authorized plane is actually unavailable — not when Neo authorized dev.
   */
  required: boolean;
  /**
   * When true, step may only run if inventory.healthyCompute &&
   * PE_CLOSEOUT_STAGING_MUTATE=yes. Default path must skip or block, never silent-pass.
   */
  requiresMutate?: boolean;
  /**
   * Safety rail: these never run even with mutate flag (email/LlamaParse/prod-os).
   */
  forbiddenAlways?: boolean;
  notes?: string;
}

/** Substrings forbidden on the tip product tree (same class as Phase 9). */
export const PE_PHASE_10_FORBIDDEN_PATH_SUBSTRINGS = [
  'pe-final-v2.part',
  'remaining-transfer-instructions',
  'program-elements-final-closeout-source.yml',
  'PLACEHOLDER_PART',
] as const;

/**
 * Authorized Phase 10 acceptance plane = sole live env (env=dev / capiro-dev).
 * Names match infra/cdk env=dev conventions + live ECS/ECR.
 *
 * Forbidden clusters are unintended/multi-account targets only — NOT capiro-dev.
 * Dead staging names must never become the expected plane.
 */
export const PE_PHASE_10_STAGING_EXPECTED = {
  /** Historical launcher env name; target is sole live env=dev. */
  planeName: 'sole-live-env-dev',
  workflowEnv: 'dev',
  accountId: '967807252336',
  region: 'us-east-1',
  ecsClusterName: 'capiro-dev',
  apiServiceName: 'capiro-dev-api',
  webServiceName: 'capiro-dev-web',
  apiTaskDefinitionFamily: 'capiro-dev-api',
  webTaskDefinitionFamily: 'capiro-dev-web',
  migrateTaskDefinitionFamily: 'capiro-dev-api-migrate',
  computeStackName: 'Capiro-dev-Compute',
  dataStackName: 'Capiro-dev-Data',
  networkStackName: 'Capiro-dev-Network',
  secretsStackName: 'Capiro-dev-Secrets',
  appHost: 'app.capiro.ai',
  ecrApiRepo: 'capiro/dev/api',
  ecrWebRepo: 'capiro/dev/web',
  ecrApiRepoCandidates: ['capiro/dev/api'] as const,
  ecrWebRepoCandidates: ['capiro/dev/web'] as const,
  /** Dead / unintended planes — must never receive PE Phase 10 deploy. */
  forbiddenEcsClusters: ['capiro-staging', 'capiro-prod-os-capiro'] as const,
  /**
   * CF Compute may be UPDATE_ROLLBACK_COMPLETE while out-of-band ECS is healthy.
   * Live health is ECS+services+Aurora; CF is advisory unless FORCE_CF_HEALTH=yes.
   */
  allowCfComputeRollbackWithLiveEcs: true,
} as const;

/**
 * Ordered acceptance steps. Plan worklist → concrete catalog.
 * Mutating deploy/migrate are required for PE_PHASE_10_OK but fail as env_blocked
 * when inventory proves compute/DB missing — never deploy to forbidden clusters.
 */
export const PE_PHASE_10_ACCEPTANCE_STEPS: readonly PePhase10Step[] = [
  {
    id: 'staging_auth_gate',
    kind: 'auth',
    title: 'Neo live-env authorization (PE_CLOSEOUT_STAGING_OK + sole env=dev)',
    command: '',
    required: true,
    notes:
      'PE_CLOSEOUT_STAGING_OK=yes after Neo auth text; target is workflow env=dev / capiro-dev characteristics, not dead staging',
  },
  {
    id: 'git_sha_record',
    kind: 'git',
    title: 'Record branch HEAD, origin tip, merge-base, main',
    command: '',
    required: true,
  },
  {
    id: 'aws_inventory_readonly',
    kind: 'aws_inventory',
    title: 'Read-only AWS inventory of Capiro-dev* + ECS + RDS (sole live plane)',
    command: 'bash apps/api/scripts/pe-phase-10-staging-probe.sh',
    required: true,
    notes: 'No Secrets Manager GetSecretValue; no ecs update-service in probe',
  },
  {
    id: 'image_digest_record',
    kind: 'image',
    title: 'Record ECR digests for branch SHA (or build/push under mutate)',
    command: '',
    required: true,
  },
  {
    id: 'transport_absent',
    kind: 'integrity',
    title: 'No transport/recovery artifacts on tip',
    command: 'pnpm -C apps/api exec tsx scripts/verify-pe-phase-10.ts --integrity-only',
    required: true,
  },
  {
    id: 'local_pe_preflight_k',
    kind: 'local_preflight',
    title: 'Local PE Phase K trust gate (not a live-env substitute)',
    command: 'pnpm -C apps/api run verify:pe-phase-k',
    required: true,
    notes: 'Discloses local-only; cannot satisfy Phase 10 exit gate alone',
  },
  {
    id: 'local_pe_phase9_preflight',
    kind: 'local_preflight',
    title: 'Local PE Phase 9 catalog+integrity (not a live-env substitute)',
    command: 'pnpm -C apps/api exec tsx scripts/verify-pe-phase-9.ts --integrity-only',
    required: true,
  },
  {
    id: 'email_automation_dark',
    kind: 'security',
    title: 'Email canaries and new automation remain dark (policy)',
    command: '',
    required: true,
    notes:
      'Prove no PE Phase 10 path enables send-pe-alert-emails / LlamaParse / derive --commit',
  },
  {
    id: 'staging_migrate_additive',
    kind: 'migrate',
    title: 'Apply additive PE migrations to sole-live Aurora (env=dev)',
    command: '',
    required: true,
    requiresMutate: true,
    notes:
      'run-task capiro-dev-api-migrate; never hand-edit _prisma_migrations; secrets stay in task def',
  },
  {
    id: 'staging_deploy_images',
    kind: 'deploy',
    title: 'Deploy branch images to sole-live ECS api+web (capiro-dev)',
    command: '',
    required: true,
    requiresMutate: true,
    notes: 'Forbidden clusters: capiro-staging, capiro-prod-os-capiro',
  },
  {
    id: 'inspect_only_loaders',
    kind: 'runtime_check',
    title: 'Inspect-only PE loaders against sole-live env',
    command: '',
    required: true,
    requiresMutate: false,
    notes: 'Needs reachable API/task; fails closed if missing',
  },
  {
    id: 'exact_sha_internal_promotion',
    kind: 'runtime_check',
    title: 'One exact-SHA internal promotion (sole-live env)',
    command: '',
    required: true,
    requiresMutate: true,
  },
  {
    id: 'identical_replay',
    kind: 'runtime_check',
    title: 'Identical replay proves zero duplicate canonical writes',
    command: '',
    required: true,
    requiresMutate: true,
  },
  {
    id: 'derive_chain_dry_run',
    kind: 'runtime_check',
    title: 'Derive-chain dry run (no commit)',
    command: '',
    required: true,
    requiresMutate: false,
  },
  {
    id: 'browser_smoke',
    kind: 'runtime_check',
    title: 'Browser/HTTP smoke against sole-live app host',
    command: '',
    required: true,
    notes: 'app.capiro.ai when healthy',
  },
  {
    id: 'rls_ethical_wall',
    kind: 'security',
    title: 'RLS and ethical-wall checks on live data plane',
    command: '',
    required: true,
    notes: 'No cross-tenant disclosure',
  },
  {
    id: 'alarm_test_events',
    kind: 'runtime_check',
    title: 'Alarm test events (synthetic-loud; not human-reviewed)',
    command: '',
    required: true,
    notes: 'SYNTHETIC markers required; never label humanReviewed',
  },
  {
    id: 'rollback_rehearsal',
    kind: 'rollback',
    title: 'Rollback procedure recorded against captured prior task defs',
    command: '',
    required: true,
  },
  {
    id: 'acceptance_record',
    kind: 'evidence',
    title: 'Write acceptance record under docs/verification',
    command: '',
    required: true,
  },
  {
    id: 'forbidden_production_actions',
    kind: 'security',
    title: 'Refuse secrets pull / LlamaParse / email send / unintended-cluster deploy',
    command: '',
    required: true,
    forbiddenAlways: true,
  },
] as const;

export function pePhase10StepIds(): string[] {
  return PE_PHASE_10_ACCEPTANCE_STEPS.map((s) => s.id);
}

export function pePhase10RequiredSteps(): PePhase10Step[] {
  return PE_PHASE_10_ACCEPTANCE_STEPS.filter((s) => s.required);
}

/** Plan exit-gate bullets for the acceptance record. */
export const PE_PHASE_10_EXIT_GATE_BULLETS = [
  'staging_acceptance_record_complete',
  'rollback_rehearsed',
  'no_critical_alarm',
  'no_cross_tenant_disclosure',
  'no_unexplained_data_mutation',
] as const;

export type PePhase10ExitGateBullet = (typeof PE_PHASE_10_EXIT_GATE_BULLETS)[number];
