# Defense-budget Package 9 — operations, load, and recovery qualification

Package 9 defines the evidence required before any defense-budget workload can move beyond shadow processing. This package contributes executable fail-closed gates and reproducible qualification protocols. A local in-memory component test exercises the production outbox worker's 100-row/four-worker, retry, stale-lease and injected-failure paths; it is not durable-database, notification-ledger, sustained-load, latency, alarm, rollback, cost, independent-accuracy, or buyer evidence. Those qualification scenarios remain `NOT_RUN`, the decision is `NO_GO`, and no new activation beyond the already authorized shadow posture is allowed.

## Governing limits

The inherited Package 0 limits remain hard ceilings until an approved, measured replacement exists:

| Measure                          |      Limit |
| -------------------------------- | ---------: |
| Peak pending outbox rows         |        100 |
| Dead-letter rows                 |         10 |
| Oldest pending age               | 60 minutes |
| Concurrent drain tasks           |          4 |
| Common interactive query p95     |   2,000 ms |
| Incremental AWS annual spend     |     $1,000 |
| Paid provider annual spend       |       $500 |
| Paid provider default allocation |         $0 |

These are limits, not forecasts or results. Do not admit work that would cross a cap. The zero paid-provider default means all provider-failure qualification uses deterministic local stubs until a separately named and approved paid manifest sets a bounded allocation.

## Qualification artifacts

- [Failure and load qualification matrix](./failure-recovery-qualification.json) contains fixed workload definitions, injections, assertions, owner functions, alarms, and the current unrun status for each scenario.
- [Buyer benchmark protocol](./buyer-benchmark-protocol.md) specifies six plan workflows, blinded independent adjudication, and decision gates.
- [Operator and activation runbook](./operator-runbook.md) defines stage gates, alarms, stop conditions, and rollback behavior.
- [Validation status](./validation-evidence.md) records local code/artifact checks and the explicit limits of the component test.
- [Current release scorecard](./current-release-scorecard-2026-09-25.json) records the executable `NO_GO`/shadow-only decision and every blocker.
- [Current Jev economics report](./jev-economics-current-2026-09-25.json) records the proposed/unpriced fixture's `NO_GO` result without inventing savings.
- [Release and deployment evidence](./release-evidence-2026-09-25.json) binds the Package 9 merge to the AWS build, image digest, healthy ECS rollout, read-only inventory, alarms, and the retained `NO_GO` activation decision.

## Decision

`NO_GO` for production or paid activation. `GO` only for non-mutating shadow observation under existing authorization. Reconsider only after every required scenario has a retained run manifest and evidence bundle, all zero-loss and no-duplicate assertions pass, budget limits remain within bounds, and independent reviewers sign the result.
