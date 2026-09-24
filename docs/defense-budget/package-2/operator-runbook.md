# Package 2 operator runbook

## Deployment boundary

Deploy only the ARM64 `apps/meriv2-orchestrator/Dockerfile` image to `capiro-dev-meriv2-orchestrator`. The API and defense-api services do not own the live Jev call sites and need no Package 2 image rollout.

Every AWS command must use `--profile capiro-dev --region us-east-1`. Use a narrow manual ECR/ECS CLI flow for this service; the repository's generic prepare/ship scripts target the API path and are not appropriate for this rollout.

The image must be built from the exact merged GitHub `main` SHA and tagged with that SHA. Register a new task-definition revision by copying revision 80, changing only the container image and release-SHA environment fields, then update the service with `--force-new-deployment`. Do not alter `MERI_JEV_TASKS`, provider modes, tenant enrollment, surface enrollment or secret references as part of this release.

## Qualification

1. Confirm local `main` and `origin/main` resolve to the same merge SHA.
2. Build and push the ARM64 image with AWS ECR authentication.
3. Resolve the pushed digest and verify it belongs to the exact merge-SHA tag.
4. Register the task definition and update the service through AWS CLI.
5. Wait for `services-stable`; require desired 1, running 1, pending 0 and no failed deployment.
6. Inspect the running task and require the expected digest and release SHA.
7. Re-read the task environment and require `MERI_JEV_TASKS=claim_support,passage_relevance`. The Package 2 task names must remain absent.
8. Check target health and recent service events. No paid Package 2 provider calls are needed for deployment qualification.

The public health target is `https://app.capiro.ai/meri-api/health`.

## Rollback

The pre-change rollback point is task definition `capiro-dev-meriv2-orchestrator:80`, digest `sha256:fa3e6aa90e4e9f7ddbc88b2167303e233638c2454c201dfd7c01b0729788ffa9`.

If service health, startup or configuration checks fail, update the service back to revision 80 with AWS CLI and wait for stability. A later flag-only containment revision may set Jev provider and passage selection modes to `off`, but Package 2 itself does not change those flags.
