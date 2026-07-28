# Program Elements Trust Remediation — Phase A verdict

**Verdict: SAFE TO REVIEW.** Code, CI and the a1–a4 gates are satisfied and
independently re-verified. Operational evidence (a5) is **partial**: everything
obtainable read-only without a deploy was captured; the two artifacts that
require the reviewed revision to be *running* are `UNVERIFIED`, because
producing them would require deploying this branch, which Phase A forbids.

Phase A is therefore **code-complete and operationally incomplete**. It is
**not** "PHASE A COMPLETE", and it must not be merged or deployed on the
strength of this document alone.

- Repository: `neo-capiro/capirov2`
- Branch: `agent/pe-trust-phase-a`
- Pull request: [#647](https://github.com/neo-capiro/capirov2/pull/647) — **draft, unmerged**
- Reviewed revision: `e43b3a6f5b6ee987752b5fdd6eab8c4f5cd64c18`
- `origin/main` integrated: `2d8067f47ededbb3f189296fc8a4bc60d85994a2`
- Environment inspected: `capiro-dev` / `us-east-1` (this account is the live production environment)
- Captured: 2026-07-28 (UTC)

---

## 1. Artifact status

| Artifact | Status |
| --- | --- |
| `git-sha.txt` | **CAPTURED** — reviewed revision, integrated main SHA, and ECR-verified proof this revision is not deployed. |
| `baseline-tests.txt` | **CAPTURED** — full local verification matrix plus a clean-`origin/main` comparison for every failure. |
| `eventbridge-rules.json` | **CAPTURED** — all 79 rules in the account swept; each required PE verb labelled from its container command override. |
| `sync-task-definition.json` | **CAPTURED** — `capiro-dev-api-migrate` rev 19, the task definition used by every live PE rule. Redacted; no env/secret values. |
| `live-env-key-names.txt` | **CAPTURED** — key names only, values and secret source ARNs omitted by construction. |
| `diag-pe-trust.json` | **UNVERIFIED — reviewed revision is not running anywhere.** See §4. |
| `live-source-counts.json` | **UNVERIFIED — same root cause.** See §4. |

No file in this directory contains a credential, secret value, token, account
ID, private URL, or email address. This was checked, not assumed.

---

## 2. What the live inspection actually shows

All labels below are derived from each rule target's **container command
override**, not from rule names.

### Required verbs

| Verb | Status |
| --- | --- |
| `ingest-defense-budget` | **VERIFIED ABSENT** |
| `run-pe-derive-chain` | **VERIFIED PRESENT** — `capiro-dev-pe-derive-chain`, `run-pe-derive-chain --commit`, `cron(30 10 * * ? *)`, ENABLED |
| `watch-budget-docs` | **VERIFIED PRESENT** — `capiro-dev-watch-budget-docs`, `watch-budget-docs --commit`, `cron(0 12 * * ? *)`, ENABLED |
| `send-pe-alert-emails` | **VERIFIED ABSENT** |
| `parse-hasc-report` | **VERIFIED ABSENT** |
| `parse-sasc-report` | **VERIFIED ABSENT** |
| `parse-hac-d-report` | **VERIFIED ABSENT** |
| `parse-sac-d-report` | **VERIFIED ABSENT** |
| `parse-ndaa-conference` | **VERIFIED ABSENT** |
| `parse-defense-approps-public-law` | **VERIFIED ABSENT** |
| `parse-pdoc` | **VERIFIED ABSENT** |
| `load-defense-budget-package` | **VERIFIED ABSENT** |

Other PE `parse-*` / `load-*` verbs discovered live: **none.** No rule in the
account carries a `parse-*` or `load-*` command override.

### Other PE-adjacent scheduled rules

| Rule | Command |
| --- | --- |
| `capiro-dev-enrich-award-pe` | `enrich-award-pe --limit 5000` |
| `capiro-dev-match-pe-mentions` | `match-pe-mentions --commit --limit 50` |
| `capiro-dev-sync-sam-opportunities` | `sync-sam-opportunities` |

### Two findings worth a reviewer's attention

1. **The generalized PDF path is not scheduled, and could not run if it were.**
   `ingest-defense-budget` has no rule, and the task definition every PE rule
   uses carries none of `LLAMA_CLOUD_API_KEY`, `LLAMA_CLOUD_BASE_URL`,
   `DEFENSE_BUDGET_RAW_BUCKET`, `DEFENSE_BUDGET_RAW_KMS_KEY_ARN` or
   `DEFENSE_BUDGET_RETENTION_YEARS`. The command fails closed without them.
   The Phase A freeze is therefore a guard against a future regression rather
   than the interruption of something currently running.

2. **Every live PE rule runs on `capiro-dev-api-migrate` with a command
   override.** Its default command is `["migrate"]` and it sets no
   `entryPoint`, so it inherits the image `ENTRYPOINT`
   (`/usr/local/bin/entrypoint.sh`). Consequences:
   - `migrate` routes to the Phase A wrapper's fail-closed branch.
   - Every other PE verb takes the `*)` branch into
     `entrypoint-legacy.sh` → `entrypoint-dispatcher.inc`. That include is on
     the live execution path for all five scheduled PE jobs, which is why it
     was rebuilt from main's dispatcher rather than left at its pre-fork copy
     (a dropped verb here would break a scheduled production job).
   - `PE_ALERT_EMAIL_TENANTS` exists as an environment key. Its **value was
     never read**, and no rule invokes `send-pe-alert-emails`, so no email
     fan-out is scheduled.

---

## 3. Safety invariants for this session

Every item was verified, not assumed:

- **No canonical data write.** No migration, backfill, repair, canonical
  promotion or committed ingestion job was run.
- **No migration execution.** No `prisma migrate deploy`, `migrate resolve`, or
  any `_prisma_migrations` statement was issued against any environment.
- **No vendor parse.** LlamaParse was never invoked. The only argument
  combination that can reach it (`--extract-only --allow-vendor-parse`) was
  deliberately never run.
- **No secret retrieval.** `/capiro/dev/llamaparse/api-key` was not read. No
  Secrets Manager or SSM value was fetched. Task-definition inspection returned
  key names only.
- **No email send.** `PE_ALERT_EMAIL_TENANTS` was not enabled or read.
- **No deploy.** No image build, no `ecs update-service`, no `cdk deploy`. ECR
  contains no image for this revision.
- **All AWS calls were read-only** — `sts get-caller-identity`,
  `events list-rules`, `events list-targets-by-rule`, `events describe-rule`,
  `ecs describe-task-definition`, `ecr describe-images`.
- **Phase B was not started.** `agent/pe-trust-phase-b` and
  `agent/pe-trust-phase-b-ci-base` exist on the remote and were left untouched.

Because no write of any kind occurred, the a5 requirement to confirm that no
table count, `updated_at`, SyncRun row, watermark or source-document row changed
is satisfied by construction: nothing in this session could have changed them.

---

## 4. Why two artifacts are UNVERIFIED

`diag-pe-trust.json` must be produced "from the exact code revision being
reviewed against staging and production", and `live-source-counts.json` depends
on the same diagnostic.

That is not achievable within Phase A's constraints:

- The `diag-pe-trust` verb and `scripts/diag-program-element-trust-baseline.ts`
  are **added by this PR**. They do not exist in any built image — `aws ecr
  describe-images capiro/dev/api` has no tag for `e43b3a6f`, `1428bb09` or
  `766e7002`; `:latest` is commit `2ec465dc`.
- Aurora is on a private subnet and is reachable only from ECS, so the
  diagnostic cannot be pointed at it from a workstation.
- Running it in-cluster would require building and deploying this revision.
  Phase A explicitly forbids deploying.

Rather than fabricate JSON or substitute a different command's output, both are
recorded as UNVERIFIED. **A staging/production `capiro-staging` target is also
not available**: the `capiro-staging` ECS cluster does not exist despite
CloudFormation reporting success, so "staging" is not a usable environment here.

The diagnostic was still proven to work, locally and behaviourally:

- Dispatch reaches it: `sh scripts/entrypoint.sh diag-pe-trust` prints
  `Running diag-pe-trust (SELECT-only Program Elements trust baseline)` and
  executes the script.
- It fails closed: against an unreachable database it exits **1**, prints one
  fatal `[diag-pe-trust] FAILED` message, emits **no partial JSON**, and leaks
  no credential.
- It is SELECT-only by construction: all eight Prisma calls are `findMany`;
  the file contains no `create` / `update` / `upsert` / `delete` /
  `$executeRaw` / `$transaction`, no SyncRun creation and no watermark write.

**To close a5, the required follow-up is:** merge (or otherwise build) this
revision, then run `diag-pe-trust` as a one-off ECS task on `capiro-dev` and
archive its JSON plus the resulting source counts here. That is a read-only run;
the blocker is purely that the code must exist in an image first.

---

## 5. Gate summary

| Task | Status |
| --- | --- |
| a1 — SELECT-only PE trust diagnostic | **MET** (code + behaviour verified; live run pending per §4) |
| a2 — package and container entry points | **MET** |
| a3 — generalized PDF write freeze | **MET** |
| a4 — no automatic migration-history mutation + runbook | **MET** |
| a5 — live read-only operational evidence | **PARTIAL** — 5 of 7 artifacts captured; 2 UNVERIFIED per §4 |
| a6 — Phase A gate passed and PR updated truthfully | **MET for code/CI**, and this document is the truthful record |

## 6. Remaining blocker

One, and it is not a code defect: **a5 cannot be finished without the reviewed
revision existing in a built image.** Everything reachable read-only has been
captured. Deciding whether to merge first and collect the remaining read-only
production evidence afterwards is a policy call for the reviewer, not something
this session should take unilaterally.
