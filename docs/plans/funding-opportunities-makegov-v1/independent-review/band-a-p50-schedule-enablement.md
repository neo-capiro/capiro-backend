# Band A — P50 independent review: the schedule/webhook enablement plan

**Artifact under review:** `docs/runbooks/funding-opportunities-rollout.md`, **Part J (§30–34)**,
"controlled schedule and webhook enablement (P50)" (lines 1820–1995).

**Convention:** `docs/runbooks/phase-2-independent-live-validation.md` §6.2 — a reviewer who was
not the implementer, read-only verification of live claims, a verdict that is exactly one of two
strings, and a dated approval record.

**Scope:** Part J reviewed *as a procedure a human will execute against live `capiro-dev`*, which
serves `app.capiro.ai`. Not a code review of the jobs it schedules.

**Pinned commit:** `d800dcfde5`. Every repo citation was read via `git show d800dcfde5:<path>` from
`C:\dev\capirov2`; that working tree was not touched. Line numbers are as of this commit.

**Live verification:** `AWS_PROFILE=capiro-dev`, account `967807252336`, `us-east-1`, on
**2026-08-13**. Read-only throughout — only `sts get-caller-identity`, `events list-rules`,
`events list-targets-by-rule` (×90), `ecs list-task-definitions`, `ecs describe-task-definition`,
`cloudformation list-stacks`, `cloudformation list-stack-resources`,
`cloudformation describe-stack-events`, `cloudwatch describe-alarms`. Nothing was created,
enabled, disabled, modified, deployed or deregistered. No secret value was printed at any point.

**Reviewer independence:** I did not implement, deploy, or author any part of this program or this
runbook. A prior read-only investigation reached some of the conclusions below; I re-derived every
live number myself rather than adopting it, and two of my results **differ** from what that
investigation reported (see F3 and F8).

---

## Verdict

```
P50_SCHEDULE_ENABLEMENT_REJECTED
```

Failing sections: **§30a, §30b, §31, §32, §33, §34**.

Part J's headline hazard analysis is the best piece of infrastructure writing in this runbook, and
its central numbers are exactly right — I reproduced 27 / 23 / 16 independently, five days after
the runbook measured them, and they still hold to the rule. §30 and §30c pass essentially intact.

But Part J fails as an *executable* procedure on four independent counts:

1. **The seven jobs this program actually needs to enable have no EventBridge rule, and Part J
   contains no procedure for creating one.** All seven Tango/DIBBS/SBIR jobs exist in CDK with
   `enabled: false` and exist as container verbs, but **none has a live rule**. Every command in
   §32 reads an existing rule; all seven return `ResourceNotFoundException`. The only in-repo
   mechanism that creates them is the `cdk deploy` that §34 forbids. (F2)
2. **§34's "Do not run `cdk deploy Capiro-dev-Compute`" is one sentence carrying a blast radius
   that needs a page.** 58 of 94 CDK-declared job names collide *exactly* with live rule names;
   the stack owns **zero** `AWS::Events::Rule` resources today; and the last attempt (2026-07-25)
   created 76 rules, failed, and its rollback deleted all 76 — while also attempting to
   delete-and-recreate the production A/AAAA records for `capiro.ai` and `app.capiro.ai`. (F1)
3. **§30b is stale in a way that misdirects.** Its claim about revision 9 is true and I confirm it
   verbatim — but the fix it prescribes was already made at revision 10, and the current revision
   is 14. Meanwhile revisions 13 and 14 carry a **different, previously unreported defect that
   breaks the canonical migration path outright**. (F3, F4)
4. **§33's eight required alarms: zero of eight exist**, and §33 gives no command, namespace,
   dimension or threshold to create any of them. (F5)

**Answer to the mandatory question (§5 of the brief):** No. As written, Part J does **not** give an
operator everything needed to safely enable one job without touching the others. For the four
Funding-Opportunities rules that *do* exist it comes close — the §32 record is fully obtainable and
`aws events disable-rule` is a real, sufficient rollback. For the seven jobs this program is
actually about, it forces improvisation on live infrastructure: the operator must invent a
`put-rule`/`put-targets` invocation including the IAM invoker role, three subnet ids, a security
group, the container name, and the `Input` override JSON, none of which Part J states. Details in
F2 and F10.

**Do not fix anything from this document in place.** Findings are queued below, severity-ranked,
each with the exact evidence and the exact runbook text change a fixer needs.

---

## What passes

Stated first, because it is substantial.

**§30's headline numbers are exactly right, and I reproduced them independently five days later.**
I swept all **90** EventBridge rules in the account with `list-targets-by-rule` (using `Targets[]`,
not `Targets[0]` — see F7) and counted by task-definition family:

| claim in §30 / §30a | runbook | measured 2026-08-13 | |
|---|---:|---:|---|
| rules targeting `capiro-dev-api-migrate` | 27 | **27** | PASS |
| …of those, NOT revision-pinned | 23 | **23** | PASS |
| …of those 23 unpinned, ENABLED | 16 | **16** | PASS |
| rules targeting `capiro-dev-api-admin-migrate` | 0 | **0** | PASS |

Supplementary detail the runbook does not state and which supports it: the 4 pinned rules are all
pinned at `:42` (`extract-bill-pe-codes`, `match-pe-mentions`, `pe-derive-chain`,
`watch-budget-docs`), and 20 of the 27 are enabled in total (16 unpinned + 4 pinned).

- **All six jobs §30 names as consequences are confirmed unpinned and enabled** against
  `capiro-dev-api-migrate`: `capiro-dev-sync-sam-opportunities`, `capiro-dev-enrich-grant-details`,
  `capiro-dev-generate-grant-opportunity-candidates`, `capiro-dev-sync-federal-award`,
  `capiro-dev-refresh-memory-graph`, and both clio jobs (`capiro-dev-run-clio-scheduled-tasks`,
  `capiro-dev-emit-clio-alerts`).
- **§30a's `deploy-dev.sh` claim is verbatim correct.** `scripts/deploy-dev.sh` line 49:
  `MIGRATE_TD="capiro-dev-api-admin-migrate"   # task def family; latest ACTIVE revision is used`.
- **§30b's claim about revision 9 is verbatim correct.** `capiro-dev-api-admin-migrate:9`
  (registered 2026-08-06T21:13:37Z) does run
  `migrate resolve --rolled-back 20260503170000_directory_contact_notes … || true` before
  `migrate deploy`, unconditionally. The runbook did not overstate this.
- **§30's three "consequences worth internalising" are sound**, and consequence 2 is not
  hypothetical: `capiro-dev-api-migrate` reached revision **60** at 2026-08-13T21:10:57Z, during
  this review. Per §30's own logic, the image behind 16 enabled scheduled jobs changed today.
- **§30c is accurate and its warning against casual pinning is well-judged** — and confirmed live:
  the 4 rules pinned at `:42` are now 18 revisions behind, which is precisely the failure mode
  §30c names.
- **All seven new job verbs are dispatchable.** `sync-tango-dibbs`, `sync-tango-sbir`,
  `process-tango-events`, `generate-dibbs-opportunity-candidates`,
  `generate-sbir-opportunity-candidates` (and the two reconcile jobs, which reuse the sync verbs
  with `--full`) all resolve in `apps/api/scripts/entrypoint-dispatcher.inc`. No renamed-or-missing
  script here.
- **§31's dependency-ordering principle and the "webhooks supplement, never replace" paragraph are
  correct and worth keeping** unchanged. The defect in §31 is its table's contents, not its logic.
- **§32's field list is the right list**, and for a rule that exists it is fully obtainable. I
  pulled the complete record for `capiro-dev-generate-sam-opportunity-candidates` and every field
  §32 asks for was present.

---

## Findings

### F1 — P0 — §34: the `cdk deploy` prohibition understates its own blast radius by a wide margin

§34's entire warning is three lines: *"Do not run `cdk deploy Capiro-dev-Compute`. The tracked
Compute stack is drifted; enabling live rules is an out-of-band operation until that drift is
formally reconciled."* An operator reading "drifted" will picture a diff. What is actually there is
a stack that has been sitting in a failed-rollback state for three weeks, whose last deploy attempt
reached into production DNS.

**The naming collision the brief asked me to confirm — confirmed.**
`infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts` sets
`ruleName: \`capiro-${props.envName}-${kebab(job.id)}\``, and `compute-stack.ts:1586` passes
`envName: cfg.envName` (= `dev`) with `jobs: INGESTION_JOBS`. The three rules named in the brief
collide **exactly**, and all three are ENABLED and pointed at a per-job family today:

| CDK job id | rule name CDK would create | live state | task-def family it ACTUALLY targets today |
|---|---|---|---|
| `SyncCongress` | `capiro-dev-sync-congress` | ENABLED | `capiro-dev-api-sync-congress` (unpinned) |
| `SyncLegiscanBills` | `capiro-dev-sync-legiscan-bills` | ENABLED | `capiro-dev-api-sync-legiscan-bills` (unpinned) |
| `SyncBea` | `capiro-dev-sync-bea` | ENABLED | `capiro-dev-api-sync-bea` (unpinned) |

This is not three rules. **58 of the 94 jobs in `INGESTION_JOBS` collide with a live rule name.**
The construct points *every* rule at one shared `props.taskDefinition` — the `syncJobsTaskDef`
whose family is `capiro-dev-api-sync-jobs`, container `api-sync-jobs` — so a successful deploy
would repoint all 58 away from the 20-odd distinct per-job families they use today onto a single
task definition, silently changing image, environment, secret bundle and container name for all of
them at once.

**But a deploy would not get that far, and that is worse.** The `Capiro-dev-Compute` stack owns
**0** `AWS::Events::Rule` resources (51 resources total; the census is 7 IAM roles, 6 IAM policies,
5 ECS task definitions, 4 Route53 record sets, 4 log groups, 3 target groups, 3 listener rules,
3 ECS services, 3+3 autoscaling, 2 listeners, WAF, ALB, cluster, CDK metadata). CloudFormation
would therefore attempt **CREATE** on all 94 and fail with `already exists` on the first of the 58
collisions, triggering another rollback of a stack that is already
`UPDATE_ROLLBACK_COMPLETE`.

**This exact thing already happened.** From the stack's event history:

- The 2026-07-25 update created `IngestionSchedules*` rules and then failed. **76** distinct
  `IngestionSchedules*Rule*` logical ids reached `DELETE_COMPLETE` during the rollback, together
  with `ApiSyncJobsTaskDefB221E6DF`, `ApiSyncJobsLogs4714C6F9`,
  `ApiSyncJobsTaskDefEventsRoleECDC9F5F` and `ApiSyncJobsTaskDefExecutionRole495B990D`.
- Final event: `Capiro-dev-Compute UPDATE_ROLLBACK_COMPLETE` at 2026-07-25T04:47:08Z. The stack has
  been in that state ever since.
- The failure reasons include, verbatim:
  `Tried to delete resource record set [name='app.capiro.ai.', type='A'] but the values provided do not match the current values, Tried to create resource record set [name='app.capiro.ai.', type='A'] but it already exists`
  — and the same for `capiro.ai.` (A **and** AAAA) and `*.app.capiro.ai.`. Also
  `MarketingServiceTaskCountTargetAFD867EB … 'service/capiro-dev/capiro-dev-marketing|ecs:service:DesiredCount|ecs' was not found`.

So the Compute stack owns the live production apex and app DNS records, and the last deploy attempt
tried to delete and recreate them. That is the fact §34 needs to state.

**And even a "clean" deploy would flip live schedules.** Comparing CDK's declared `enabled` against
live state across the 58 collisions:

- **8 currently-ENABLED rules are declared `enabled: false`** → a deploy would **disable** them:
  `capiro-dev-sync-legistorm-directory`, `capiro-dev-sync-legistorm-districts`,
  `capiro-dev-sync-legistorm-trips`, `capiro-dev-reconcile-legistorm-trips-full`,
  `capiro-dev-sync-federal-assistance-awards`, `capiro-dev-enrich-assistance-awards`,
  `capiro-dev-sync-grants-reconcile`, `capiro-dev-enrich-grant-details`.
  (`ingestion-schedule.ts` documents this drift in comments — "`enabled: false` below does NOT
  describe reality" — but the comments are in the CDK file, not in the runbook the operator reads.)
- **2 currently-DISABLED rules are declared `enabled: true`** → a deploy would **enable** them:
  `capiro-dev-flush-tracker-digests-daily`, `capiro-dev-flush-tracker-digests-weekly`.
- **36 rules do not exist live and would be created — 21 of them ENABLED**, including
  `capiro-dev-emit-changes`, `capiro-dev-generate-briefings`, `capiro-dev-compute-health-scores`,
  `capiro-dev-refresh-kg-edge-cache`, `capiro-dev-import-dow-directory`,
  `capiro-dev-sync-legiscan-masterlist-wide` and 15 others.

Note the direction of the second bullet: a `cdk deploy` here does not only revert or disable. It
**turns on** crons that a human deliberately turned off. That is the sentence §34 is missing.

**Required runbook change — replace §34's three-line warning with a new §34a.** Suggested text:

> **### 34a. Why `cdk deploy Capiro-dev-Compute` is prohibited (concretely)**
>
> `ScheduledIngestionJobs` names every rule `capiro-${envName}-${kebab(job.id)}`
> (`infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts`). Measured 2026-08-13, **58 of the 94
> jobs in `INGESTION_JOBS` produce a name that already exists live** — including
> `capiro-dev-sync-congress`, `capiro-dev-sync-legiscan-bills` and `capiro-dev-sync-bea`, all
> ENABLED and targeting per-job families (`capiro-dev-api-sync-congress`,
> `capiro-dev-api-sync-legiscan-bills`, `capiro-dev-api-sync-bea`) that CDK does not know about.
> The construct points every rule at one shared task definition, so a successful deploy would
> repoint all 58 onto `capiro-dev-api-sync-jobs` at once.
>
> It would not get that far. `Capiro-dev-Compute` owns **zero** `AWS::Events::Rule` resources
> today, so CloudFormation would CREATE, not UPDATE, and fail `already exists` on the first
> collision — rolling back a stack that has been in `UPDATE_ROLLBACK_COMPLETE` since
> 2026-07-25T04:47:08Z. That rollback is not hypothetical: it deleted **76** `IngestionSchedules*`
> rules plus `ApiSyncJobsTaskDef`, `ApiSyncJobsLogs` and both its IAM roles. The same failed update
> also attempted to delete-and-recreate the **production** Route53 A/AAAA records for `capiro.ai`,
> `app.capiro.ai` and `*.app.capiro.ai`, which this stack owns.
>
> Finally, CDK's declared state does not match live even where names agree: a deploy would
> **disable 8 currently-enabled** rules (the LegiStorm four, both assistance-award jobs,
> `sync-grants-reconcile`, `enrich-grant-details`), **enable 2 currently-disabled** ones (both
> `flush-tracker-digests-*`), and **create 36 new rules, 21 of them enabled**. A `cdk deploy` here
> turns crons **on** that a human deliberately turned off. Reproduce with the sweep in §30
> (corrected form in §30d) before believing any of these numbers are still current.

---

### F2 — P0 — §31/§32: Part J cannot be followed at all for the seven jobs this program needs

The seven jobs the brief names — `SyncTangoDibbs`, `ReconcileTangoDibbsFull`, `SyncTangoSbir`,
`ReconcileTangoSbirFull`, `ProcessTangoEvents`, `GenerateDibbsOpportunityCandidates`,
`GenerateSbirOpportunityCandidates` — are all present in `infra/cdk/lib/ingestion-schedule.ts` at
`d800dcfde5`, all with `enabled: false`, and all seven verbs dispatch correctly. **None of the
seven has a live EventBridge rule.** Verified against the full 90-rule inventory:

| CDK job id | rule name it would get | live? |
|---|---|---|
| `SyncTangoDibbs` | `capiro-dev-sync-tango-dibbs` | **absent** |
| `ReconcileTangoDibbsFull` | `capiro-dev-reconcile-tango-dibbs-full` | **absent** |
| `SyncTangoSbir` | `capiro-dev-sync-tango-sbir` | **absent** |
| `ReconcileTangoSbirFull` | `capiro-dev-reconcile-tango-sbir-full` | **absent** |
| `ProcessTangoEvents` | `capiro-dev-process-tango-events` | **absent** |
| `GenerateDibbsOpportunityCandidates` | `capiro-dev-generate-dibbs-opportunity-candidates` | **absent** |
| `GenerateSbirOpportunityCandidates` | `capiro-dev-generate-sbir-opportunity-candidates` | **absent** |

This breaks Part J in three places at once:

- **§31's enablement-order table has no row for any of the seven.** It was written before they
  existed (they are part of today's D-79 / #943 change). Its seven rows cover SAM, grants, two
  Tango opportunity jobs, two producers, lifecycle and the event drain — DIBBS and SBIR appear
  nowhere, in either the source-sync layer or the producer layer.
- **§32's per-job record is unobtainable for all seven.** Every one of its six "where to get it"
  commands (`list-targets-by-rule`, `describe-rule` ×2) targets an existing rule; for these seven
  they return `ResourceNotFoundException`. So does its **Disable command**, which is the runbook's
  only stated rollback. §32's own rule — *"A rule nobody can disable in one command is a rule
  nobody should have enabled"* — is violated by construction: there is no rule to disable, and the
  runbook never says how one comes to exist.
- **§34's rollback step 2 is likewise inapplicable**, for the same reason.

**Part J contains no rule-creation procedure anywhere.** Grepping §30–34 for EventBridge verbs
returns only `list-targets-by-rule` (×2), `describe-rule` (×2), `disable-rule` (×2) — no
`put-rule`, no `put-targets`, no `enable-rule`. The nearest thing in the whole runbook is Part G
§25's `aws events put-rule --profile capiro-dev --region us-east-1 --state DISABLED ...`, which
ends in a literal `...`: no `--schedule-expression`, no `put-targets` at all, and therefore nothing
that would attach an ECS target, task definition, network configuration or command override.

The only mechanism in the repo that creates these rules is `cdk deploy Capiro-dev-Compute`, which
§34 forbids and which F1 shows would be destructive. **The result is a dead end**: an operator
following Part J for the DIBBS/SBIR/event-drain jobs has no sanctioned path, and will improvise
`put-rule`/`put-targets` against live infrastructure with values they had to reverse-engineer.

**Required runbook change — a new §32a giving the out-of-band creation procedure.** The values are
derivable and should be written down rather than rediscovered. From
`list-targets-by-rule --rule capiro-dev-generate-sam-opportunity-candidates` (read-only, verified
2026-08-13), the working shape of a Funding-Opportunities rule target on this account is:

- `RoleArn`: `arn:aws:iam::967807252336:role/capiro-dev-eventbridge-sync-invoker`
- `EcsParameters.TaskDefinitionArn`: `…:task-definition/capiro-dev-api-migrate` (unpinned — see
  the §30 hazard; a new rule should target a **pinned** revision of
  `capiro-dev-api-sync-jobs` instead, per §30c's stated end-state)
- `LaunchType`: `FARGATE`, `TaskCount`: 1, `PlatformVersion`: `LATEST`
- `NetworkConfiguration.awsvpcConfiguration`: subnets `subnet-0e38bd390f8961fef`,
  `subnet-0920665f91c905f01`, `subnet-06db79cd21239de19`; security group `sg-01def4e5c0fe44d4a`;
  `AssignPublicIp: DISABLED`
- `Input`: `{"containerOverrides":[{"name":"api","command":["<verb>","--commit"]}]}` — note the
  container name is `api` on the `api-migrate` family, but `api-sync-jobs` on the
  `capiro-dev-api-sync-jobs` family. Getting this wrong produces a task that starts and does
  nothing useful.

§32a must also state the rule is created `--state DISABLED` and that the §32 record is filled in
*from the created rule* before `enable-rule` is ever run — which restores §32's guarantee.

Whoever writes §32a should re-derive these values at the time rather than trusting this list; the
point of the section is that the operator has a sanctioned procedure, not that these specific ids
are eternal.

---

### F3 — P1 — §30b is stale: the hazard it names was fixed at revision 10, and the current revision is 14

**The claim itself is confirmed.** `capiro-dev-api-admin-migrate:9`, registered
2026-08-06T21:13:37Z, runs exactly what §30b says, unconditionally and with `|| true`:

```
node ./node_modules/prisma/build/index.js migrate resolve --rolled-back 20260503170000_directory_contact_notes --schema=./prisma/schema.prisma || true
```

**But revision 9 has not been the latest for five days.** Full revision history of the family
(all 14 ACTIVE):

| rev | registered (UTC) | carries `migrate resolve --rolled-back`? |
|---:|---|---|
| 9 | 2026-08-06T21:13:37Z | **yes** |
| 10 | 2026-08-08T15:06:02Z | no |
| 11 | 2026-08-08T16:00:50Z | no |
| 12 | 2026-08-08T00:21:06Z¹ | no |
| 13 | 2026-08-09T01:21:46Z | no |
| **14 (latest ACTIVE)** | **2026-08-09T03:54:54Z** | **no** |

¹ as returned; ordering by revision is authoritative.

So the answer to the brief's question is: **revision 14 is still current, and it does NOT carry the
`migrate resolve` hazard — it was removed at revision 10.** The prior investigation's date of
"2026-08-09" is right in UTC (the API returns `2026-08-08T23:54:54-04:00`); either form is
defensible, but the runbook should record UTC to avoid the ambiguity.

§30b's instruction — *"Before the next dev migration run, register a clean revision whose command
is `migrate deploy` alone, and let `deploy-dev.sh` pick that up as latest"* — is therefore already
satisfied, and reads as outstanding work. An operator acting on it would register a redundant
15th revision. Worse, it invites them to believe the family is now healthy, which F4 shows it is
not.

**Required runbook change — rewrite §30b as a verification step, not a remediation instruction:**

> **### 30b. `capiro-dev-api-admin-migrate` — verify the command before every migration run**
>
> Revision 9 carried a hardcoded
> `prisma migrate resolve --rolled-back 20260503170000_directory_contact_notes || true`, left over
> from a past recovery, unconditional and unable to announce itself. The dangerous case was the one
> where it *succeeds*: the ledger says rolled-back for a migration whose objects still exist, and
> the following `migrate deploy` re-applies it.
>
> **That line was removed at revision 10 (2026-08-08T15:06:02Z) and is absent from every revision
> since, including the current latest ACTIVE, revision 14 (2026-08-09T03:54:54Z).** No further
> remediation is required for it.
>
> Because `deploy-dev.sh` resolves this family by name and takes the latest ACTIVE revision, this
> is a standing check, not a one-off. Before any migration run:
>
> ```bash
> # READ-ONLY. Expect exactly one node invocation, `migrate deploy`, and a DATABASE_URL
> # that interpolates ${ENCODED_PASSWORD}.
> aws ecs describe-task-definition --region us-east-1 \
>   --task-definition capiro-dev-api-admin-migrate \
>   --query 'taskDefinition.{rev:revision,registeredAt:registeredAt,cmd:containerDefinitions[0].command}'
> ```
>
> Anything other than a bare `migrate deploy` — a `resolve`, a `db push`, a `|| true` — is a
> finding, not a detail. **See §30e before running this family at all.**

---

### F4 — P1 — NEW: `capiro-dev-api-admin-migrate:13` and `:14` build a `DATABASE_URL` with the literal password `***`

Not in the runbook, not in the prior investigation. Found while verifying F3.

Revisions 13 and 14 compute `ENCODED_PASSWORD` and then **do not use it**. The `DATABASE_URL` they
export contains the literal three-character string `***` where the password belongs:

```
ENCODED_PASSWORD=$(node -e '…encodeURIComponent…' "$DB_PASSWORD")
export DATABASE_URL="postgresql://${DB_USER}:***@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require"
node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
```

**This is not output redaction — I ruled that out before reporting it.** Measured on the raw CLI
output inside the shell, without printing any secret:

| rev | occurrences of `ENCODED_PASSWORD` | contains `${DB_USER}:${ENCODED_PASSWORD}@` | contains literal `:***@` | command length |
|---:|---:|---|---|---:|
| 12 | **2** | yes | no | 330 |
| 13 | **1** | no | **yes** | 314 |
| 14 | **1** | no | **yes** | 314 |

The 16-character delta is exactly the length difference between `${ENCODED_PASSWORD}` (19) and
`***` (3). `DB_PASSWORD` occurs once in all three (the `node -e` argument only). Revision 14's
secret bundle is byte-identical to revision 12's and contains **no** `DATABASE_URL` secret to fall
back on — `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` are injected individually, exactly as
before. So the exported `DATABASE_URL` is the one Prisma will use, and its password is `***`.

**Consequence.** `scripts/deploy-dev.sh` line 49 resolves this family by name and takes the latest
ACTIVE revision — which is 14. **The canonical migration path for `capiro-dev` is broken right
now** and will fail Aurora authentication on the next run. This is loud rather than silent, which
is why it is P1 and not P0: it cannot corrupt the migration ledger the way the §30b hazard could.
But it means §30a's reassurance — *"the canonical deploy path avoids [the §30 hazard]"* — is
currently true and useless, because the safe family does not work. An operator who hits this under
time pressure has an obvious and very bad workaround available: switch `MIGRATE_TD` to
`capiro-dev-api-migrate`, which is precisely the 16-job de facto deploy §30 exists to prevent.

The `***` shape strongly suggests a task-definition JSON was hand-assembled from masked output
(console, a log, or a pasted doc) and re-registered. Whoever fixes it should check revision 13's
provenance for the same pattern elsewhere, not just patch 15.

**Required runbook change — new §30e, placed immediately after §30b:**

> **### 30e. The current `api-admin-migrate` revision is broken — check before you rely on §30a**
>
> Revisions **13 and 14** of `capiro-dev-api-admin-migrate` export a `DATABASE_URL` whose password
> is the literal string `***`. `ENCODED_PASSWORD` is computed and then discarded; no `DATABASE_URL`
> secret exists to override it. Since `deploy-dev.sh` takes the **latest ACTIVE** revision of this
> family, a migration run today authenticates as `***` and fails.
>
> **Fix it by registering a clean revision 15** — copy revision 12's container definition, whose
> URL correctly interpolates `${ENCODED_PASSWORD}` — and re-run the §30b check. **Do not work
> around it by pointing `MIGRATE_TD` at `capiro-dev-api-migrate`.** That is a de facto deploy of 16
> scheduled jobs (§30) and is never the right answer to a broken admin-migrate revision.

---

### F5 — P1 — §33: none of the eight required alarms exists, and §33 cannot be executed as written

§33 opens *"Create these before enabling, not after. An alarm added after the first bad night is an
alarm that did not catch the first bad night."* The instinct is right. The section is inert.

I enumerated all **50** CloudWatch alarms in `us-east-1` on this account. **Zero** correspond to any
of §33's eight rows:

| §33 alarm | exists live? |
|---|---|
| Last success age | **no** |
| Error / degraded run (`INCOMPLETE`) | **no** |
| Checkpoint incompleteness (`tango_sync_checkpoint.completeness`) | **no** |
| 429 / breaker (`tango_api_usage.status = 'rate_limit'`) | **no** |
| Webhook signature failures (401s on `/webhooks/tango`) | **no** |
| Queue age (oldest `pending` in `tango_event_outbox`) | **no** |
| Poison events (`quarantined` count) | **no** |
| Alert volume (alerts/day, alerts/client) | **no** |

The only superficially similar alarms belong to other features and must not be mistaken for these:
`capiro-dev-meriv2-outbox-oldest-age`, `capiro-dev-meriv2-outbox-dead-letter`,
`capiro-dev-meriv2-outbox-retries` (Meri V2, a different outbox), and `capiro-dev-pe-sync-*`.

Separately, §33 is not executable even by a willing operator. Five of the eight rows describe
**database predicates**, not CloudWatch metrics — `tango_sync_checkpoint.completeness <> 'complete'`,
`tango_api_usage.status = 'rate_limit'`, oldest `pending` row age, `quarantined` count, alerts/day.
No metric is emitted for any of them at this commit as far as Part J states, and §33 gives no
namespace, no dimension, no threshold, no period, no `put-metric-alarm` command, and no
metric-publishing job. "Test each alarm by forcing its condition once" has nothing to act on.

**Required runbook change.** §33 must either (a) grow a concrete per-row spec — metric name,
namespace, dimensions, statistic, period, threshold, and the emitting job — plus the
`put-metric-alarm` invocation, or (b) be honestly relabelled as a *design* requirement with an
explicit blocking note that **no alarm from this table exists today (0/8, verified 2026-08-13)** and
that enabling any job before they do violates §33's own opening sentence. Either is acceptable;
silence is not, because as written §33 reads like a checklist someone has been ticking.

---

### F6 — P1 — §31: three of the seven rows in the enablement-order table cannot be enabled

Beyond the missing DIBBS/SBIR rows (F2), the existing table names jobs that have no rule anywhere:

| § | Job | Verb | live rule? | CDK job? |
|---:|---|---|---|---|
| 1 | SAM source sync | `sync-sam-opportunities` | yes (ENABLED) | yes |
| 2 | Grant detail enrichment | `enrich-grant-details` | yes (ENABLED) | yes |
| **3** | Tango opportunity shadow | `sync-tango-opportunity-shadow` | **no** | **no** |
| **4** | Tango notice history | `sync-tango-opportunity-notices` | **no** | **no** |
| 5 | Producers | `generate-sam-opportunity-candidates`, `generate-funding-grant-candidates` | yes (both DISABLED) | yes |
| 6 | Lifecycle | `process-funding-opportunity-lifecycle` | yes (DISABLED) | yes |
| **7** | Event drain | `process-tango-events` | **no** | yes (`ProcessTangoEvents`, `enabled: false`) |

Rows 3 and 4 are the sharper problem. Both verbs are real — `entrypoint-dispatcher.inc:677` and
`:692` dispatch them, and `scripts/sync-tango-opportunity-shadow.ts` /
`sync-tango-opportunity-notices.ts` exist — but there is **no `SyncTangoOpportunityShadow` or
`SyncTangoOpportunityNotices` entry in `ingestion-schedule.ts`**, so not even the forbidden
`cdk deploy` would create them. They are runnable by hand and schedulable by nobody.

The table itself says row 4 feeds *"**the event processor**"* (its only bolded cell). So the
ordering as written makes row 7 unreachable: the drain's stated upstream has no schedule and no
declaration. An operator working the table top-to-bottom stalls at row 3.

**Required runbook change.** §31's table needs (a) a `rule` column recording the live rule name and
its current state, with `— none —` where there is none, (b) rows for the seven new jobs slotted
into the dependency order (source syncs `sync-tango-dibbs` / `sync-tango-sbir` before the
`generate-*-opportunity-candidates` producers; the two `Reconcile*Full` jobs after their
incremental counterparts have run clean twice; `process-tango-events` last), and (c) an explicit
note that rows 3 and 4 have no CDK declaration and require either a new `ScheduledIngestionJob`
entry or the §32a out-of-band procedure — naming which, rather than leaving it open.

---

### F7 — P2 — §30: the verification command cannot reproduce §30's own numbers

The sweep printed in §30 has three defects. It is the command a §6.2 reviewer is meant to re-run,
so its correctness is load-bearing.

```bash
for r in $(aws events list-rules --region us-east-1 --query 'Rules[].Name' --output text); do
  td=$(aws events list-targets-by-rule --rule "$r" --region us-east-1 \
        --query 'Targets[0].EcsParameters.TaskDefinitionArn' --output text)
  case "$td" in *api-migrate:[0-9]*) ;; *api-migrate*) echo "UNPINNED $r";; esac
done
```

1. **`*api-migrate*` also matches `capiro-dev-api-admin-migrate`.** Today that is harmless because
   the admin family has 0 rules — but it makes §30a's "0" row unverifiable *by the very command
   §30 supplies*, since a rule targeting `api-admin-migrate` would be printed as an `api-migrate`
   hit. The table and the command cannot both be checked with one sweep.
2. **`Targets[0]` reads only the first target.** EventBridge allows up to 5 per rule. Any second
   target on the migrate family is invisible. I swept `Targets[]` and got the same 27, so there is
   no undercount today, but the command carries a latent one.
3. **It never reads `State`, so "16 enabled" is not derivable from it.** An operator running the
   documented command gets 23 lines of `UNPINNED <name>` and no way to reach the number the prose
   asserts. This is the defect that matters for a §6.2 re-verification.

**Required runbook change — a new §30d with a corrected, self-sufficient sweep.** This is the one I
actually ran; it reproduces all four numbers in §30/§30a:

> ```bash
> # READ-ONLY. Prints one line per rule with an ECS target: STATE / PIN / family / rule.
> aws events list-rules --region us-east-1 --query 'Rules[].[Name,State]' --output text |
> while IFS=$'\t' read -r name state; do
>   for arn in $(aws events list-targets-by-rule --rule "$name" --region us-east-1 \
>                  --query 'Targets[].EcsParameters.TaskDefinitionArn' --output text </dev/null); do
>     tail=${arn##*task-definition/}
>     case "$tail" in
>       *:[0-9]*) fam=${tail%:*}; pin="PINNED:${tail##*:}" ;;
>       *)        fam=$tail;      pin="UNPINNED" ;;
>     esac
>     printf '%s\t%s\t%s\t%s\n' "$state" "$pin" "$fam" "$name"
>   done
> done | sort > /tmp/eb-sweep.tsv
>
> # exact-family counts — note the ^…$ anchoring, which `*api-migrate*` lacks
> awk -F'\t' '$3=="capiro-dev-api-migrate"' /tmp/eb-sweep.tsv | wc -l                       # expect 27
> awk -F'\t' '$3=="capiro-dev-api-migrate" && $2=="UNPINNED"' /tmp/eb-sweep.tsv | wc -l     # expect 23
> awk -F'\t' '$3=="capiro-dev-api-migrate" && $2=="UNPINNED" && $1=="ENABLED"' /tmp/eb-sweep.tsv | wc -l  # expect 16
> awk -F'\t' '$3=="capiro-dev-api-admin-migrate"' /tmp/eb-sweep.tsv | wc -l                 # expect 0
> ```
>
> Two portability notes worth keeping in the runbook, both of which cost time to rediscover: rule
> names must have any `\r` stripped before being passed to `--rule` (a Windows-authored name list
> silently returns empty targets, not an error), and `aws … --output json` on this account fails
> with a `charmap` codec error on rule descriptions containing `→`, so restrict `--query` to the
> fields you need.

---

### F8 — P2 — §30c: the `capiro-dev-api-sync-jobs` facts are stale, and it is not unused

§30c states the real fix is *"a separate task-definition family for scheduled jobs
(`capiro-dev-api-sync-jobs` already exists, at revision 1, and is what these rules should
target)."* Two corrections, one of which changes the recommendation's risk profile:

- **It is at revision 12, not 1.** Revisions 1–12 exist; **2–5 are INACTIVE**, deregistered by the
  2026-07-25 rollback (F1); 1 and 6–12 are ACTIVE. Revision 12 was registered
  **2026-08-13T16:31:03Z** — during this program — with the image pinned by digest
  (`…@sha256:4208d7e9…`).
- **Three rules already target it**, so the family is not the clean slate §30c implies:
  `capiro-dev-sync-legistorm-districts`, `capiro-dev-sync-legistorm-trips` and
  `capiro-dev-reconcile-legistorm-trips-full`, all **ENABLED** and all pinned to **`:1`** —
  registered 2026-07-24 with image tag `latest`. Those three enabled crons have been running an
  11-revision-old task definition, and are exactly the "pinned rules stop receiving updates"
  failure mode §30c warns about, already live.

This matters for the recommendation: migrating the 23 unpinned rules onto `api-sync-jobs` is not a
move onto virgin ground; it lands them next to three rules pinned to a stale revision, and the
family's revision pointer is already moving (rev 12 today). The reconciliation task §30c defers
should state which revision the migrated rules pin to and what happens to the three legacy `:1`
pins.

**Required runbook change:** correct "at revision 1" to "at revision 12 as of 2026-08-13 (revisions
2–5 INACTIVE, deregistered by the 2026-07-25 Compute rollback)", and add the sentence: *"Three
rules already target this family — `sync-legistorm-districts`, `sync-legistorm-trips`,
`reconcile-legistorm-trips-full` — all ENABLED and all pinned to `:1`. Any reconciliation must say
what happens to those pins."*

---

### F9 — P2 — Part G §25 and Part J §31 give two different enablement orders, uncross-referenced

The same runbook contains two enablement orders that do not agree:

- **§25** (Part G, "Schedules, and closing #680"): *"Order of enablement: catalog syncs → enricher
  → producers → lifecycle. Each layer depends on the one above having run at least once."* Four
  layers. No event drain. No Tango stage.
- **§31** (Part J): a seven-row table ending at the event drain, with two Tango stages in the
  middle.

Neither section references the other. An operator who works Part G to completion believes they are
done after lifecycle and never reaches `process-tango-events` — the one job that turns provider
events into client-visible alerts. §25 also carries its own stale `put-rule ... --state DISABLED
...` fragment (F2) and a "second consecutive committed lifecycle run" gate that §32 restates
differently as "two clean manual commit runs per job".

**Required runbook change:** make §25 defer to §31 explicitly — replace §25's order line with
*"Enablement order and the per-job record are owned by Part J §31–32; do not enable from this
section"* — and reconcile the two-run gate so it is stated once, in §32.

---

### F10 — P2 — §32: "two clean manual commit runs per job" has no invocation form anywhere in Part J

§32's strongest requirement is *"**Two clean manual commit runs per job** before its rule is
enabled. Not one — the second is what proves idempotency and quietness."* The reasoning is right
and it is the single most valuable tripwire in Part J.

There is no `aws ecs run-task` command anywhere in §30–34, and no statement of which task-definition
family, container name, subnets, security group or launch type a manual run should use. The
container name in particular is a live trap: it is `api` on `capiro-dev-api-migrate` and
`api-sync-jobs` on `capiro-dev-api-sync-jobs`, and a `containerOverrides` naming the wrong one
produces a task that starts, runs the default command, and exits 0 — which §30 consequence 1
already warns is indistinguishable from success.

For jobs whose rule exists, the values are recoverable from `list-targets-by-rule` (that is what
§32's table is for). For the seven new jobs they are not recoverable at all, because there is no
rule (F2). Either way the runbook should state the invocation once rather than implying it.

**Required runbook change:** add the `aws ecs run-task` form to §32, with `--started-by` set to
something identifiable, and cross-reference §30 consequence 1 — *"Always check `startedBy` before
believing an exit code"* is advice the runbook gives but never enables, because it never tells the
operator to set `startedBy` on their own runs.

---

### F11 — P3 — §30's hazard fired again during this review; cite it as fact, not hypothesis

`capiro-dev-api-migrate` reached **revision 60**, registered **2026-08-13T21:10:57Z**, while this
review was in progress. Per §30's own analysis that silently changed the container image behind all
16 unpinned+enabled rules, including `sync-sam-opportunities`, `enrich-grant-details` and
`generate-grant-opportunity-candidates` — three of the jobs this program is about.

§30 already makes the argument; it would land harder with a dated instance. Suggested addition to
§30 consequence 2: *"This is not hypothetical. `capiro-dev-api-migrate` went from revision 42 (the
revision 4 rules are pinned to) to revision 60 between 2026-07 and 2026-08-13; each of those 18
registrations silently re-imaged 16 enabled jobs."*

---

## Queue

| # | Sev | § | Finding |
|---|---|---|---|
| F1 | **P0** | 34 | `cdk deploy` prohibition understates blast radius: 58 exact rule-name collisions; stack owns 0 `Events::Rule`; 2026-07-25 rollback deleted 76 rules and touched production `capiro.ai`/`app.capiro.ai` DNS; a deploy would disable 8 live crons, **enable 2 deliberately-disabled ones**, and create 21 new enabled ones. Needs new §34a |
| F2 | **P0** | 31, 32, 34 | All 7 Tango/DIBBS/SBIR jobs have **no live rule**; §32's record and disable command return `ResourceNotFoundException`; Part J has no `put-rule`/`put-targets` procedure. Needs new §32a |
| F3 | P1 | 30b | Stale: rev 9's `migrate resolve` hazard confirmed but removed at rev 10; current is rev 14 (2026-08-09T03:54:54Z). Remediation instruction should become a standing verification |
| F4 | P1 | 30a, 30b | **NEW:** `api-admin-migrate:13`/`:14` build `DATABASE_URL` with literal `***`; `ENCODED_PASSWORD` computed and discarded; canonical migration path broken today. Needs new §30e |
| F5 | P1 | 33 | 0 of 8 required alarms exist (50 alarms swept); 5 of 8 rows are DB predicates with no metric, namespace, threshold or command |
| F6 | P1 | 31 | Rows 3 and 4 (`sync-tango-opportunity-shadow`, `sync-tango-opportunity-notices`) have no rule **and no CDK declaration**; row 7 (`process-tango-events`) has no rule. Table's own stated dependency makes row 7 unreachable |
| F7 | P2 | 30 | Documented sweep cannot reproduce its own numbers: `*api-migrate*` also matches `api-admin-migrate`; `Targets[0]` ignores targets 2–5; `State` never read, so "16 enabled" is underivable. Needs new §30d |
| F8 | P2 | 30c | `capiro-dev-api-sync-jobs` is at rev **12** (not 1), revs 2–5 INACTIVE; 3 ENABLED rules already pin it at `:1` |
| F9 | P2 | 25, 31 | Two different enablement orders in one runbook, uncross-referenced; §25's stops before the event drain |
| F10 | P2 | 32 | "Two clean manual commit runs" has no `run-task` invocation form; container name differs by family (`api` vs `api-sync-jobs`); `startedBy` advised in §30 but never set |
| F11 | P3 | 30 | §30's hazard fired during this review (rev 60 registered 2026-08-13T21:10:57Z); cite as dated fact |

---

## Approval record

**Verdict: `P50_SCHEDULE_ENABLEMENT_REJECTED`** — 2026-08-13, by an independent reviewer who did
not implement, deploy, or author any part of this program or this runbook. Pinned to `d800dcfde5`
for all repo citations; live state measured against `capiro-dev` (account `967807252336`,
`us-east-1`) on 2026-08-13.

Failing sections: §30a, §30b, §31, §32, §33, §34.

Read-only throughout: `list`/`describe`/`get` calls only, no resource created, enabled, disabled,
modified, deployed or deregistered, no database read, no working tree touched, nothing committed.
No secret value was printed — F4 was established from occurrence counts and string lengths computed
inside the shell.

**§30 and §30c pass and should not be touched** beyond the F8 and F11 corrections. Their central
measurement — 27 rules on `capiro-dev-api-migrate`, 23 unpinned, 16 of those enabled, 0 on
`api-admin-migrate` — reproduced exactly, five days after it was taken, and the reasoning built on
it is the strongest safety argument in this runbook. The rejection is of the executable layer
around it: a prohibition whose consequences are not written down (F1), an enablement procedure that
does not cover the jobs it is for (F2), a stale remediation sitting on top of a live breakage
(F3/F4), and an alarm table with nothing behind it (F5).

Re-review should be scoped to the queue above, and should re-run the §30d sweep rather than trusting
any number in this document — the account moved twice while I was measuring it (`api-migrate` to
rev 60, `api-sync-jobs` to rev 12, both on 2026-08-13).
