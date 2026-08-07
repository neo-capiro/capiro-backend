/**
 * Phase 7 Workstream M — which source a product read is served from.
 *
 * Four modes, in the order the rollout walks them (plan §M.7):
 *
 * ```text
 * legacy          → serve the mutable program_element* tables, as today
 * shadow          → serve legacy, compute snapshot, compare, expose nothing
 * snapshot_canary → serve snapshot to named tenants, still comparing
 * snapshot        → serve snapshot to everyone
 * ```
 *
 * The mode is a config enum defaulting to `legacy`, mirroring
 * `KG_TRAVERSAL_SOURCE`, so this whole workstream lands inert: nothing changes
 * for any caller until an operator moves the flag.
 *
 * ---------------------------------------------------------------------------
 * Two rules that are not obvious
 * ---------------------------------------------------------------------------
 *
 * **1. `snapshot_canary` still compares for everyone.**
 *
 * A non-canary tenant in canary mode is served legacy *and compared*, which is
 * exactly `shadow`. That is deliberate: the canary exists to find the
 * differences the shadow pass did not, and switching comparison off for the 99%
 * of traffic still on legacy would throw away the larger sample at the moment it
 * matters most.
 *
 * **2. No active snapshot means legacy, in every mode.**
 *
 * A snapshot read with no active pointer is not an empty result, it is a
 * product outage — the PE finder returns nothing, every profile 404s. The
 * pointer is absent in exactly the situations where that would be worst: before
 * the first promotion, and immediately after a rollback whose target was never
 * activated. So the resolver forces `legacy` and says why, rather than trusting
 * that a flag was only ever flipped in a sound state.
 */

export const SNAPSHOT_READ_MODE_V1_VALUES = [
  'legacy',
  'shadow',
  'snapshot_canary',
  'snapshot',
] as const;
export type SnapshotReadModeV1 = (typeof SNAPSHOT_READ_MODE_V1_VALUES)[number];

export const DEFAULT_SNAPSHOT_READ_MODE_V1: SnapshotReadModeV1 = 'legacy';

export interface SnapshotReadModeInputV1 {
  configuredMode: SnapshotReadModeV1;
  /** The requesting tenant, or null for a system/unauthenticated context. */
  tenantId: string | null;
  /** Tenants promoted to snapshot reads while the mode is `snapshot_canary`. */
  canaryTenantIds?: readonly string[];
  /**
   * Whether a snapshot is actually active for this domain and environment.
   * Resolved once per request by the caller, not guessed here.
   */
  hasActiveSnapshot: boolean;
}

export interface SnapshotReadDecisionV1 {
  /** Which response the caller returns to the client. */
  serve: 'legacy' | 'snapshot';
  /** Whether to compute the other side and compare digests. */
  compare: boolean;
  /** Machine-readable reason, for the metric label. Never contains data. */
  reason:
    | 'mode_legacy'
    | 'mode_shadow'
    | 'canary_tenant'
    | 'canary_non_tenant'
    | 'mode_snapshot'
    | 'no_active_snapshot';
}

/**
 * Resolve what to serve and whether to compare.
 *
 * Pure and total: every mode has an answer, and the fail-safe is always
 * `legacy`. A caller cannot construct an input that yields a snapshot read with
 * nothing to read from.
 */
export function resolveSnapshotReadModeV1(input: SnapshotReadModeInputV1): SnapshotReadDecisionV1 {
  // Checked first, so it cannot be reasoned around by a later branch.
  if (!input.hasActiveSnapshot) {
    // Comparison is off too: there is no snapshot response to compare against,
    // and a "mismatch" against an absent snapshot would be pure noise on the
    // dashboard an operator is watching to decide whether to proceed.
    return { serve: 'legacy', compare: false, reason: 'no_active_snapshot' };
  }

  switch (input.configuredMode) {
    case 'legacy':
      return { serve: 'legacy', compare: false, reason: 'mode_legacy' };
    case 'shadow':
      return { serve: 'legacy', compare: true, reason: 'mode_shadow' };
    case 'snapshot_canary': {
      const canary = input.canaryTenantIds ?? [];
      const isCanary = input.tenantId != null && canary.includes(input.tenantId);
      return isCanary
        ? { serve: 'snapshot', compare: true, reason: 'canary_tenant' }
        : { serve: 'legacy', compare: true, reason: 'canary_non_tenant' };
    }
    case 'snapshot':
      return { serve: 'snapshot', compare: false, reason: 'mode_snapshot' };
  }
}

/**
 * Whether legacy canonical *writes* are still permitted in this mode.
 *
 * Reads and writes are separate switches — plan §M.12 gives writes their own
 * kill switch defaulting off — but they are not independent: once any tenant is
 * being served from a snapshot, a legacy writer mutating the compatibility
 * tables underneath produces a divergence that looks exactly like a promotion
 * defect. This is the assertion that ties them together, used by the
 * containment gate to refuse a write that the read mode has already made
 * unsafe.
 */
export function legacyWritesUnsafeInModeV1(mode: SnapshotReadModeV1): boolean {
  return mode === 'snapshot_canary' || mode === 'snapshot';
}
