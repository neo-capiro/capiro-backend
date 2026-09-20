# Package E governed ingestion operator runbook

## Current disposition

This runbook describes the Package E v1 operator surface. It is not an
authorization record.

- The only environment is `capiro-dev` in `us-east-1`.
- There is no authorized runnable manifest. The proposal is qualification-only
  and has `runnableProductionManifest: null`.
- Air Force FY27 RDT&E Volume I is excluded after two deterministic Package D
  qualification failures.
- Package D is the production baseline. Its image does not contain Package E.
- A Package E release may occur only from a reviewed merged commit, through AWS
  CLI, after exact-image qualification. Deployment must leave the drain parked
  at `echo no-op-default-command` and must not launch a batch.

## Command and immutable-input contract

The container command is:

```text
/usr/local/bin/entrypoint.sh run-defense-budget-ingestion-manifest-v1 <arguments>
```

The repository-side prefix is:

```powershell
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 --
```

Preview is the default and may read a local reviewed file. Production
`--start` and `--resume` refuse local files: they require both an immutable
versioned S3 URI and an independent SHA-256 of the complete object bytes.

```text
--manifest-s3-uri s3://<bucket>/<key>?versionId=<non-null-version>
--manifest-object-sha256 <64 lowercase hex>
```

The object must be JSON, 1–2,000,000 bytes, and parse as a self-hashed v1
manifest. Credentials, presigned query fields, unversioned objects, extra query
fields, and a `null` version are refused.

Before a write, retain the operation/content hash, exact ordered member and
exclusion list, source/archive coordinates, lifecycle IDs and expected states,
runtime/config/image/task identities, limits, and authorization record.
Start/resume also require exact `GIT_SHA`, `API_IMAGE_DIGEST`,
`DEFENSE_BUDGET_DRAIN_IMAGE_DIGEST`, and `ECS_TASK_DEFINITION_ARN` environment
bindings. Non-secret `BUDGET_*` and `DEFENSE_BUDGET_*` settings plus region
must hash to `runtimeConfigSha256`.

The process reads the ECS v4 task metadata endpoint and independently verifies
the full task-definition family/revision, `ingestion-drain` container image
digest, 4-vCPU/8192-MiB task limits, and exact TaskARN. That TaskARN becomes the
durable task/job ID. If `--task-job-id` is supplied, it must equal the attested
TaskARN; normally omit it.

## Preview

Preview performs contract and database eligibility checks only. It does not
register a manifest, lease an outbox row, read source bytes, run a parser, or
write readiness/approval/correction/canonical state.

Local source-tree preview:

```powershell
$env:APP_ENV = 'capiro-dev'
$env:AWS_REGION = 'us-east-1'
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 -- --manifest C:\approved\package-e-manifest.json
```

Preview the exact object intended for an eventual task:

```powershell
$env:APP_ENV = 'capiro-dev'
$env:AWS_REGION = 'us-east-1'
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 -- `
  --manifest-s3-uri 's3://<bucket>/<key>?versionId=<version>' `
  --manifest-object-sha256 '<sha256>'
```

Require `outcome: "preview"` and an empty `preflightIssues` array. Any issue
is a no-go. Never edit reviewed bytes in place; changed membership, source,
runtime, limits, or capacity requires a new reviewed manifest and authorization
boundary.

## Start — exact authorization required

Run only inside the digest-pinned ECS task defined by the manifest, after an
authorized preview of the same object version and object hash:

```text
run-defense-budget-ingestion-manifest-v1
--start
--manifest-s3-uri
s3://<bucket>/<key>?versionId=<version>
--manifest-object-sha256
<sha256>
--confirm
capiro-dev
```

Use `aws ecs run-task --profile capiro-dev --region us-east-1` with the
reviewed task-definition revision, current reviewed network configuration, and
the argument vector above. Do not construct a shell command, embed manifest
JSON, use a mutable tag, or widen membership in the override. V1 processes one
document at a time.

There is currently no authorized object or eligible production row, so this
command must not be launched.

## Status

```powershell
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 -- --status --operation-id <operation-uuid>
```

Inspect operation status and each item's source/archive/artifact identity,
candidate/run/task ID, attempts, timing, retry eligibility, and failure group.
The summary reports selected, archived, extracted, pending, running, retry,
evidence-ready, REVIEW, PASS, REJECT, quarantined, and uncertain separately.
`approvals`, `readiness`, and `canonicalPublication` must remain
`not_performed`.

## Stop new work

```powershell
$env:APP_ENV = 'capiro-dev'
$env:AWS_REGION = 'us-east-1'
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 -- `
  --stop-new-work --operation-id <operation-uuid> --confirm capiro-dev
```

Stop is cooperative: it prevents the next claim while the in-flight owner keeps
heartbeating only until the earlier of its document deadline and the operation
deadline. At that boundary the controller signals parser cancellation, fences
new verification persistence and terminal checkpointing, and records the
member as `uncertain` for exact-task reconciliation. An exact `evidence_ready`
checkpoint already committed before the boundary may still be adopted and
finalized instead of reparsed. Do not terminate an ECS task merely because
stop was requested. A forced or ambiguous termination must also enter
exact-task reconciliation before retry.

## Resume

First inspect status and confirm there is no unresolved `uncertain` item.
Resume refuses an unknown operation or a different manifest hash.

```text
run-defense-budget-ingestion-manifest-v1
--resume
--manifest-s3-uri
s3://<bucket>/<key>?versionId=<same-version>
--manifest-object-sha256
<same-sha256>
--confirm
capiro-dev
```

Launch this argument vector with AWS CLI using the same immutable runtime
identity. A terminal operation returns persisted state without parsing again.
A due transient retry remains bounded by the original attempt and elapsed
limits. Committed candidate/evidence correlation is adopted rather than
reparsed.

## Reconcile an uncertain item

Read the durable `taskJobId`, which is the attested ECS TaskARN, then observe
that exact task:

```powershell
aws ecs describe-tasks --profile capiro-dev --region us-east-1 --cluster capiro-dev `
  --tasks <exact-task-arn> `
  --query 'tasks[0].{lastStatus:lastStatus,stopCode:stopCode,stoppedReason:stoppedReason,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason,imageDigest:imageDigest}}'
```

Do not reconcile a running, missing, or ambiguous task. Save a concise,
credential-free reason file and attest only the exact recorded identity:

```powershell
$env:APP_ENV = 'capiro-dev'
$env:AWS_REGION = 'us-east-1'
pnpm --dir apps/api run run:defense-budget-ingestion-manifest-v1 -- `
  --reconcile-uncertain --operation-id <operation-uuid> --item-id <member-uuid> `
  --expected-task-job-id <exact-task-arn> --actor <operator-id> `
  --reason-file C:\approved\reconcile-reason.txt --confirm capiro-dev
```

Existing exact verification correlation returns `evidence_ready`; otherwise an
eligible item returns `retry_wait`. `ineligible` is a stop signal, not an
invitation to create a replacement manifest.

## Exit meanings

| Exit | Meaning |
| ---: | --- |
| 0 | Preview eligible; operation completed; stop/reconciliation recorded; or status found. Inspect dispositions—REVIEW or quarantine can coexist with a clean controller exit. |
| 1 | Unexpected runtime/database/archive/parser/controller exception. Preserve state and classify before retry. |
| 2 | CLI, manifest, immutable-input, environment, or runtime-attestation error. |
| 3 | Ineligible, conflict, busy, paused, not found, or reconciliation mismatch. |
| 4 | Uncertain. Block overlap and retry until the exact task is reconciled. |

`PASS`, `REVIEW`, and `REJECT` are verification dispositions, not approvals.
This command never approves or publishes facts.

## Direct AWS CLI release — only after merge

1. Fetch the reviewed default branch and prove the merge SHA is an ancestor of
   `origin/main`.
2. Inspect the current CodeBuild project with
   `aws codebuild batch-get-projects --profile capiro-dev --region us-east-1`.
   Use only a reviewed Package E buildspec that fails closed on the resolved
   merge SHA, builds Linux/ARM64 API and drain images, passes the API digest as
   the drain base, uses immutable tags, and does not deploy.
3. Resolve and record both ECR digests and architecture. Never deploy a tag.
4. Clone current task definitions into sanitized payloads. Remove output-only
   fields, preserve roles/network/logging/secrets, pin all image/sidecar
   digests, set release/runtime bindings, and assert the drain's default command
   is exactly `["echo no-op-default-command"]`.
5. Register revisions through
   `aws ecs register-task-definition --cli-input-json file://<reviewed.json>
   --profile capiro-dev --region us-east-1`.
6. Run the additive migration with `aws ecs run-task`, wait for STOPPED, and
   require exit 0 before changing the API service.
7. Qualify the exact drain digest twice in isolated Postgres/MinIO through the
   real Package E path and run the negative isolation control. Retain full task
   ARNs, definitions, image digests, logs, exit codes, reports, artifact hashes,
   and substantive-repeat comparison.
8. Update only `capiro-dev-api` to the qualified API task definition with
   `aws ecs update-service`; wait stable and verify every running
   `imageDigest`.
9. Re-audit running tasks, services, schedules, and EventBridge targets. Keep
   the newly registered drain parked. Stop; deployment does not authorize
   `run-defense-budget-ingestion-manifest-v1`.

The repository does not yet contain the reviewed buildspec/payload generator,
and no merge exists, so the AWS release sequence is currently gated.

## Evidence retention

Retain merge/tree, build ID and resolved source, image/base/architecture
identities, task definitions, migration task, qualification runs, rollout and
consumer audit. For a later authorized batch retain exact manifest object
version and both hashes, authorization, preview, protected-state baseline,
operation/item/task IDs, status/stop/resume/reconcile output, artifacts and
dispositions, timing/resource observations, and before/after approval,
correction, readiness, canonical, and out-of-manifest evidence.

Never retain secrets, database URLs, credentials, authorization headers, or
presigned URLs.
