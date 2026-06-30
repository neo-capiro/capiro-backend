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
} as const;

export type MeriV2FlagKey = (typeof MERIV2_FLAGS)[keyof typeof MERIV2_FLAGS];

/** Global env kill-switch for MeriV2. Default OFF — only the literal 'true' enables. */
export function meriV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIV2_ENABLED === 'true';
}

/**
 * A MeriV2 surface flag is active only when the env kill-switch is on AND the
 * per-tenant flag resolves true (tenant default false). Either side OFF →
 * dormant (the existing in-process path runs unchanged).
 */
export function meriV2FlagEnabled(
  settings: unknown,
  flag: MeriV2FlagKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return meriV2Enabled(env) && tenantFeatureEnabled(settings, flag, false);
}
