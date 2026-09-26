# Narrow Meri ECS release helper

`narrow-meri-ecs-release.mjs` is a **single-production-environment** gate for
`capiro-dev-api` or `capiro-dev-meriv2-orchestrator` only. `prepare` (also the
default action) uses AWS read calls and optionally writes a local manifest.
It does not build images or infer which source commit is approved.

Before use, an operator must approve the exact source scope, immutable image
digest, change window, disposable tenant, rollback owner, and production QA
procedure. There is no staging environment. Do **not** use the broad MeriV2
release scripts for this narrow rollout: they include other services and a
migration task.

Prepare one service with a reviewed image already in its exact ECR repository:

```powershell
node scripts/narrow-meri-ecs-release.mjs prepare --service api --image 123456789012.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:<64-hex-digits> --manifest .deploy-logs/narrow-meri/api-manifest.json
```

Use `--service orchestrator` and repository `capiro/dev/meriv2-orchestrator`
for the other service. The manifest captures both services' live task-definition
ARNs, immutable image digests, steady counts, deployment IDs, and available
health indicators. It does not record task-definition environment values or
Secrets Manager values. An existing manifest file is not overwritten.

After reviewing the manifest, execute **one** service with its exact prepared
rollback ARN. This action registers a cloned task definition, changes only the
selected container image, rechecks both live baselines immediately before the
service update, updates only that service, and waits for ECS stability:

```powershell
node scripts/narrow-meri-ecs-release.mjs execute --service api --manifest .deploy-logs/narrow-meri/api-manifest.json --rollback-task-definition <manifest.baseline.api.taskDefinitionArn> --ack-manual-baseline-health yes --confirm UPDATE_CAPIRO_DEV_API_PRODUCTION
```

The explicit health acknowledgment is necessary because ECS may report
`UNKNOWN` for tasks without a health check. ECS stability is **not** proof of
authentication, application behavior, or factual accuracy. Stop here, have
the user sign in through the browser, and perform the approved health/auth,
factual-value, and rollback checks. Record actual returned values and source
content. Only after a manual go/no-go should the next service receive a **new**
prepare manifest; the first manifest will fail drift checks after the rollout.
The B5 private-route override must remain unset in the first rollout.

For a deliberate rollback, use the registered ARN printed after execution as
`--expected-current-task-definition` and the prepared baseline ARN as the
rollback pin:

```powershell
node scripts/narrow-meri-ecs-release.mjs rollback --service api --manifest .deploy-logs/narrow-meri/api-manifest.json --expected-current-task-definition <new-arn> --rollback-task-definition <baseline-arn> --confirm ROLLBACK_CAPIRO_DEV_API_PRODUCTION
```

An ECS stabilization failure also attempts an automatic rollback, but the
operator must verify it. ECS has no compare-and-swap `UpdateService`: another
operator can change the service in the short interval between the final read
and update. Coordinate an exclusive release window. Registration may leave an
unused task-definition revision if a final drift check fails. A successful
ECS deployment is only a manual QA checkpoint, not release acceptance.
