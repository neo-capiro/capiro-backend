/**
 * Phase 7 Gap 5 decision C — the two canary pieces that did not already exist.
 *
 * Before this file, most of "canary" was already built by Workstream M and is
 * deliberately NOT duplicated here:
 *
 *   - configuration + safe defaults: `PE_SNAPSHOT_READ_MODE` (defaults
 *     `legacy`) and `PE_SNAPSHOT_CANARY_TENANTS` (`config.schema.ts`);
 *   - tenant/internal canary controls: `resolveSnapshotReadModeV1`'s
 *     `canaryTenantIds` allowlist (`snapshot-read-mode-v1.ts`);
 *   - shadow comparison: `compareShadowReadV1` / `worstSeverityV1` /
 *     `blocksCanaryV1` (`shadow-read-comparison-v1.ts`);
 *   - the "no active snapshot" fail-safe, forcing `legacy` regardless of
 *     configuration (`resolveSnapshotReadModeV1`'s first branch).
 *
 * Two things Neo asked for were genuinely missing:
 *
 *   1. A rollback switch distinct from the mode configuration itself. Setting
 *      `PE_SNAPSHOT_READ_MODE=legacy` back is a full redeploy of that
 *      variable; an operator watching a canary mismatch spike needs a single,
 *      unambiguous kill switch that overrides *whatever* the configured mode
 *      is, the same way `PE_LEGACY_BUDGET_WRITES`'s own kill switch overrides
 *      the twelve legacy dispatcher verbs. `resolveCanaryRollbackV1` is that
 *      switch: when engaged, it wins over every other input, unconditionally.
 *   2. Mismatch reporting. `compareShadowReadV1` produces one comparison at a
 *      time; nothing aggregates a stream of them into "is the canary healthy
 *      right now." `CanaryMismatchAggregatorV1` is that aggregation — a
 *      rolling window over already-computed `ShadowComparisonV1` results,
 *      reusing `blocksCanaryV1` rather than re-deriving what blocks a canary.
 *
 * Both are pure and Nest-free, matching every other primitive in this module,
 * and both default to the safest state: rollback engaged blocks everything,
 * and an aggregator with no observations reports a healthy, unblocked canary
 * (there is nothing yet to be unhealthy about) rather than an alarm.
 */
import {
  blocksCanaryV1,
  type MismatchSeverityV1,
  type ShadowComparisonV1,
} from './shadow-read-comparison-v1.js';

/**
 * `worstSeverityV1` in `shadow-read-comparison-v1.ts` reduces mismatch
 * *classes* to a severity; this reduces already-resolved *severities* to the
 * worst one seen, which is a different, smaller job — reusing its name would
 * suggest it was the same function reused, not a second one with a similar
 * shape.
 */
const SEVERITY_ORDER_V1: readonly MismatchSeverityV1[] = ['none', 'p2', 'p1', 'p0'];
function worstOfSeveritiesV1(severities: readonly MismatchSeverityV1[]): MismatchSeverityV1 {
  let worst: MismatchSeverityV1 = 'none';
  for (const severity of severities) {
    if (SEVERITY_ORDER_V1.indexOf(severity) > SEVERITY_ORDER_V1.indexOf(worst)) worst = severity;
  }
  return worst;
}

/* ------------------------------------------------------------------ */
/* Rollback switch                                                     */
/* ------------------------------------------------------------------ */

export interface CanaryRollbackInputV1 {
  /** The operator kill switch. Env-var-sourced by the caller
   *  (`PE_SNAPSHOT_CANARY_ROLLBACK`, matching the `PE_SNAPSHOT_READ_MODE` /
   *  `PE_LEGACY_BUDGET_WRITES` naming convention), defaulting to `false`. */
  rollbackEngaged: boolean;
}

export interface CanaryRollbackDecisionV1 {
  /** True when the rollback switch must win regardless of configured mode. */
  forceLegacy: boolean;
  reason: 'rollback_engaged' | 'rollback_not_engaged';
}

/**
 * Composes with `resolveSnapshotReadModeV1`, does not replace it: a caller
 * checks this FIRST, and only consults the mode resolver at all when
 * `forceLegacy` is false. Kept as a separate, single-purpose function rather
 * than folded into the mode resolver's own switch statement, so the kill
 * switch is checkable — and testable — independently of every mode branch it
 * would otherwise have to be threaded through.
 */
export function resolveCanaryRollbackV1(input: CanaryRollbackInputV1): CanaryRollbackDecisionV1 {
  return input.rollbackEngaged
    ? { forceLegacy: true, reason: 'rollback_engaged' }
    : { forceLegacy: false, reason: 'rollback_not_engaged' };
}

/* ------------------------------------------------------------------ */
/* Mismatch reporting                                                   */
/* ------------------------------------------------------------------ */

export interface CanaryMismatchReportV1 {
  compared: number;
  matched: number;
  mismatched: number;
  mismatchRate: number;
  worstSeverity: MismatchSeverityV1;
  /** True the instant any observation in the window blocks the canary — a
   *  single P0/P1 mismatch is a halt signal, not something an average can
   *  dilute back into "mostly fine." */
  shouldHaltCanary: boolean;
  severityCounts: Record<MismatchSeverityV1, number>;
}

const EMPTY_SEVERITY_COUNTS: Record<MismatchSeverityV1, number> = {
  none: 0,
  p2: 0,
  p1: 0,
  p0: 0,
};

/**
 * Rolling aggregation over already-computed shadow comparisons. Deliberately
 * does not compute comparisons itself — that is `compareShadowReadV1`'s job —
 * this only summarizes what a caller already ran.
 *
 * Bounded by construction: `record` keeps at most `windowSize` observations,
 * evicting the oldest, so a long-running canary process reports on "the last
 * N reads" rather than growing an unbounded history in memory.
 */
export class CanaryMismatchAggregatorV1 {
  private readonly window: MismatchSeverityV1[] = [];

  constructor(private readonly windowSize: number = 500) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new Error('windowSize must be a positive integer');
    }
  }

  record(comparison: Pick<ShadowComparisonV1, 'severity'>): void {
    this.window.push(comparison.severity);
    if (this.window.length > this.windowSize) this.window.shift();
  }

  report(): CanaryMismatchReportV1 {
    const compared = this.window.length;
    const matched = this.window.filter((s) => s === 'none').length;
    const mismatched = compared - matched;
    const worstSeverity = worstOfSeveritiesV1(this.window);
    const severityCounts: Record<MismatchSeverityV1, number> = { ...EMPTY_SEVERITY_COUNTS };
    for (const severity of this.window) severityCounts[severity] += 1;

    return {
      compared,
      matched,
      mismatched,
      // 0 with nothing observed yet, not NaN — an empty window is a "nothing
      // to report" state, not a division-by-zero bug for a dashboard to trip
      // an alert on.
      mismatchRate: compared === 0 ? 0 : mismatched / compared,
      worstSeverity,
      shouldHaltCanary: blocksCanaryV1(worstSeverity),
      severityCounts,
    };
  }
}
