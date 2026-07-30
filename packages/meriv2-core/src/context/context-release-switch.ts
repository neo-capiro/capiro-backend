/**
 * Master switch for compiling Context Packet **v2** on a live surface.
 *
 * v2 is not a cosmetic upgrade of v1. Turning it on for a surface changes three
 * things at once:
 *
 *  1. **Model input.** `compileV2` wraps every rendered body in a
 *     `<context_item source_type=… instructions_allowed=…>` envelope, so the
 *     prompt every consumer builds by concatenating `packet.rendered[].body`
 *     changes shape.
 *  2. **What is withheld.** v2 runs the governed-memory filter, so items with no
 *     approval, an open conflict, a denied sensitivity or a missing source are
 *     excluded — correct, but only once the adapter actually SELECTs the
 *     governed columns. An adapter that still returns v1 rows would drop every
 *     firm-identity and client-steering item as `unapproved`.
 *  3. **What is read from the database.** The governed columns and the
 *     `context_packet` v2 columns are added by
 *     `20260729010000_memory_governance_context_v2`, so a v2 compile before that
 *     migration is applied would fail on a missing column.
 *
 * It therefore ships DARK and is armed per environment during the canary, with
 * exactly the same shape as `resolveAssuranceReleaseMode`
 * (packages/meriv2-core/src/assurance/risk-gate.ts) and
 * `governedMemoryEnforcementEnabled` (apps/api/src/memory/
 * memory-authorization.helpers.ts): a pure parser that returns the armed value
 * ONLY for the exact string `'enforce'`.
 *
 * Pure by design — callers pass the raw environment value, so this package keeps
 * no ambient environment dependency and the default stays unit-testable.
 */
import { contextSurfacePolicy } from './surface-policy';
import { CONTEXT_COMPILER_V2_VERSION } from './compiler';
import type { ContextRequest, ContextSurface } from './contract';

export type ContextPacketMode = 'v1' | 'v2';

/** Environment variable that arms v2. */
export const CONTEXT_PACKET_V2_ENV = 'CONTEXT_PACKET_V2';

/** Bumped whenever the governed selection/filter policy itself changes. */
export const CONTEXT_POLICY_VERSION = 'context-policy-v2.0';

/**
 * Surfaces v2 may compile for, even when armed. This is an ALLOWLIST, not a
 * blocklist, so a surface added later is dark until somebody audits it.
 *
 * The excluded surfaces are excluded for a specific, verified reason: they push
 * `packet.rendered[].body` into text a **user reads verbatim** rather than into a
 * prompt. `alert-memo.service.ts` and `district-brief.service.ts` both build
 * deliverable sections as `## ${title}\n${body}`, so a v2 compile there would
 * print the literal `<context_item …>` envelope into a memo. `outreach` and
 * `research` are excluded pending the same audit.
 */
export const CONTEXT_PACKET_V2_SURFACES: readonly ContextSurface[] = [
  'chat',
  'ga-chat',
  'in-editor',
  'workspace-editor',
  'strategy',
  'steward',
  'workspace-gen',
];

/**
 * `'v2'` ONLY for the exact (trimmed, lowercased) string `'enforce'`. Every other
 * value — including `'true'`, `'1'`, `'on'`, `'v2'` and `undefined` — is `'v1'`.
 */
export function resolveContextPacketMode(raw: string | undefined): ContextPacketMode {
  return String(raw ?? '')
    .trim()
    .toLowerCase() === 'enforce'
    ? 'v2'
    : 'v1';
}

/** True only when v2 is armed AND this surface is on the audited allowlist. */
export function contextPacketV2Enabled(raw: string | undefined, surface: ContextSurface): boolean {
  return resolveContextPacketMode(raw) === 'v2' && CONTEXT_PACKET_V2_SURFACES.includes(surface);
}

export interface ContextPacketV2RequestOptions {
  surface: ContextSurface;
  /**
   * SERVER-DERIVED ethical-wall decision for the request's client.
   *
   * **Required, not optional, on purpose.** `compileV2` is fail-closed — it
   * admits client-scope memory only on a literal `true` — so a call site that
   * simply forgot this field would silently lose all client steering context
   * rather than fail loudly. Making it required turns "somebody added a fifth v2
   * surface and never resolved the wall" into a compile error instead of a
   * runtime information-leak-or-blackout.
   *
   * Pass `false` when there is no client in scope; it only gates client-scope
   * rows, which cannot match a clientless request anyway.
   *
   * In apps/api resolve it with `clientMemoryAllowed()`
   * (apps/api/src/memory/memory-wall.helpers.ts). Never accept it from a client.
   */
  ethicalWallAllowed: boolean;
  /** Correlation key joining the packet to the run that consumed it. */
  traceId?: string | null;
  /** The prompt build that consumed the packet (e.g. `legacy-in-editor-v2`). */
  promptVersion?: string | null;
  policyVersion?: string | null;
  compilerVersion?: string | null;
}

/**
 * The single wiring point every surface uses to opt into v2, so the five call
 * sites cannot drift apart. Returns an EMPTY object when v2 is not armed for the
 * surface, which leaves the caller's request byte-for-byte unchanged.
 *
 * Deliberately does NOT set `persistence`. `applyContextSurfacePolicy` derives it
 * from the surface policy and 10 of 11 policies are `'required'`, which makes
 * `ContextCompiler.persist` rethrow — turning a diagnostics-only trace-write
 * failure into a 500 on the live in-editor route and a total steering blackout in
 * the orchestrator resolver. A trace write stays fail-open on every surface.
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
  };
}
