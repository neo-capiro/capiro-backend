# Business Development Phase 5 — Operations and Rollback

Status: release runbook. Exact merged SHA, image digests, task definitions, scheduler ARN, and pilot evidence are filled after the direct AWS deployment.

## Flags and limits

| Setting | Default | Meaning |
|---|---:|---|
| `BIZDEV_WATCH_ENABLED` | `false` | Global API/evaluator kill switch; HTTP, `/api/me`, and scheduled work all fail closed/no-op when false |
| tenant `businessDevelopment.enabled` | `false` | Existing base Business Development enrollment |
| tenant `businessDevelopment.watch.enabled` | `false` | Phase 5 enrollment; both tenant flags are required |
| `BIZDEV_WATCH_SOURCE_FAMILIES` | five supported existing projections | Comma-separated validated allowlist; acquisition revision is excluded; unknown/empty fails closed when enabled |
| `BIZDEV_WATCH_MAX_PER_RUN` | `50` | Maximum source-state claims per evaluator invocation (1..500) |
| `BIZDEV_WATCH_MAX_RECORDS_PER_SOURCE` | `50` | Complete-read bound per watch/source (1..500); exceeding it produces partial, no delivery, no baseline advance |
| `BIZDEV_WATCH_LEASE_SECONDS` | `300` | Claim lease duration (30..3600 seconds) |

The internal pilot uses global-on plus both tenant flags on only for the named internal tenant. Backfilled watches in other tenants cannot be claimed because candidate discovery filters tenant settings before the lease claim.

## Scheduler and retry ownership

`bizdev-watch-scan` is the only evaluator verb. It performs one bounded pass and exits; there is no process-local cron, provider call, sleep, retry loop, or duplicate ingestion schedule. EventBridge/ECS is the sole re-invoker. A failed task is observed and retried only by the external scheduling policy.

The scheduled task uses the reviewed API image digest and existing database secrets/network configuration. It overrides only the container command to `bizdev-watch-scan`. It must not invoke any `sync-*`, `ingest-*`, provider, or general-purpose task-runner command.

## Cost and blast-radius controls

Cost is bounded database work only: claim count, record count, source allowlist, short-lived execution, and tenant flags. There are no provider credits, LLM calls, embeddings, or network-egress fetches in the evaluator. The CLI prints one JSON summary containing checked, baselined, candidates, duplicates, delivered, suppressed, partial, failed, and durationMs.

## Failure, replay, and overlap

- Each source state is independent. Read failure, incomplete results, review, or malformed observations release only the worker's lease and do not advance the last complete baseline/check marker.
- Alert insertion is conflict-safe. Only a newly inserted alert receives a delivery and prospect activity. Duplicate replay can still commit the complete baseline.
- Every finalization predicates on the claim token. If a lease expires and another worker claims it, the stale worker cannot clear or overwrite the new lease.
- Paused/muted/conflict-excluded/dismissed scopes receive no delivery. Backfill delivery is suppressed by default. Ending a watch clears the legacy `watch_requested` bit.
- No negative claim is manufactured from missing or stale source data.

## Observability

Retain the evaluator JSON line in CloudWatch. Inspect per-source state for `health`, `last_attempt_at`, `last_successful_complete_check_at`, `last_error`, `consecutive_failures`, and lease expiry. Inspect alert/delivery uniqueness and recipient state through the standard tenant-scoped read path. Logs must contain counts and technical row identities only, not prospect notes or private firm reasoning.

Pilot gates include zero cross-tenant access, zero duplicate recipient delivery, zero confident ambiguous-identity alert, zero false stage/amount claim in the reviewed sample, zero provider-network calls, and no partial/error baseline advancement.

## Rollback

1. Set `BIZDEV_WATCH_ENABLED=false` on the API and evaluator task environment.
2. Disable the EventBridge rule/target.
3. Turn off tenant `businessDevelopment.watch.enabled` for pilot tenants if the API surface must disappear immediately.
4. Restore the previous API, Meri orchestrator, and web task definitions in reverse deployment order.
5. Retain the additive migration and tenant records for audit/recovery. Do not delete alerts or canonical projection rows during operational rollback.

The rollback never changes an existing source ingestion task, cadence, credential, or projection.

## Release record

The rollout writes a machine-readable external evidence packet under the release
orchestration directory. This repository intentionally does not hard-code mutable
AWS identifiers or attempt to embed a commit's own SHA in that commit. The packet
must contain:

- reviewed and merged 40-character commit SHA;
- API, Meri orchestrator, and web immutable image digests and task definitions;
- migration task definition, task ARN, stop code, and container exit code;
- evaluator task definition and EventBridge rule/target ARN;
- pilot tenant IDs and flag state;
- manual quiet-baseline metrics and RLS/browser verification results;
- known rollback task definitions.

## AWS verification

After merging, use AWS CLI to:

1. resolve each exact-SHA ECR tag to an immutable digest;
2. clone/register task definitions pinned to those digests and release SHA;
3. run the additive migration task and require exit code 0;
4. update API, Meri orchestrator, then web, requiring each ECS service to stabilize;
5. register/update the DB-only evaluator task and EventBridge target;
6. confirm the rule state, target command, network configuration, image digest, and no concurrently orphaned watch tasks;
7. inspect CloudWatch and the tenant-scoped watch state after a quiet baseline run;
8. test kill-switch no-op and restore the pilot setting.

Any failed migration or unstable service stops the rollout. Already-updated services are restored to the recorded baseline task definitions; the additive migration remains in place.
