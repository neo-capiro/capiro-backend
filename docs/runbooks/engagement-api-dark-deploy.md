# engagement-api Dark Deploy — Runbook

**Micro-session:** 2.13 · covers Gates A–D from the [full Phase 2 plan](../../../phase-2-engagement-api-dark-fargate-executable-plan.md)

This is the end-to-end sequence for taking `engagement-api` from code-complete
to a dark, preview-only Fargate service. Every gate below is a **separate
explicit authorization** — approving one does not authorize the next.

**No AWS credentials exist in the environment that produced micro-sessions
2.0–2.14.** Gates B through D require a session with real AWS access; nothing
past 2.14 has been executed.

---

## Prerequisites

- [Phase 2 input lock](../plans/engagement-api/phase-2-input-lock.md) — Phase
  0/1 acceptance references and locked input hashes.
- [Phase 2 handoff, 2.0–2.10](../plans/engagement-api/phase-2-handoff-2.0-to-2.10.md).
- `pnpm verify:engagement-phase-2` passes. This is Gate A's acceptance
  criterion — see below.

---

## Gate A — code and synth only (no AWS mutation)

**Allowed:** edit code, run tests, build a local ARM64 OCI artifact, synth
test templates, run `cdk diff` read-only, open the draft PR.

**Not allowed:** create ECR, push an image, deploy a stack, create a listener
rule, scale a service.

```bash
pnpm verify:engagement-phase-2
```

This is exactly [micro-sessions 2.0–2.12](../plans/engagement-api/phase-2-handoff-2.0-to-2.10.md).
It uses no AWS credentials and makes no live call; every AWS/docker
interaction it exercises runs against a fake binary the tests themselves
assert on.

---

## Gate B — Registry and Network foundation

**Requires explicit authorization naming:** environment, account, region,
Registry stack, Network stack.

```bash
export ENGAGEMENT_API_INFRA_CONFIG=/absolute/path/to/<env>-config.json  # NOT the test fixture
cd infra/cdk

# Read-only first.
AWS_REGION=... CAPIRO_ENV=<env> EXPECTED_AWS_ACCOUNT_ID=... \
  EXPECTED_VPC_ID=... EXPECTED_ECS_CLUSTER_ARN=... \
  EXPECTED_HTTPS_LISTENER_ARN=... EXPECTED_MAIN_API_TARGET_GROUP_ARN=... \
  EXPECTED_GENERIC_API_RULE_PRIORITY=<discovered> \
  bash ../../scripts/engagement-api-infra-discover.sh

pnpm exec cdk deploy \
  Capiro-<env>-EngagementApiRegistry \
  Capiro-<env>-EngagementApiNetwork \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts" \
  --require-approval never
```

**After deploy, verify:**
- ECR repository is immutable, scanned, KMS-encrypted, retained.
- Target group is empty, IP type, port 4500, `/health` check.
- No listener rule was created — `cdk deploy` never creates one; only
  micro-session 2.11's script may.
- Current product health unaffected. Generic `/api/*` rule and Recall
  unchanged.

Never build with `pnpm --dir infra/cdk run build`'s `dist/` output for
deployment identifiers — always re-derive from `cdk diff`/`describe-stacks`
after a real deploy.

---

## Gate D-part-1 — associate the empty target group

**Before the ECS service exists**, authorize creating the exact priority-6
preview rule:

```bash
export AWS_REGION=... EXPECTED_AWS_ACCOUNT_ID=... HTTPS_LISTENER_ARN=... \
  ENGAGEMENT_TARGET_GROUP_ARN=<from the Network stack output> \
  MAIN_API_TARGET_GROUP_ARN=... GENERIC_API_RULE_PRIORITY=<discovered>

bash scripts/engagement-api-alb-rules.sh verify-baseline

export CONFIRM_ENGAGEMENT_PREVIEW_RULE_CREATE="${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:6"
bash scripts/engagement-api-alb-rules.sh create-preview
bash scripts/engagement-api-alb-rules.sh verify-preview
```

At this point preview-header requests may return 503 (no registered targets
yet). **Do not tell any user to try the preview during this interval.**
Ordinary traffic must remain on main throughout — confirm with a manual
request to a normal Engagement route.

Full detail: [engagement-api-preview-rule.md](engagement-api-preview-rule.md).

---

## Gate C — image push and service deploy

**Requires explicit authorization naming:** release SHA, repository,
environment, service stack.

```bash
export RELEASE_SHA=<40-hex git sha> CAPIRO_ENV=<env> AWS_REGION=... \
  EXPECTED_AWS_ACCOUNT_ID=...

bash scripts/engagement-api-image.sh build
export CONFIRM_ENGAGEMENT_IMAGE_PUSH="${EXPECTED_AWS_ACCOUNT_ID}:${AWS_REGION}:${RELEASE_SHA}"
bash scripts/engagement-api-image.sh push
bash scripts/engagement-api-image.sh describe   # writes image-digest.txt
bash scripts/engagement-api-image.sh verify-scan
```

Update the deployment config with the resolved `imageDigest` and
`releaseSha`, then:

```bash
cd infra/cdk
pnpm exec cdk deploy \
  Capiro-<env>-EngagementApiService \
  --app "ts-node --prefer-ts-exts bin/engagement-api.ts" \
  --require-approval never
```

**After deploy:** wait for ECS steady state, wait for the target to register
healthy, then send exactly one safe preview read
(`GET /api/engagement/capabilities` with the preview header) and verify:

- `X-Capiro-Service: engagement-api`
- `RELEASE_SHA` matches
- shadow posture (`ENGAGEMENT_PROCESS_MODE=shadow`, etc. — see
  `scripts/verify-engagement-api-task-config.mjs`)
- the UI contract hash is present as nonsecret metadata
- no worker started, no external action reachable

Full acceptance: [engagement-api-ui-aware-preview-acceptance.md](engagement-api-ui-aware-preview-acceptance.md)
(micro-session 2.12's manifest; the live run is 2.18).

---

## Rollback

See [engagement-api-rollback.md](engagement-api-rollback.md). Short version:
delete the preview rule first, verify the current product, only then consider
scaling or destroying the service.

---

## What does NOT happen in any gate above

- No merge (Phase 10).
- No canonical `/api/engagement/*` cutover.
- No Recall cutover.
- No database migration.
- No web/UI change.
- No Outreach V3 UI.
- No mutation of the frozen historical Compute stack.
