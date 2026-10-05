// ---------------------------------------------------------------------------
// MeriV3 is the only chat runtime (program plan 2026-10-05, §2.2 and §4.1).
//
// Two keys decide whether a tenant's chat turn is served:
//   1. env MERIV3_ENABLED — the global kill switch. Default ON: only an explicit
//      off value ('false', '0', 'off', 'no') turns Meri off everywhere.
//   2. tenant settings_jsonb.clioFeatureFlags['meriv3.fullChat'] — the per-tenant
//      off switch. Default ON: only an explicit boolean false turns it off.
//
// When either key is closed the turn is REFUSED with "Meri is unavailable"
// (meriv3-runtime.proxy.ts); it never falls back to the MeriV2 proxy or the
// legacy in-process loop. There is no tenant slug allow-list any more: a new
// tenant is on V3 from its first turn.
//
// The live task definitions carry MERIV3_ENABLED=true and it is codified in
// infra/cdk/lib/compute-stack.ts, so a future deploy cannot drop it. Truth table
// pinned in apps/api/src/meri/meri-feature-flags.matrix.spec.ts.
// ---------------------------------------------------------------------------
export const MERIV3_CHAT_FLAG = 'meriv3.fullChat' as const;

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/** Global kill switch. Unset means on; only an explicit off value disables V3. */
export function meriV3EnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MERIV3_ENABLED?.trim().toLowerCase();
  return !raw || !OFF_VALUES.has(raw);
}

/** Per-tenant off switch. Missing or malformed settings mean on. */
export function meriV3TenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return true;
  return (flags as Record<string, unknown>)[MERIV3_CHAT_FLAG] !== false;
}

/** Two keys: the global kill switch and the tenant off switch. */
export function meriV3ChatActive(
  settings: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return meriV3EnvironmentEnabled(env) && meriV3TenantFlagEnabled(settings);
}

/** Classified refusal when either key is closed. */
export const MERI_UNAVAILABLE_CODE = 'meri_unavailable' as const;
export const MERI_UNAVAILABLE_MESSAGE = 'Meri is unavailable right now.';
