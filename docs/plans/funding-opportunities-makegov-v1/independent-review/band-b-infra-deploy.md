# Band B — Infra / Deploy · Independent §6.2 Review

**Verdict: `FO_GA_BAND_B_INFRA_REJECTED`**

**Date:** 2026-08-13
**Reviewer:** independent agent — did not implement, deploy, or review any phase of the
Funding Opportunities + MakeGov/Tango program.
**Pinned commit:** `d800dcfde5` (`feat(x-feed): configurable X Intelligence dashboard feed (#948)`,
2026-08-13). All repo reads via `git show d800dcfde5:<path>`; the `C:\dev\capirov2` working
tree was not touched.
**AWS:** profile `capiro-dev`, account `967807252336`, `us-east-1`. **Every AWS call in this
review was read-only** (`describe-*` / `list-*` / `get-*`). No resource was created, modified,
scaled, or deleted. Nothing was fixed — findings are recorded here only.

Convention followed from `docs/runbooks/phase-2-independent-live-validation.md`: different
reviewer than implementer, read-only live verification of claims rather than trust in handoff
docs, a verdict that is exactly one of two strings, and a dated approval record.

**Scope:** P13 (generic opportunity source identity bridge), P16 (optional config /
Secrets Manager wiring), every migration this program has added, and
`infra/cdk/lib/compute-stack.ts` / `config.ts` generally. The EventBridge-collision and
ALB-vs-real-traffic-ALB drift are explicitly **out of scope here** — a separate investigation
covers those via `cdk diff`. Findings below are the ones that survive after setting those aside.

---

## Why this is a rejection

Two findings fail scope items outright, and the runbook's standard is explicit that approval
requires every check to pass *as specified*, not "close enough":

- **F-1** — a live-reality drift on the Aurora cluster that serves production, which would cut
  database capacity 4× on the next CloudFormation update **and is invisible to the very
  `cdk diff` the remediation runbook tells you to trust**. This fails scope item 4.
- **F-2** — the program's own "was it applied" guard list still omits 6 of its 27 migrations,
  including two that create tenant-scoped RLS tables. D-69 identified this exact class of defect
  and fixed one instance without sweeping for the rest. This fails scope item 1(c).

Everything else in scope passed, including some claims that passed unusually well — see
**Passes** below. The rejection is narrow and both findings are fixable without touching
application code.

---

## Findings, severity-ranked

### F-1 · HIGH · Aurora max-ACU drift that `cdk diff` cannot see

Scope item 4 asked whether `config.ts`'s values still match live reality seven-plus weeks after
a prior investigation recorded them as "already corrected in code to match live" on 2026-07-17.
For four of the five named values, yes. For `auroraMaxAcu`, no — and the way it fails is worse
than a plain mismatch.

Three sources, three-way disagreement:

| Source | `MaxCapacity` |
|---|---|
| `infra/cdk/lib/config.ts` (env=dev block, line 237) | `4` |
| Deployed CloudFormation template, `Capiro-dev-Data` (`UPDATE_COMPLETE` 2026-07-25) | `4` |
| **Live Aurora cluster `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv`** | **`16.0`** |

The cluster was scaled to 16 ACU **out-of-band**, outside CloudFormation, at some point after
2026-07-25. `config.ts` feeds `data-stack.ts:124` `serverlessV2MaxCapacity`, so any CFN update
of `Capiro-dev-Data` reverts the live cluster from 16 → 4.

Per this repo's own memory and the config's own comment block, the `env=dev` stacks **are** the
live production deployment serving `app.capiro.ai`. A silent 4× reduction in maximum database
capacity on that cluster is a production capacity incident, not a dev inconvenience.

**The part that makes this HIGH rather than MEDIUM:** because the deployed template *already*
says `4`, `cdk diff` reports **no difference**. `infra/cdk/DRIFT-FINDINGS.md` Step C instructs
the operator to "run `cdk diff` to confirm these are now no-ops before deploying" and concludes
"A future diff should no longer shrink Aurora." Both sentences are now false, and the prescribed
safety check is the thing that will fail to catch it. The operator does the right thing, sees a
clean diff, deploys, and cuts capacity.

`auroraMinAcu` (0.5) and `auroraBackupRetentionDays` (35) both still match live — the SOC2-relevant
backup value is fine. Only max capacity drifted.

**Recommendation (not applied):** decide which number is correct. If 16 is intentional, update
`config.ts` and the deployed template so CFN owns reality. If 4 is correct, the scale-up needs a
recorded rationale before anyone reverts it. Either way, `DRIFT-FINDINGS.md` Step C should stop
claiming a clean diff proves Aurora is safe — for out-of-band drift it proves the opposite.

---

### F-2 · HIGH · D-69's guard-list remediation was incomplete — 6 of 27 migrations still uncovered

Scope item 1(c). D-69 (2026-08-08) found that `20260908010000_tango_dibbs` had shipped without
being added to the "was it applied" assertion list in
`.github/workflows/funding-opportunities-ci.yml`, and added it. The entry frames this as a
one-off omission. It was not — the sweep was never done.

The guard list contains **21** names. This program has added **27** migrations (all migrations
stamped `>= 20260810` that touch program-domain objects). Six are absent:

| Missing migration | Self-declared phase | What it does |
|---|---|---|
| `20260822010000_client_tango_entity_sync_status` | "Funding Opportunities P19" | Columns on `clients` |
| `20260823010000_client_profile_enrichment_candidates` | "Funding Opportunities P20" | **Creates tenant-scoped `client_profile_enrichment_candidate` + RLS** |
| `20260824010000_client_relevant_vehicle` | "Funding Opportunities P22" | **Creates tenant-scoped `client_relevant_vehicle` + RLS** |
| `20260825010000_tango_procurement_forecasts` | "Funding Opportunities P24" | Creates `tango_procurement_forecast` |
| `20261001010000_tango_subaward_intelligence` | "MakeGov/Tango subaward substrate" | Creates `tango_subaward`, `tango_subaward_sync_checkpoint` |
| `20261001011000_tango_subaward_reobservation_freshness` | (subaward freshness) | Trigger + index changes |

Attribution is not inferred — the first four migrations name their own phase in line 1 of the
SQL, and the two subaward migrations name the program. None of these are another program's work.

Two of the six create **tenant-scoped tables with RLS policies**. The guard exists precisely
because `prisma migrate deploy` exits 0 on a no-op, so a migration missing from the directory
passes the deploy step unnoticed — and the failure mode the workflow's own comments cite
(LegiWatch Gate E: merged, deployed, digest-verified, and still 500ing for every tenant because
its migrations never ran) applies with more force to a table whose absence takes an RLS-protected
surface with it.

**The sharpest detail:** `20261001010000_tango_subaward_intelligence` and
`20261001011000_tango_subaward_reobservation_freshness` are the *exact two migrations D-69's own
experiment used as its reference point* — the decision-log entry quotes both names, and the
measured `_prisma_migrations` output in it lists them. The author had both names in hand, in the
same session, while editing this list, and did not add them. This is the same shape as D-69's own
finding one layer out: a fix applied to the instance that was noticed rather than to the class.

**Recommendation (not applied):** add the six names, and — because a hardcoded list has now gone
stale twice — replace the enumeration with something derived from the migrations directory, the
way `verify-migrations.ts` already does (see F-5). A list that must be hand-maintained in lockstep
with a directory will drift again.

---

### F-3 · MEDIUM · The P16 secret boundary is correct live, but the code enforcing it is undeployed

Scope item 2 asked for direct verification rather than trust in the code comment. The boundary
**passes, live and completely** — see Passes below for the evidence. This finding is about *why*
it passes.

`compute-stack.ts:275-295` states the claim plainly: `TANGO_API_KEY` is "added ONLY to
apiSyncSecrets below, never to apiServeSecrets or apiMigrateSecrets... the long-lived serve task
has no way to reach for this key even if a future bug tried." The code does exactly what it says.
But that code has never run against `capiro-dev`:

- `Capiro-dev-Compute` (status `UPDATE_ROLLBACK_COMPLETE`) contains **51 resources total**:
  4 task definitions (`capiro-dev-api:17`, `capiro-dev-api-migrate:5`, `capiro-dev-web:4`,
  `capiro-dev-marketing:1`, `capiro-dev-api-bootstrap-roles:1`), 3 services, and
  **zero EventBridge rules**.
- `compute-stack.ts` defines **13** `FargateTaskDefinition`s, **6** `FargateService`s, and the
  `ScheduledIngestionJobs` construct (`IngestionSchedules`, line 1586). None of the sync-jobs
  resources, and no `Sync`/`Tango`-named resource of any kind, exists in the stack.
- Live reality is far ahead of what CFN believes: `capiro-dev-api` is at **rev 144** (CFN knows
  rev 17); `capiro-dev-api-migrate` at **rev 60** (CFN knows rev 5).
- `capiro-dev-api-sync-jobs` (rev 12, the one carrying `TANGO_API_KEY`) is **not a
  CloudFormation resource at all**. Its execution role `capiro-dev-syncjobs-execution-role` was
  created 2026-08-09, is untagged, sits at path `/`, and carries **18 ad-hoc inline policies**
  spanning api-strategy, intel-api, onboard-api, workspace, engagement, Stripe, Clio and more —
  a hand-accumulated role, not a CDK-generated one (contrast the CDK-named
  `Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg` used by the serving API).
- Similarly, all **90** live EventBridge rules are outside CloudFormation (`ManagedBy` null on
  every one), including the 6 funding-related schedules.

So the security boundary the review was asked to verify holds today by **manual convention**, not
because the reviewed code enforces it. Nothing re-asserts it: a hand edit to the sync-jobs task
definition, or a hand-created new task definition reusing that execution role, would break it
silently, and no CI gate or CFN drift check would notice. Conversely, whenever `Capiro-dev-Compute`
is finally deployed, it will produce a *different* set of task definitions from the ones running.

This is not a request to deploy the stack — given F-1 and F-4 that would be the wrong move right
now. It is a request to stop describing the boundary as enforced by CDK when the enforcement path
is undeployed, and to add a check that tests the live task definitions directly (the sweep in
Passes below is ~30 seconds of `describe-task-definition` calls and could run on a schedule).

---

### F-4 · MEDIUM · The Compute stack is no longer stuck, removing an accidental guardrail

`infra/cdk/DRIFT-FINDINGS.md` records `Capiro-dev-Compute` as `UPDATE_ROLLBACK_FAILED`, both in
its 2026-06-01 original and its 2026-07-17 re-verification, and builds its whole remediation
sequence around Step A "unstick" coming first.

Live today, `Capiro-dev-Compute` is **`UPDATE_ROLLBACK_COMPLETE`** (last event
2026-07-25T04:47:08Z) — a stable, **updatable** state. Step A has effectively happened.

That matters because the doc's Step B (ALB reconcile — `compute-stack.ts` still does
`new ApplicationLoadBalancer` against an ALB that serves real production traffic) is recorded as
**still not done**, and Step C is now stale in the dangerous direction (F-1). The document's own
warning is "Do NOT deploy yet — B and C must be done first or the next deploy is destructive."

The condition that made a destructive deploy *impossible* has been removed, while both reasons it
would be destructive remain. Nothing in the repo reflects this status change, so an operator
reading `DRIFT-FINDINGS.md` today will believe a failed-rollback stack is still protecting them.

**Recommendation (not applied):** update `DRIFT-FINDINGS.md`'s status header, and treat
"stack is updatable" as raising the priority of Steps B and C rather than as progress.

---

### F-5 · LOW / PROCESS · No durable per-environment record of applied migrations

Scope item 5, the mandatory question. The answer is more favourable than the question anticipated,
but the gap is real.

**There is a genuine mechanism, and it is well built:** `apps/api/scripts/verify-migrations.ts`
(`--live`, or `--applied=<dump.json>`, optionally `--service=`). Critically it is
**directory-driven, not list-driven** — it enumerates repo migration directories and requires each
to appear in `_prisma_migrations`, so unlike the CI guard list in F-2 it *cannot* go stale when a
migration is added. Its header documents three non-obvious facts it had to get right (all five
service trees share one database and one `_prisma_migrations`; a rolled-back row is not by itself
drift; directory names are not unique by timestamp), each verified live rather than assumed. This
is the right tool and it already covers all 27 of this program's migrations by construction.

**The gap:** it is on-demand only. It is not scheduled, is not a required check, and — the actual
answer to the question — **produces no persisted artifact**. There is no stored record anywhere in
this repo of "which migrations are applied to which environment." That information exists only by
inference, computed at query time by reading `_prisma_migrations` directly.

The consequence is visible in this program's own documents. `completion-matrix.md` carries
human-typed "applied" claims in its per-phase Migration cells, and D-70 already named exactly this
failure: *"a claim about the live system was carried forward from a document instead of being
checked against the system."* The correction D-70 applied — rewording cells to "applied — verified
2026-08-09 by a clean `migrate deploy` reporting 0 pending" — attaches a method and a date to the
claim, which is a real improvement, but it is still a point-in-time assertion in prose that goes
stale the moment anything changes and that nothing re-checks.

So: **inference-only is the correct characterisation**, with the important mitigation that a
directory-driven verifier exists to perform that inference correctly. Naming it as a process gap
is warranted; describing it as "no mechanism at all" would be unfair to `verify-migrations.ts`.

**Recommendation (not applied):** run `verify-migrations.ts --live` on a schedule and write its
output somewhere durable and dated, so "applied to capiro-dev" becomes a fact with provenance
rather than a sentence someone typed. That would also subsume the F-2 guard list entirely.

---

## Passes — verified, not assumed

### Migration hygiene 1(a): no destructive DDL — PASS

All 27 program migrations were dumped and scanned. Across every one there is **no `DROP TABLE`,
no `DROP COLUMN`, no `TRUNCATE`, and no `DELETE FROM`.** The only `DROP` statements are six, and
each was read in full context:

- `20260820010000_funding_opportunity_generic_source` (**P13**, in scope) — two
  `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` pairs. `..._source_chk` is strictly widening
  (`grants_gov`, `sam_gov` → plus `agency_forecast`, `dibbs`, `sbir_sttr`), so no existing row can
  fail. `..._one_source_chk` is a genuine rewrite into three branches, but the migration backfills
  `source_record_key`/`source_record_type` **before** re-adding the constraint, so existing rows
  are made conformant first. Ordering verified in the file, not assumed.
- `20260904010000_outcome_event_funding_opportunity` — two `DROP`+`ADD` CHECK widenings on
  `outcome_event`, both wrapped in `DO $$ ... IF EXISTS (SELECT 1 FROM pg_constraint ...)` guards.
  Strictly additive vocabularies (3 new `kind` values, 1 new `source_type`).
- `20260907010000_tango_event_outbox_per_event` — `DROP INDEX IF EXISTS
  "tango_event_outbox_delivery_uniq"`, immediately replaced by a superset composite unique
  `(delivery_id, event_index)`. The migration documents that no alert row has ever been written in
  any environment (P48's insert raised `constraint does not exist` on every call until PR #842,
  never deployed), so there is no data whose interpretation changes.
- `20261001011000_tango_subaward_reobservation_freshness` — `DROP TRIGGER IF EXISTS` as the
  idempotent half of a re-create.

No destructive DDL requiring a separately-approved contract phase was found, so the program's
stated rule is not violated.

Worth noting as a positive: `20260820010000`'s comment block documents that
`NULL = 'x'` evaluates to NULL and a CHECK passes on NULL, so each `=` conjunct explicitly rejects
NULL first — and states this was **rehearsed against `pgvector:pg16` before the comment was
written**, with the admitted-row case reproduced. That is the standard this review would want
everywhere.

### Migration hygiene 1(b): forward-only / additive — PASS

Every table creation uses `CREATE TABLE IF NOT EXISTS`; every index `CREATE INDEX IF NOT EXISTS`;
every constraint addition is wrapped in a `pg_constraint` existence guard (Postgres has no
`ADD CONSTRAINT IF NOT EXISTS`). Every column addition uses `ADD COLUMN IF NOT EXISTS`, and the
one `NOT NULL` addition observed (`tango_event_outbox.event_index`) carries a `DEFAULT 0`. All 27
are retry-safe: a partial failure followed by a re-run is a no-op. Four data-mutating `UPDATE`
statements exist, all backfills of newly-added nullable columns, all idempotent via
`WHERE <col> IS NULL` predicates.

### RLS sweep (scope item 3) — PASS, 6 tables spanning early to late phases

The instruction was to spot-check actual migration SQL for at least 5 tables across different
phases. The program adds 28 new tables; **6 are tenant-scoped**, and all 6 were checked against
real SQL, not comments:

| Table | Migration / phase | ENABLE | FORCE | Policies |
|---|---|---|---|---|
| `client_funding_opportunity` | `20260810010000` (P01, earliest) | yes | yes | 4 |
| `client_profile_enrichment_candidate` | `20260823010000` (P20) | yes | yes | 4 |
| `client_relevant_vehicle` | `20260824010000` (P22) | yes | yes | 4 |
| `opportunity_requirement_review` | `20260831010000` | yes | yes | 4 |
| `funding_opportunity_stage_transition` | `20260901010000` | yes | yes | 4 |
| `tango_event_alert` | `20260906010000` (latest tenant table) | yes | yes | 4 |

Every one carries `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and**
`ALTER TABLE ... FORCE ROW LEVEL SECURITY`, plus exactly four policies —
SELECT / INSERT / UPDATE / DELETE — all using the identical predicate
`rls_bypass() OR tenant_id = current_tenant_id()`, with **UPDATE correctly carrying both `USING`
and `WITH CHECK`** (the common omission that lets a tenant update a row out of its own scope).
No deviation across six tables and five phases.

The remaining ~22 new tables — `tango_resource_snapshot`, `tango_sync_checkpoint`,
`tango_dibbs_solicitation`, `tango_sbir_topic`, `tango_subaward`, `opportunity_attachment`,
`tango_procurement_forecast` and the rest — have **no tenant discriminator** and correctly have no
RLS. They are global provider catalogs, and the decision is documented explicitly rather than left
implicit: `20261001010000_tango_subaward_intelligence` opens with *"GLOBAL PUBLIC REFERENCE DATA:
no tenant_id and no RLS. Tenant/client exposure is decided by the read service through confirmed
client identity mappings."*

One near-miss worth recording so a future reviewer does not repeat the work:
`tango_procurement_forecast` and `tango_budget_vendor_flow` each have an `organization_id` column
and no RLS, which scans as a tenant-scoped table missing its policies. It is not —
`organization_id` there is a **`TEXT` federal agency identifier from the provider** (adjacent to
`organization_agency_code` / `organization_agency_name`), not a Capiro tenant. Correctly
un-scoped.

**D-79 check:** today's DIBBS/SBIR matching-producer work (PR #943) added **no new table and no
new migration** — the newest program migration remains `20261001011000`. There is no new
tenant-scoped surface from D-79 requiring RLS.

### P16 secret-injection boundary (scope item 2) — PASS, verified exhaustively

Rather than checking only the four named task definitions, **all 227 active task definition
families** in the account were enumerated and their latest revision's `secrets` and `environment`
blocks inspected for any `TANGO` reference. Result:

```
total families: 227
--- families whose LATEST revision references TANGO ---
  capiro-dev-api-sync-jobs : TANGO_API_KEY
--- sweep complete ---
```

Exactly one family. The specifically-named exclusions were each confirmed individually:

| Task definition | Revision | `TANGO` in `secrets` | `TANGO` in `environment` |
|---|---|---|---|
| `capiro-dev-api-sync-jobs` | 12 | **`TANGO_API_KEY`** | none |
| `capiro-dev-api` (serving) | 144 | none | none |
| `capiro-dev-api-migrate` | 60 | none | none |
| `capiro-dev-api-admin-migrate` | 14 | none | none |
| `capiro-dev-meriv2-orchestrator` | 19 | none | none |
| `capiro-dev-meriv2-control-monitor` | 1 | none | none |

The IAM layer holds independently of the task definitions, which is stronger than the code comment
claims:

- The injected secret is `arn:aws:secretsmanager:us-east-1:967807252336:secret:tango-c0YGNk`.
- Inline policy `TangoApiKeyRead` grants only `secretsmanager:GetSecretValue` +
  `DescribeSecret`, scoped to **that single secret ARN** — no wildcard.
- It is attached to exactly one role, `capiro-dev-syncjobs-execution-role`, which is the execution
  role of exactly one task definition, `capiro-dev-api-sync-jobs`.
- The serving API, `api-migrate` and `meriv2-orchestrator` all share a **different** execution role
  (`Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`). Its 17 inline policies were
  enumerated and its large default policy grepped: **zero references to `tango`**, and its
  Secrets Manager grants are per-secret ARNs under `capiro/dev/*` prefixes, which
  `tango-c0YGNk` does not match.
- `capiro-dev-engagement-api` uses a third, separate execution role.

So the serving task cannot read the key even out-of-band, not merely "is not handed it". The claim
verifies. F-3 above is solely about this being hand-maintained rather than CDK-enforced.

The mirror-image claim also holds: `TANGO_WEBHOOK_SIGNING_SECRET` is serve-only in code
(`apiServeSecrets`), and no task definition carries it live — consistent with the code's note that
it stays absent until the provider endpoint exists (P50).

### `config.ts` vs live: appHost / wildcardHost / rootDomain — PASS

All three verified against the live `capiro.ai` hosted zone (`Z085985135X6Q5QT98ZBK`):

| Config value | Setting | Live Route53 |
|---|---|---|
| `appHost` | `app.capiro.ai` | A-alias → `dualstack.capiro-prod-alb-57164953.us-east-1.elb.amazonaws.com` ✓ |
| `wildcardHost` | `*.app.capiro.ai` | `\052.app.capiro.ai` A-alias → same ALB ✓ |
| `rootDomain` | `capiro.ai` | A-alias → same ALB ✓ |
| `auroraBackupRetentionDays` | `35` | live `BackupRetentionPeriod: 35` ✓ |
| `auroraMinAcu` | `0.5` | live `MinCapacity: 0.5` ✓ |
| `auroraMaxAcu` | `4` | live `MaxCapacity: 16.0` ✗ — **see F-1** |

Legacy `app-dev.capiro.ai` and `*.app-dev.capiro.ai` records still exist pointing at the same ALB.
They are leftovers from before the app-dev → app correction and are not referenced by `config.ts`;
noted, not a finding.

---

## Verdict

```
FO_GA_BAND_B_INFRA_REJECTED
```

Failing scope items: **1(c)** (F-2 — 6 of 27 migrations outside the guard mechanism, D-69's
remediation incomplete) and **4** (F-1 — undetectable Aurora max-ACU drift that would cut
production capacity 4× on the next CloudFormation update).

Scope items **1(a)**, **1(b)**, **2**, **3** and **5** pass, with F-3, F-4 and F-5 recorded as
non-blocking findings that should be resolved alongside the two blockers.

Both blockers are fixable without touching application code. F-2 is a six-line edit to
`.github/workflows/funding-opportunities-ci.yml` (better: derive the list from the migrations
directory). F-1 is a decision about which capacity number is correct, plus a correction to
`DRIFT-FINDINGS.md` Step C, which currently tells operators that a clean `cdk diff` proves Aurora
is safe — for this class of out-of-band drift it proves the opposite.

Nothing in this review was fixed, committed, or deployed.
