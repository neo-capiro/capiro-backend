/**
 * Phase 10B-1 — governed observation-to-SourceDocument bridge, pure decision
 * half.
 *
 * The bridge turns one governed `defense_budget_source_observation` row into
 * a durably archived, SHA-bound `SourceDocument`, then hands that document to
 * the existing Phase 1-7 ingestion pipeline. This module owns only the
 * fail-closed ELIGIBILITY decision — whether a given `observation_state` may
 * even be considered for the bridge — so that decision is testable without a
 * database, exactly like `assertObservationQueueable` in `watcher.ts`.
 *
 * `review_required` / `blocked` / `withdrawn` must never reach governed
 * ingestion (same invariant the ingestion-outbox composite FK enforces at the
 * database layer). `ingested` is not a failure — it is the idempotent-replay
 * case: a prior run of the bridge already succeeded, and a retry (at-least-
 * once invocation) must converge rather than error or duplicate work. Every
 * other declared `ObservationState` value is refused by default: the current
 * watcher never actually persists `discovered` / `downloaded` / `classified`
 * / `queued` / `unchanged` / `superseded` as a *stored* row (recordObservation
 * only ever writes `review_required` or `changed`), so treating anything
 * other than `changed` and `ingested` as ineligible is the conservative,
 * fail-closed default rather than a guess about states that do not occur in
 * practice today.
 */

import { NON_QUEUEABLE_OBSERVATION_STATES, type ObservationState } from './types.js';

export type BridgeEligibility =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'idempotent_replay' }
  | { readonly kind: 'ineligible'; readonly reason: string };

/**
 * Decide whether an observation in the given state may be considered by the
 * bridge at all. This is evaluated BEFORE any byte fetch, archive, or
 * registration is attempted.
 */
export function evaluateBridgeEligibility(observationState: ObservationState): BridgeEligibility {
  if (NON_QUEUEABLE_OBSERVATION_STATES.includes(observationState)) {
    return {
      kind: 'ineligible',
      reason: `observation_state '${observationState}' must never reach governed ingestion`,
    };
  }
  if (observationState === 'ingested') {
    return { kind: 'idempotent_replay' };
  }
  if (observationState === 'changed') {
    return { kind: 'eligible' };
  }
  return {
    kind: 'ineligible',
    reason: `observation_state '${observationState}' is not eligible for the governed ingestion bridge`,
  };
}

/** A deterministic result the bridge returns when fetched bytes disagree with the persisted SHA. */
export const SOURCE_BYTES_CHANGED = 'SOURCE_BYTES_CHANGED' as const;

/**
 * Phase 10B-2 forward-looking finding — NOT a Phase 10B-1 failure and NOT
 * referenced anywhere in the per-observation ingestion bridge's active code
 * path (`observation-ingestion-bridge.service.ts`,
 * `observation-ingestion-bridge.ports.ts`). Governed per-observation
 * ingestion (archive -> SourceDocument -> parse -> verify -> durably persist
 * evidence) succeeds or fails entirely on its own terms; canonical promotion
 * is a separate, later stage this bridge does not attempt and does not gate
 * on.
 *
 * This constant documents WHY that later stage cannot simply be "the next
 * per-observation step" once it is eventually built — traced (Phase 10B-1
 * repair) starting from `ParserRouterV1Service`'s terminal result: the real
 * canonical write path, `DefenseBudgetCanonicalPromotionServiceV1.execute`
 * (Phase 7 Workstream E), is unreachable from a single-observation bridge for
 * three structural reasons, not a missing wiring detail:
 *
 *   1. **Scope mismatch.** Promotion operates on a `DefenseBudgetPromotionPlanV1`
 *      built from an ENTIRE certified cycle/family (all R-1/R-2/R-2A/R-3/R-4
 *      documents for RDT&E, the equivalent family sets for non-RDT&E and
 *      committee/Phase 6), not on one document. There is no per-document
 *      canonical projector: `canonical-projectors-v1.ts` turns an already
 *      cross-document-reconciled Phase 4/5/6 projection candidate into a
 *      `PromotionProjectionInputV1`, and that reconciliation itself only runs
 *      over a full manifest.
 *   2. **Separate human authorization.** Even a complete plan cannot execute
 *      itself: `execute-defense-budget-promotion-v1.ts` requires a
 *      `defense_budget_promotion_authorization_v1` record issued by a
 *      distinct, auditable operator action, bound by hash to the exact plan,
 *      with its own expiry — deliberately not something a bridge invocation
 *      can self-issue.
 *   3. **Separate database role.** The execution path reads
 *      `PROMOTER_DATABASE_URL` and explicitly refuses to fall back to
 *      `DATABASE_URL`; the serving API (and therefore this bridge) does not
 *      hold that credential by design.
 *
 * The Phase 10B-2 gap this leaves is real orchestration work: watching
 * per-observation bridge completions, waiting for a family/cycle's required
 * corpus, reconciling/certifying the whole family, and building a canonical
 * promotion plan to hand to the existing authorization + execute stage. None
 * of that exists yet. It is not modeled as a per-observation retry loop.
 */
export const PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING =
  'PHASE10B1_BLOCKED_CANONICAL_PROJECTION_BOUNDARY_MISSING' as const;

/**
 * Production parser artifacts still require a durable/shared implementation
 * for `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT`. Whether the existing
 * immutable S3/proof architecture can provide deterministic replay more
 * cleanly than EFS is an explicit later infrastructure decision; this phase
 * deliberately does not provision or choose that substrate.
 */
export const PARSER_ARTIFACT_STORAGE_RUNTIME_GAP =
  'PARSER_ARTIFACT_STORAGE_RUNTIME_GAP' as const;

/**
 * The lifecycle observation represents a specific immutable byte identity.
 * This is the one comparison every code path must route through — never a
 * bespoke `===` at a call site — so the "never overwrite, never silently
 * accept, never ingest under the old observation" rule is enforced in one
 * place.
 */
export function compareObservedShaToPersisted(input: {
  readonly persistedContentSha256: string;
  readonly fetchedContentSha256: string;
}): { readonly matches: boolean } {
  return { matches: input.persistedContentSha256 === input.fetchedContentSha256 };
}
