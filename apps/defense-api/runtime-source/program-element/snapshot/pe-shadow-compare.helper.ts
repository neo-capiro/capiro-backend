/**
 * Phase 7 Workstream M — the single call site for `compareShadowReadV1` on the
 * Program Elements read surface.
 *
 * Every migrated method that runs in `shadow`/`snapshot_canary` mode calls
 * `schedulePeShadowComparisonV1` exactly once, handing it a `compute` thunk that
 * produces whichever side wasn't already computed for serving the response.
 * That thunk runs **detached**: the client is served the already-computed
 * result immediately, and the comparison happens after, in the background.
 * This is the cost story plan §M.10 needs without doubling response latency —
 * shadow mode adds background CPU/DB load (real, and worth capacity-planning
 * before widening it), but never makes a client wait on the snapshot side.
 *
 * A comparison failure — the thunk throwing, `compareShadowReadV1` throwing on
 * a pathological input — is logged and dropped, never rethrown. A shadow
 * comparison exists to learn something before cutover; it must never be able to
 * fail a request that would otherwise have succeeded.
 *
 * Follows the EMF-over-`Logger.log` convention already established in
 * `observability/api-latency.middleware.ts`, rather than introducing a second
 * metrics pipeline. Dimensions are `method`/`severity`/`matched` only — the
 * mismatch `path`s and digests go into a separate structured warn log, not into
 * metric dimensions, because CloudWatch dimension cardinality would blow up
 * across every possible field path.
 */
import { Logger } from '@nestjs/common';
import {
  compareShadowReadV1,
  type ShadowCompareOptionsV1,
  type ShadowComparisonV1,
} from '../../defense-budget/promotion/shadow-read-comparison-v1.js';
import type { SloMetricRecorderV1 } from '../../defense-budget/promotion/slo-metrics-v1.js';

const NAMESPACE = 'Capiro/PeSnapshotShadow';
const logger = new Logger('PeSnapshotShadowCompare');

export interface PeShadowComparisonInputV1 {
  method: string;
  legacy: unknown;
  snapshot: unknown;
  timing?: { legacyMs: number; snapshotMs: number };
  options?: ShadowCompareOptionsV1;
  /**
   * Phase 7 Gap 5 decision C. Optional: omitting it leaves the EMF metric and
   * the structured logs exactly as they were, which is what every existing
   * caller and every spec gets.
   *
   * Passed in rather than injected because this module is deliberately a pair
   * of free functions, not an `@Injectable` — `schedulePeShadowComparisonV1`
   * runs detached from the request that scheduled it, and a service holding
   * request-scoped state would be the wrong shape for that. The dimensions
   * travel with the recorder because a detached comparison has no ambient
   * request to read a domain or environment off.
   */
  slo?: {
    recorder: SloMetricRecorderV1;
    domain: string;
    environment: string;
  };
}

/**
 * Runs the comparison synchronously and emits the metric/log. Exported
 * separately from the scheduling wrapper below so a caller that has already
 * computed both sides (e.g. a rehearsal script) can invoke it directly without
 * going through the detached-scheduling machinery.
 *
 * Never throws: a defect in the comparator itself must not become a request
 * failure any more than a real mismatch would.
 */
export function recordPeShadowComparisonV1(
  input: PeShadowComparisonInputV1,
): ShadowComparisonV1 | null {
  try {
    const comparison = compareShadowReadV1({
      legacy: input.legacy,
      snapshot: input.snapshot,
      options: input.options,
      timing: input.timing,
    });

    logger.log(
      JSON.stringify({
        _aws: { CloudWatchMetrics: [{ Namespace: NAMESPACE }] },
        MetricName: 'pe.snapshot_shadow_mismatch',
        Value: comparison.matched ? 0 : 1,
        Unit: 'Count',
        Dimensions: [
          { Name: 'method', Value: input.method },
          { Name: 'severity', Value: comparison.severity },
          { Name: 'matched', Value: String(comparison.matched) },
        ],
        Timestamp: new Date().toISOString(),
      }),
    );

    // One per comparison, 1 or 0 — not the number of differing fields. Plan
    // §M.10's gate is "zero unexplained P0/P1 mismatch", which counts reads
    // that disagreed, not fields; and a field count would be silently capped by
    // the comparator's MAX_DETAILS bound, so a catastrophically wrong response
    // would report the same 50 as a merely bad one. Summing this over a window
    // gives the mismatching-read count the gate is actually written against.
    input.slo?.recorder.record('shadow_read_mismatch_count', comparison.matched ? 0 : 1, {
      domain: input.slo.domain,
      environment: input.slo.environment,
      method: input.method,
    });

    if (!comparison.matched) {
      // Paths and classes, never values — `comparison` has nowhere to put a
      // value by construction (see shadow-read-comparison-v1.ts's own header).
      logger.warn(
        JSON.stringify({
          method: input.method,
          severity: comparison.severity,
          classes: comparison.classes,
          counts: comparison.counts,
          details: comparison.details,
        }),
      );
    }

    return comparison;
  } catch (error) {
    logger.error(
      `pe snapshot shadow comparison threw for ${input.method}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * Schedules a comparison without making the caller wait on it. `compute`
 * typically re-runs whichever path (legacy or snapshot) wasn't already
 * computed to serve the response, and reports how long each side took.
 */
export function schedulePeShadowComparisonV1(input: {
  method: string;
  compute: () => Promise<{
    legacy: unknown;
    snapshot: unknown;
    timing: { legacyMs: number; snapshotMs: number };
  }>;
  options?: ShadowCompareOptionsV1;
  slo?: PeShadowComparisonInputV1['slo'];
}): void {
  void input
    .compute()
    .then(({ legacy, snapshot, timing }) => {
      recordPeShadowComparisonV1({
        method: input.method,
        legacy,
        snapshot,
        timing,
        options: input.options,
        slo: input.slo,
      });
    })
    .catch((error) => {
      logger.error(
        `pe snapshot shadow comparison setup failed for ${input.method}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
}
