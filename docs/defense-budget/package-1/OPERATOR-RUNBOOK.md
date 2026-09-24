# Package 1 annual-operations runbook

## Invariants

- Use the exact merged GitHub `main` SHA and immutable ECR digests.
- Apply the additive Prisma migration before deploying either updated API runtime.
- Deploy the lifecycle coordinator stack with `enableLifecycleCoordinator=false` first.
- Never leave the legacy watcher and the Package 1 coordinator enabled together.
- Run the queue inventory in a read-only transaction. Do not replay or drain a row merely because it is old.
- Preserve source revisions, approvals, corrections, manifest ledgers and extraction evidence during rollback.

## Release order

1. Merge the release candidate to GitHub `main`, fast-forward local `main`, and prove both point to the same SHA.
2. Build the API and defense-api images from that SHA in native ARM64 CodeBuild. Resolve and record their immutable ECR digests.
3. Register and run a one-off API migration task with the new API digest. Require exit code zero before continuing.
4. Roll the API service to the new digest and wait for stable healthy tasks.
5. Run `snapshot-defense-budget-package1-v1 --pretty` in an isolated API task. Capture only its structured output and task identity.
6. Synthesize and deploy `Capiro-dev-DefenseBudgetAnnualOperations` with the exact defense-api digest and the schedule disabled.
7. Run the coordinator task once without `--commit`. Require zero database writes and exit code zero.
8. Run it once with `schedule-tick --commit`. Require exit code zero, no `PHASE9_SCHEDULE_TICK_FAILED` marker and bounded adapter results.
9. Disable `capiro-dev-watch-budget-docs`. Record its prior state and target.
10. Enable `capiro-dev-defense-budget-lifecycle-coordinator`. Confirm exactly one target, the expected task definition and the expected image digest.

## Queue-recovery decision

`manifest_eligible_now=true` is necessary but not sufficient. Before creating the first one-row manifest, also prove that the source's format profile is qualified on the exact drain digest and that its immutable archive object/version is readable. `replay_eligible_now=true` applies only to governed verification rejection (`governedDisposition=verification_rejected`, `verifierDecision=REJECT`). All other dead letters remain quarantined.

No recovery action is permitted when the inventory reports a candidate, active approval, correction, superseded observation/document, manifest reservation, missing archive version or live lease. Unknown is treated as ineligible.

## Scheduler rollback

1. Disable `capiro-dev-defense-budget-lifecycle-coordinator` immediately.
2. Stop any running Package 1 coordinator task only after recording its task ARN and log stream. Do not delete its log group or DLQ.
3. If the preceding manual tick and legacy task definition remain qualified, re-enable `capiro-dev-watch-budget-docs`; otherwise leave both rules disabled and operate manually.
4. Roll the API service back to its recorded pre-Package-1 task definition when runtime rollback is required. The additive migration and immutable evidence remain in place.
5. Record queue counts, active approvals, corrections and governed-manifest state in a fresh read-only snapshot. Do not delete or rewrite evidence to make counts match the baseline.

## Database rollback boundary

The migration is additive and remains applied during application rollback. Its trigger protects running Package E manifests. Removing it would weaken the safety boundary and requires a separate reviewed migration after confirming there are no running manifests; it is not part of routine rollback.
