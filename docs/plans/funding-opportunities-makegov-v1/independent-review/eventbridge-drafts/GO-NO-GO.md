# Tier 3.8 — EventBridge rule drafts for go/no-go

**Status: CREATED. All 7 rules exist in AWS as DISABLED. Nothing is enabled.**

Written 2026-08-14T02:54Z. Updated 2026-08-14 (revision 3): `:13`
registered (ACTIVE, revision 13, image `d800dcfde5`). All 7 `fo-dev-*`
rules created DISABLED with targets verified at `:13`. The create
phase is complete; enable is a separate, later decision.

Live values re-derived 2026-08-14 against account `967807252336` /
`us-east-1` / profile `capiro-dev` (identity
`arn:aws:iam::967807252336:user/capirocli`). Pinned code SHA for the
CDK commands/crons: `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`.

This is the sanctioned out-of-band creation procedure Part J never
contained (P0-9 / P50 F2). It is **not** authorization to run it.

---

## Verdict if asked "create them now?"

**NO-GO until Neo answers the two items below.** Creating DISABLED
rules is still a live write on the sole-live account. Even after a
yes, **do not enable any of them** — that is a later, separate
decision, and several of these jobs are not safe to fire unattended
(P0-1, P0-5, P0-11, P1-4, P1-5).

### PassRole gap — FIXED (2026-08-14)

`capiro-dev-syncjobs-execution-role` is now included in the invoker's
`RunTaskAndPassRole` inline policy Statement[1], verified live:

- `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ`
- `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`
- `arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiMigrateTaskDefExecutionRoleEB-HuOMLdmYvwnx`
- `arn:aws:iam::967807252336:role/capiro-dev-syncjobs-execution-role` ← ADDED

This was applied via `aws iam put-role-policy` and re-read to confirm.
EventBridge can now `ecs:RunTask` + `iam:PassRole` for `:12`/`:13`.

### ECR digest pruned — `:12` is broken for new launches (2026-08-14)

`:12` is digest-pinned to `sha256:4208d7e9...` which has been pruned from
ECR (`ImageNotFoundException` on both tag and digest lookup). Currently
running tasks are unaffected, but any new launch of `:12` — including
firing any EventBridge rule targeting it — would fail with a pull error.

**Fix:** register `capiro-dev-api-sync-jobs:13` with the same container
definition as `:12` but image changed to
`967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:d800dcfde51f6cf21a4b54b511006b9001fd6d2b`
(confirmed still in ECR, digest `sha256:73ddbf9c...`, descendant commit).
The `:13` payload is constructed locally at `%TEMP%/td13-payload.json`
(5470 bytes, 28 secrets by ARN reference, identical roles/CPU/mem/network).
**BLOCKED on Neo's go-ahead to register.**

### Still-open shared-infra risk (not this draft, still live)

`capiro-dev-api-sync-jobs:12` is digest-pinned to
`sha256:4208d7e9ba2215336f63773fedb2ea071145aff8e3f6a8ee42c624ef5f6d5fbe`.
That digest has been **pruned from ECR** (confirmed 2026-08-14). The
re-tag protection originally proposed is no longer possible — you
cannot re-tag an image that no longer exists. The fix is registering
`:13` against a still-present image (see above). Creating DISABLED
rules does not consume the digest; enabling them later against a
pruned digest would fail.

---

## What is being proposed

Seven EventBridge rules on the `default` bus. All `State: DISABLED`.
Naming prefix `fo-dev-` — deliberately **not** CDK's
`capiro-${env}-*` — so a later `cdk deploy Capiro-dev-Compute` cannot
collide with or claim them (P0-8).

| # | CDK id | Proposed rule name | Cron (UTC) | Container command |
|---|---|---|---|---|
| 1 | `SyncTangoDibbs` | `fo-dev-sync-tango-dibbs` | `cron(10 13 * * ? *)` daily 13:10 | `sync-tango-dibbs --commit` |
| 2 | `ReconcileTangoDibbsFull` | `fo-dev-reconcile-tango-dibbs-full` | `cron(10 13 ? * SUN *)` Sun 13:10 | `sync-tango-dibbs --commit --full` |
| 3 | `SyncTangoSbir` | `fo-dev-sync-tango-sbir` | `cron(30 13 * * ? *)` daily 13:30 | `sync-tango-sbir --commit` |
| 4 | `ReconcileTangoSbirFull` | `fo-dev-reconcile-tango-sbir-full` | `cron(30 13 ? * SUN *)` Sun 13:30 | `sync-tango-sbir --commit --full` |
| 5 | `ProcessTangoEvents` | `fo-dev-process-tango-events` | `cron(20 13 * * ? *)` daily 13:20 | `process-tango-events --commit` |
| 6 | `GenerateDibbsOpportunityCandidates` | `fo-dev-generate-dibbs-opportunity-candidates` | `cron(15 13 * * ? *)` daily 13:15 | `generate-dibbs-opportunity-candidates --commit` |
| 7 | `GenerateSbirOpportunityCandidates` | `fo-dev-generate-sbir-opportunity-candidates` | `cron(35 13 * * ? *)` daily 13:35 | `generate-sbir-opportunity-candidates --commit` |

Crons and commands are copied from `infra/cdk/lib/ingestion-schedule.ts`
at `d800dcfde5` (lines 543–739). Sunday full-reconcile overlapping the
daily incremental at the same minute is intentional in the CDK comments
(upserts; Sunday just refreshes what Sunday's incremental already wrote).

JSON for each rule lives next to this file:

- `<name>.put-rule.json`
- `<name>.put-targets.json`
- `index.json` — machine-readable table
- `emit_drafts.py` — regenerator; re-run if any live id below has moved

---

## Shared target (all seven)

Copied from the live working shape of
`capiro-dev-generate-sam-opportunity-candidates` (network / invoker /
cluster) and from the three live rules that already target the
`api-sync-jobs` family (container name + Input shape), then **changed**
in the three places Part J said to change them:

| Field | Value | Why this, not the SAM copy |
|---|---|---|
| Task definition | `capiro-dev-api-sync-jobs:13` **pinned** | `:12`'s digest is pruned from ECR. `:13` (not yet registered) will point at `capiro/dev/api:d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (still in ECR). Same 28 secrets, same roles, same CPU/mem as `:12`. |
| Container name | `api-sync-jobs` | SAM uses `api` because it fires `api-migrate`. Wrong name = task starts, default command, exit 0, did nothing (P50 F10). |
| Role | `capiro-dev-eventbridge-sync-invoker` | Same as every live FO / sync-jobs rule. PassRole gap FIXED 2026-08-14. |
| Cluster | `arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev` | Live. |
| Subnets | `subnet-0e38bd390f8961fef`, `subnet-0920665f91c905f01`, `subnet-06db79cd21239de19` | Live, same as every Fargate one-shot on this account. |
| Security group | `sg-01def4e5c0fe44d4a` | Live. |
| Public IP | `DISABLED` | Live. |
| Launch | `FARGATE` / count 1 / `LATEST` | Live. |
| Logs | `/capiro/dev/api`, stream prefix `sync-jobs` | From `:12`'s log configuration, not SAM's `api` prefix. |

`:13` secrets include `TANGO_API_KEY` (same 28 secrets as `:12`, by ARN reference). Confirmed this session, names only.

---

## Name collision check (this session)

`describe-rule` on all 7 proposed `fo-dev-*` names **and** all 7 CDK
`capiro-dev-*` names → `ResourceNotFoundException` every time. A
`list-rules` filter on `fo-` / `tango` / `dibbs` / `sbir` returned `[]`.
Create-not-overwrite is currently true. **Re-run the describe-rule
loop immediately before any put-rule** — `origin/main` and this
account both move.

---

## What create would and would not do

Would:

- Add 7 DISABLED rules + 7 ECS targets on the default bus.
- Cost nothing until enabled (DISABLED rules do not fire).
- Give Part J a real `--name` for `describe-rule` / `disable-rule`.

Would not:

- Enable anything.
- Touch `Capiro-dev-Compute`, Route53, ALB, or any existing
  `capiro-dev-*` rule.
- Fix P0-1 (no-op looks healthy), P0-2 (no ingestion alarm), P0-5
  (P19 swallows ceiling/breaker), P1-4 (DIBBS floor-clearing is
  item-agnostic), P1-5 (SBIR agency acronym never matches).
- Create the missing `sync-tango-opportunity-notices` /
  `sync-tango-opportunity-shadow` rules (P1-10). Those two have
  **no CDK declaration at all**. `ProcessTangoEvents` will drain an
  empty table until someone separately authors those.

A DISABLED create is therefore low blast-radius **and** operationally
incomplete. It unblocks the "there is no rule to disable" dead end.
It does not make enablement safe.

---

## Procedure if Neo says go (create only, still DISABLED)

Working directory for the `file://` paths: this folder. Use a native
`C:/dev/...` path, not MSYS `/c/dev/...`, and export `MSYS_NO_PATHCONV=1`.

Per rule, in this order. Stop the whole batch if any describe-rule
returns a rule rather than `ResourceNotFoundException`.

```bash
export AWS_PROFILE=capiro-dev AWS_DEFAULT_REGION=us-east-1 MSYS_NO_PATHCONV=1
DIR='C:/dev/capiro-fo-ga-review-wt/docs/plans/funding-opportunities-makegov-v1/independent-review/eventbridge-drafts'

# 1. prove absence (must fail)
aws events describe-rule --name fo-dev-sync-tango-dibbs

# 2. create DISABLED
aws events put-rule --cli-input-json "file://${DIR}/fo-dev-sync-tango-dibbs.put-rule.json"

# 3. attach target
aws events put-targets --cli-input-json "file://${DIR}/fo-dev-sync-tango-dibbs.put-targets.json"

# 4. prove still DISABLED and target is :12 / api-sync-jobs
aws events describe-rule --name fo-dev-sync-tango-dibbs --query '{Name:Name,State:State,Schedule:ScheduleExpression}'
aws events list-targets-by-rule --rule fo-dev-sync-tango-dibbs
```

Repeat for the other six names in `index.json`. Do **not** run
`enable-rule`. Do **not** run `cdk deploy`.

### Rollback (one command per rule, either is enough)

```bash
aws events disable-rule --name fo-dev-sync-tango-dibbs     # no-op if already DISABLED
aws events remove-targets --rule fo-dev-sync-tango-dibbs --ids fo-dev-sync-tango-dibbs-fargate
aws events delete-rule --name fo-dev-sync-tango-dibbs
```

`put-rule` on an existing name is an overwrite — that is why step 1
is mandatory. These names are not in CDK, so delete does not fight
CloudFormation.

---

## Decisions still required (this draft cannot close them)

1. **Register `capiro-dev-api-sync-jobs:13`?** Yes / no. The payload is
   ready at `%TEMP%/td13-payload.json`. `register-task-definition` with
   that JSON creates `:13`. This is the one remaining blocker. **All
   7 put-targets.json files already reference `:13`.**
2. **Create the 7 DISABLED `fo-dev-*` rules?** Yes / no. Recommended
   yes *after* `:13` is registered (so the created target is launchable).
   PassRole gap is already fixed — no longer a blocker.
3. **Do not enable any of the seven** until: server-side rail flags
   exist or an explicit D-07 exception is recorded (P1-1 — Neo decided
   "no flags for os.capiro.ai", needs writing into completion-matrix);
   P1-4/P1-5 are fixed or accepted as known fan-out / zero-row
   behaviour; P49 canary walk is scheduled the same day; and no
   ingestion resume is running that day (shared Tango quota).

The other items from the 2026-08-13 handoff are all closed:
- `funding_opportunities_dibbs` flag → "no flags for os.capiro.ai" (Neo decided)
- "design-partner acceptance" → deferred (Neo decided)
- `funding_opportunities_sbir=true` on `capiro-internal` → confirmed intentional
- PassRole fix → DONE and verified live

---

## Live re-derivation notes (so the next session does not re-pay it)

- 90 EventBridge rules in the account. 0 mention fo/tango/dibbs/sbir.
- Exactly 3 rules target `capiro-dev-api-sync-jobs`, all at **`:1`**,
  all ENABLED (the three LegiStorm trips/districts rules). Container
  override name is already `api-sync-jobs`.
- `:12` registered 2026-08-13T16:31:03Z, image digest
  `sha256:4208d7e9ba2215336f63773fedb2ea071145aff8e3f6a8ee42c624ef5f6d5fbe`,
  ARM64, 512/1024, execution role
  `capiro-dev-syncjobs-execution-role` (created 2026-08-09).
- `:1` still points at `capiro/dev/api:latest` (absent from ECR) and
  the Compute execution role.
- Invoker inline policy `RunTaskAndPassRole` read in full this
  session; no attached managed policies.
- Sunday EventBridge cron form confirmed against live
  `capiro-dev-reconcile-legistorm-trips-full` =
  `cron(0 5 ? * SUN *)`.
- Daily form confirmed against live
  `capiro-dev-generate-sam-opportunity-candidates` =
  `cron(52 11 * * ? *)`.
