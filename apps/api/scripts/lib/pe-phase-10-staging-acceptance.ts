/**
 * Phase 10 pre-merge acceptance — pure evaluators (unit-tested, no AWS IO).
 *
 * PE_PHASE_10_OK requires every required step satisfied on the authorized sole
 * live plane (env=dev / capiro-dev). Missing compute/DB is not a silent pass:
 * emit PE_PHASE_10_BLOCKED with a complete honest acceptance record.
 *
 * Exit-gate bullets that only have deferred/env_blocked proofs are unsatisfied.
 * BLOCKED must NOT paint all exitGate bullets as [x].
 */

import {
  PE_PHASE_10_ACCEPTANCE_STEPS,
  PE_PHASE_10_EXIT_GATE_BULLETS,
  PE_PHASE_10_FORBIDDEN_PATH_SUBSTRINGS,
  PE_PHASE_10_STAGING_EXPECTED,
  type PePhase10ExitGateBullet,
  type PePhase10FailureClass,
  type PePhase10Step,
  type PePhase10StepKind,
} from './pe-phase-10-staging-acceptance-catalog.js';

/** Process exit when acceptance is complete but plane is not shippable. */
export const PE_PHASE_10_BLOCKED_EXIT = 78;
/** Optional env skip for soft steps (mirrors Phase 9 soft skip). */
export const PE_PHASE_10_ENV_SKIP_EXIT = 75;

export interface PePhase10GitEvidence {
  headSha: string;
  originHeadSha: string | null;
  mainSha: string | null;
  mergeBaseSha: string | null;
  branch: string;
}

export interface PePhase10ImageDigestRecord {
  repo: string;
  tag: string | null;
  digest: string | null;
  pushedAt: string | null;
  present: boolean;
  note?: string;
}

export interface PePhase10PriorTaskDef {
  family: string;
  revision: number | null;
  arn: string | null;
  image: string | null;
}

export interface PePhase10Inventory {
  accountId: string | null;
  region: string;
  probeOk: boolean;
  ecsClusterExists: boolean;
  ecsClusterStatus: string | null;
  apiServiceExists: boolean;
  webServiceExists: boolean;
  computeStackStatus: string | null;
  dataStackStatus: string | null;
  networkStackStatus: string | null;
  auroraClusterLive: boolean;
  auroraClusterId: string | null;
  forbiddenClusterPresent: boolean;
  healthyCompute: boolean;
  blockers: string[];
  warnings: string[];
  capturedAt: string;
  rawNotes?: string[];
  priorTaskDefs?: PePhase10PriorTaskDef[];
}

export interface PePhase10StepOutcome {
  stepId: string;
  exitCode: number;
  detail?: string;
  classification?: PePhase10FailureClass;
  durationMs?: number;
}

export interface PePhase10IntegrityInput {
  tipPaths: readonly string[];
  changedPaths?: readonly string[];
}

export interface PePhase10IntegrityResult {
  ok: boolean;
  blockers: string[];
  forbiddenHits: string[];
}

export interface PePhase10ExitGateEvaluation {
  bullet: PePhase10ExitGateBullet;
  satisfied: boolean;
  reason: string;
}

export interface PePhase10GateResult {
  ok: boolean;
  blockedComplete: boolean;
  blockers: string[];
  warnings: string[];
  classifications: Array<{
    stepId: string;
    classification: PePhase10FailureClass;
    reason: string;
  }>;
  exitGate: PePhase10ExitGateEvaluation[];
  marker: 'PE_PHASE_10_OK' | 'PE_PHASE_10_BLOCKED' | 'PE_PHASE_10_FAIL';
}

export function assertPePhase10CatalogHonest(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (!step.id || !/^[a-z0-9_]+$/.test(step.id)) {
      errors.push(`invalid step id: ${step.id}`);
    }
    if (ids.has(step.id)) errors.push(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (step.forbiddenAlways && step.requiresMutate) {
      errors.push(`${step.id}: forbiddenAlways steps must not require mutate path`);
    }
    if (step.command && /(password|secret|ghp_|AKIA)/i.test(step.command)) {
      errors.push(`${step.id}: command looks like it embeds a secret`);
    }
    if (step.command.includes('*') && ['local_preflight', 'aws_inventory'].includes(step.kind)) {
      errors.push(`${step.id}: command must not use shell globs`);
    }
  }

  const requiredKinds: PePhase10StepKind[] = [
    'auth',
    'git',
    'aws_inventory',
    'image',
    'local_preflight',
    'deploy',
    'migrate',
    'runtime_check',
    'security',
    'rollback',
    'evidence',
  ];
  for (const k of requiredKinds) {
    if (!PE_PHASE_10_ACCEPTANCE_STEPS.some((s) => s.kind === k && s.required)) {
      errors.push(`missing required step kind: ${k}`);
    }
  }

  for (const must of [
    'staging_auth_gate',
    'aws_inventory_readonly',
    'staging_migrate_additive',
    'staging_deploy_images',
    'rollback_rehearsal',
    'acceptance_record',
    'forbidden_production_actions',
  ]) {
    if (!ids.has(must)) errors.push(`missing required step: ${must}`);
  }

  for (const s of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (s.requiresMutate && !s.required) {
      errors.push(`${s.id}: mutate steps must be required (fail closed if skipped)`);
    }
  }

  if (PE_PHASE_10_STAGING_EXPECTED.ecsClusterName !== 'capiro-dev') {
    errors.push('expected ECS cluster must be capiro-dev (sole live plane)');
  }
  if (PE_PHASE_10_STAGING_EXPECTED.workflowEnv !== 'dev') {
    errors.push('workflowEnv must be dev');
  }
  if ((PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters as readonly string[]).includes('capiro-dev')) {
    errors.push('capiro-dev must NOT be forbidden — it is the authorized sole live plane');
  }
  for (const mustForbid of ['capiro-staging', 'capiro-prod-os-capiro'] as const) {
    if (!(PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters as readonly string[]).includes(mustForbid)) {
      errors.push(`${mustForbid} must remain a forbidden unintended deploy target`);
    }
  }
  if (PE_PHASE_10_STAGING_EXPECTED.appHost !== 'app.capiro.ai') {
    errors.push('appHost must be app.capiro.ai for sole live plane');
  }

  return { ok: errors.length === 0, errors };
}

export function evaluatePePhase10Integrity(
  input: PePhase10IntegrityInput,
): PePhase10IntegrityResult {
  const blockers: string[] = [];
  const forbiddenHits: string[] = [];
  const pool = [...input.tipPaths, ...(input.changedPaths ?? [])];
  for (const p of pool) {
    const norm = p.replace(/\\/g, '/');
    for (const frag of PE_PHASE_10_FORBIDDEN_PATH_SUBSTRINGS) {
      if (norm.includes(frag)) {
        forbiddenHits.push(norm);
        blockers.push(`forbidden transport/recovery path present: ${norm} (matched ${frag})`);
      }
    }
  }
  const uniq = [...new Set(blockers)];
  return { ok: uniq.length === 0, blockers: uniq, forbiddenHits: [...new Set(forbiddenHits)] };
}

/** Auth: Neo must set PE_CLOSEOUT_STAGING_OK=yes explicitly. */
export function evaluateStagingAuth(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  reason: string;
} {
  const v = (env.PE_CLOSEOUT_STAGING_OK ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') {
    return {
      ok: true,
      reason:
        'PE_CLOSEOUT_STAGING_OK authorized (sole live env=dev / capiro-dev; launcher name historical)',
    };
  }
  return {
    ok: false,
    reason: 'PE_CLOSEOUT_STAGING_OK not set to yes — refuse Phase 10 live-env work',
  };
}

/** Mutate flag is separate from OK (default discover-only). */
export function evaluateStagingMutateAllowed(
  env: NodeJS.ProcessEnv = process.env,
  inventory?: Pick<PePhase10Inventory, 'healthyCompute'>,
): { ok: boolean; reason: string } {
  const auth = evaluateStagingAuth(env);
  if (!auth.ok) return { ok: false, reason: auth.reason };
  const m = (env.PE_CLOSEOUT_STAGING_MUTATE ?? '').trim().toLowerCase();
  if (!(m === 'yes' || m === 'true' || m === '1')) {
    return {
      ok: false,
      reason:
        'PE_CLOSEOUT_STAGING_MUTATE not yes — discover/inventory only (no migrate/deploy/promote)',
    };
  }
  if (inventory && !inventory.healthyCompute) {
    return {
      ok: false,
      reason: 'authorized plane inventory not healthyCompute — mutate refused even with MUTATE=yes',
    };
  }
  return { ok: true, reason: 'mutate authorized and inventory healthy on sole live plane' };
}

/**
 * Collapse CF + ECS + RDS probe facts into inventory health.
 * Live health = correct account + ECS cluster ACTIVE + api/web services + live aurora.
 * CF Compute ROLLBACK alone does not fail when allowCfComputeRollbackWithLiveEcs.
 */
export function summarizeStagingInventory(partial: {
  accountId: string | null;
  region?: string;
  ecsClusterExists: boolean;
  ecsClusterStatus?: string | null;
  apiServiceExists?: boolean;
  webServiceExists?: boolean;
  computeStackStatus?: string | null;
  dataStackStatus?: string | null;
  networkStackStatus?: string | null;
  auroraClusterLive: boolean;
  auroraClusterId?: string | null;
  forbiddenClusterPresent?: boolean;
  rawNotes?: string[];
  capturedAt?: string;
  priorTaskDefs?: PePhase10PriorTaskDef[];
}): PePhase10Inventory {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const region = partial.region ?? PE_PHASE_10_STAGING_EXPECTED.region;
  const exp = PE_PHASE_10_STAGING_EXPECTED;

  if (partial.accountId && partial.accountId !== exp.accountId) {
    blockers.push(`wrong AWS account ${partial.accountId} (expected ${exp.accountId})`);
  }
  if (!partial.accountId) warnings.push('accountId unknown');

  if (!partial.ecsClusterExists) {
    blockers.push(`ECS cluster ${exp.ecsClusterName} does not exist (ACTIVE)`);
  } else if (partial.ecsClusterStatus && partial.ecsClusterStatus !== 'ACTIVE') {
    blockers.push(`ECS cluster status ${partial.ecsClusterStatus} (want ACTIVE)`);
  }

  const compute = partial.computeStackStatus ?? null;
  if (!compute) {
    warnings.push(
      `CloudFormation stack ${exp.computeStackName} missing or unknown (advisory; ECS is source of truth)`,
    );
  } else if (/ROLLBACK/.test(compute) || /FAILED/.test(compute)) {
    if (exp.allowCfComputeRollbackWithLiveEcs) {
      warnings.push(
        `Compute stack ${exp.computeStackName} status=${compute} — known drift; ECS live health still authoritative`,
      );
    } else {
      blockers.push(
        `Compute stack ${exp.computeStackName} status=${compute} (need healthy COMPLETE without rollback)`,
      );
    }
  } else if (!/COMPLETE$/.test(compute)) {
    blockers.push(`Compute stack ${exp.computeStackName} status=${compute}`);
  }

  if (partial.apiServiceExists === false) {
    blockers.push(`ECS service ${exp.apiServiceName} missing`);
  }
  if (partial.webServiceExists === false) {
    blockers.push(`ECS service ${exp.webServiceName} missing`);
  }

  if (!partial.auroraClusterLive) {
    blockers.push(
      `Sole-live Aurora is not live in RDS (expected cluster pattern under ${exp.dataStackName})`,
    );
  }

  if (partial.forbiddenClusterPresent) {
    warnings.push(
      'Forbidden/unintended clusters are visible in the account (expected); deploy must never target them',
    );
  }

  const data = partial.dataStackStatus ?? null;
  if (data && /ROLLBACK|FAILED/.test(data)) {
    blockers.push(`Data stack status ${data}`);
  }

  const accountOk = !partial.accountId || partial.accountId === exp.accountId;
  const servicesOk = partial.apiServiceExists === true && partial.webServiceExists === true;
  if (partial.apiServiceExists !== true) {
    if (!blockers.some((b) => b.includes(exp.apiServiceName))) {
      blockers.push(`ECS service ${exp.apiServiceName} missing or unknown`);
    }
  }
  if (partial.webServiceExists !== true) {
    if (!blockers.some((b) => b.includes(exp.webServiceName))) {
      blockers.push(`ECS service ${exp.webServiceName} missing or unknown`);
    }
  }
  const healthyCompute =
    accountOk &&
    partial.ecsClusterExists &&
    (partial.ecsClusterStatus == null || partial.ecsClusterStatus === 'ACTIVE') &&
    servicesOk &&
    partial.auroraClusterLive &&
    blockers.length === 0;

  return {
    accountId: partial.accountId,
    region,
    probeOk: true,
    ecsClusterExists: partial.ecsClusterExists,
    ecsClusterStatus: partial.ecsClusterStatus ?? null,
    apiServiceExists: partial.apiServiceExists ?? false,
    webServiceExists: partial.webServiceExists ?? false,
    computeStackStatus: compute,
    dataStackStatus: data,
    networkStackStatus: partial.networkStackStatus ?? null,
    auroraClusterLive: partial.auroraClusterLive,
    auroraClusterId: partial.auroraClusterId ?? null,
    forbiddenClusterPresent: partial.forbiddenClusterPresent ?? false,
    healthyCompute,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    capturedAt: partial.capturedAt ?? new Date().toISOString(),
    rawNotes: partial.rawNotes,
    priorTaskDefs: partial.priorTaskDefs,
  };
}

export function isForbiddenDeployCluster(clusterName: string): boolean {
  return (PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters as readonly string[]).includes(
    clusterName,
  );
}

export function isAuthorizedDeployCluster(clusterName: string): boolean {
  return (
    clusterName === PE_PHASE_10_STAGING_EXPECTED.ecsClusterName &&
    !isForbiddenDeployCluster(clusterName)
  );
}

export function classifyEnvBlockedStep(
  step: PePhase10Step,
  inventory: PePhase10Inventory,
  mutateAllowed: boolean,
): { classification: PePhase10FailureClass; reason: string; exitCode: number } {
  if (step.forbiddenAlways) {
    return {
      classification: 'ok',
      reason: `${step.id}: production-forbidden actions correctly refused`,
      exitCode: 0,
    };
  }
  if (step.requiresMutate) {
    if (!mutateAllowed) {
      return {
        classification: 'env_blocked',
        reason: `${step.id}: mutate not authorized or inventory unhealthy — not executed`,
        exitCode: PE_PHASE_10_BLOCKED_EXIT,
      };
    }
    if (!inventory.healthyCompute) {
      return {
        classification: 'env_blocked',
        reason: `${step.id}: authorized plane unhealthy — not executed (${inventory.blockers.join('; ')})`,
        exitCode: PE_PHASE_10_BLOCKED_EXIT,
      };
    }
  }
  const needsPlane =
    step.kind === 'runtime_check' ||
    step.kind === 'deploy' ||
    step.kind === 'migrate' ||
    (step.kind === 'security' &&
      step.id !== 'email_automation_dark' &&
      step.id !== 'forbidden_production_actions');
  if (needsPlane && !inventory.healthyCompute) {
    return {
      classification: 'env_blocked',
      reason: `${step.id}: no healthy authorized plane — cannot execute runtime acceptance`,
      exitCode: PE_PHASE_10_BLOCKED_EXIT,
    };
  }
  // Discover-only (mutate off) on a healthy plane: ship/runtime proofs are not
  // executed by this classifier — honest env_blocked, not silent ok and not hard FAIL.
  if (needsPlane && !mutateAllowed) {
    return {
      classification: 'env_blocked',
      reason: `${step.id}: discover-only path (PE_CLOSEOUT_STAGING_MUTATE not yes) — runtime proof not executed`,
      exitCode: PE_PHASE_10_BLOCKED_EXIT,
    };
  }
  return {
    classification: 'operator_policy',
    reason: `${step.id}: not auto-classified`,
    exitCode: 1,
  };
}

function classById(
  classifications: PePhase10GateResult['classifications'],
  stepId: string,
): PePhase10FailureClass | undefined {
  return classifications.find((c) => c.stepId === stepId)?.classification;
}

export function evaluatePePhase10Gate(args: {
  authOk: boolean;
  inventory: PePhase10Inventory;
  mutateAllowed: boolean;
  outcomes: readonly PePhase10StepOutcome[];
  integrityOk: boolean;
  integrityBlockers?: string[];
  imageRecords?: readonly PePhase10ImageDigestRecord[];
  rollbackDocumented: boolean;
  rollbackCapturedPriors?: boolean;
  acceptanceRecordWritten: boolean;
  emailAutomationDark: boolean;
  requireFullShip?: boolean;
}): PePhase10GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const classifications: PePhase10GateResult['classifications'] = [];
  const byId = new Map(args.outcomes.map((o) => [o.stepId, o]));

  if (!args.authOk) {
    blockers.push('staging auth gate failed (PE_CLOSEOUT_STAGING_OK)');
    classifications.push({
      stepId: 'staging_auth_gate',
      classification: 'auth_refused',
      reason: 'PE_CLOSEOUT_STAGING_OK not yes',
    });
  } else {
    classifications.push({
      stepId: 'staging_auth_gate',
      classification: 'ok',
      reason: 'PE_CLOSEOUT_STAGING_OK authorized (sole live env=dev)',
    });
  }

  if (!args.integrityOk) {
    blockers.push(...(args.integrityBlockers ?? ['integrity failed']));
  }

  for (const b of args.inventory.blockers) warnings.push(`inventory: ${b}`);
  for (const w of args.inventory.warnings) warnings.push(`inventory: ${w}`);

  let allRequiredSatisfiedOrBlocked = true;
  let anyRequiredHardFail = false;
  let anyRequiredEnvBlocked = false;
  let anyRequiredMissing = false;

  for (const step of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (!step.required) continue;
    const outcome = byId.get(step.id);

    if (!outcome) {
      if (step.id === 'staging_auth_gate') continue;
      if (step.id === 'email_automation_dark') {
        if (args.emailAutomationDark) {
          classifications.push({
            stepId: step.id,
            classification: 'ok',
            reason: 'email/automation remain dark',
          });
        } else {
          blockers.push('email or automation not confirmed dark');
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
          classifications.push({
            stepId: step.id,
            classification: 'branch_introduced',
            reason: 'email/automation dark policy violated',
          });
        }
        continue;
      }
      if (step.id === 'rollback_rehearsal') {
        // Documented prose alone is never PE_PHASE_10_OK-class ok — need exercised outcome.
        if (!args.inventory.healthyCompute || !args.mutateAllowed) {
          anyRequiredEnvBlocked = true;
          classifications.push({
            stepId: step.id,
            classification: 'env_blocked',
            reason: args.rollbackDocumented
              ? 'rollback documented only; plane/mutate insufficient to exercise ECS update-service rehearse'
              : 'rollback not exercised (env_blocked)',
          });
        } else {
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
          blockers.push('rollback_rehearsal missing exercised outcome on healthy mutate plane');
          classifications.push({
            stepId: step.id,
            classification: 'branch_introduced',
            reason: 'rollback_rehearsal required outcome missing (prose-only is UNSATISFIED)',
          });
        }
        continue;
      }
      if (step.id === 'acceptance_record') {
        if (args.acceptanceRecordWritten) {
          classifications.push({
            stepId: step.id,
            classification: 'ok',
            reason: 'acceptance record written',
          });
        } else {
          blockers.push('acceptance record not written');
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
        }
        continue;
      }
      if (step.id === 'forbidden_production_actions') {
        classifications.push({
          stepId: step.id,
          classification: 'ok',
          reason: 'forbidden actions refused by policy',
        });
        continue;
      }
      if (
        step.requiresMutate ||
        step.kind === 'runtime_check' ||
        step.kind === 'deploy' ||
        step.kind === 'migrate' ||
        (step.kind === 'security' &&
          step.id !== 'email_automation_dark' &&
          step.id !== 'forbidden_production_actions')
      ) {
        const c = classifyEnvBlockedStep(step, args.inventory, args.mutateAllowed);
        const classification =
          c.classification === 'operator_policy' && !args.inventory.healthyCompute
            ? 'env_blocked'
            : c.classification;
        const reason =
          classification === 'env_blocked' && c.classification === 'operator_policy'
            ? `${step.id}: no healthy authorized plane — data-plane security proof deferred`
            : c.reason;
        classifications.push({ stepId: step.id, classification, reason });
        if (classification === 'env_blocked') anyRequiredEnvBlocked = true;
        else if (classification !== 'ok') {
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
          blockers.push(reason);
        }
        continue;
      }
      anyRequiredMissing = true;
      allRequiredSatisfiedOrBlocked = false;
      blockers.push(`required step not executed: ${step.id}`);
      classifications.push({
        stepId: step.id,
        classification: 'branch_introduced',
        reason: `required step missing: ${step.id}`,
      });
      continue;
    }

    const code = outcome.exitCode;
    let classification: PePhase10FailureClass =
      outcome.classification ?? (code === 0 ? 'ok' : 'branch_introduced');
    let reason = outcome.detail ?? `${step.id} exit=${code}`;

    if (code === PE_PHASE_10_BLOCKED_EXIT || classification === 'env_blocked') {
      classification = 'env_blocked';
      anyRequiredEnvBlocked = true;
      reason = outcome.detail ?? `${step.id} environment blocked`;
    } else if (code === 0) {
      classification = 'ok';
    } else if (code === PE_PHASE_10_ENV_SKIP_EXIT && !step.required) {
      classification = 'ok';
      warnings.push(`${step.id}: env skip`);
    } else {
      if (step.requiresMutate || ['deploy', 'migrate', 'runtime_check'].includes(step.kind)) {
        if (!args.inventory.healthyCompute) {
          classification = 'env_blocked';
          anyRequiredEnvBlocked = true;
          reason = `${step.id}: interpreted as env_blocked (plane unhealthy, exit ${code})`;
        } else {
          classification = 'branch_introduced';
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
          blockers.push(reason);
        }
      } else {
        classification = 'branch_introduced';
        anyRequiredHardFail = true;
        allRequiredSatisfiedOrBlocked = false;
        blockers.push(reason);
      }
    }

    classifications.push({ stepId: step.id, classification, reason });
  }

  const images = args.imageRecords ?? [];
  const anyImage = images.some((i) => i.present);
  if (!anyImage) {
    warnings.push('no ECR image digests present for branch tip tags (expected pre-merge)');
  }
  // Prefer tip-SHA tags when provided on records (ship path pins headSha)
  const tipPinned =
    images.some((i) => i.present && i.digest && i.repo.includes('/api')) &&
    images.some((i) => i.present && i.digest && i.repo.includes('/web'));
  if (!tipPinned) {
    warnings.push('api+web digests with present=true required for full ship');
  }

  const rlsOk = classById(classifications, 'rls_ethical_wall') === 'ok';
  const alarmOk = classById(classifications, 'alarm_test_events') === 'ok';
  const migrateOk = classById(classifications, 'staging_migrate_additive') === 'ok';
  const deployOk = classById(classifications, 'staging_deploy_images') === 'ok';
  const promotionOk = classById(classifications, 'exact_sha_internal_promotion') === 'ok';
  const replayOk = classById(classifications, 'identical_replay') === 'ok';
  const loadersOk = classById(classifications, 'inspect_only_loaders') === 'ok';
  const browserOk = classById(classifications, 'browser_smoke') === 'ok';
  const deriveOk = classById(classifications, 'derive_chain_dry_run') === 'ok';
  const rollbackOutcomeOk = classById(classifications, 'rollback_rehearsal') === 'ok';
  const mutationFromOutcome = (args.outcomes ?? []).find((o) => o.stepId === 'mutation_boundary_observe');
  const mutationOk =
    classById(classifications, 'mutation_boundary_observe') === 'ok' ||
    (mutationFromOutcome != null &&
      (mutationFromOutcome.exitCode ?? 1) === 0 &&
      (mutationFromOutcome.classification ?? 'ok') !== 'branch_introduced');

  const fullRuntimeProofs =
    rlsOk &&
    alarmOk &&
    migrateOk &&
    deployOk &&
    promotionOk &&
    replayOk &&
    loadersOk &&
    browserOk &&
    deriveOk &&
    mutationOk;

  const exitGate: PePhase10ExitGateEvaluation[] = PE_PHASE_10_EXIT_GATE_BULLETS.map((bullet) => {
    switch (bullet) {
      case 'staging_acceptance_record_complete': {
        const satisfied =
          args.acceptanceRecordWritten &&
          args.authOk &&
          args.integrityOk &&
          args.inventory.healthyCompute &&
          args.mutateAllowed &&
          fullRuntimeProofs &&
          tipPinned &&
          !anyRequiredEnvBlocked &&
          !anyRequiredHardFail;
        return {
          bullet,
          satisfied,
          reason: satisfied
            ? 'acceptance record complete with full authorized-plane proofs'
            : anyRequiredEnvBlocked || !args.inventory.healthyCompute || !args.mutateAllowed
              ? 'UNSATISFIED: acceptance incomplete — runtime/ship steps env_blocked or mutate off (not a pass)'
              : !args.acceptanceRecordWritten
                ? 'acceptance record missing'
                : !tipPinned
                  ? 'UNSATISFIED: missing tip-present api+web image digests'
                  : 'UNSATISFIED: missing full runtime proofs on authorized plane',
        };
      }
      case 'rollback_rehearsed': {
        const honest =
          (rollbackOutcomeOk || args.rollbackDocumented) &&
          Boolean(args.inventory.priorTaskDefs?.some((t) => !!t.arn)) &&
          args.inventory.healthyCompute &&
          // Prefer exercised outcome when present in classifications
          (rollbackOutcomeOk ||
            // discover-only may only document — still UNSATISFIED for OK path via fullRuntime
            false);
        // Require exercised rollback_rehearsal outcome for satisfied exit-gate
        const satisfied =
          rollbackOutcomeOk &&
          Boolean(args.inventory.priorTaskDefs?.some((t) => !!t.arn)) &&
          args.inventory.healthyCompute;
        void honest;
        return {
          bullet,
          satisfied,
          reason: satisfied
            ? 'rollback rehearsed: prior TD ARNs captured and ECS update-service exercise recorded'
            : args.rollbackDocumented
              ? 'UNSATISFIED: rollback prose only — need exercised update-service rehearse outcome'
              : 'rollback missing',
        };
      }
      case 'no_critical_alarm': {
        const satisfied = args.inventory.healthyCompute && alarmOk && !anyRequiredHardFail;
        return {
          bullet,
          satisfied,
          reason: satisfied
            ? 'alarm test path exercised; no critical acceptance failure'
            : 'UNSATISFIED: alarm proofs deferred or failed (not N/A auto-pass)',
        };
      }
      case 'no_cross_tenant_disclosure': {
        const satisfied = args.inventory.healthyCompute && rlsOk;
        return {
          bullet,
          satisfied,
          reason: satisfied
            ? 'rls_ethical_wall ok on authorized data plane'
            : 'UNSATISFIED: RLS/ethical-wall proof deferred or failed (not N/A auto-pass)',
        };
      }
      case 'no_unexplained_data_mutation': {
        const satisfied =
          args.mutateAllowed &&
          args.inventory.healthyCompute &&
          migrateOk &&
          deployOk &&
          promotionOk &&
          replayOk &&
          mutationOk &&
          !anyRequiredHardFail &&
          !anyRequiredEnvBlocked;
        return {
          bullet,
          satisfied,
          reason: satisfied
            ? 'mutate path executed with explained PE apply steps + identical replay zero-dupe + non-pe10 mutation boundary'
            : !args.mutateAllowed
              ? 'UNSATISFIED: discover-only — no explained mutate proof (vacuous skip is not a pass)'
              : !mutationOk
                ? 'UNSATISFIED: mutation_boundary_observe missing or drifted (no hard-ok observe)'
                : 'UNSATISFIED: mutate incomplete, env_blocked, or missing promotion/replay proofs',
        };
      }
      default:
        return { bullet, satisfied: false, reason: 'unknown bullet' };
    }
  });

  const requireFull = args.requireFullShip !== false;
  const ok =
    requireFull &&
    args.authOk &&
    args.integrityOk &&
    args.inventory.healthyCompute &&
    args.mutateAllowed &&
    !anyRequiredHardFail &&
    !anyRequiredEnvBlocked &&
    !anyRequiredMissing &&
    args.acceptanceRecordWritten &&
    args.rollbackDocumented &&
    args.emailAutomationDark &&
    exitGate.every((e) => e.satisfied) &&
    tipPinned &&
    fullRuntimeProofs &&
    rollbackOutcomeOk;

  const blockedComplete =
    !ok &&
    args.authOk &&
    args.integrityOk &&
    args.acceptanceRecordWritten &&
    args.rollbackDocumented &&
    args.emailAutomationDark &&
    !anyRequiredHardFail &&
    !anyRequiredMissing &&
    (!args.inventory.healthyCompute || !args.mutateAllowed) &&
    anyRequiredEnvBlocked &&
    allRequiredSatisfiedOrBlocked;

  if (ok) {
    return {
      ok: true,
      blockedComplete: false,
      blockers: [],
      warnings: [...new Set(warnings)],
      classifications,
      exitGate,
      marker: 'PE_PHASE_10_OK',
    };
  }

  if (blockedComplete) {
    return {
      ok: false,
      blockedComplete: true,
      blockers: [
        'PE_PHASE_10_BLOCKED: authorized plane or mutate authorization insufficient for full ship gate',
        ...args.inventory.blockers.map((b) => `inventory: ${b}`),
      ],
      warnings: [...new Set(warnings)],
      classifications,
      exitGate,
      marker: 'PE_PHASE_10_BLOCKED',
    };
  }

  return {
    ok: false,
    blockedComplete: false,
    blockers: [...new Set(blockers.length ? blockers : ['PE_PHASE_10_FAIL'])],
    warnings: [...new Set(warnings)],
    classifications,
    exitGate,
    marker: 'PE_PHASE_10_FAIL',
  };
}

export function stepByIdOrThrow(id: string): PePhase10Step {
  const s = PE_PHASE_10_ACCEPTANCE_STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown phase 10 step: ${id}`);
  return s;
}
