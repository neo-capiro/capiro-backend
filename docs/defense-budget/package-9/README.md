# Defense-budget Package 9 — operations, load, and recovery qualification

Package 9 defines the evidence required before any defense-budget workload can move beyond shadow processing. This package contributes executable fail-closed gates and reproducible qualification protocols. The retained evidence now includes a limited disposable-PostgreSQL concurrent outbox/recovery and compiled-query run, a separate 30-minute local synthetic product-query run, a limited local composite populated tenant-canary/emergency-routing/active-pointer rollback run, and a complete synthetic warning/stop alarm matrix delivered through isolated AWS CloudWatch-to-SNS-to-SQS resources. Those runs do not prove production-representative sustained concurrent load, HTTP/authentication/network or verified-update latency, human alarm acknowledgement, stop-admission, authenticated deployed or production response-equivalence rollback, attributable incremental cost, independent accuracy, buyer outcomes, or commercial economics. The decision remains `NO_GO`, and no new activation beyond the already authorized shadow posture is allowed.

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
- [Disposable durable-database harness](./durable-harness.md) exercises the production outbox repository and worker against isolated PostgreSQL, including a five-second concurrent run of the checked-in compiled query mix, while keeping production, buyer, accuracy, update-latency, and economics gates explicitly unqualified.
- [Corrected concurrent drain/query evidence](./evidence/durable-run-p9-20260925125747227-ef8fac.json) records a 100-row peak, four drain workers, terminal pending/leased/dead-letter `0/0/0`, 100 evidence identities, 100 logical notifications, eight fault scenarios, and 20 error-free query samples across four clients and eight operations at p95 172.174 ms. It is a short local synthetic run, not sustained production evidence.
- [Complete synthetic alarm-matrix evidence](./evidence/alarm-matrix-run-p9-f07-20260925T124316Z-08d62a.json) records all 18 required warning/stop thresholds crossing `ALARM` and recovering to `OK` through exact ephemeral AWS resources, with 36 acknowledged deliveries, no duplicates, and verified cleanup. Human acknowledgement, stop-admission, and evidence-preservation actions remain unrun.
- [Populated local composite rollback evidence](./evidence/rollback-composite-run-p9-f06-20260925T130219Z.json) records the shipped read and gate services' tenant-canary and emergency process-routing branches together with the real promotion engine's authorized pointer rollback from a deliberately defective populated Program Element response to the exact populated prior response. It also proves immutable row-hash preservation, drain pause, suppressed rollback side effects, and durable audit records against disposable PostgreSQL. Authenticated deployed and production-data rollback remain unrun.
- [Local synthetic sustained product-query evidence](./evidence/product-query-p9q-20260925042812623-c66b14bb.json) records 7,176 direct compiled service/read-store operations over a 1,800-second request-start window with zero errors and p95 7.067 ms. It used a small synthetic corpus and disposable PostgreSQL, bypassed HTTP/authentication/network hops, and did not run concurrently with the 100-row/four-worker drain.
- [AWS cost supporting observation](./evidence/aws-cost-observation-p9-20260925T112754Z.json) records a read-only 30-day Cost Explorer query and a simple account-wide annualized run rate. Because the query has no defense-budget or Package 9 cost-allocation boundary, it is supporting context only and does not pass the incremental-cost gate.

## Decision

`NO_GO` for production or paid activation. `GO` only for non-mutating shadow observation under existing authorization. Reconsider only after every required scenario has a retained run manifest and evidence bundle, all zero-loss and no-duplicate assertions pass, budget limits remain within bounds, and independent reviewers sign the result.
