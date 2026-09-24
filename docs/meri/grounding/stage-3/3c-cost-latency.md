# Stage 3c — cost and latency

## Measurement

`meri.canary.turn` keeps its existing token and `estimatedCostUsd` fields and adds `cost` counters for retrieval tool calls and latency, coverage follow-up tokens, Jev calls, legacy calls, and repair loops. Old events remain valid; absent counters read as zero. `buildCanaryReport` reports totals, per-completed-task values, and nearest-rank p50/p95. A completed task is a released, non-`incomplete` turn. `costPerCorrectCompletedTask` is null with `human_labels_not_supplied` unless explicit human labels are provided; runtime heuristics never stand in for correctness.

Use the component distributions to find where cost accumulates, but promote an optimization only after the same evaluation window remains within the approved quality and evidence-recall limits.

## Retry and cancellation

The Jev client is the only retry owner. It performs at most `maxAttempts` HTTP attempts for retryable 429/529 responses. Passage selection, the calibrated live-repair cascade, and the post-release shadow assessor call the provider once and do not wrap it in another retry loop.

Passage selection checks the request signal before every batch. The cascade checks cancellation before Jev and again before legacy, and live repair checks before each claim and before its repair loop. The shadow assessor owns a linked post-release controller bounded by the registry's `claim_support.shadowBudget` (`12` claims, `60,000` input tokens, `6,000 ms`); because it runs after release, its cancellation and budget cannot hold or rewrite the reply.

## Decision cache

`MERI_JEV_CACHE_MODE`, `MERI_JEV_CACHE_TENANTS`, and `MERI_JEV_CACHE_SURFACES` gate the cache; the default is `off`. Off means no lookup or cache execution. The bounded process-local LRU holds at most 1,000 successful Jev outcomes for five minutes. Its SHA-256 key includes tenant, client, evidence-envelope hash (including source/document versions), claim id and text, question version, model version, and task-registry version. Failures, unavailable results, and legacy decisions are never stored.

Shadow never serves a hit: it obtains a fresh Jev decision and measures outcome agreement. Enforce may serve a hit marked `cached: true`; the served decision has zero latency and no usage tokens. Promote only after a predeclared representative sample of at least 1,000 shadow hits has at least 99.5% agreement, with unchanged quality and evidence-recall gates. Cache telemetry is `{ mode, lookups, hits, agreements }` when enabled and absent when off.

## Why claim support remains v1

`claim_support.v1` remains one claim per request. Combining claims changes the question state and evidence packet, can introduce cross-claim leakage, and invalidates existing calibration. A future `claim_support.v2` must define a bounded multi-claim schema, preserve claim-to-evidence isolation, specify partial/malformed response behavior, receive fresh calibration and task-registry versioning, and pass quality/evidence-recall evaluation before rollout.
