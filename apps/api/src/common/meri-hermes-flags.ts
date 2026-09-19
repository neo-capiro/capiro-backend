/**
 * Meri ⇄ Hermes runtime pilot gate (Phase 0).
 *
 * Hermes is a THIRD peer runtime beside legacy in-process Meri and MeriV3. It is
 * a strict, server-resolved, default-closed canary with three independent keys:
 *
 *   1. `MERI_HERMES_ENABLED === 'true'`            — global environment switch.
 *   2. `MERI_HERMES_PILOT_TENANT_IDS`              — comma-separated CANONICAL tenant
 *      UUIDs (never slugs, never browser input). Default is EMPTY: nobody is on
 *      Hermes until an operator lists the resolved pilot tenant id explicitly.
 *   3. tenants.settings_jsonb.clioFeatureFlags['meri.hermesRuntime'] === true
 *      — explicit per-tenant opt-in (default false).
 *
 * The tenant id MUST come from the authenticated TenantContext resolved by the
 * tenant middleware. A tenant field supplied by a client cannot widen the gate;
 * `meriHermesRuntimeActive` is pure and unit-tested for exactly that.
 *
 * When the pilot gate is open but the runtime is misconfigured or fails, the
 * turn must SURFACE that error; there is no silent fallback to legacy/V3 (see
 * MeriHermesRuntimeAdapter). Rollback is flipping any one of the three keys.
 */

export const MERI_HERMES_RUNTIME_FLAG = 'meri.hermesRuntime' as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function meriHermesEnvironmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERI_HERMES_ENABLED === 'true';
}

/**
 * Canonical tenant-id allowlist. Entries that are not UUIDs are ignored (a slug
 * pasted here by mistake must not accidentally match anything). Default empty.
 */
export function meriHermesPilotTenantIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.MERI_HERMES_PILOT_TENANT_IDS?.trim() ?? '';
  return new Set(
    raw
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_RE.test(id)),
  );
}

export function meriHermesTenantFlagEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  return (flags as Record<string, unknown>)[MERI_HERMES_RUNTIME_FLAG] === true;
}

/**
 * All three keys must be open. `tenantId` is the server-resolved canonical id.
 */
export function meriHermesRuntimeActive(
  settings: unknown,
  tenantId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!meriHermesEnvironmentEnabled(env)) return false;
  const id = tenantId?.trim().toLowerCase();
  if (!id || !UUID_RE.test(id)) return false;
  if (!meriHermesPilotTenantIds(env).has(id)) return false;
  return meriHermesTenantFlagEnabled(settings);
}

/** Non-secret view of the runtime configuration (values of secrets are never exposed). */
export interface MeriHermesRuntimeConfig {
  runtimeUrl: string | null;
  apiKeyConfigured: boolean;
  brokerSigningKeyConfigured: boolean;
  brokerPublicUrl: string | null;
  model: string | null;
  requestTimeoutMs: number;
}

export function meriHermesRuntimeConfig(env: NodeJS.ProcessEnv = process.env): MeriHermesRuntimeConfig {
  const url = env.MERI_HERMES_RUNTIME_URL?.trim().replace(/\/+$/, '') || null;
  const broker = env.MERI_HERMES_BROKER_PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
  const timeout = Number(env.MERI_HERMES_REQUEST_TIMEOUT_MS ?? '');
  return {
    runtimeUrl: url,
    apiKeyConfigured: Boolean(env.MERI_HERMES_API_KEY?.trim()),
    brokerSigningKeyConfigured: (env.MERI_HERMES_BROKER_SIGNING_KEY?.trim().length ?? 0) >= 32,
    brokerPublicUrl: broker,
    model: env.MERI_HERMES_MODEL?.trim() || null,
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
}

/**
 * Human-readable configuration problem for a pilot-enabled tenant, or null when
 * the runtime can be addressed. Surfaced verbatim as an `error` frame so a
 * misconfigured pilot never masquerades as legacy success.
 */
export function meriHermesConfigurationError(cfg: MeriHermesRuntimeConfig): string | null {
  if (!cfg.runtimeUrl) {
    return 'Hermes runtime is enabled for this tenant but MERI_HERMES_RUNTIME_URL is not configured.';
  }
  if (!cfg.apiKeyConfigured) {
    return 'Hermes runtime is enabled for this tenant but MERI_HERMES_API_KEY is not configured.';
  }
  if (!cfg.brokerSigningKeyConfigured) {
    return 'Hermes runtime is enabled for this tenant but MERI_HERMES_BROKER_SIGNING_KEY is missing or shorter than 32 characters.';
  }
  return null;
}
