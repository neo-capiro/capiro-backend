# Runbook — Deploy the Strategy API (api-strategy) Gate-1 scaffold (DARK)

**Status:** Neo-gated. This runbook provisions a NEW Fargate service on `capiro-dev`,
which **IS real production**. Nothing here is executed by the coding agent — it is
the operator checklist for the G1 "deploys dark, health green" verification.

**What ships:** the `apps/api-strategy` service, exposing only `GET
/strategy-api/health`. No feature routes exist yet (G2+), so the service is
inherently dark — there is nothing user-facing to flag off. The `sp_*` tables +
RLS + append-only trigger + the seeded reference baseline land via the migrate
task.

**Why gated (not `cdk deploy`):** the CDK-managed ALB is a phantom and
`Capiro-dev-Compute` is wedged in `UPDATE_ROLLBACK_FAILED` (see
`infra/cdk/DRIFT-FINDINGS.md`). Live prod is served by the hand-created
`capiro-prod-alb`. So the service + target group + ALB rule are created
out-of-band (mirroring how `workspace` and `meriv2-orchestrator` were), NOT via
`cdk deploy`. The CDK code in `compute-stack.ts`/`config.ts` is authored for the
eventual stack reconciliation.

All commands: `--profile capiro-dev`, region `us-east-1`, account `967807252336`.

---

## Preconditions (one-time infra, out-of-band)

1. **ECR repo**
   ```
   aws ecr create-repository --repository-name capiro/dev/api-strategy --profile capiro-dev
   ```
2. **Extend the GHA OIDC push policy** (`capiro-gha-*`'s `ecr-push` policy) to cover
   `capiro/dev/api-strategy` — otherwise `api-strategy-image.yml` fails to push.
3. **Log group** for the serve task:
   ```
   aws logs create-log-group --log-group-name /capiro/dev/api-strategy --profile capiro-dev
   ```
   **Deliberate log-group divergence (documented so it's discoverable):**
   `compute-stack.ts` declares dedicated groups `/capiro/dev/api-strategy` and
   `/capiro/dev/api-strategy-migrate` for when the CDK stack is eventually
   reconciled. The hand-authored one-off task-defs
   (`infra/deploy/api-strategy-{migrate,reference}-taskdef.json`) instead log to
   the **existing** `/capiro/dev/api` group (with `api-strategy-*` stream
   prefixes). This is intentional: during the wedged/phantom-stack window the
   dedicated groups don't exist in AWS, and the awslogs driver fails to start a
   task whose target log group is missing — so the one-offs reuse the
   guaranteed-to-exist API group. Find their streams by the
   `api-strategy-migrate` / `api-strategy-reference` prefix.

## Step 1 — Build & push the image (CI, build-artifact only)

Trigger `api-strategy-image.yml` (GitHub → Actions → api-strategy-image → Run
workflow, env=dev), or push to `main` touching `apps/api-strategy/**`. Produces
`…/capiro/dev/api-strategy:{sha,latest}`. This workflow does NOT deploy.

## Step 2 — Apply the migration (one-off ECS task, MASTER creds)

Registers `sp_*` tables + RLS + the append-only trigger, then seeds the reference
baseline (insert-if-empty).
```
aws ecs register-task-definition --cli-input-json file://infra/deploy/api-strategy-migrate-taskdef.json --profile capiro-dev
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-api-strategy-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[<3 private subnets>],securityGroups=[<service SG>],assignPublicIp=DISABLED}" \
  --profile capiro-dev
aws logs tail /capiro/dev/api --log-stream-name-prefix api-strategy-migrate --follow --profile capiro-dev
```
Get subnets/SG from `aws ecs describe-services --cluster capiro-dev --services capiro-dev-api`.
Expect: `prisma migrate deploy` applies `20260722000000_init_strategy`, then
"Seeded N sp_reference_entry baseline row(s)." (N = 28: 16 congress + 9 PPBE lane
bars + 3 current phases).

**Verify (read-only)** via the diag run-task pattern (`capiro-dev-api-diag`, set
`app.bypass_rls`): confirm the 8 `sp_*` tables exist, `sp_reference_entry` has 28
rows, and `\d+ sp_activity_log` shows the `sp_activity_log_append_only` trigger.

## Step 3 — Create the service + target group (out-of-band, mirrors workspace)

Do NOT `cdk deploy`. Create against the live `capiro-prod-alb`:
1. Register the serve task definition (from the CDK-defined `capiro-dev-api-strategy`
   family once reconciled, or a hand-authored serve JSON mirroring
   `intel-api-serve-taskdef.json`: container `api-strategy`, `command ["serve"]`,
   port 4400, serve secrets = CLERK_SECRET_KEY + DB_HOST/PORT (master) +
   DB_USER/PASSWORD (app), env STRATEGY_PORT=4400 / DB_NAME=capiro / WEB_ORIGIN /
   CLERK_JWT_ISSUER, logs → /capiro/dev/api-strategy).
2. Create target group `capiro-prod-api-strategy-tg` (VPC, port 4400, target-type
   IP, health-check path `/strategy-api/health`, healthy code 200).
3. Create the ECS service `capiro-dev-api-strategy` (cluster `capiro-dev`, desired 1,
   private subnets, the shared service SG, circuit-breaker rollback) wired to the tg.

## Step 4 — Add the ALB rule (out-of-band, phantom-ALB workaround)

On the live `capiro-prod-alb` HTTPS:443 listener. Taken priorities there:
workspace≈12, meriv2-orch=13, /webhooks/*=15 — pick a free one `< 20` (e.g. 16):
```
aws elbv2 create-rule --listener-arn <capiro-prod-alb :443 listener ARN> \
  --priority 16 \
  --conditions Field=path-pattern,Values='/strategy-api/*' \
  --actions Type=forward,TargetGroupArn=<capiro-prod-api-strategy-tg ARN> \
  --profile capiro-dev
```

## Step 5 — Verify health green

```
curl -sS https://app.capiro.ai/strategy-api/health
# → {"ok":true,"service":"api-strategy"}
```
Also confirm the target group shows the task `healthy`.

## Reference baseline updates (later, as Congress/PPBE move) — FND-8

```
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-api-strategy-reference \
  --overrides '{"containerOverrides":[{"name":"api-strategy-reference","environment":[{"name":"STRATEGY_REFERENCE_JSON","value":"<json array>"}]}]}' \
  --network-configuration "awsvpcConfiguration={subnets=[…],securityGroups=[…],assignPublicIp=DISABLED}" \
  --profile capiro-dev
```
With no `STRATEGY_REFERENCE_JSON`/`STRATEGY_REFERENCE_FILE` the verb recomputes the
built-in baseline against today's fiscal calendar (a deterministic reset). It
refuses an empty payload.

## Rollback

- **Instant:** `aws ecs update-service --cluster capiro-dev --service capiro-dev-api-strategy --desired-count 0 --profile capiro-dev` — nothing else depends on the service.
- Remove the ALB rule: `aws elbv2 delete-rule --rule-arn <rule ARN>`.
- **Data:** the `sp_*` tables are purely additive and unreferenced by any other
  service; they can be left in place. If a full teardown is required, apply the
  down direction (DROP the `sp_*` tables, enums, the `enforce_sp_activity_log_append_only`
  function + trigger; leave the shared `current_tenant_id()/rls_bypass()/current_user_id()`
  functions, which pre-exist from apps/api).

## Notes / guardrails

- `capiro-dev` IS real prod. The migrate task uses the **master** DB credential
  (DDL + RLS `GRANT`s); the serve task uses the least-privilege **app** role.
- Auth (`@capiro/auth`, Clerk) is reused unchanged — do not edit the
  change-controlled guard/clerk files.
- Feature-flag enforcement (`strategyPlanner.enabled` / `.meri`) is added in G2;
  at G1 the service is dark by construction (health-only).
