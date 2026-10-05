# Meri deployment plan for Stages 1 to 3, written for the Opus 5.5 lead agent

Date: 2026-10-05 (evening). Author: lead agent session with Neo. Companion to `00-Meri-Program-Plan-2026-10-05.md`.

This file sequences the three execution stages of the program plan (Stage 1 §4, Stage 2 §5, Stage 3 §6) into pull requests, production rolls and verification steps, and gives the exact release mechanics for each roll. It is written to be executed by a Claude Opus 5.5 lead agent running in Claude Code on this Windows host, one small PR or one roll per session.

It does not change any decision D1 to D10, the architecture rules, the task list in §8 or the testing policy in §9. Where this file and the program plan differ on what to build, the program plan wins. This file adds how and in what order to ship it. Facts below were verified read-only on 2026-10-05 against origin/main `d16a27137`, the live ECS services and the AWS account. Re-verify served revisions before every roll; they move.

## 0. Operating notes for the Opus 5.5 lead agent

### 0.1 Session shape

1. Start every session by reading, in order: `STATUS.md` (top section only), this file's checklist for the current stage (§3, §4 or §5), then the program-plan section you are executing. Do not re-read the historical checkpoints in `STATUS.md`.
2. One unit of work per session: one PR from branch to merge, or one production roll from build to recorded verification. Do not start a roll in a session that also has uncommitted code changes.
3. End every session by writing the outcome to `STATUS.md` (implemented, tested, merged, deployed are four different words; `BLOCKED` and `NOT_RUN` are never reported as pass) and, for a roll, to `docs/meri/releases/<date>/<name>/`.
4. Effort. Opus 5.5 defaults to medium effort. Set the session effort to high for PR work and to xhigh for the deletion PRs (§4.3, §4.4), for every production roll and for every reachability audit. Give the full task up front; do not drip-feed steps.
5. If a gate fails twice for the same reason, stop and report the exact failure instead of iterating a third time. If a roll's verification fails, roll back (§2.7) before investigating.

### 0.2 Worktree recipe (every PR)

```bash
git -C C:/dev/main/capirov2-main fetch origin main
git -C C:/dev/main/capirov2-main worktree add C:/dev/main/meri-<stage>-<slug> -b <branch> origin/main
cd C:/dev/main/meri-<stage>-<slug>
pnpm install --frozen-lockfile --offline
for p in shared defense-domain defense-contracts auth meriv2-core strategy-verifier; do pnpm --filter "./packages/$p" run build; done
(cd apps/api && ./node_modules/.bin/prisma generate)
```

Then gates, per program plan §9: `NODE_OPTIONS=--max-old-space-size=8192` for the API `tsc --noEmit --rootDir .`, the orchestrator typecheck, and only the focused specs for the files you touched (`--runInBand` when a spec touches the shared local Postgres). Nothing else.

Hazards that have already cost work on this host, with the rule that avoids each:

| Hazard | Rule |
| --- | --- |
| The git stash stack is shared across every worktree and every concurrent agent session | Never bare `git stash`. Park work as a WIP commit. |
| Another session can commit your in-progress edits into its own commit in a shared worktree | One worktree per PR, named for the PR, never shared with a review workflow or another session. |
| A fresh worktree fails `tsc` with about 1,100 `TS2307` errors until the workspace packages are built | Run the prebuild loop above before any gate. |
| API `tsc` exits 134 without a larger heap | Always `NODE_OPTIONS=--max-old-space-size=8192`. |
| `pkill` does not kill Windows `node.exe`; a stray jest worker has held 4.3 GB | `powershell -NoProfile -Command "taskkill /PID <pid> /T /F"`. Never run a jest suite and an image build at the same time. |
| `*.log` is gitignored, so evidence written with that extension is lost | Write evidence as `.txt` or `.json`. |
| The Bash tool's heredocs break on apostrophes | Write scripts with the Write tool, then run them. |
| `prisma migrate dev`, `db push` and `migrate reset` propose dropping other branches' tables from the shared local database | Only `prisma migrate deploy` with hand-written additive migrations; `prisma migrate status` first. |
| `apps/api` migration directory names run about two years ahead of the calendar by a sorts-after-max convention | Name a new migration to sort after the current maximum (`20281007020000_clio_attachments_xlsx_kind` today). Never renumber. |
| AWS CLI under MSYS mangles arguments that start with `/` or contain `:` | Prefix with `MSYS_NO_PATHCONV=1`, and then write repository paths as `C:/dev/...`, not `/c/dev/...`. `file://` inputs are `file://C:/...`. |

### 0.3 Standing constraints (program plan §0, restated)

No Hermes restart. Approvals, journal history, failed runs, tenant boundaries and existing authorizations are preserved. Paid turns run one at a time as neo@capiro.ai in capiro-internal (tenant `17b63099-bc0f-4ac5-b596-496161e9481e`, Clerk org `org_3DB7EKoeKfF8ZLu6cW4d9Vn6CT0`). State-changing test setup only on client ZZ-QA-Meri1651-Test-DoNotUse. The only external delivery approved during testing is to the tester's own mailbox. Every production change with a side effect (a flag flip, a migration apply, a WAF change, an AWS resource deletion, a model change) needs Neo's OK at the time, even where D8 or D10 already authorize the class of change. §7 lists every ask point.

## 1. Verified starting point (2026-10-05, read-only)

### 1.1 Served production (cluster `capiro-dev`, account `967807252336`, `us-east-1`)

| Service | Revision | Source commit | Ancestor of origin/main | Log group / stream prefix |
| --- | --- | --- | --- | --- |
| `capiro-dev-api` (2 tasks) | `capiro-dev-api:553` | `e06432d88` | yes | `/capiro/dev/api` / `api` |
| `capiro-dev-meriv2-orchestrator` (1 task) | `capiro-dev-meriv2-orchestrator:139` | `a442cafb3` | yes | `/capiro/dev/api` / `meriv2-orchestrator` |
| `capiro-dev-web-vnext` (1 task) | `capiro-dev-web-vnext:390` | unchanged for weeks | n/a | `/capiro/dev/web-vnext` / `web-vnext` |

Both Meri services run commits that are ancestors of main. The earlier situation where the API served an unmerged branch is over; the ancestry check in §2.1 stays mandatory because dark deploys can recreate it.

Pending on main and not yet served: `8e901607d` (PR #1996, the `clio_attachments` xlsx kind constraint; code plus migration `20281007020000_clio_attachments_xlsx_kind`). Nothing is pending for the orchestrator.

### 1.2 Live task-definition facts that shape the rolls

- API `capiro-dev-api:553` env carries `MERIV3_ENABLED=true`, `MERIV3_CANARY_TENANT_SLUGS=<eleven slugs>`, `MERIV2_ENABLED=true`, `MERIV2_ORCHESTRATOR_URL=https://app.capiro.ai`, `MERIV2_ACTION_PROPOSALS_ENABLED=true`, `MERIV2_CONTEXT_PACKET_V2=enforce`, `MERIV2_CONTROL_METRICS=on`, `GIT_SHA`/`RELEASE_SHA=e06432d88…`.
- Orchestrator `:139` env carries `MERIV3_ENABLED=true`, `MERIV3_MODEL`/`MERIV3_FAST_MODEL`/`MERIV3_DEEP_MODEL`/`MERIV3_MAX_MODEL=gpt-6-astra`, `OPENAI_MODEL=gpt-6-astra`, `ANTHROPIC_MODEL=claude-sonnet-5` (used by the narrow assistants, not by V3), `MERIV3_CANARY_TENANT_SLUGS`. Secrets already include `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` on both the API and the orchestrator. Stage 3 needs no new secret.
- `infra/cdk/lib/compute-stack.ts` has no `MERIV3_*` key for either service (it does carry `MERIV2_ENABLED`, `MERIV2_ORCHESTRATOR_URL`, `ANTHROPIC_MODEL`). The Compute stack is wedged (`infra/cdk/DRIFT-FINDINGS.md`); nobody runs `cdk deploy`. CDK edits in this program are codification only.
- Migration task definitions. `capiro-dev-api-admin-migrate` revisions 78 to 82 run command `["migrate"]` (`prisma migrate deploy` plus `seed-workflows`). The latest revision, `:83` (registered 2026-09-29), runs `["migration-status"]`, which is read-only, and is pinned to an image from commit `c53d7439`. Running the family alias applies nothing. §2.4 gives the re-register recipe; always set the command explicitly.
- `capiro-dev-api-migrate:136` runs `["migrate"]` but is pinned to an unrelated old digest. Do not use it.
- Alarms publish to SNS `arn:aws:sns:us-east-1:967807252336:capiro-dev-platform-alarms` (email to neo@capiro.ai). That topic is "the existing ops channel" in program plan §4.1. There is no metric filter on `/capiro/dev/api` for Meri today.
- WAF: regional web ACL `capiro-dev-waf` (`95dc2979-45e1-4c94-9ea8-650dfb21c516`). Live rules, by priority: `allow-msgraph-webhook-validation` (0, Allow, out-of-band), `AWS-AWSManagedRulesCommonRuleSet` (1), `AWS-AWSManagedRulesKnownBadInputsRuleSet` (2), `AWS-AWSManagedRulesSQLiRuleSet` (3). The CDK definition is `compute-stack.ts` around line 2305 and lacks rule 0.

### 1.3 Release tooling, where it lives

| Tool | Location | Note |
| --- | --- | --- |
| Release operator | `scripts/meri-release.mjs` (`inspect`, `prepare`, `promote`, `rollback`), policy in `scripts/lib/meri-release-policy.mjs`, contract in `docs/meri/deployment-prerequisite.md` | Changes one service per invocation: image plus `GIT_SHA`/`RELEASE_SHA` (plus `CAPIRO_WEB_RELEASE_SHA` for web-vnext). Never resets flags. Keeps a pinned rollback revision. |
| Immutable image builds (API and orchestrator) | `scripts/meri-image-build.mjs` (`launch`, then `collect`), env `BUILD_SERVICE=api|meriv2-orchestrator`, `BUILD_SOURCE_SHA`, `BUILD_ROOT`. Added in Stage 1; the older per-release launcher under `outputs/meri-c2-20261003/` asserted capture-harness test names and is retired. | Runs CodeBuild project `capiro-build-web-dev` (ARM_CONTAINER, so native arm64, privileged) with a buildspec override of about 2,800 characters: build, offline image smoke test, push by SHA, digest readback. Limit 25,600 characters. |
| Release kits | `C:/dev/main/outputs/meri-c2-20261003/release-setaside` (API) and `release-memclient` (orchestrator): `qualify.py`, `archive.py`, `baseline.py`, `verify.mjs`, `ship.sh`, `pr-body.md` | Copy the newest kit per service. `ship.sh` hard-codes `REPO=/c/dev/main/meri-c1-20261002` and needs that checkout clean on a fresh evidence branch. |
| Post-deploy gates | `apps/api/scripts/verify-migrations.ts --live`, `apps/api/scripts/verify-image-parity.ts` | Run from `apps/api` with `MSYS_NO_PATHCONV=1 AWS_PROFILE=capiro-dev pnpm exec tsx scripts/verify-… --cluster=capiro-dev --region=us-east-1`. |
| Live task runner | `evals/meri/simple/run-cases.mjs --cases <ids>`; `auth.mjs` signs in neo@capiro.ai only; outputs under `C:/dev/main/outputs/meri-simple-20261005` | D9 second identity not yet supported; §3 step S1-0 adds it. |
| Flag flip | `POST /api/capiro-admin/tenants/:tenantId/meriv2-flags` body `{flag, enabled}` as `capiro_admin`; `SetMeriV2FlagDto` restricts `flag` to `MERIV2_FLAGS` | Before the drill, confirm `meriv3.fullChat` is a member of `MERIV2_FLAGS`; if not, the §4.1 PR adds it. |
| Tenant model | `POST /api/capiro-admin/tenants/:tenantId/ai-credential/model` (used on 2026-10-04 to move capiro-internal to `gpt-6.1-sol`) | Stage 3 §5.3 verifies it can name a Claude model. |

Two housekeeping facts for the first session:

- The Case 45 fix (program plan §1.3 item 5) is uncommitted in worktree `C:/dev/main/meri-c1-20261002` on branch `codex/meri-document-completion-attachments-20261005` (two files, +131/-3 in `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-document-completion*.ts`). That worktree is also the release kits' `REPO`. Commit the fix first (S1-0), then keep that worktree clean for releases, or create `C:/dev/main/meri-release` and change `REPO=` in the copied kits.
- Playwright is not a dependency of `apps/web` (the web test runner is vitest; one historical `client-intel-v1.e2e-smoke.spec.ts` exists). Stage 2 §5.8 adds `@playwright/test` as a devDependency.

Path corrections to the program plan: `request-scoped-llm.client.ts` and `prompt-cache.helpers.ts` live in `apps/meriv2-orchestrator/src/meri/`, not `apps/api`; the simple runner entry is `run-cases.mjs`; the orchestrator writes to the API log group under stream prefix `meriv2-orchestrator`, so the "orchestrator 5xx" alarm in §4.1 is a filter on `/capiro/dev/api`.

## 2. The roll recipe (every production release)

### 2.1 Pre-flight (read-only, repeat immediately before `promote`)

1. Clean worktree: `git status --porcelain --untracked-files=no` is empty in the release checkout. Re-run after `git update-index --refresh` if a stat-only `M` appears.
2. Ancestry, through the service, not the family alias, twice:

```bash
TD=$(aws ecs describe-services --cluster capiro-dev --services capiro-dev-api --query "services[0].taskDefinition" --output text)
SHA=$(aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[0].environment[?name=='GIT_SHA'].value|[0]" --output text)
git merge-base --is-ancestor "$SHA" "$CANDIDATE" && echo SAFE || echo RE-MERGE-FIRST
```

   Also compare the running image digest (`aws ecs describe-tasks … containers[0].imageDigest`) against the task definition image: the digest is the truth, `GIT_SHA` is a self-report.
3. No concurrent rollout: every service shows one `PRIMARY` deployment with `rolloutState=COMPLETED`.
4. Live env diff: dump the live task definition's environment and diff it against what the registered candidate will carry. `meri-release.mjs promote` changes only the image and the SHA identity, so the diff must be exactly those keys. Configuration changes go through §2.5, never through a release.
5. For a roll that carries a migration: §2.4 happened first and the migrate task's log shows each `Applying migration` line.
6. Other sessions deploy the same services (Krisp and LegiWatch both rolled the API on 2026-10-05 while roll 1 was in flight). If the live `GIT_SHA` is not an ancestor of the candidate, rebuild from current main; never force.

### 2.2 Build an immutable image

API and orchestrator: `BUILD_SERVICE=<svc> BUILD_SOURCE_SHA=<merge commit on origin/main> BUILD_ROOT=<new dir> node scripts/meri-image-build.mjs launch`, then rerun `collect` until it writes `build-readback.json` (API about 7 minutes, orchestrator about 5). The readback's digest is the only image identity you use from here on. Update the smoke test in the script when a release changes the contracts it asserts.

Web vNext (first needed in Stage 2): never build on this host (`apps/web/Dockerfile` segfaults under QEMU). Run the retired workflow's recipe inside the same ARM CodeBuild project through a buildspec override:

```text
docker buildx build --platform linux/arm64 -f apps/web/Dockerfile \
  --build-arg GIT_SHA=$SHA --build-arg CAPIRO_WEB_BUILD_SURFACE=vnext \
  -t 967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext:$SHA --push .
```

Read `.github/workflows/web-vnext-deploy.yml` lines 75 to 125 for the Node heap setting it used, and keep the same tag-by-SHA, digest-in-readback discipline. Add a `BUILD_SERVICE=web-vnext` branch to the launcher when you do this; it is a one-time tooling PR (S1-0 below recommends committing the launcher).

### 2.3 Qualify, prepare, promote

1. Write the release evidence folder `docs/meri/releases/<date>/<name>/` (`README.md`, `release-qualification.json` in the shape of `2026-10-05/c2-sam-set-aside-release/release-qualification.json`, the build readback, `served-baseline.json`). Open and merge the evidence PR; the evidence commit SHA is what `qualify.py` cites by blob URL.
2. `node scripts/meri-release.mjs prepare --qualification <q.json> --out <manifest.json> --profile capiro-dev`. The manifest expires after one hour; the rollback digest must still exist in ECR.
3. `node scripts/meri-release.mjs promote --manifest <manifest.json> --approve <manifestHash> --confirm PROMOTE_CAPIRO_PRODUCTION_<service> --receipt <receipt.json> --profile capiro-dev`. One attempt, no automatic retry. It registers a pinned rollback revision and the candidate, rechecks the baseline and calls `UpdateService`.
4. Wait until every old task is `STOPPED` (the kits' `wait_old_stopped`), then run the kit's `verify.mjs` (exact revision, digest, `GIT_SHA`/`RELEASE_SHA`, ALB target health).
5. Roll only the services that changed. API and orchestrator rolls are separate invocations; order them as each stage section says.

### 2.4 Migrations (additive only, applied once)

Apply before promoting code that reads the new schema. Re-register `capiro-dev-api-admin-migrate` against the candidate digest with the command set explicitly:

```bash
aws ecs describe-task-definition --task-definition capiro-dev-api-admin-migrate:82 --query taskDefinition --output json \
 | jq --arg img "967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@$DIGEST" --arg sha "$SRC_SHA" '
   del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)
   | .containerDefinitions[0].image=$img
   | .containerDefinitions[0].command=["migrate"]
   | .containerDefinitions[0].environment |= map(if .name=="GIT_SHA" or .name=="RELEASE_SHA" then .value=$sha else . end)' \
 > C:/dev/main/outputs/<release>/admin-migrate-td.json
MSYS_NO_PATHCONV=1 aws ecs register-task-definition --cli-input-json file://C:/dev/main/outputs/<release>/admin-migrate-td.json
```

Run that exact new revision with `aws ecs run-task --cluster capiro-dev --launch-type FARGATE --network-configuration <copied from the api service's networkConfiguration>`. Success is not exit 0: read the task's CloudWatch stream (the group named in the task definition's `logConfiguration`) for `Applying migration <name>` and `Seeding workflow templates`, then run `verify-migrations.ts --live`. A failed migration stops the release; follow `docs/runbooks/prisma-failed-migration-recovery.md`, never edit `_prisma_migrations` by hand. Record the revision and the stream in the release README.

### 2.5 Configuration revisions (env-only changes, no image change)

For adding, changing or removing env keys (removing `MERIV2_*` in §4.3 step 4, a tenant-flag env in §4.6, a model env in Stage 3): clone the live task definition (same `jq` deletion list as above), patch only the env keys, keep the image and the SHA identity unchanged, register, print the full env diff, re-read the service's task definition ARN to confirm nothing moved, then `aws ecs update-service --cluster capiro-dev --service <svc> --task-definition <new arn>` and `aws ecs wait services-stable`. Do this outside any release window (the release operator fingerprints service configuration and refuses on drift). Record every configuration revision in `STATUS.md` and in `infra/cdk/DRIFT-FINDINGS.md`, and codify the key in `compute-stack.ts` in the same or the next PR.

### 2.6 Post-roll verification (all of it, every roll)

1. `verify-image-parity.ts` from `apps/api` (read-only). `verify-migrations.ts --live` is currently unusable: the `capiro-dev-api-diag` task definition now runs the entrypoint dispatcher, which rejects the script's probe as an unknown command (the task exits 1; no write happens because the override replaces the default `set-tenant-flag` command). Check migrations from the migrate task's log until the script is updated. `:latest` parity drift on api, web and intel-api is pre-existing (builds publish by SHA only).
2. `GIT_SHA`/`RELEASE_SHA` on the served revision equal the source SHA; the running digest equals the readback digest.
3. One live turn on capiro-internal through the ordinary product path with `run-cases.mjs` (the affected task from §8, or T1 when nothing specific changed), one paid turn, verdict recorded.
4. For an API roll that changed routing or flags: an assistant row written after the roll carries `metadata.servedBy='meriv3'`.
5. Record in `STATUS.md`: service, revision, rollback revision, commit, digest, the live check and its verdict.

### 2.7 Rollback

Behavior: the kill switch (`meriv3.fullChat=false` for one tenant, `MERIV3_ENABLED=false` globally through a configuration revision). Code: `node scripts/meri-release.mjs rollback --receipt <receipt.json> --approve <receiptHash> --confirm … --profile capiro-dev`, which returns to the pinned rollback revision. Schema: never reversed; additive migrations stay. A rollback is recorded like a release.

### 2.8 One-time tooling PR (S1-0, recommended)

Commit the build launcher and a generic kit (the four Python/JS files and `ship.sh` with `REPO`, service and evidence path as parameters) under `scripts/meri-release-kit/`, so a fresh worktree can build and ship without the `outputs/` folder. Program plan §4.3 step 5 already retires the MeriV2 scripts in favor of `meri-release.mjs`; this PR completes that tooling. Treat it as docs-and-scripts, no roll.

## 3. Stage 1 sequence: one runtime, honest kill switch, cheaper turns

Target: about 14 PRs, 7 rolls, two weeks of work plus the seven-day kill-switch clock that overlaps the second week. Exit `01_READY_FOR_02` per program plan §4.7.

### 3.1 Order of work

| Step | Work | Services | Roll | Gate before merge / roll | Ask Neo |
| --- | --- | --- | --- | --- | --- |
| S1-0 | Housekeeping: commit the Case 45 fix from `meri-c1-20261002`; runner second identity for D9 (`auth.mjs` accepts `MERI_RUNNER_SECOND_IDENTITY=qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai`, user `user_3K1rLp0VqINt4W363g2RgJr4hyC`, never a customer identity); tooling PR (§2.8) | orchestrator (code only), evals, scripts | none yet | typecheck, focused specs | no |
| S1-1 | §4.1 kill switch PR: two-key `isMeriV3ChatEnabled`, classified refusal `meri_unavailable` with persisted `servedBy:'unavailable'`, remove `meri_case46_qualified_v3_required`, matrix spec updated; confirm `meriv3.fullChat` is flippable through the admin flag endpoint | API | Roll 1 | typecheck, `meri-feature-flags.matrix.spec.ts`, proxy specs | no (merge only) |
| S1-2 | §4.2 CDK codification PR: `MERIV3_ENABLED`, orchestrator URL, and the live `MERIV3_CANARY_TENANT_SLUGS` removal noted; `DRIFT-FINDINGS.md` entry; no `cdk deploy` | infra | none | `cdk synth` only | no |
| S1-3 | Alarms: metric filter `MeriUnavailable` on `/capiro/dev/api` pattern `"meri_unavailable"`, metric filter for the V3 proxy's upstream-5xx log line (name it in S1-1), two alarms to `capiro-dev-platform-alarms`; codify in CDK with S1-2 | AWS | none | alarm visible, `OK` state | yes (new alarms notify Neo) |
| Roll 1 | API: S1-1 plus `8e901607d` (xlsx). Order: §2.4 migration (`20281007020000_clio_attachments_xlsx_kind`) first, then promote | API | 1 | §2.1 to §2.6 | yes: first Stage 1 roll and the migration apply (D10) |
| S1-4 | T15 drill: `meriv3.fullChat=false` on capiro-internal, one turn shows "Meri is unavailable" with a persisted row, flag back on, one normal turn; both recorded in `STATUS.md`. The seven-day clock starts here | prod flag | none | the two turns | yes (production flag flip) |
| S1-5 | §4.5 items 1 and 2 (citations on budget and bill answers; Case 21 limitation sentence): find the layer first (orchestrator tool evidence vs API citation minting), one PR each; Retry-After in `openai-responses.client.ts` | orchestrator and/or API | 2 and 3 | typecheck, focused specs, rerun cases 20 to 24, 28, 31, 32 and 21 once | no |
| S1-6 | §4.5 item 4, WAF exception for `POST /api/clio/attachments`: set `CrossSiteScripting_BODY` to Count inside the Common rule set with `RuleActionOverrides`, then add a rule after it that blocks on label `awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body` unless the URI path is `/api/clio/attachments`; codify both this and the live `allow-msgraph-webhook-validation` rule in `compute-stack.ts`; verify with one PPTX upload on the QA client | AWS + infra PR | none | upload returns 201 | yes (D10, production WAF change) |
| Roll 2 | Orchestrator: Case 45 fix, Retry-After, orchestrator-side citation fix if any | orchestrator | 2 | §2 | no (within the authorized release path) |
| Roll 3 | API: API-side citation fix if any, §4.6 step 1 trims (history budget, context packet) | API | 3 | §2; rerun T2 and case 21 | no |
| S1-7 | §4.4 capture harness removal: reachability audit (importers, typecheck both apps, focused specs), delete the 42 modules plus specs, the `meri-capture-provider-budget.controller.ts` endpoints, the capture branches in `streamMessage`, `evals/meri/live-v1/` (251 files) and `scripts/meri-synthetic-*`; freeze `outputs/` kits as history | API and orchestrator | 4 (API then orchestrator) | audit recorded, typecheck, focused specs | no |
| S1-8 | §4.8 Hermes residue steps 1 to 3: read-only reference check (no service, task, rule or task definition references the three families, two roles, two security groups; log group has no events after 2026-09-27); then deregister revisions, delete EFS `fs-0a641cad57e8bff4e`, the two security groups, the two roles, the four ECR images and repository `capiro/dev/meri-hermes-worker`; schedule secret `hermes/jumpbox/openrouter-api-key` for deletion with the standard window | AWS | none | each deletion preceded by its reference check; recorded in `STATUS.md` and `DRIFT-FINDINGS.md` | yes, once, with the read-only inventory attached (D8) |
| S1-9 | §4.6 measurement query (weekly `meri.api.turn.finalized` usage per turn and tenant), then step 2 projections (orchestrator, additive next to `meriv3-tool-evidence.ts`) and step 3 input-token ceiling in `meriv3-run-budget.ts` behind a tenant flag | orchestrator | 7 | typecheck, focused specs; one live turn per change | no (flag dark by default; enabling it on capiro-internal is a flag flip, ask) |
| Day 7+ | Clock check: zero `meri_unavailable` rows and zero alarm firings outside the drill; zero requests to the orchestrator `/chat` route in the seven days (CloudWatch query on `/capiro/dev/api`, stream prefix `meriv2-orchestrator`) | | | recorded | no |
| S1-10 | §4.3 PR A (orchestrator): move `chat/chat-prompt.ts` and `chat/client-filing-confirmation.ts` into `meriv3/shared/`, update the four importers, delete `chat/` and its registrations in `meri.module.ts` and the `/chat` route | orchestrator | 6 | typecheck, focused specs | no |
| S1-11 | §4.3 PR B (API): inventory the prelude methods `MeriV3ProxyService` calls, then delete `streamMessageViaMeriV2`, `meriv2-routing.helpers.ts`, `MeriV2ChatClient` wiring, `MERIV2_FLAGS` reads and the `meriv2.fullChat` flag, `installRawPhase19Adapters`, the V1 loop body and helpers, `RUNTIME_NAME='Hermes'`; remove the nine `CLIO_*` V1 config keys after grepping for other readers | API | 5 | typecheck, focused specs, reachability audit recorded | no |
| S1-12 | §4.3 step 5 scripts retirement PR (`prepare-`, `execute-meriv2-ecs-release.mjs`, `deploy-meriv2-operations-dark.mjs`, `verify-meriv2-release*.mjs`, `run-meriv2-phase19-local.mjs`) | scripts | none | `scripts/meri-release.test.mjs` | no |
| Roll 5 | API: S1-11, followed within the same session by a §2.5 configuration revision that removes `MERIV2_ENABLED`, `MERIV2_ORCHESTRATOR_URL`, `MERIV2_ACTION_PROPOSALS_ENABLED`, `MERIV2_CONTROL_METRICS`, `MERIV2_CONTEXT_PACKET_V2` only after confirming no remaining reader (the orchestrator still needs `MERIV2_PORT`, `MERIV2_API_BASE_URL`, `MERIV2_LOG_LEVEL`; leave those) | API | 5 | §2; T1 live turn | no (code roll); configuration revision recorded |
| Roll 6 | Orchestrator: S1-10 | orchestrator | 6 | §2; T1 live turn | no |
| Roll 7 | Orchestrator: S1-9 projections and ceiling (dark) | orchestrator | 7 | §2; one live turn | no |
| S1-13 | Acceptance: T1, T2, T3 (second reviewer = synthetic account), T4 (PDF plus XLSX on the QA client, Word export opened), T15 already recorded; Neo's verdicts; `01-handover.md` with `01_READY_FOR_02` or `01_BLOCKED` naming the blocker; `STATUS.md` | evals, docs | none | verdicts recorded, no open fail on walls, approvals, truthfulness | yes (verdicts) |

Roll order rationale. Roll 1 must precede everything that depends on "V3 or refuse" being live, and the xlsx migration rides it because it is the first API image after D10. Rolls 2 and 3 carry the measured bug fixes without waiting for the clock. Roll 4 (capture harness) rolls the API first because the API is the producer of capture context; once it stops producing it, the orchestrator modules are dead code and can go in the following orchestrator roll. Rolls 5 and 6 wait for the seven-day gate; the API goes first because it is the only caller of the orchestrator `/chat` route, and the seven-day log query proves that route is already idle. Roll 7 is dark behind a tenant flag and can slot anywhere after Roll 2.

### 3.2 Stage 1 week plan

Week 1: S1-0, S1-1, S1-2, S1-3, Roll 1, S1-4 (clock starts), S1-5 and S1-6 in parallel sessions, Roll 2, Roll 3, S1-7 audit.
Week 2: Roll 4 pair, S1-8 (Hermes, after Neo's OK), S1-9 measurement and PRs, Roll 7, then on day 7 the clock check, S1-10 to S1-12, Rolls 5 and 6, S1-13.

If the clock is not yet at seven days when S1-10 to S1-12 are ready, open the PRs with green gates and record "merge blocked on clock until <date>" in `STATUS.md`; §4.7 accepts open PRs with the remaining step named.

## 4. Stage 2 sequence: the Cowork layer

Target: about 20 PRs, five releases, five weeks. Exit `02_READY_FOR_03` per program plan §5.8. Every release follows §2. Web vNext ships for the first time in this program in Release B, so establish the web build path (§2.2) before Release B, not during it.

| Release | Content (program plan section) | Services | Migration | Verified by | Ask Neo |
| --- | --- | --- | --- | --- | --- |
| A, jobs foundation (dark) | §5.1: additive columns `kind`, `goal_revision`, `deliverables` on `clio_research_sessions`; status mapping onto the existing union (`queued`, `planning`, `executing`, `waiting_for_user`, `finalizing`, `completed`, `partial`, `failed`, `cancel_requested`, `cancelled`, old values still readable); `kind` on the research-session endpoints; `meri-v3-research-runner.ts` steps with job budget and narrowed allow-list; lease-expiry sweeper if §5.2's check finds none | API (3 to 4 PRs) | one, named to sort after `20281007020000` (for example `20281008010000_clio_research_sessions_jobs`), applied through §2.4 before the API roll | existing research run unchanged (one research prompt on the QA client); `verify-migrations.ts --live` | migration apply |
| B, delegate, steer, stop, resume | §5.1 entry points (composer "Delegate this", Start Work card) and §5.2 web generalization (`MeriResearchProgress`, `MeriDurableResearchControls`, `MeriResearchRecovery`, `useMeriDurableResearch`, running-jobs rail indicator, cursor reconnect, `goal_revision` steering, `cancel_requested` to `cancelled`) | web-vnext (3 to 4 PRs), API (1 to 2 PRs) | none | T5 (delegate and deliver a Word brief, one filing confirmation), T7 (steer mid-run, close tab, reopen, finish, then Stop) | no (T5 writes only to the QA client folder) |
| C, deliverables | §5.3: office brief, white paper, client update, comparison spreadsheet as Word, PowerPoint, Excel through artifact services and `run_analysis`; read-back before claiming delivery; `enforceClientFilingConfirmation` | API (2 to 3 PRs), orchestrator only if a tool-result projection is needed | none | T6 (Excel), T12 (six-slide deck), T4 rerun with PPTX input now that the WAF exception exists | no |
| D, approvals inside jobs | §5.4: `waiting_for_user` on an effect, proposal card in thread, no model calls while waiting, approval resumes, rejection records and continues safe steps; xlsx and pptx inputs and outputs end to end | API (2 PRs), web-vnext (1 PR) | none | T8 (email to the tester's own mailbox, approved by the synthetic second reviewer; nothing sends before approval), T9 (commitments audit, no task created) | no (T8 delivery to tester mailbox is pre-approved) |
| E, scheduled and proactive | §5.5: a `ClioScheduledTask` tick creates a `kind:'scheduled'` job; create, pause, cancel through a proposal; notification receipts; LegiWatch subscribe and unsubscribe through its service; meeting briefings keep `scripts/generate-meeting-briefings.ts` | API (3 PRs), web-vnext (1 PR) | none | T10 (schedule on the QA client, one triggered run, inbox result, pause), T11 (LegiWatch follow on the QA client), T13 (meeting prep, no effect) | no |
| F, Playwright flows | §5.8: add `@playwright/test` to `apps/web` devDependencies; four flows under `apps/web/e2e/meri/` (delegate and deliver; steer, close, reopen, stop; approval gate; schedule), signed in through a Clerk sign-in-token ticket for the runner identity; run once per release that touches a trait, never as a CI gate (CI is intentionally off) | web (1 PR) | none | all four flows pass once against capiro-internal | no |
| §5.6 writing profile | only if a Stage 2 draft is judged off-voice by Neo | API | none unless memory items cannot carry it | the failing task rerun | no |
| §5.7 Congressional Drafting | starts only after §5.8 passes; its own release train (API domain layer and web workbench), may run alongside Stage 3; result as an addendum to `02-handover.md` | API, web-vnext | none expected (existing entities) | T16, T17, T18 | no |

Sequencing notes.

- Release A ships dark on purpose: nothing in the UI can start a job until Release B, so a bad job state machine cannot reach a user. Verify A by running one ordinary research session and confirming its rows and statuses are unchanged.
- Release B is the first web-vnext roll. Do the §2.2 web build and a no-change web-vnext roll as a rehearsal (image from current main, `CAPIRO_WEB_RELEASE_SHA` patched by the operator) before the real one, so the first web release with product changes is not also the first use of the build path.
- The lease-expiry sweeper test needs an API restart with a job in flight. Do it on Release B's API roll: start a job on the QA client, promote, confirm the job resumes under a new epoch and finishes. Record it as the worker-loss check from §5.2.
- Releases C, D and E can overlap in development but roll in order, because D's approval resume depends on C's deliverable steps and E's scheduled jobs depend on D's gates.
- Each release's live check is the task listed; each is one paid turn, recorded with Neo's verdict. Do not rerun passing tasks.
- `02-handover.md` with `02_READY_FOR_03` when all four traits have a passing task and no open fail on walls, approvals or truthfulness.

## 5. Stage 3 sequence: Claude as a second provider

Target: about 6 PRs, one dark orchestrator roll, a comparison window on capiro-internal, a recorded decision. Exit `03_COMPLETE` per program plan §6.

### 5.1 PRs and the one V3 edit

| PR | Content | Where | Gate |
| --- | --- | --- | --- |
| 3-1 | Rename `OpenAiResponsesResult` to a provider-neutral result type (function calls, usage, telemetry, deadline), no behavior change | `apps/meriv2-orchestrator/src/meri/meriv3/` (rule 3(b) injection seam) | typecheck, existing specs unchanged |
| 3-2 | `anthropic-messages.client.ts` next to `openai-responses.client.ts`, same `complete(params)` contract; reuses `prepareAnthropicRequest` from `packages/shared/src/ai-model-policy.ts`, `prompt-cache.helpers.ts` for `cache_control` on system and tools, and the streaming request and error handling in `apps/meriv2-orchestrator/src/meri/request-scoped-llm.client.ts` (raw `fetch` to `https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`, thinking-delta parsing already present); pricing entries in `meriv3-pricing.ts` | orchestrator, additive module | unit specs against recorded responses, including a refusal, a 429 with Retry-After, a tool call and a streamed thinking block |
| 3-3 | Client selection by model id in `meriv3-reasoning.ts` (`MERIV3_MODEL` family and the tenant override): a Claude id resolves the Anthropic client; `meri.module.ts` provides the client interface; `MeriV3AssistantService` depends on the interface and reports `provider` from the client instead of the three `provider: 'openai'` literals (lines near 1291, 2639, 4377) | orchestrator; the only V3 edit | typecheck, focused specs; dark until a tenant policy names a Claude model |
| 3-4 | Comparison record and decision in `03-handover.md`; production default change only if Neo decides it (a §2.5 configuration revision on the orchestrator `MERIV3_*` env plus CDK codification) | docs, maybe infra and TD env | n/a |

Adapter constraints that follow from the current Claude Messages API (verified against the API reference on 2026-10-05; re-check `shared/model-migration.md` in the `claude-api` skill before writing code):

- Model ids are exactly `claude-opus-5-5` and `claude-sonnet-5` for the §6.2 list; no date suffixes. The current Sonnet is `claude-sonnet-5-5`; adding it to the comparison is Neo's call, not the agent's.
- Thinking is always on for Opus 5.5: send `thinking: {type: 'adaptive'}` or omit it; `{type: 'disabled'}` and `budget_tokens` are rejected. Depth is `output_config.effort`; Opus 5.5 defaults to `medium`, so map V3's reasoning profiles to explicit effort levels (fast: low, standard: medium or high, deep: xhigh, max: max) and record the mapping.
- Forced tool choice (`any` or a named tool) returns 400 on Opus 5.5. V3's forced function lookup must map to `tool_choice: {type: 'auto'}` plus an instruction naming the tool and `strict: true` on the tool definition. Tool schemas pass through unchanged (they are Anthropic-native already).
- No assistant prefill. Any V3 prefill-style continuation must become an instruction or a structured output.
- Thinking blocks are bound to the model and the conversation. Within a turn's tool loop the adapter must echo every assistant content block, thinking included, back unchanged and keep the message history append-only. If V3 rewrites earlier assistant content between calls, that is a measured defect to fix at the seam, not inside the loop.
- Stream every request; use the final-message accumulation already present in `request-scoped-llm.client.ts`. Honor the run deadline and budget exactly as the OpenAI client does.
- `stop_reason: 'refusal'` (with `stop_details`) is a classified provider refusal surfaced honestly to the user, never a silent fallback to another model; the orchestrator grants nothing.
- Honor `Retry-After` on 429 and 529 within the deadline (Stage 1 added the same to the OpenAI client).
- Telemetry: `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`; prices Opus 5.5 $4 in, $20 out, $0.20 cache read per million; Sonnet 5 $2 in, $10 out. Verify long-context pricing for inputs above 200,000 tokens before the comparison, since a typical turn is about 340,000 input tokens until §4.6 lands.

### 5.2 Roll 8 (orchestrator, dark)

PRs 3-1 to 3-3 merge, then one orchestrator roll per §2. Verification: one live turn on capiro-internal still reports `provider: 'openai'` and the same model in `meri.api.turn.finalized`; no change in `servedBy`.

### 5.3 Comparison window (capiro-internal only)

1. Verify the mechanism first: whether `POST /api/capiro-admin/tenants/:tenantId/ai-credential/model` accepts a Claude model id on the tenant's existing OpenAI credential, and how `usedTenantKey` resolves when the model is Claude (the platform `ANTHROPIC_API_KEY` is the expected key; a tenant OpenAI key must never be sent to Anthropic). If the credential model is provider-bound, add a tenant-scoped model override read by `meriv3-reasoning.ts` in PR 3-3 instead.
2. Ask Neo once for the comparison window. Then, for each of `gpt-6-astra`, `gpt-6.1-sol`, `claude-sonnet-5`, `claude-opus-5-5`: set the capiro-internal model, run T5, T6, T9, T12 and T13 once each (one paid turn at a time), record Neo's verdict, cost and latency from the finalized-turn telemetry, and set the model back to `gpt-6.1-sol` at the end. Twenty paid tasks in total; no repeats, no graders.
3. Record the per-surface decision (chat turns, jobs) in `03-handover.md`. A HOLD on the default is a complete outcome. If Neo chooses a new default, it is a §2.5 configuration revision plus CDK codification, with Neo's OK at the time.
4. Fine-tuning stays on hold; `legislative_analyst`, `legislative_drafter`, `ga_writer` exist only as child-step prompts if a Stage 2 task showed a gap.

## 6. Verification matrix

| Change class | Proof required before "deployed" is written |
| --- | --- |
| Any roll | §2.6 in full: migration drift clean, image parity clean, served SHA and digest match, one live turn with verdict, `STATUS.md` entry with revision and rollback revision |
| Flag flip | before and after readback of `clioFeatureFlags` for the tenant, the two turns, recorded |
| Migration | `Applying migration` line in the migrate task's stream, `verify-migrations.ts --live` clean, revision recorded |
| Configuration revision | env diff printed and saved, service stable, `DRIFT-FINDINGS.md` and CDK updated |
| Deletion PR | reachability audit saved (importers grep, typecheck both apps, focused specs), one live turn after the roll, `servedBy` distribution unchanged a week later |
| AWS resource deletion (Hermes) | read-only reference check saved before, `STATUS.md` and `DRIFT-FINDINGS.md` after |
| Web vNext roll | `CAPIRO_WEB_RELEASE_SHA` equals the source SHA on the served revision; the four Playwright flows that touch the changed trait pass once |

## 7. Ask-Neo checkpoints

| When | What to ask | Why |
| --- | --- | --- |
| Before Roll 1 | OK to start Stage 1 with the first API roll, and OK to apply the xlsx migration on that roll | program plan §11 open item 3; D10 migration apply |
| S1-3 | OK to create the two Meri alarms on the platform alarm topic | they email Neo |
| S1-4 | OK to flip `meriv3.fullChat` off and on for capiro-internal (T15) | production flag |
| S1-6 | OK to change the live WAF (XSS exception for `/api/clio/attachments`) | D10, production WAF |
| S1-8 | OK, once, for the Hermes AWS deletions, with the read-only inventory attached; separately, whether `.hermes/` and `tools/hermes-qa/` are still in use | D8; program plan §11 open item 2 |
| S1-9 | OK to enable the token-ceiling tenant flag on capiro-internal | production flag |
| Stage 1 end | Verdicts for T1 to T4 and T15 | §4.7 |
| Release A | OK to apply the jobs migration | migration apply |
| Each Stage 2 release | Verdicts for the listed tasks | §5.8 |
| Stage 3 §5.3 | OK for the comparison window on capiro-internal, and the decision on the default afterwards | D2; §11 open item 1 |

Nothing else needs a question. Everything else in this plan is authorized by the program plan.

## 8. Records

- `STATUS.md`: top section only, replace rather than append, one paragraph per roll or decision, with revision, rollback revision, commit, digest, live check and verdict.
- `docs/meri/releases/<date>/<name>/`: `README.md`, `release-qualification.json`, build readback, served baseline and readback, migrate task stream excerpt when a migration ran.
- `01-handover.md`, `02-handover.md`, `03-handover.md`: the stage records with their exit labels.
- `infra/cdk/DRIFT-FINDINGS.md`: every configuration revision, alarm, WAF change and AWS deletion.
- `01-source-acquisition.md`: any open-source slice adopted under program plan §3 rule 8 (expected only in §5.7).
- Verdicts: the review page or `STATUS.md`, as Neo prefers; the runner's `results.jsonl` is the machine record.

## 9. Deployment risks and their mitigations

1. The migrate family's latest revision is read-only (`:83`). Mitigation: §2.4 always sets `command=["migrate"]` and reads the stream for `Applying migration`.
2. A dropped `MERIV3_ENABLED` after Roll 1 is an outage, not a fallback. Mitigation: S1-2 codifies it before Roll 1 merges; the alarm from S1-3 catches it within five minutes; rollback is the configuration revision.
3. The release operator refuses on configuration drift. Mitigation: never run a configuration revision while a manifest is live; prepare and promote in the same hour.
4. Concurrent merges move main while an image builds. Mitigation: the ancestry check twice, the second immediately before `promote`; rebuild rather than force.
5. Web vNext has not been built or rolled in weeks and cannot build on this host. Mitigation: the rehearsal roll before Release B; the ARM CodeBuild project.
6. Deleting V1 before inventorying the prelude breaks `MeriV3ProxyService` construction. Mitigation: S1-11 starts with the inventory and the `installRawPhase19Adapters` removal in the same PR.
7. The shared local Postgres and stash stack. Mitigation: §0.2 rules; one worktree per PR.
8. The runner cannot approve as a second reviewer today. Mitigation: S1-0 adds the synthetic identity before T3.
9. A Claude turn with a forced tool choice or a disabled-thinking parameter fails with 400 and could be mistaken for a provider outage. Mitigation: the §5.1 constraint list is implemented and unit-tested before Roll 8.
10. The ~340,000-token turn makes the Stage 3 comparison expensive and may cross a long-context price band on either provider. Mitigation: §4.6 lands in Stage 1; the comparison records cost from telemetry, not estimates.

## 10. Prompt to start the Opus 5.5 lead agent

"Read `docs/meri/implementation/00-Meri-Program-Plan-2026-10-05.md`, then `00-Meri-Deployment-Plan-Opus-5-5-2026-10-05.md`, then the top of `STATUS.md` and `HANDOVER-2026-10-05.md`. Run at high effort, xhigh for deletions and rolls. Execute Stage 1 in the order of deployment plan §3.1, one PR or one roll per session, from a fresh worktree on current main using deployment plan §0.2. Ship only through deployment plan §2. Test only as program plan §9 says. Run real tasks only as neo@capiro.ai in capiro-internal, one paid turn at a time, and record my verdicts. Ask me at the checkpoints in deployment plan §7 and nowhere else. Write `STATUS.md` at the end of every session. When Stage 1's exit holds, write `01-handover.md` and continue with deployment plan §4."
