import {
  JEV_TASK_REGISTRY,
  type JevTaskRegistration,
} from '@capiro/meriv2-core';
import type { JevTask } from '@capiro/meriv2-core';
import {
  bizdevJevTaskModes,
  type BizDevJevTenantModes,
} from '../common/tenant-flags.js';

/**
 * Business Development Phase 3 — task-mode controls for the BD-ENTITY /
 * BD-SIGNAL Jev tasks (API side).
 *
 * Layered, independently dark controls; the EFFECTIVE mode is always the
 * LEAST PERMISSIVE combination of:
 *
 *   1. global env kill switch  BIZDEV_JEV_ENABLED (default off — one switch
 *      disables every BD Jev task for every tenant, no matter what else is on);
 *   2. per-task env mode        BIZDEV_JEV_TASK_<TASK>_MODE
 *      (off | shadow | internal_canary, default off);
 *   3. per-tenant, per-task, per-mode enrollment booleans in
 *      settings_jsonb.clioFeatureFlags (each default OFF — a tenant must be
 *      explicitly enrolled in a task AND a mode);
 *   4. the shared meriv2-core registry ceiling — `internal_canary` is REFUSED
 *      (downgraded to off, with reason codes) unless the registry both raises
 *      the task's max rollout above shadow and marks its evaluation set
 *      approved. Today both BD registrations are shadow_only with a
 *      `proposed` evaluation set, so the canary is mechanically impossible to
 *      arm from configuration alone.
 */

export const BD_JEV_TASKS = ['bd_entity', 'bd_signal'] as const;
export type BdJevTask = (typeof BD_JEV_TASKS)[number];

/** API-side task modes. `internal_canary` is a projection mode, never an auto-apply mode. */
export const BD_JEV_MODES = ['off', 'shadow', 'internal_canary'] as const;
export type BdJevMode = (typeof BD_JEV_MODES)[number];

export const BIZDEV_JEV_ENABLED_ENV = 'BIZDEV_JEV_ENABLED' as const;
export const BIZDEV_JEV_TASK_MODE_ENV: Readonly<Record<BdJevTask, string>> = {
  bd_entity: 'BIZDEV_JEV_TASK_BD_ENTITY_MODE',
  bd_signal: 'BIZDEV_JEV_TASK_BD_SIGNAL_MODE',
} as const;

const MODE_RANK: Record<BdJevMode, number> = { off: 0, shadow: 1, internal_canary: 2 };

const truthy = (value: string | undefined): boolean =>
  ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());

/**
 * The global default-off kill switch, as a pure boolean. Callers use this to
 * short-circuit SYNCHRONOUSLY (before any tenant-settings DB read, provider
 * factory work or trace write) so a dark deployment costs one boolean check.
 */
export function bdJevGlobalEnabled(env: Record<string, string | undefined>): boolean {
  return truthy(env[BIZDEV_JEV_ENABLED_ENV]);
}

/** Parse one per-task env mode. Blank/absent → off (dark default). Unknown → off. */
export function parseBdJevTaskEnvMode(raw: string | undefined): BdJevMode {
  const value = (raw ?? '').trim().toLowerCase();
  return (BD_JEV_MODES as readonly string[]).includes(value) ? (value as BdJevMode) : 'off';
}

export interface BdJevTaskModeResolution {
  task: BdJevTask;
  mode: BdJevMode;
  reasons: string[];
}

/**
 * Least-permissive combination for ONE task. Pure: same inputs → same output.
 *
 * `internal_canary` additionally requires the shared registry to say the task
 * may roll out beyond shadow AND that its evaluation set is approved; when the
 * registry does not, the requested canary is REFUSED (mode `off`, never a
 * silent downgrade to shadow — the tenant only enrolled the canary tier, not
 * the shadow tier, so shadowing would be MORE permissive than enrolled).
 */
export function resolveBdJevTaskMode(input: {
  task: BdJevTask;
  env: Record<string, string | undefined>;
  tenantModes: BizDevJevTenantModes;
  registration?: JevTaskRegistration;
}): BdJevTaskModeResolution {
  const reasons: string[] = [];
  const task = input.task;
  if (!truthy(input.env[BIZDEV_JEV_ENABLED_ENV])) {
    return { task, mode: 'off', reasons: ['global_kill_switch_off'] };
  }
  const envMode = parseBdJevTaskEnvMode(input.env[BIZDEV_JEV_TASK_MODE_ENV[task]]);
  if (envMode === 'off') reasons.push('env_mode_off');

  const tenantMode = input.tenantModes[task] ?? 'off';
  if (tenantMode === 'off') reasons.push('tenant_not_enrolled');

  let requested = (MODE_RANK[envMode] <= MODE_RANK[tenantMode] ? envMode : tenantMode) as BdJevMode;

  if (requested === 'internal_canary') {
    const registration = input.registration ?? JEV_TASK_REGISTRY[task as JevTask];
    const registryAllows =
      registration != null &&
      registration.maxRolloutMode !== 'shadow' &&
      registration.maxRolloutMode !== 'off' &&
      registration.evaluationSet.status === 'approved';
    if (!registryAllows) {
      reasons.push('registry_refuses_canary');
      if (registration?.maxRolloutMode === 'shadow') reasons.push('registry_max_rollout_shadow');
      if (registration && registration.evaluationSet.status !== 'approved') {
        reasons.push(`evaluation_set_${registration.evaluationSet.status}`);
      }
      requested = 'off';
    }
  }
  return { task, mode: requested, reasons };
}

/** Resolve BOTH BD tasks at once (one settings read → one pure computation). */
export function resolveBdJevModes(input: {
  env: Record<string, string | undefined>;
  tenantSettings: unknown;
}): Record<BdJevTask, BdJevTaskModeResolution> {
  const tenantModes = bizdevJevTaskModes(input.tenantSettings);
  const out = {} as Record<BdJevTask, BdJevTaskModeResolution>;
  for (const task of BD_JEV_TASKS) {
    out[task] = resolveBdJevTaskMode({ task, env: input.env, tenantModes });
  }
  return out;
}