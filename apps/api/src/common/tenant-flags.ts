/**
 * Per-tenant Meri feature flags (assistant-parity cross-cutting convention).
 *
 * Flags live under tenants.settings_jsonb.clioFeatureFlags, e.g.
 *   { "clioFeatureFlags": { "runAnalysis": true } }
 * and compose with env kill-switches: a feature is active only when its env
 * switch is on AND the tenant flag resolves true (each feature picks its own
 * tenant default — pilot features default false, GA features default true).
 * Pure so it unit-tests under `src/**.spec.ts`.
 */

export function tenantFeatureEnabled(
  settings: unknown,
  flag: string,
  defaultValue: boolean,
): boolean {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const value = (flags as Record<string, unknown>)[flag];
      if (typeof value === 'boolean') return value;
    }
  }
  return defaultValue;
}

/**
 * MeriV2 surface flags (Phase 0). Govern whether an existing surface PROXIES to
 * the meriv2-orchestrator instead of running its in-process path. Both default
 * OFF and are ANDed with the global MERIV2_ENABLED env kill-switch, so MeriV2
 * stays dormant until a human flips BOTH the env switch and a per-tenant flag
 * (the < 5s rollback in SC0.4 is flipping either back off).
 */
export const MERIV2_FLAGS = {
  inEditorAssistant: 'meriv2.inEditorAssistant',
  workspaceGen: 'meriv2.workspaceGen',
  // C4: the full Meri chat surface. When ON (and MERIV2_ENABLED), apps/api's
  // chat route proxies to the orchestrator's /meri-api/chat loop instead of
  // running the in-process MeriService path.
  fullChat: 'meriv2.fullChat',
} as const;

export type MeriV2FlagKey = (typeof MERIV2_FLAGS)[keyof typeof MERIV2_FLAGS];

/** Global env kill-switch for MeriV2. Default OFF — only the literal 'true' enables. */
export function meriV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV2_ENABLED === 'true';
}

/**
 * A MeriV2 surface flag is active when the env kill-switch is on AND the
 * per-tenant flag resolves true. GA (2026-07): the tenant flag defaults ON, so
 * a tenant without an explicit flag is on MeriV2 whenever MERIV2_ENABLED is set
 * — opt out with an explicit `false`. MERIV2_ENABLED off → dormant everywhere.
 */
export function meriV2FlagEnabled(
  settings: unknown,
  flag: MeriV2FlagKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return meriV2Enabled(env) && tenantFeatureEnabled(settings, flag, true);
}

/**
 * Meeting Notetaker (docs/plans/meeting-notetaker-bot-plan.md). Governs whether a
 * tenant's users can dispatch the Recall.ai bot to join/transcribe meetings.
 * Modeled on the MeriV2 surface flags: ANDed with a global env kill-switch
 * (NOTETAKER_ENABLED) and defaulting OFF per-tenant, so the feature stays dormant
 * until a human flips BOTH the env switch and the per-tenant flag. The
 * belt-and-suspenders gate is deliberate — this drives an external media
 * processor (Recall) that records third parties, so it must not go live by
 * accident. Per-tenant canary flip is via SQL UPDATE on tenants.settings_jsonb
 * (same path used for the MeriV2 flips) until an admin surface is added.
 */
export const NOTETAKER_FLAG = 'notetaker.enabled' as const;

/** Global env kill-switch for the notetaker. Default OFF — only the literal 'true' enables. */
export function notetakerEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTETAKER_ENABLED === 'true';
}

/**
 * The notetaker is active for a tenant only when the env kill-switch is on AND
 * the per-tenant `notetaker.enabled` flag resolves true (tenant default false).
 * Either side OFF → the feature is dormant.
 */
export function notetakerEnabled(settings: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return notetakerEnvEnabled(env) && tenantFeatureEnabled(settings, NOTETAKER_FLAG, false);
}
