import { CONTEXT_COMPILER_V2_VERSION } from './compiler';
import {
  applyContextSurfacePolicy,
  contextSurfacePolicy,
  surfacePolicies,
} from './surface-policy';
import type { ContextRequest, ContextSurface } from './contract';

/** Phase 8 rollout modes. Unknown values fail closed to off. */
export type ContextPacketMode = 'off' | 'shadow' | 'enforce';

export const MERIV2_CONTEXT_PACKET_V2_ENV = 'MERIV2_CONTEXT_PACKET_V2';
export const CONTEXT_PACKET_V2_ENV = MERIV2_CONTEXT_PACKET_V2_ENV;
export const CONTEXT_POLICY_VERSION = 'context-policy-v2.1';
export const CONTEXT_PACKET_V2_TENANT_FLAG = 'meriv2.contextPacketV2';

/** Every surface with an explicit Phase 8 policy is eligible for a tenant canary. */
export const CONTEXT_PACKET_V2_SURFACES: readonly ContextSurface[] = surfacePolicies().map(
  (policy) => policy.surface,
);

export function contextPacketSurfaceFlag(surface: ContextSurface): string {
  return `${CONTEXT_PACKET_V2_TENANT_FLAG}.${surface}`;
}

/** Exact parser for the global ceiling. */
export function resolveContextPacketMode(raw: string | undefined): ContextPacketMode {
  const normalized = String(raw ?? '')
    .trim()
    .toLowerCase();
  return normalized === 'shadow' || normalized === 'enforce' ? normalized : 'off';
}

/**
 * Server-side tenant canary resolution over tenant.settings_jsonb.
 *
 * The tenant-wide flag must be literal true. A per-surface flag defaults to true
 * once the tenant-wide canary is enabled, but an explicit false keeps that one
 * surface dark. Browser values are never accepted here.
 */
export function tenantContextPacketCanaryEnabled(
  settings: unknown,
  surface: ContextSurface,
): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as { clioFeatureFlags?: unknown }).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  const record = flags as Record<string, unknown>;
  if (record[CONTEXT_PACKET_V2_TENANT_FLAG] !== true) return false;
  return record[contextPacketSurfaceFlag(surface)] !== false;
}

export function resolveTenantContextPacketMode(
  rawGlobalMode: string | undefined,
  settings: unknown,
  surface: ContextSurface,
): ContextPacketMode {
  const ceiling = resolveContextPacketMode(rawGlobalMode);
  if (ceiling === 'off') return 'off';
  return tenantContextPacketCanaryEnabled(settings, surface) ? ceiling : 'off';
}

/** True only when v2 is the model-steering packet for an audited surface. */
export function contextPacketV2Enabled(raw: string | undefined, surface: ContextSurface): boolean {
  return resolveContextPacketMode(raw) === 'enforce' && CONTEXT_PACKET_V2_SURFACES.includes(surface);
}

export interface ContextPacketV2RequestOptions {
  surface: ContextSurface;
  /** Server-derived ethical-wall decision. Only literal true admits client memory. */
  ethicalWallAllowed: boolean;
  traceId?: string | null;
  promptVersion?: string | null;
  policyVersion?: string | null;
  compilerVersion?: string | null;
}

/**
 * Compatibility shim for pre-Phase-8 callers.
 *
 * Real rollout ownership now lives in ContextPacketRolloutCompiler, which applies
 * the new global ceiling plus server-read tenant/surface canaries. This helper is
 * retained so older call sites and their tests remain source-compatible while
 * compiler services strip request-time v2 hints before resolving the authoritative
 * mode.
 */
export function contextPacketV2Overrides(
  raw: string | undefined,
  opts: ContextPacketV2RequestOptions,
): Partial<ContextRequest> {
  if (!contextPacketV2Enabled(raw, opts.surface)) return {};
  const policy = contextSurfacePolicy(opts.surface);
  const applied = applyContextSurfacePolicy({
    tenantId: '',
    surface: opts.surface,
    clientId: null,
    ethicalWallAllowed: opts.ethicalWallAllowed,
  });
  return {
    contractVersion: 2,
    ethicalWallAllowed: opts.ethicalWallAllowed === true,
    traceId: opts.traceId ?? null,
    promptVersion: opts.promptVersion ?? null,
    policyVersion: opts.policyVersion ?? CONTEXT_POLICY_VERSION,
    compilerVersion: opts.compilerVersion ?? CONTEXT_COMPILER_V2_VERSION,
    allowedSensitivities: [...policy.allowedSensitivities],
    tokenBudget: policy.tokenBudget,
    budgetUnit: 'tokens',
    persistence: policy.persistence,
    layers: [...applied.layers],
  };
}
