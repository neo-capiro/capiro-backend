PASS

The implementation correctly addresses the one-shot recovery scenario:

1. **No re-registration risk**: Hard-codes CANDIDATE=arn:...:489, never calls register-task-definition. Single exact update enforced via CLI arg check and mutation counter.

2. **Binding verification**: `inspect()` verifies original files unchanged (sha256), baseline 488 still live, candidate 489 ACTIVE, normalized hashes match, source ancestry preserved to docs/ only.

3. **Exclusive claim**: `wx` flag on recovery plan and execution files ensures single execution.

4. **Durable intent**: status progresses READY → UPDATE_INTENT (persisted) → UPDATE_ACKNOWLEDGED → ecs-healthy with full rollback capture.

5. **Fresh proof**: `inspect()` re-run in `run()` catches any drift between prepare and execution.

6. **Runtime verification**: Waits for single COMPLETED deployment, verifies task health via release.snapshot (existing ALB/target-health checks), validates no concurrent deployments or config drift.

7. **No path widening**: Minimal scope - one service, one candidate, no retries, reconciliation-required on any anomaly.

Real defect considerations addressed:
- `need(currentMain() === plan.operatorHead)` catches commits between prepare and run
- `definitionProjection` normalizes environment ordering differences only, catches semantic changes
- Update timeout enters RECONCILIATION_REQUIRED without retry
- Deployment ID mismatch (foreign primary) caught immediately
- Health failure exits to reconciliation rather than rollback attempts

The test suite (5/5) validates the flow including failure modes. No additional execution required from this review.