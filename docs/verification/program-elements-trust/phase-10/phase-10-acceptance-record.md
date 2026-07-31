# Phase 10 pre-merge acceptance record (sole live env=dev)

- Generated (UTC): 2026-07-31T14:16:47.386Z
- Marker: **PE_PHASE_10_FAIL**
- Plane: `capiro-dev` / workflow env=`dev` (authorized sole live = prod path)
- HEAD: `cda492c8e525896446b4e71f87f2b81f0b681fd8`
- origin/agent/...: `cda492c8e525896446b4e71f87f2b81f0b681fd8`
- origin/main: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- merge-base: `3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- Auth PE_CLOSEOUT_STAGING_OK: true
- Mutate PE_CLOSEOUT_STAGING_MUTATE: true
- Inventory healthyCompute: **true**

## Gate
- **PE_PHASE_10_FAIL** — see blockers

## Inventory blockers
- (none)

## Gate blockers
- live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=false body={"stop":"Essential container in task exited","containers":[{"name":"api","exit":1,"reason":null}],"startedAt":"2026-07-31T10:12:17.684000-04:00","stoppedAt":"2026-07-31T10:12:44.669000-04:00"} log=de:internal/fs/promises:858
  return await PromisePrototypeTh); step inspect_only_loaders UNSATISFIED
- live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=false body={"stop":"Essential container in task exited","containers":[{"name":"api","exit":1,"reason":null}],"startedAt":"2026-07-31T10:12:17.684000-04:00","stoppedAt":"2026-07-31T10:12:44.669000-04:00"} log=de:internal/fs/promises:858
  return await PromisePrototypeTh); step exact_sha_internal_promotion UNSATISFIED
- live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=false body={"stop":"Essential container in task exited","containers":[{"name":"api","exit":1,"reason":null}],"startedAt":"2026-07-31T10:12:17.684000-04:00","stoppedAt":"2026-07-31T10:12:44.669000-04:00"} log=de:internal/fs/promises:858
  return await PromisePrototypeTh); step identical_replay UNSATISFIED
- live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=false body={"stop":"Essential container in task exited","containers":[{"name":"api","exit":1,"reason":null}],"startedAt":"2026-07-31T10:12:17.684000-04:00","stoppedAt":"2026-07-31T10:12:44.669000-04:00"} log=de:internal/fs/promises:858
  return await PromisePrototypeTh); step derive_chain_dry_run UNSATISFIED
- live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=false body={"stop":"Essential container in task exited","containers":[{"name":"api","exit":1,"reason":null}],"startedAt":"2026-07-31T10:12:17.684000-04:00","stoppedAt":"2026-07-31T10:12:44.669000-04:00"} log=de:internal/fs/promises:858
  return await PromisePrototypeTh); step rls_ethical_wall UNSATISFIED

## Warnings
- inventory: Compute stack Capiro-dev-Compute status=UPDATE_ROLLBACK_COMPLETE — known drift; ECS live health still authoritative
- inventory: Forbidden/unintended clusters are visible in the account (expected); deploy must never target them

## Captured prior task defs (rollback)
- `capiro-dev-api` rev=70 arn=`arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:70` image=n/a
- `capiro-dev-web` rev=12 arn=`arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:12` image=n/a

## Image digests
- `capiro/dev/api` tag=cda492c8e525896446b4e71f87f2b81f0b681fd8 present=true digest=sha256:8e220931729753277f5a44f22b80e05bfe5faa7e8c2d590c4265583018981054
- `capiro/dev/web` tag=cda492c8e525896446b4e71f87f2b81f0b681fd8 present=true digest=sha256:277489e381aa8921ccbfd6a4b07d473d20e0083cd39fd1b55b450748d02660f4

## Outcomes
- `git_sha_record` exit=0 class=ok head=cda492c8e525896446b4e71f87f2b81f0b681fd8 origin=cda492c8e525896446b4e71f87f2b81f0b681fd8 main=3dcb12f823774b6fae8578dc56fc122bf9a0879e mb=3dcb12f823774b6fa
- `aws_inventory_readonly` exit=0 class=ok healthyCompute=true plane=capiro-dev blockers=0 probeExit=0
- `local_pe_preflight_k` exit=0 class=ok skipped via --skip-local-gates (operator)
- `local_pe_phase9_preflight` exit=0 class=ok skipped via --skip-local-gates (operator)
- `transport_absent` exit=0 class=ok no forbidden paths
- `image_digest_record` exit=0 class=ok recorded 2 repo checks; present=2 skipBuild=true
- `staging_migrate_additive` exit=0 class=ok migrate task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/c7bb5474194946abb71b57b6b0240edd exit=0
- `staging_deploy_images` exit=0 class=ok deployed api=arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:72 web=arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:13 on ca
- `inspect_only_loaders` exit=1 class=branch_introduced live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=f
- `exact_sha_internal_promotion` exit=1 class=branch_introduced live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=f
- `identical_replay` exit=1 class=branch_introduced live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=f
- `derive_chain_dry_run` exit=1 class=branch_introduced live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=f
- `rls_ethical_wall` exit=1 class=branch_introduced live proofs missing/failed (live proofs task arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/3665b7d22d33447cb1ee78f9cdbc5ddc failed wait=0 exit=1 markerOk=f
- `browser_smoke` exit=0 class=ok host=app.capiro.ai codes={"root":"200","health":"200","healthz":"200","api_health":"401","pe_list":"401","pe_detail":"401"} (401 on PE routes = auth wall presen
- `alarm_test_events` exit=0 class=ok SYNTHETIC alarm path ok alarm=capiro-dev-alb-5xx pulsed+restored; PE trust synthetic events ok; not humanReviewed
- `rollback_rehearsal` exit=0 class=ok exercised rollback to arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:70/arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:12 
- `acceptance_record` exit=0 class=ok wrote C:\c\Users\neoma\AppData\Local\Temp\pe-closeout-wt\docs\verification\program-elements-trust\phase-10

## Exit-gate bullets
- [ ] staging_acceptance_record_complete: UNSATISFIED: missing full runtime proofs on authorized plane
- [x] rollback_rehearsed: rollback rehearsed: prior TD ARNs captured and ECS update-service exercise recorded
- [ ] no_critical_alarm: UNSATISFIED: alarm proofs deferred or failed (not N/A auto-pass)
- [ ] no_cross_tenant_disclosure: UNSATISFIED: RLS/ethical-wall proof deferred or failed (not N/A auto-pass)
- [ ] no_unexplained_data_mutation: UNSATISFIED: mutate incomplete, env_blocked, or missing promotion/replay proofs

## Rollback (captured priors on authorized services)
- Rollback against CAPTURED prior task definitions on authorized sole-live cluster capiro-dev:
- aws ecs update-service --cluster capiro-dev --service capiro-dev-api --task-definition arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:70
- aws ecs update-service --cluster capiro-dev --service capiro-dev-web --task-definition arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:12
- Do NOT hand-edit _prisma_migrations; schema rollback via Aurora snapshot if migrate is bad.
- Captured new api TD: arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:72
- Captured new web TD: arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-web:13
- Never deploy/rollback to capiro-staging or capiro-prod-os-capiro from this harness.
- Email/canaries/LlamaParse/derive --commit remain dark.

## Safety (this run)
- No Secrets Manager GetSecretValue
- No email send / LlamaParse / derive --commit
- Deploy target authorized only: `capiro-dev`
- Forbidden clusters: capiro-staging, capiro-prod-os-capiro
- Email automation remains dark (policy)
- Synthetic alarm events stay synthetic-loud, never humanReviewed

## Honesty
- This file is implementer evidence, **not** independent REVIEW PASS.
- Local `verify:pe-phase-k` / Phase 9 integrity are preflight, not live-env substitutes.
- PE_PHASE_10_BLOCKED means the work stopped honestly — not a pass.
- Exit-gate bullets without proofs are unchecked (no N/A auto-pass).
