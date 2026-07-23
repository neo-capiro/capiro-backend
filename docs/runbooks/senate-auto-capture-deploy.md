# Senate Auto-Capture — Production Deploy Runbook

Ships automatic capture of every streamable Senate committee proceeding
(hearings + markups + business meetings) on **capiro-dev (= prod)**. Code is on
branch `feat/senate-auto-capture` (= `main` + capture; pushed). All steps are
prod mutations — run with `--profile capiro-dev --region us-east-1`.

**Dark-first:** everything ships with `SENATE_AUTO_CAPTURE=false`, so the poller
discovers + probes + records `live` but launches NO capture until Step 8.

Fixed values (from the live infra):
- subnets: `subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19`
- security group: `sg-01def4e5c0fe44d4a`
- ApiTaskRole: `Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ`
- NET='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'

---

## 1. Build image from the branch + redeploy serve (~12 min)
Builds `capiro/dev/intel-api:latest` from `feat/senate-auto-capture` and
force-redeploys `capiro-dev-intel-api` (buildspec does the redeploy).
```
aws codebuild start-build --project-name capiro-build-intel-api \
  --source-version feat/senate-auto-capture --profile capiro-dev --query build.id --output text
# poll until SUCCEEDED:
aws codebuild batch-get-builds --ids <BUILD_ID> --profile capiro-dev \
  --query "builds[0].buildStatus" --output text
```

## 2. Apply the Prisma migration (creates the two intel_senate_* tables)
The `:latest` image now contains migration `20260723140829_senate_auto_capture`.
```
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-migrate \
  --launch-type FARGATE --network-configuration $NET --profile capiro-dev
# verify (after it exits): the migrate task logs "migrate deploy" applied, and
# SELECT to_regclass('intel_senate_hearing_capture') is non-null.
```

## 3. Register the capture task-def
```
aws ecs register-task-definition --cli-input-json \
  file://infra/deploy/intel-api-capture-taskdef.json --profile capiro-dev
```

## 4. Register the poll task-def (SENATE_AUTO_CAPTURE=false, launcher env wired)
```
aws ecs register-task-definition --cli-input-json \
  file://infra/deploy/intel-api-poll-taskdef.json --profile capiro-dev
```

## 5. IAM — let the poll task launch capture tasks
```
aws iam put-role-policy --role-name Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ \
  --policy-name SenateAutoCapturePollLaunch \
  --policy-document file://infra/deploy/intel-api-poll-taskrole-inline-policy.json --profile capiro-dev
```

## 6. Dry-run validation (dark — no capture launched)
```
aws ecs run-task --cluster capiro-dev --task-definition capiro-dev-intel-api-poll \
  --launch-type FARGATE --network-configuration $NET --profile capiro-dev
# Watch logs (/capiro/dev/api, stream prefix intel-api-poll): expect
#   POLL_CFG dryRun=true autoCapture=false launcherConfigured=true ...
#   POLL_DONE discovered=<n> upserted=<n> probed=<n> live/pending/skipped=...
# Verify claim rows: SELECT hearing_key,comm,filename,status,media_url
#   FROM intel_senate_hearing_capture ORDER BY created_at DESC LIMIT 20;
```

## 7. EventBridge cron → run-task poll (business hours, every 3 min)
Reuse the existing EventBridge→ECS invoke role used by the other capiro-dev
scheduled ingestion rules (find it via any existing rule's target RoleArn:
`aws events list-targets-by-rule --rule <an-existing-ingestion-rule>`), and
ensure it can `ecs:RunTask` the poll task-def + `iam:PassRole` the two roles.
```
aws events put-rule --name capiro-dev-poll-senate-hearings \
  --schedule-expression "cron(0/3 12-23 ? * MON-FRI *)" --state ENABLED \
  --description "Senate auto-capture poller (dark until SENATE_AUTO_CAPTURE=true)" --profile capiro-dev
aws events put-targets --rule capiro-dev-poll-senate-hearings --profile capiro-dev --targets '[{
  "Id":"poll","Arn":"arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev",
  "RoleArn":"<EVENTBRIDGE_ECS_INVOKE_ROLE_ARN>",
  "EcsParameters":{"TaskDefinitionArn":"capiro-dev-intel-api-poll","TaskCount":1,"LaunchType":"FARGATE",
    "NetworkConfiguration":{"awsvpcConfiguration":{"Subnets":["subnet-0e38bd390f8961fef","subnet-0920665f91c905f01","subnet-06db79cd21239de19"],"SecurityGroups":["sg-01def4e5c0fe44d4a"],"AssignPublicIp":"DISABLED"}}}
}]'
```
While dark, the poll task's own default command is `--dry-run=true`, so even
scheduled runs launch nothing until Step 8.

## 8. Go live — flip the kill-switch (after Step 6 looks right + Deepgram ceiling OK)
Re-register the poll task-def with `SENATE_AUTO_CAPTURE=true` and the real-run
command, so scheduled runs launch capture workers:
- edit `infra/deploy/intel-api-poll-taskdef.json`: `SENATE_AUTO_CAPTURE` → `"true"`,
  and container `command` → `["task","poll-hearings","--dry-run=false"]`
```
aws ecs register-task-definition --cli-input-json file://infra/deploy/intel-api-poll-taskdef.json --profile capiro-dev
```
(EventBridge target `capiro-dev-intel-api-poll` resolves to the latest revision.)

**Verify E2E** on the next live hearing: `intel_senate_hearing_capture.status`
goes pending→live→capturing; `intel_senate_transcript_segment` rows grow; a
`hearing_watch` tenant can `GET /senate-hearings` and `/senate-hearings/:id`.

## Rollback
- Stop launches: set `SENATE_AUTO_CAPTURE=false` (re-register poll td) or
  `aws events disable-rule --name capiro-dev-poll-senate-hearings`.
- Kill in-flight captures: `aws ecs list-tasks --cluster capiro-dev --family capiro-dev-intel-api-capture` → `stop-task` each.
- The tables/task-defs/rule are additive; the serve deploy (Step 1) is the only
  change to existing prod, and it's `main` + capture (no feature regression).

## MAX_CONCURRENT_CAPTURES
Default 8 (poll td env). If Deepgram's concurrent-connection ceiling is higher,
raise it by re-registering the poll td — no code change. Over-cap go-lives are
deferred+logged (`OVER_CAPACITY`), never dropped.
