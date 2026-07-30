/**
 * Master switch for compiling Context Packet **v2** on a live surface.
 *
 * v2 is not a cosmetic upgrade of v1. Turning it on for a surface changes model
 * input, governed filtering, and the database columns the adapter reads/writes.
 * It therefore ships dark and is armed per environment during canary rollout.
 */
import { contextSurfacePolicy } from './surface-policy';
import { CONTEXT_COMPILER_V2_VERSION } from './compiler';
import type { ContextRequest, ContextSurface } from './contract';

export type ContextPacketMode = 'v1' | 'v2';

export const CONTEXT_PACKET_V2_ENV = 'CONTEXT_PACKET_V2';
export const CONTEXT_POLICY_VERSION = 'context-policy-v2.0';

/** Audited v2 surfaces. Deliverable-body surfaces remain excluded until Phase 8. */
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
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'enforce'
    ? 'v2'
    : 'v1';
}

export function contextPacketV2Enabled(raw: string | undefined, surface: ContextSurface): boolean {
  return resolveContextPacketMode(raw) === 'v2' && CONTEXT_PACKET_V2_SURFACES.includes(surface);
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
 * Single v2 wiring point for every surface.
 *
 * Phase 7 now carries the audited persistence policy into the compiler. Chat and
 * other internal conversational surfaces are best-effort and return truthful
 * degraded provenance if the trace cannot be written. External deliverable
 * surfaces are required and must hold before release when persistence fails.
 */
export function contextPacketV2Overrides(
  raw: string | undefined,
  opts: ContextPacketV2RequestOptions,
): Partial<ContextRequest> {
  if (!contextPacketV2Enabled(raw, opts.surface)) return {};
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
    persistence: policy.persistence,
  };
}
