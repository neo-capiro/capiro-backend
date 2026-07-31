/**
 * Phase 10 staging acceptance — pure evaluators (unit-tested, no AWS IO).
 *
 * PE_PHASE_10_OK requires every required step satisfied on a healthy staging
 * plane. Missing compute/DB is not a silent pass: emit PE_PHASE_10_BLOCKED with
 * a complete honest acceptance record.
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

/** Process exit when acceptance is complete but staging plane is not shippable. */
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

export interface PePhase10Inventory {
  accountId: string | null;
  region: string;
  probeOk: boolean;
  /** ECS describe-clusters for expected name returned ACTIVE + exists. */
  ecsClusterExists: boolean;
  ecsClusterStatus: string | null;
  apiServiceExists: boolean;
  webServiceExists: boolean;
  computeStackStatus: string | null;
  dataStackStatus: string | null;
  networkStackStatus: string | null;
  /** Live RDS: DESCRIBE finds stage cluster identifier from CF or expected pattern. */
  auroraClusterLive: boolean;
  auroraClusterId: string | null;
  forbiddenClusterPresent: boolean;
  /** True only when compute stack healthy AND cluster+services exist AND aurora live. */
  healthyCompute: boolean;
  blockers: string[];
  warnings: string[];
  /** ISO time of inventory capture. */
  capturedAt: string;
  rawNotes?: string[];
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
  /** Full ship gate — only true when mutate path + healthy + all required pass. */
  ok: boolean;
  /**
   * Honest blocked path: auth ok, inventory/local/git/record complete,
   * required runtime steps classified env_blocked (not silently ok).
   */
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

  // Safety: every requiresMutate step must be required (plan pillars)
  for (const s of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (s.requiresMutate && !s.required) {
      errors.push(`${s.id}: mutate steps must be required (fail closed if skipped)`);
    }
  }

  if (!PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters.includes('capiro-dev')) {
    errors.push('capiro-dev must remain a forbidden Phase 10 deploy target');
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
    return { ok: true, reason: 'PE_CLOSEOUT_STAGING_OK authorized' };
  }
  return {
    ok: false,
    reason: 'PE_CLOSEOUT_STAGING_OK not set to yes — refuse Phase 10 staging work',
  };
}

/** Mutate flag is separate from staging OK (default discover-only). */
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
      reason: 'staging inventory not healthyCompute — mutate refused even with MUTATE=yes',
    };
  }
  return { ok: true, reason: 'mutate authorized and inventory healthy' };
}

/**
 * Collapse CF + ECS + RDS probe facts into inventory health.
 * Drift: CF UPDATE_COMPLETE with missing live RDS/ECS ⇒ not healthy.
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
}): PePhase10Inventory {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const region = partial.region ?? PE_PHASE_10_STAGING_EXPECTED.region;

  if (partial.accountId && partial.accountId !== PE_PHASE_10_STAGING_EXPECTED.accountId) {
    blockers.push(
      `wrong AWS account ${partial.accountId} (expected ${PE_PHASE_10_STAGING_EXPECTED.accountId})`,
    );
  }
  if (!partial.accountId) warnings.push('accountId unknown');

  if (!partial.ecsClusterExists) {
    blockers.push(
      `ECS cluster ${PE_PHASE_10_STAGING_EXPECTED.ecsClusterName} does not exist (ACTIVE)`,
    );
  } else if (partial.ecsClusterStatus && partial.ecsClusterStatus !== 'ACTIVE') {
    blockers.push(`ECS cluster status ${partial.ecsClusterStatus} (want ACTIVE)`);
  }

  const compute = partial.computeStackStatus ?? null;
  if (!compute) {
    blockers.push(`CloudFormation stack ${PE_PHASE_10_STAGING_EXPECTED.computeStackName} missing`);
  } else if (!/COMPLETE$/.test(compute) || /ROLLBACK/.test(compute) || /FAILED/.test(compute)) {
    blockers.push(
      `Compute stack ${PE_PHASE_10_STAGING_EXPECTED.computeStackName} status=${compute} (need healthy COMPLETE without rollback)`,
    );
  }

  if (partial.apiServiceExists === false) {
    blockers.push(`ECS service ${PE_PHASE_10_STAGING_EXPECTED.apiServiceName} missing`);
  }
  if (partial.webServiceExists === false) {
    blockers.push(`ECS service ${PE_PHASE_10_STAGING_EXPECTED.webServiceName} missing`);
  }

  if (!partial.auroraClusterLive) {
    blockers.push(
      'Staging Aurora is not live in RDS (CF may still report phantom UPDATE_COMPLETE physical IDs)',
    );
  }

  if (partial.forbiddenClusterPresent) {
    warnings.push(
      'Forbidden production/dev clusters are visible in the account (expected); deploy must never target them',
    );
  }

  const data = partial.dataStackStatus ?? null;
  if (data && /ROLLBACK|FAILED/.test(data)) {
    blockers.push(`Data stack status ${data}`);
  }

  // HEALTHY requires: correct account (if known), ECS cluster + services, non-rollback compute, live aurora
  const accountOk =
    !partial.accountId || partial.accountId === PE_PHASE_10_STAGING_EXPECTED.accountId;
  const computeOk =
    !!compute && /COMPLETE$/.test(compute) && !/ROLLBACK/.test(compute) && !/FAILED/.test(compute);
  // Require explicit true — unknown/undefined services are not healthy.
  const servicesOk = partial.apiServiceExists === true && partial.webServiceExists === true;
  if (partial.apiServiceExists !== true) {
    if (!blockers.some((b) => b.includes(PE_PHASE_10_STAGING_EXPECTED.apiServiceName))) {
      blockers.push(`ECS service ${PE_PHASE_10_STAGING_EXPECTED.apiServiceName} missing or unknown`);
    }
  }
  if (partial.webServiceExists !== true) {
    if (!blockers.some((b) => b.includes(PE_PHASE_10_STAGING_EXPECTED.webServiceName))) {
      blockers.push(`ECS service ${PE_PHASE_10_STAGING_EXPECTED.webServiceName} missing or unknown`);
    }
  }
  const healthyCompute =
    accountOk &&
    partial.ecsClusterExists &&
    (partial.ecsClusterStatus == null || partial.ecsClusterStatus === 'ACTIVE') &&
    computeOk &&
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
  };
}

export function isForbiddenDeployCluster(clusterName: string): boolean {
  return (PE_PHASE_10_STAGING_EXPECTED.forbiddenEcsClusters as readonly string[]).includes(
    clusterName,
  );
}

/**
 * Classify a required mutant/runtime step when inventory is unhealthy.
 * Must not return `ok`.
 */
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
        reason: `${step.id}: staging plane unhealthy — not executed (${inventory.blockers.join('; ')})`,
        exitCode: PE_PHASE_10_BLOCKED_EXIT,
      };
    }
  }
  // Runtime / data-plane security checks that need a plane also block
  if (
    (step.kind === 'runtime_check' ||
      step.kind === 'deploy' ||
      step.kind === 'migrate' ||
      (step.kind === 'security' &&
        step.id !== 'email_automation_dark' &&
        step.id !== 'forbidden_production_actions')) &&
    !inventory.healthyCompute
  ) {
    return {
      classification: 'env_blocked',
      reason: `${step.id}: no healthy staging plane — cannot execute runtime acceptance`,
      exitCode: PE_PHASE_10_BLOCKED_EXIT,
    };
  }
  return {
    classification: 'operator_policy',
    reason: `${step.id}: not auto-classified`,
    exitCode: 1,
  };
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
  acceptanceRecordWritten: boolean;
  emailAutomationDark: boolean;
  /** When true, require healthy + all required runtime passes for PE_PHASE_10_OK. */
  requireFullShip?: boolean;
}): PePhase10GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const classifications: PePhase10GateResult['classifications'] = [];
  const byId = new Map(args.outcomes.map((o) => [o.stepId, o]));
  const stepById = new Map(PE_PHASE_10_ACCEPTANCE_STEPS.map((s) => [s.id, s]));

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
      reason: 'PE_CLOSEOUT_STAGING_OK authorized',
    });
  }

  if (!args.integrityOk) {
    blockers.push(...(args.integrityBlockers ?? ['integrity failed']));
  }

  for (const b of args.inventory.blockers) {
    // Inventory blockers are exit-gate blockers for OK, but expected for BLOCKED path.
    warnings.push(`inventory: ${b}`);
  }
  for (const w of args.inventory.warnings) warnings.push(`inventory: ${w}`);

  let allRequiredSatisfiedOrBlocked = true;
  let anyRequiredHardFail = false;
  let anyRequiredEnvBlocked = false;
  let anyRequiredMissing = false;

  for (const step of PE_PHASE_10_ACCEPTANCE_STEPS) {
    if (!step.required) continue;
    const outcome = byId.get(step.id);

    // Built-in eval for policy steps when orchestrator omitted explicit outcome
    if (!outcome) {
      if (step.id === 'staging_auth_gate') {
        continue; // handled above
      }
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
        if (args.rollbackDocumented) {
          classifications.push({
            stepId: step.id,
            classification: 'ok',
            reason: 'rollback procedure documented',
          });
        } else {
          blockers.push('rollback rehearsal not documented');
          anyRequiredHardFail = true;
          allRequiredSatisfiedOrBlocked = false;
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
      // Mutating / runtime acceptance AND data-plane security proofs need a live
      // staging plane; navigate-to-missing surface fails closed as env_blocked.
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
        // Force env_blocked classification for data-plane security when unhealthy
        // even if classifyEnvBlockedStep returned operator_policy.
        const classification =
          c.classification === 'operator_policy' && !args.inventory.healthyCompute
            ? 'env_blocked'
            : c.classification;
        const reason =
          classification === 'env_blocked' && c.classification === 'operator_policy'
            ? `${step.id}: no healthy staging plane — data-plane security proof deferred`
            : c.reason;
        classifications.push({
          stepId: step.id,
          classification,
          reason,
        });
        if (classification === 'env_blocked') {
          anyRequiredEnvBlocked = true;
        } else if (classification !== 'ok') {
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
      // Required step real failure
      if (step.requiresMutate || ['deploy', 'migrate', 'runtime_check'].includes(step.kind)) {
        // If plane unhealthy, force env_blocked rather than branch_introduced false-fail
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

  // Image digests: if none present for branch tip, warn on blocked path; hard-block only for full ship
  const images = args.imageRecords ?? [];
  const anyImage = images.some((i) => i.present);
  if (!anyImage) {
    warnings.push('no ECR image digests present for branch tip tags (expected pre-merge)');
  }

  const exitGate: PePhase10ExitGateEvaluation[] = PE_PHASE_10_EXIT_GATE_BULLETS.map((bullet) => {
    switch (bullet) {
      case 'staging_acceptance_record_complete':
        return {
          bullet,
          satisfied: args.acceptanceRecordWritten && args.authOk && args.integrityOk,
          reason: args.acceptanceRecordWritten
            ? 'acceptance record on tip evidence path'
            : 'acceptance record missing',
        };
      case 'rollback_rehearsed':
        return {
          bullet,
          satisfied: args.rollbackDocumented,
          reason: args.rollbackDocumented
            ? 'rollback text present in acceptance record'
            : 'rollback missing',
        };
      case 'no_critical_alarm':
        return {
          bullet,
          satisfied: args.inventory.healthyCompute
            ? !anyRequiredHardFail
            : true /* N/A while blocked — not green-washed as runtime proof */,
          reason: args.inventory.healthyCompute
            ? anyRequiredHardFail
              ? 'hard failures may indicate alarm risk'
              : 'no critical acceptance failure recorded'
            : 'N/A: staging plane down — critical-alarm proof deferred (not claimed)',
        };
      case 'no_cross_tenant_disclosure':
        return {
          bullet,
          satisfied: args.inventory.healthyCompute
            ? classifications.some(
                (c) => c.stepId === 'rls_ethical_wall' && c.classification === 'ok',
              )
            : true,
          reason: args.inventory.healthyCompute
            ? 'depends on rls_ethical_wall outcome'
            : 'N/A: no staging data plane — disclosure proof deferred (not claimed)',
        };
      case 'no_unexplained_data_mutation':
        return {
          bullet,
          satisfied: !args.mutateAllowed || !args.inventory.healthyCompute || !anyRequiredHardFail,
          reason: !args.mutateAllowed
            ? 'no mutate path — no PE Phase 10 writes claimed'
            : 'mutate path requires runtime proof',
        };
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
    anyImage;

  // Blocked-complete: honest stop — auth+integrity+record+dark+rollback packs done,
  // all ship steps env_blocked, inventory unhealthy (or mutate off).
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
        'PE_PHASE_10_BLOCKED: staging plane or mutate authorization insufficient for full ship gate',
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
