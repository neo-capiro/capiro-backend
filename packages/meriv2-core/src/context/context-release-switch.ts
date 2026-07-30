import { contextSurfacePolicy } from './surface-policy';
import { CONTEXT_COMPILER_V2_VERSION } from './compiler';
import type { CompiledContextPacket, ContextRequest, ContextSurface } from './contract';

/** Global rollout ceiling. Tenant opt-in is still required for shadow/enforce. */
export const CONTEXT_PACKET_V2_ENV = 'MERIV2_CONTEXT_PACKET_V2';
/** settings_jsonb.clioFeatureFlags key. Default is deliberately false. */
export const CONTEXT_PACKET_V2_TENANT_FLAG = 'meriv2.contextPacketV2';
export const CONTEXT_POLICY_VERSION = 'context-policy-v2.0';

export type ContextPacketMode = 'off' | 'shadow' | 'enforce';

/** Audited model-input surfaces. New surfaces stay off until explicitly reviewed. */
export const CONTEXT_PACKET_V2_SURFACES: readonly ContextSurface[] = [
  'chat',
  'ga-chat',
  'in-editor',
  'workspace-editor',
  'strategy',
  'steward',
  'workspace-gen',
];

export function resolveContextPacketMode(raw: string | undefined): ContextPacketMode {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'shadow' || value === 'enforce' ? value : 'off';
}

/** Explicit-true only. Missing, malformed, or non-boolean values fail closed. */
export function contextPacketV2TenantEnabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const flags = (settings as Record<string, unknown>).clioFeatureFlags;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  return (flags as Record<string, unknown>)[CONTEXT_PACKET_V2_TENANT_FLAG] === true;
}

export function resolveContextPacketRollout(
  raw: string | undefined,
  tenantEnabled: boolean,
  surface: ContextSurface,
): ContextPacketMode {
  if (!tenantEnabled || !CONTEXT_PACKET_V2_SURFACES.includes(surface)) return 'off';
  return resolveContextPacketMode(raw);
}

/** Compatibility predicate: only enforce changes the model-input contract. */
export function contextPacketV2Enabled(
  raw: string | undefined,
  surface: ContextSurface,
  tenantEnabled = false,
): boolean {
  return resolveContextPacketRollout(raw, tenantEnabled, surface) === 'enforce';
}

export interface ContextPacketV2RequestOptions {
  surface: ContextSurface;
  /** Server-derived; never accept a browser value. */
  ethicalWallAllowed: boolean;
  traceId?: string | null;
  promptVersion?: string | null;
  policyVersion?: string | null;
  compilerVersion?: string | null;
  tenantEnabled?: boolean;
}

/**
 * Backward-compatible request helper. It is enforce-only and tenant-disabled by
 * default, so the former CONTEXT_PACKET_V2 environment variable cannot arm v2.
 */
export function contextPacketV2Overrides(
  raw: string | undefined,
  opts: ContextPacketV2RequestOptions,
): Partial<ContextRequest> {
  if (!contextPacketV2Enabled(raw, opts.surface, opts.tenantEnabled === true)) return {};
  return v2Overrides(opts);
}

export interface CompileContextPacketRolloutInput {
  request: ContextRequest;
  mode: ContextPacketMode;
  ethicalWallAllowed: boolean;
  compile: (request: ContextRequest) => Promise<CompiledContextPacket>;
  onShadowError?: (errorCode: string) => void;
}

/**
 * One rollout path for every adapter.
 * - off: compile/persist v1 only;
 * - shadow: compile/persist v1, then best-effort v2, but return v1 to the model;
 * - enforce: compile/persist and return v2.
 *
 * Browser-supplied contract, wall, policy, compiler and budget fields are removed
 * before the server-owned mode is applied.
 */
export async function compileContextPacketForRollout(
  input: CompileContextPacketRolloutInput,
): Promise<CompiledContextPacket> {
  const v1Request = sanitizeToV1(input.request);
  const mode = CONTEXT_PACKET_V2_SURFACES.includes(input.request.surface) ? input.mode : 'off';
  if (mode === 'off') return input.compile(v1Request);

  const v2Request: ContextRequest = {
    ...v1Request,
    ...v2Overrides({
      surface: input.request.surface,
      ethicalWallAllowed: input.ethicalWallAllowed,
      traceId: input.request.traceId ?? null,
      promptVersion: input.request.promptVersion ?? null,
      policyVersion: input.request.policyVersion ?? null,
      compilerVersion: input.request.compilerVersion ?? null,
      tenantEnabled: true,
    }),
  };

  if (mode === 'enforce') return input.compile(v2Request);

  const v1 = await input.compile(v1Request);
  try {
    await input.compile(v2Request);
  } catch (error) {
    input.onShadowError?.(boundedContextErrorCode(error));
  }
  return v1;
}

function v2Overrides(opts: ContextPacketV2RequestOptions): Partial<ContextRequest> {
  const policy = contextSurfacePolicy(opts.surface);
  return {
    contractVersion: 2,
    ethicalWallAllowed: opts.ethicalWallAllowed === true,
    traceId: opts.traceId ?? null,
    promptVersion: opts.promptVersion ?? null,
    policyVersion: opts.policyVersion ?? CONTEXT_POLICY_VERSION,
    compilerVersion: opts.compilerVersion ?? CONTEXT_COMPILER_V2_VERSION,
    tokenBudget: policy.tokenBudget,
    budgetUnit: 'tokens',
    persistence: 'best-effort',
  };
}

function sanitizeToV1(request: ContextRequest): ContextRequest {
  const {
    contractVersion: _contractVersion,
    ethicalWallAllowed: _ethicalWallAllowed,
    tokenBudget: _tokenBudget,
    budgetUnit: _budgetUnit,
    traceId: _traceId,
    promptVersion: _promptVersion,
    policyVersion: _policyVersion,
    compilerVersion: _compilerVersion,
    ...base
  } = request;
  return base;
}

export function boundedContextErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : 'ContextPacketShadowError';
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'context_error';
}
