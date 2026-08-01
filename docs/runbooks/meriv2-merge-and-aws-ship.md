# MeriV2 — Merge and AWS Ship Runbook

## Purpose

This is the authoritative operator path from PR #679 to an all-controls-dark AWS deployment and then to a bounded tenant/surface canary.

It replaces GitHub Actions as the release gate with repository-owned local commands. It does **not** weaken the database, browser, security, or deployment requirements.

> **Critical environment warning:** Capiro’s AWS environment named `dev` serves production traffic. Treat every `dev` command below as a production change.

## What is already developed

The release contains:

- governed institutional memory with immutable shared versions;
- independent review, client grants, ethical walls, legal holds, conflicts, revoke/restore, and transition history;
- exact projection/outbox recovery;
- Context Packet v2 with tenant and surface canaries;
- persisted policy packs with tenant canaries and independent review;
- government-affairs assurance across Chat, In-editor, Workspace, Strategy, Outreach, Steward, memo, and district brief;
- database, browser, accessibility, and control-system rehearsals;
- an additive projection-worker stack and an additive MeriV2 control stack;
- reversible backfill and rollback operators;
- read-only AWS discovery and release-preparation commands;
- guarded AWS mutation commands for migrations, dark ECS deployment, and dark operations-stack deployment.

The operator’s remaining responsibilities are to run the local release gate, merge, build exact-SHA images, execute the guarded deployment commands, smoke test, and activate one approved canary at a time.

---

# 1. Required roles and stop authority

Record these people in the change ticket before release:

| Role | Responsibility |
|---|---|
| Release operator | Runs commands and captures evidence |
| Database reviewer | Reviews migration and backfill evidence |
| Security reviewer | Reviews tenant/wall/grant and audit behavior |
| Product/UX reviewer | Accepts browser, accessibility, hold, and degraded states |
| Incident commander | Can stop expansion and authorize rollback |

The code implementer must not be the sole production approver.

---

# 2. Pre-merge development gate

From a clean checkout of `agent/meriv2-world-class-closeout`:

```bash
git fetch origin main agent/meriv2-world-class-closeout
git checkout agent/meriv2-world-class-closeout
git pull --ff-only origin agent/meriv2-world-class-closeout
git status --short
```

Require zero output from `git status --short`, then run:

```bash
pnpm verify:meriv2-development
```

This command performs the locked install, Prisma generation, required builds, formatting, static phase-completeness checks, package and repository typechecks, tests, evaluations, and disposable Phase 18 database rehearsal. It does not write to AWS or a shared database.

Stop on any nonzero exit code. Do not waive a failing command because a prior phase once passed.

## Authenticated browser prerequisites

Export the dedicated Phase 19 Clerk test identities and prepared live-state paths described in:

```text
docs/qa/meriv2-closeout-browser-acceptance.md
```

The test identities must not be customer identities.

---

# 3. Read-only AWS discovery and final local release gate

Collect identifiers and ARNs only:

```bash
pnpm collect:meriv2-aws-context -- \
  --env dev \
  --profile capiro-dev \
  --region us-east-1 \
  --output .artifacts/meriv2-aws-context-dev.json
```

The collector never calls `GetSecretValue` and never mutates AWS.

Then run the full release gate:

```bash
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

This adds:

- authenticated Phase 19 browser and accessibility acceptance;
- independent MeriV2 operations-stack synthesis;
- read-only AWS CDK diff.

Acceptance requires the final summary marker:

```text
MERIV2_LOCAL_RELEASE_PREFLIGHT_OK
```

Retain the `.artifacts/meriv2-release-<sha>/` evidence directory.

---

# 4. Merge PR #679

Before merging, confirm:

```bash
git fetch origin main agent/meriv2-world-class-closeout
git rev-list --count agent/meriv2-world-class-closeout..origin/main
```

The count must be `0`.

PR #679 must be:

- current with `main`;
- mergeable;
- reviewed by security/code, database, product/UX, and release operators;
- free of unresolved review threads;
- accurately documented with the local preflight evidence SHA.

Use a normal merge commit. Do not squash hundreds of historical closeout commits into an opaque production commit and do not force-push the release branch.

After merge, record the exact merge SHA:

```bash
git checkout main
git pull --ff-only origin main
export RELEASE_SHA="$(git rev-parse HEAD)"
test "${#RELEASE_SHA}" -eq 40
```

Run the release gate again on the exact merge SHA:

```bash
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

The merge SHA—not the pre-merge branch SHA—is the production artifact identity.

---

# 5. Capture production rollback points

```bash
export AWS_PROFILE=capiro-dev
export AWS_REGION=us-east-1
export CAPIRO_ENV=dev
export CLUSTER=capiro-dev
export EVIDENCE_DIR=".deploy-logs/meriv2-${RELEASE_SHA}"
mkdir -p "$EVIDENCE_DIR"

aws sts get-caller-identity \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  > "$EVIDENCE_DIR/00-caller.json"
```

Capture current service task definitions:

```bash
for service in api meriv2-orchestrator workspace api-strategy web; do
  aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "capiro-dev-${service}" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --output json \
    > "$EVIDENCE_DIR/01-${service}-baseline.json"
done
```

Also record:

- current database snapshot identifier and restore procedure;
- current API migration status;
- current EventBridge rule states;
- active alarms;
- current nonsecret feature values;
- current image digests;
- incident commander and rollback decision window.

Stop if a core service is already degraded or a database migration is already running.

---

# 6. Build and push exact-SHA ARM64 images

Authenticate Docker to ECR:

```bash
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity \
  --profile "$AWS_PROFILE" \
  --query Account \
  --output text)"
export ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

aws ecr get-login-password \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
```

Build and push every service from the exact merge SHA checkout:

```bash
docker buildx build --platform linux/arm64 \
  -f apps/api/Dockerfile \
  -t "$ECR_REGISTRY/capiro/dev/api:$RELEASE_SHA" \
  --push .

docker buildx build --platform linux/arm64 \
  -f apps/meriv2-orchestrator/Dockerfile \
  -t "$ECR_REGISTRY/capiro/dev/meriv2-orchestrator:$RELEASE_SHA" \
  --push .

docker buildx build --platform linux/arm64 \
  -f apps/workspace/Dockerfile \
  -t "$ECR_REGISTRY/capiro/dev/workspace:$RELEASE_SHA" \
  --push .

docker buildx build --platform linux/arm64 \
  -f apps/api-strategy/Dockerfile \
  -t "$ECR_REGISTRY/capiro/dev/api-strategy:$RELEASE_SHA" \
  --push .

docker buildx build --platform linux/arm64 \
  -f apps/web/Dockerfile \
  -t "$ECR_REGISTRY/capiro/dev/web:$RELEASE_SHA" \
  --push .
```

Verify every tag resolves:

```bash
for repository in \
  capiro/dev/api \
  capiro/dev/meriv2-orchestrator \
  capiro/dev/workspace \
  capiro/dev/api-strategy \
  capiro/dev/web; do
  aws ecr describe-images \
    --repository-name "$repository" \
    --image-ids "imageTag=$RELEASE_SHA" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --query 'imageDetails[0].imageDigest' \
    --output text
done
```

Do not reuse or move `latest` as the release identity.

---

# 7. Prepare dark task definitions with read-only AWS calls

```bash
pnpm prepare:meriv2-ecs-release -- \
  --sha "$RELEASE_SHA" \
  --env dev \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
```

This produces task-definition JSON and a manifest under:

```text
.deploy-logs/meriv2-ecs-release/<release-sha>/
```

It does not mutate AWS. Review the generated environment values. The initial deployment must contain:

```text
MEMORY_GOVERNANCE_TENANTS=
MEMORY_GOVERNANCE_LIFECYCLE=off
MEMORY_GOVERNANCE_ENFORCE=off
MEMORY_CLIENT_REVIEW=off
MEMORY_GOVERNANCE_CENTER=off
MEMORY_AUTOLEARN_GOVERNED=false
MERIV2_CONTEXT_PACKET_V2=off
CONTEXT_PACKET_V2=
MERI_POLICY_PACK_SOURCE=off
MERI_POLICY_PACK_TENANTS=
MERI_RELEASE_GATE=off
MERI_RELEASE_GATE_TENANTS=
MERI_RELEASE_GATE_SURFACES=
```

A stale broad tenant allowlist is a release blocker even when another switch appears off.

---

# 8. Apply migrations and deploy all services dark

The guarded executor resolves every SHA tag to an immutable ECR digest before registration, runs the dedicated migration task first, then updates the five services one at a time. If a service fails to stabilize, it restores all services already changed to their previous task definitions. Additive migrations remain in place.

```bash
pnpm ship:meriv2-ecs-release -- \
  --sha "$RELEASE_SHA" \
  --manifest ".deploy-logs/meriv2-ecs-release/$RELEASE_SHA/manifest.json" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --confirm DEPLOY_CAPIRO_DEV_PRODUCTION
```

Acceptance marker:

```text
MERIV2_ECS_DARK_RELEASE_COMPLETE
```

This command intentionally does **not**:

- run a governance backfill;
- enable any tenant;
- enable Context Packet v2;
- publish or enforce a policy pack;
- enable assurance;
- enable either EventBridge schedule;
- send an external communication.

Stop on any migration failure. Never use `prisma migrate resolve`, edit `_prisma_migrations`, or apply hand-written production repair SQL as part of this release.

---

# 9. Deploy only the additive operations stacks, still dark

Use the context document collected before release:

```bash
pnpm deploy:meriv2-operations-dark -- \
  --sha "$RELEASE_SHA" \
  --context .artifacts/meriv2-aws-context-dev.json \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --confirm DEPLOY_CAPIRO_DEV_OPERATIONS_DARK
```

Acceptance marker:

```text
MERIV2_OPERATIONS_DARK_DEPLOY_COMPLETE
```

The command deploys only:

```text
Capiro-dev-MemoryProjectionWorker
Capiro-dev-MeriV2Control
```

It explicitly verifies both rules remain `DISABLED`:

```text
capiro-dev-memory-projection-worker
capiro-dev-meriv2-control-monitor
```

Do not deploy the historical Compute stack merely to introduce these controls. The dedicated operations app imports the live cluster, subnets, security group, secrets, KMS keys, API ECR repository, and encrypted alert topic.

---

# 10. Dark production smoke test

Before any flag or schedule changes, verify with an internal tenant:

- API `/health`;
- web `/healthz`;
- MeriV2 orchestrator health;
- Workspace health;
- Strategy API health;
- legacy chat and MeriV2 chat;
- in-editor assistance;
- Workspace generation, including standalone `generate-section`;
- Strategy drafting and Steward extraction;
- existing memory reads and private writes;
- no migration errors;
- no cross-tenant or ethical-wall disclosure;
- no prompt, memory body, token, secret, or customer content in control logs.

Run read-only diagnostics:

```bash
pnpm --filter @capiro/api exec tsx scripts/emit-meriv2-control-metrics.ts
pnpm --filter @capiro/api exec tsx scripts/diag-memory-governance-v2.ts \
  --tenant-id <internal-tenant-uuid>
```

Do not proceed if any core service is unstable, any dead-letter exists, or a confidential value appears in evidence.

---

# 11. Enable the projection worker, then the control monitor

## Projection worker

First run the worker task manually against no work or a controlled test obligation. Verify bounded logs and exact completion. Then update only the `Capiro-dev-MemoryProjectionWorker` stack with:

```text
enableMemoryProjectionWorker=true
meriv2ApiImageTag=<exact release SHA>
```

The stack refuses an armed schedule with `latest` or any non-SHA tag.

## Control monitor

Run its task manually once on the migrated schema. Then update only the `Capiro-dev-MeriV2Control` stack with:

```text
enableMeriV2ControlMonitor=true
meriv2ApiImageTag=<exact release SHA>
```

Verify two consecutive five-minute snapshots and encrypted SNS routing. Do not run the deliberate alarm-breach demonstration in `dev`; it is production.

---

# 12. Activate one internal tenant in order

Use exact UUIDs. Do not use `all` in production canaries.

## 12.1 Governed memory

Set on the API task definition:

```text
MEMORY_GOVERNANCE_TENANTS=<internal-tenant-uuid>
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_CENTER=enforce
```

Verify:

- first-time shared Settings file → standard independent-review proposal;
- edit to existing shared Settings file → immutable correction proposal;
- approval creates a new controlling version and retains prior history;
- stable Settings type/slug reload resolves the new controlling version;
- proposer cannot self-approve;
- client-granted reviewer works without admin elevation;
- ethical wall still binds admins and grantees;
- correction, conflict, revoke, restore, legal hold, and projection retry behave truthfully.

## 12.2 Context Packet v2 shadow

Set the global ceiling:

```text
MERIV2_CONTEXT_PACKET_V2=shadow
```

In the internal tenant’s server-owned settings, enable only the exact initial surface:

```text
clioFeatureFlags.meriv2.contextPacketV2=true
clioFeatureFlags.meriv2.contextPacketV2.chat=true
```

Compare v1/v2 inclusion, ordering, exclusions, health, token use, latency, and wall behavior. Shadow must not change model input.

## 12.3 Persisted policy shadow

After a policy pack has completed independent review and publication through the product lifecycle:

```text
MERI_POLICY_PACK_SOURCE=shadow
MERI_POLICY_PACK_TENANTS=<internal-tenant-uuid>
```

The static reviewed baseline remains authoritative in shadow. Review every decision difference.

## 12.4 Assurance shadow

```text
MERI_RELEASE_GATE=shadow
MERI_RELEASE_GATE_TENANTS=<internal-tenant-uuid>
MERI_RELEASE_GATE_SURFACES=chat
```

Review false positives, unsupported high-risk rate, held/degraded predictions, latency, and low-risk parity.

## 12.5 Enforce in bounded order

Only after the prior shadow evidence is accepted:

1. internal Chat;
2. internal In-editor;
3. standalone Workspace section and generate-all;
4. Strategy;
5. Steward;
6. memo and district brief;
7. Outreach last;
8. one design-partner tenant;
9. small cohort;
10. general availability.

Never expand tenant and surface scope in the same change.

---

# 13. Backfill only after stable canary

The initial migration and deployment do not classify legacy rows.

For each tenant independently:

```bash
pnpm --filter @capiro/api exec tsx scripts/backfill-memory-governance-v2.ts \
  --tenant-id <tenant-uuid>
```

Review the prepared job, plan hash, counts, and quarantine. Then use the exact execute command printed by the operator with matching tenant and job confirmations. Verify before moving to another tenant.

Retain the same job ID for drift-safe rollback. Never overwrite rows changed after preparation or execution.

---

# 14. Stop conditions

Stop expansion immediately for any of these:

- tenant, private-owner, client, or ethical-wall disclosure;
- successful self-review or policy four-eyes bypass;
- required Context Packet persistence failure;
- unsupported high-risk prose released or persisted;
- stale Context Packet or policy binding accepted at the destination;
- existing shared Settings truth replaced in place;
- stable Settings identity returning a superseded version;
- outbox age over 15 minutes, repeated worker crash, or dead letter;
- legal-held data changed destructively;
- unexplained backfill quarantine or drift;
- customer prose, source excerpts, tokens, or secrets in logs/metrics;
- service deployment that does not stabilize;
- unexplained MeriV2 alarm.

---

# 15. Rollback order

1. Freeze expansion and preserve evidence.
2. Remove the smallest tenant/surface canary.
3. Set the affected subsystem to shadow or off.
4. Disable the affected EventBridge rule.
5. Restore prior ECS task definitions using the captured baseline.
6. Roll back only the exact drift-safe backfill job, if applicable.
7. Roll policy back by publishing a prior independently reviewed version.
8. Handle migration problems through a separate forward-repair change.

Do not drop additive schema during an ordinary incident. Do not reopen terminal memory rows. Do not delete audit evidence.

Detailed rollback commands are in:

```text
docs/runbooks/meriv2-memory-context-assurance-rollback.md
```

---

# 16. Definition of shipped

The release is shipped—not merely deployed—only when:

- the exact merge SHA passed the local release preflight;
- migrations succeeded without manual repair;
- all five services are stable on immutable image digests;
- both operations stacks exist and initially deployed dark;
- dark smoke tests passed;
- worker and monitor schedules were enabled and observed safely;
- one internal tenant passed governed memory, Context, policy, and assurance canaries;
- no security or confidentiality stop condition occurred;
- backfill, if started, is tenant-scoped, reviewed, and reversible;
- rollback points and evidence remain available.
