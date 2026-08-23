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
