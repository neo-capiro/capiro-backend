# Phase 7 — Pre-implementation dependency map

Required first action of the Phase 7 execution plan (_Verified Canonical Promotion, Legacy Cutover, and Production Rollout V1_): establish repository state, verify the Phase 0–6 prerequisites against actual code rather than planning-time assumptions, and inventory every current path capable of mutating canonical budget data before Workstream A is written.

Everything below was verified against the working tree, not inferred from the plan.

---

## 1. Repository state

| Item                         | Value                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| Repo                         | `neo-capiro/capirov2`                                                      |
| Phase 7 branch               | `agent/pe-budget-canonical-promotion-cutover-v1`                           |
| Base commit                  | `a1e9b401` — Phase 6 A–O unified, `origin/main` merged, J–O defects closed |
| `origin/main` at branch time | `2748e26a` (fully merged into the base)                                    |
| Phase 6 PR                   | #777 — OPEN, MERGEABLE, base `main`                                        |
| Toolchain                    | node v22.23.1, pnpm 9.12.0 (matches `packageManager`), Python 3.11.15      |
| Prisma migrations            | 228, latest `20260820010000_funding_opportunity_generic_source`            |

**Base caveat.** Phase 7 is branched from the Phase 6 head rather than from `main`, because Phase 6 is not yet merged. The trees are equivalent — `a1e9b401` already contains `origin/main` — so when #777 merges, this base becomes correct with no rebase. If #777 changes during review, this branch must be rebased onto the merged result before Workstream A is accepted.

---

## 2. Prerequisite verification (Phases 0–6)

| Prereq                                             | Status                                            | Evidence                                                                                           |
| -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Phases 0–5 merged and green                        | **SATISFIED**                                     | `verify:pe-budget-phase-1`…`-5` present on `main`; closeout PRs #748–#757 merged                   |
| Phase 6 A–O complete and green                     | **SATISFIED on this base**, pending merge of #777 | `verify:pe-budget-phase-6` PASS — 78 suites / 779 tests, 24/24 negative controls, safety gate PASS |
| Every Phase 4–6 family has a typed projection plan | **SUPERSEDED — see note below**                   | `defense-budget/{rdte,procurement,om,milcon,stages,phase6}` projection contracts present           |
| Migration chain passes fresh + from baseline       | **NOT YET REHEARSED**                             | Phase 7 Workstream D task; no shared DB touched                                                    |
| Production-scale disposable dataset                | **NOT PRESENT**                                   | Phase 7 Workstream O task                                                                          |
| Approved rollback + DB backup procedure            | **NOT VERIFIED**                                  | operator-owned; must exist before any cutover step                                                 |
| Current AWS/CDK drift documented                   | PARTIAL                                           | drift is referenced in infra runbooks; must be re-confirmed before Workstream N                    |

### Correction (session 10) — "typed projection plan" was accepted for "persisted projection plan"

The row above is accurate about what it says and wrong about what it was taken
to mean, and the gap that produced is worth recording next to the claim rather
than only in the gap tracker.

Projection **contracts** are present for every Phase 4–6 family. Persisted
projection **plans** were not, and never had been: the planners computed a plan
in memory, reported its `contentSha256`, and discarded it. `git log --all
-S"projection_plan" -- apps/api/prisma` finds no commit on any branch that ever
created a table for one. Phase 7 nonetheless binds authorization to
`projectionPlanIds` / `projectionPlanHashes` and treats them as reloadable
evidence, which a discarded object cannot be.

This is the same conflation Gap 1 records for Phase 6's "merged and green" —
green tests over contracts whose production wiring does not exist. Two
prerequisites in this table were accepted on the presence of a contract rather
than of a producer.

Closed in session 10 under Gap 5 decision 3: `defense_budget_projection_plan`
(migration `20260907020000`) plus the `projection-plan/` substrate.

**Session 11 completes it.** Phase 6 was the last family with no plan-shaped
document to persist at all; `build-defense-budget-phase6-projection-plan-v1`
plus the pure `phase6-projection-plan-builder-v1.ts` close that, and the DB
rehearsal proves the committee family filing a real, non-empty plan end to end.
All three families can now produce a persisted plan.

Note the shape this settled into, because it looks like an omission and is not:
**filing stays a separate verb, deliberately.** Phase 5's mandatory negative
control NC20 forbids its planner scripts from importing Prisma at all, so
"wire persistence into the planner" is prohibited, not merely unfinished. The
architecture Neo confirmed is `pure deterministic planner → immutable plan +
content hash → separate persistence command → reload + hash verification →
Phase 7 eligibility`. What remains is chaining the verb into producing
pipelines and rebuilding existing outputs — operational sequencing, not a
missing capability.

**The generalizable check, for any future prerequisite in this table:** ask
whether the thing is *produced and persisted*, not whether a type for it
exists. A contract, a schema, and a green suite are jointly compatible with
nothing ever having written a row.

### Standing blocker — CI cannot run

The **100 most recent workflow runs across the entire repository** are `startup_failure` at 0s — on `main`, on already-merged branches, for both `push` and `pull_request`. Last successful run anywhere: **2026-07-31**. Repo is private, Actions enabled, not archived or disabled, permissions `all`. The signature indicates an **org-level Actions billing / spending-limit block**, not a code defect; it is not fixable from a branch.

Consequence for Phase 7: every "green" claim in this phase is _locally_ reproduced. The plan's requirement that Phase 0–7 suites pass in CI cannot be satisfied until GitHub Actions is unblocked. No workflow currently runs `verify:pe-budget-*` at all, so wiring those in is additional Workstream O work once Actions is restored. `verify:pe-budget-phase-6` requires `DATABASE_URL` to be set (it calls `prisma validate`) even though it never connects.

---

## 3. Canonical writer inventory

Paths able to mutate `program_element`, `program_element_year`, source observations, budget actions, deltas, or intelligence changes: **41 call sites across 30 files**. Every one must be classified as _migrated_, _contained_, or _retired_ by Workstream M, and denied at the database-grant level by Workstream D.

### Services (`apps/api/src/`)

| Service                             | File                                                           | Phase 7 disposition                                                                                    |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ProgramElementWriterService`       | `program-element/program-element-writer.service.ts:97`         | **Primary legacy writer** — 4 DML sites. Workstreams F–J must not call it.                             |
| `ReconciliationService`             | `program-element/reconciliation/reconciliation.service.ts:120` | Must not reinterpret already-verified projections. Winner flags become compatibility data only (WS K). |
| `ProgramElementChangeOutboxService` | `program-element/program-element-change-outbox.service.ts:85`  | PE-centric outbox; superseded by the generic promotion outbox (WS L).                                  |
| `DeltaEngineService`                | `program-element/deltas/delta-engine.service.ts:78`            | 4 DML sites, PE-centric, can emit intelligence changes. Replaced by generic snapshot deltas (WS L).    |
| `IntelligenceService`               | `intelligence/intelligence.service.ts`                         | 1 DML site — direct `intelligence_change` emission to stop (WS L.13).                                  |
| `budget-position-writer.ts`         | `program-element/budget-position-writer.ts`                    | Additional write surface; classify in WS M inventory.                                                  |

### Operational scripts (`apps/api/scripts/`)

Writer scripts requiring containment in Workstream M: `rebuild-program-element-years.ts`, `reconcile-stale-pes.ts`, `repair-pe-thousands-as-millions.ts`, `derive-budget-actions.ts`, `backfill-appropriation-type.ts`, `load-om.ts`, `load-om-op5.ts`, `load-pdoc-enrichment.ts`, `sync-jbook-r2.ts`, `match-pe-mentions.ts`, `emit-changes.ts`, `emit-committee-changes.ts`, `emit-bill-alerts.ts`, `send-pe-alert-emails.ts`, `watch-budget-docs.ts`, `compute-health-scores.ts`, `seed-demo-client.ts`.

The rebuild/repair/backfill scripts are the highest-risk bypasses: they write canonical rows directly with no verification binding.

### Read paths

`ProgramElementReadService` (`program-element-read.service.ts:162`) and `BudgetLinesReadService` (`budget-lines-read.service.ts:49`), plus `program-element.controller.ts`, `budget-lines.controller.ts`, and the Meri PE tools (`meri/meri-tools.service.ts`). These are the Workstream M cutover surface. The `program-element/` tree holds ~130 files.

---

## 4. Entrypoint and dispatcher

| File                                         | Lines | Role                                                                                                                                                                                                    |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/scripts/entrypoint.sh`             | 99    | Trust-critical wrapper. Owns only: `migration-status`, `migrate`, `diag-pe-trust`, `audit-llamaparse-pe-units`, `pe-phase-10-live-proofs`, `emit-meriv2-control-metrics`, `demo-meriv2-control-alarms`. |
| `apps/api/scripts/entrypoint-dispatcher.inc` | 718   | Legacy dispatcher — still exposes the direct canonical budget-loader verbs.                                                                                                                             |
| `apps/api/scripts/entrypoint-legacy.sh`      | —     | Legacy shim.                                                                                                                                                                                            |

Workstream N adds the eight promotion verbs to `entrypoint.sh` directly (**not** the dispatcher), and Workstream M makes the dispatcher's budget verbs refuse `--commit`.

---

## 5. Infrastructure

`infra/cdk/lib/compute-stack.ts` defines **12 Fargate task definitions**: Api, Web, Marketing, Workspace, Meriv2Orchestrator, ApiStrategy, ApiStrategyMigrate, WorkspaceMigrate, ApiMigrate, ApiEmbedBackfill, ApiSyncJobs, **ApiBootstrapRoles**. Scheduled work runs through `constructs/scheduled-ingestion-jobs.ts` and `ingestion-schedule.ts`.

### Database roles — existing pattern

`ApiBootstrapRolesTaskDef` (family `capiro-<env>-api-bootstrap-roles`, command `bootstrap-roles`) already provisions least-privilege roles from master + app credentials held in separate Secrets Manager secrets. Roles referenced today:

```
capiro_master                    (Aurora master — migrations only)
capiro_app / capiro_app_role     (general API serve role)
capiro_admin                     (admin capability)
capiro_defense_budget_parser     (parser role)
```

**This is a significant favourable finding.** Phase 7's `capiro_pe_promoter` is an extension of an established pattern rather than new infrastructure: the separate-secret, separate-role, bootstrap-task mechanism already exists and is already deployed. Workstream D should add the promoter role to this task rather than inventing a parallel mechanism.

---

## 6. Plan-vs-reality substitutions

| Plan reference                                                       | Repository reality                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ProgramElementWriterService`                                        | Confirmed — `src/program-element/program-element-writer.service.ts`        |
| `ReconciliationService`                                              | Confirmed — `src/program-element/reconciliation/reconciliation.service.ts` |
| `ProgramElementChangeOutboxService`                                  | Confirmed — `src/program-element/program-element-change-outbox.service.ts` |
| `DeltaEngineService`                                                 | Confirmed — `src/program-element/deltas/delta-engine.service.ts`           |
| `compute-budget-deltas.ts`                                           | **Substitution:** `src/program-element/deltas/delta-compute.ts`            |
| `ProgramElementReadService` / `BudgetLinesReadService`               | Confirmed                                                                  |
| `ComputeStack`                                                       | Confirmed — `infra/cdk/lib/compute-stack.ts`                               |
| `ScheduledIngestionJobs`                                             | Confirmed — `infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts`         |
| Trust-critical entrypoint                                            | Confirmed — `apps/api/scripts/entrypoint.sh` (99 lines, 7 verbs)           |
| Legacy dispatcher                                                    | Confirmed — `apps/api/scripts/entrypoint-dispatcher.inc` (718 lines)       |
| `capiro_pe_promoter` (new)                                           | Extends existing `ApiBootstrapRolesTaskDef` role pattern                   |
| Phase 2 statement that verification carries no canonical implication | Confirmed — still true in `defense_budget_verification_v1`                 |

No planned symbol was found missing, and nothing was invented.

---

## 7. Workstream entry conditions

| WS                                  | Ready?          | Note                                                                                           |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| A — eligibility + authorization     | **Ready**       | Phase 6 cycle certification exists at `defense-budget/phase6/phase6-cycle-certification-v1.ts` |
| B — mapping registry                | **Ready**       | All Phase 4–6 projection unions present on this base                                           |
| C — deterministic planner           | Ready after A/B |                                                                                                |
| D — snapshot schema + DB role       | **Ready**       | Extends `ApiBootstrapRolesTaskDef`; disposable-PostgreSQL rehearsal still to build             |
| E — promotion engine                | After A–D       |                                                                                                |
| F–J — family + lifecycle projectors | After E         | RDT&E, procurement, O&M, MILCON, congressional all have native contracts                       |
| K — overrides / corrections         | After F–J       | Existing reconciliation queue + data-issue service are the migration source                    |
| L — outbox / deltas                 | After E         | Replaces `DeltaEngineService` + `ProgramElementChangeOutboxService`                            |
| M — read cutover + legacy shutdown  | After L         | 30-file writer inventory in §3 is the containment work list                                    |
| N — operator + Fargate              | After D/E/L/M   | 12 existing task definitions; documented CDK drift must be re-confirmed                        |
| O — closeout                        | Last            | **Cannot fully close while CI is blocked**                                                     |

---

## 8. Open blockers

1. **Phase 6 not yet merged** (#777). Phase 7 work on this base is valid but not final until it lands.
2. **GitHub Actions blocked repo-wide.** No Phase 7 gate can be proven in CI. Requires org billing/settings action.
3. **No production-scale fixture dataset** for the Workstream O rehearsal.
4. **Rollback/backup procedure not verified** as existing and approved.

None of these prevent Workstream A–D implementation; items 2–4 block Workstream O closeout.

---

## 9. Safety statement

Producing this map involved read-only inspection only. No merge, deployment, AWS mutation, shared-database migration, production-data access, canonical promotion, snapshot activation, rollback, alert fan-out, or paid-parser call occurred.
