# Defense-budget Package 9 — operations, load, and recovery qualification

Package 9 defines the evidence required before any defense-budget workload can move beyond shadow processing. This package contributes executable fail-closed gates and reproducible qualification protocols. The retained evidence now includes a limited disposable-PostgreSQL outbox/recovery run and one limited isolated AWS CloudWatch-to-SNS-to-SQS alarm-delivery/recovery run. Those runs do not prove sustained product load or latency, every required warning and stop alarm, stop-admission, projection/routing rollback, cost, independent accuracy, buyer outcomes, or commercial economics. The decision remains `NO_GO`, and no new activation beyond the already authorized shadow posture is allowed.

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
- [Disposable durable-database harness](./durable-harness.md) exercises the production outbox repository and worker against isolated PostgreSQL while keeping alarm, rollback, buyer, accuracy, and economics gates explicitly unqualified.
- [Isolated alarm-delivery evidence](./evidence/alarm-delivery-run-p9-f07-20260925T030858Z-5d9b39.json) records the limited synthetic AWS alarm and recovery path. The reusable harness is `scripts/qualify-package9-f07-isolated.ps1`; it creates only uniquely named ephemeral resources, never uses the production alarm topic, and verifies cleanup.

## Decision

`NO_GO` for production or paid activation. `GO` only for non-mutating shadow observation under existing authorization. Reconsider only after every required scenario has a retained run manifest and evidence bundle, all zero-loss and no-duplicate assertions pass, budget limits remain within bounds, and independent reviewers sign the result.
