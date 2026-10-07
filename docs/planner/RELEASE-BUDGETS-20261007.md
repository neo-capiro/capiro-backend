# Planner project budgets and costs

Fifteenth release, [PR #2193](https://github.com/neo-capiro/capirov2/pull/2193), from `feat/planner-project-budgets-20261007`. Live on stable, healthy Strategies 48 and web-vNext 461, both built from `e696855a8c72909350ac0f36db7775f435c9f4d1`. The final evidence commit changes documentation only.

## Behavior and access

Project admins can configure a budget in hours or cost, manage a pool of up to 500 hourly rates, and compare task estimates with actual time. Rates are rounded to two decimals and costs use integer arithmetic. Unknown rates are explicit; zero rates are valid. Rates do not grant project access and remain available after a member leaves until removed. A new organization time setting supplies the currency for newly saved project budgets; existing budgets keep their currency.

Actual work uses latest immutable time corrections/removals and each entry's recorded project allocation. General project time is included. Current task access is rechecked after a task moves; readable archived history remains available. Billable/non-billable filters affect actual work. Task estimates use current project memberships and exclude archived tasks. Project admins alone can access budgets, rates and costs; organization admin status does not bypass project access. Internal financial resources are excluded from public project, generic resources and reports.

Portfolio rollups intersect readable portfolios with current project admin grants. Money is grouped by currency without conversion. Each project admin can configure a personal threshold against the budget or estimate. Delivery is owner-only through the approved Planner Inbox and main notification bell, once per saved configuration. Events, Inbox rows and immutable receipts commit atomically. Revoking project admin access hides old financial notifications and blocks their mutation. Missing rates prevent misleading cost alerts for the affected actual/estimated reference.

Planner remains on Strategies, in the signed-in organization. Existing approved Capiro connections remain unchanged. No Workspace document connection, new authentication scope, role or external integration is added.

## Qualification

359 distinct API checks across 34 suites and 134 web checks across 20 suites pass. The broad API run passed 346 checks, then focused repair verification passed 47 checks including the updated eleven-table assertion and all twelve budget database cases. The broad web run passed 132 checks; 21 focused budget/bell checks passed after adding two regressions for typed budget and timesheet navigation. Shared, Strategies and web production builds pass. A fresh twelve-migration rehearsal verifies eleven forced-RLS tables, six immutable triggers and restricted application privileges.

Database cases cover project admin access without an organization bypass, generic resource isolation, corrected/removed/billable/general time, multi-project estimates with one actual allocation, moved-task revocation, archived history, retained departed rates, currency snapshots, concurrent updates, separate-currency portfolio rollups, concurrent workers, personal delivery, demotion/redaction, rollback after failed receipt insertion, raw cross-tenant RLS, receipt immutability/foreign-key scope and progress beyond fifty alert candidates. Web cases cover access boundaries, unrated cost labeling, hours and actual filters, decimal rates, opening-version saves, conflicts, personal alerts, revoked cached data, organization cancellation, archived history and portfolio currencies.

Synthetic browser verification saved a ten-hour budget, three hourly rates and a $1,000 cost budget. Task estimates total $601.50. Logging one billable hour produces $125.50 actual cost, $874.50 remaining and 12.55% used. Personal alert configuration persists visibly. Read-only production preflight verifies all 27 existing migration checksums, eleven completed Planner migrations, ten forced-RLS tables and five immutable triggers under the actual non-super/non-bypass application role.

## Deployed identities and database proof

Both final ARM64 CodeBuild jobs succeeded against the exact source above. Strategies build `capiro-build-web-dev:6ccf0ea3-ad3f-4766-81d0-0447bd1283de` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:a3a7823d93cb92dc9cd128a80e377b368cec70068a73dcdc558fb8b5a264be0a`. Web build `capiro-build-web-dev:00791958-96db-464d-b7a2-047cd03e1e06` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:95d4a771df3f266fda13b8536e350d803d4dddf35d8e2bf699a379a19c066577`. Earlier builds of the initial source were stopped before deployment when browser qualification identified a missing typed notification route; the final source fixes both budget and timesheet navigation and includes two regressions.

Dedicated migration revision 16 used the same Strategies digest and exited zero in task `d9ae309c583b4e8885f7bf62288f8063`. The additive migration `20261007040000_planner_project_budgets` adds scoped immutable alert receipts and internal-resource indexes/constraints. Read-only migration and serving-role proofs verify twelve completed Planner migrations, eleven forced-RLS tables, six immutable triggers, restricted grants, receipt policy/foreign keys/indexes and migration checksums. Serving revision 48 contains 28 migration files. Markers `PLANNER_BUDGET_PREFLIGHT_PASSED`, `PLANNER_BUDGET_MIGRATION_PROOF_PASSED` and `PLANNER_BUDGET_PROOF_PASSED` all passed.

Strategies task `f2f2fd6c30784d669149d33d82f47f9a` and web task `d693ce7f468249b88a19373c96305ef1` are running and healthy. Each service has a single completed primary deployment with one desired/running task and no pending tasks. Public Strategies health returns `ok: true`; public runtime configuration identifies the exact web source. Candidate task definitions preserve every baseline field except immutable image and release identifiers. No canonical API, Compute, routing, IAM, shared authentication or CDK changes were deployed.

## Authenticated live verification and cleanup

A private synthetic project, task and portfolio were created through the signed-in UI with no additional members. The task estimate was two hours. One billable hour on December 7 was explicitly allocated to this project, separate from existing time history. Saving a $125.50 hourly rate and $100 cost budget produced $251 estimated cost, $125.50 actual cost, $25.50 over budget and 125.5% usage. A page reload preserved the rate, budget and personal 80% threshold. The portfolio showed exactly the same two-hour/one-hour and USD totals.

The scheduler delivered the personal threshold once to Inbox and the main bell. Clicking this specific bell entry marked it read and opened `/planner?scope=budget&project=6825933e-f38a-412c-83dc-232ab0480c98`. The original eight unrelated unread bell items remained unread. `PLANNER_BUDGET_PROOF_LIVE_PROOF_PASSED` independently verified project/portfolio totals, generic-resource financial isolation, denied ungranted/cross-tenant access, the exact budget link and one immutable delivery receipt using read-only transactions under `capiro_app`.

The test alert was disabled before cleanup. The single time entry was removed through the recoverable correction flow, then the test task, project, portfolio and specific Inbox item were archived through normal UI recovery flows. Archived budget history shows zero actual/estimated cost and disabled editing. `PLANNER_BUDGET_CLEANUP_PROOF_LIVE_PROOF_PASSED` verifies all three archives, the removed latest time revision, disabled alert, one read/archived Inbox delivery and zero Planner unread items. Hashes of all seven pre-existing owner time events and their revisions, preferences and organization time configuration are unchanged; private preferences remain version 4 and organization settings remain empty.

Browser evidence is saved locally in `artifacts/planner/budget-live-cost.png`, `budget-live-portfolio.png`, `budget-live-bell.png` and `budget-live-cleanup.png`. USD/EUR currency snapshots and admin currency settings are qualified in restricted-role database/web tests; the signed-in production member appropriately cannot change organization settings.

## Remaining parity

Full Asana parity remains in progress. Shared capacity plans/allocations, placeholders/team pools, capacity-derived estimates, workload cost comparisons and saved cost report charts require subsequent work. This release's estimated source is task estimates. Timer, parent/subtask time rollups, time-field CSV import and further rules/templates also remain. The unanswered request to place saved report charts on Capiro's main Dashboard does not authorize those widgets.

Rollback restores Strategies 47 and web-vNext 460. The additive twelfth migration can remain; no destructive schema rollback is needed.

Primary references: [Asana budgets and rates](https://help.asana.com/s/article/tracking-project-budgets-and-progress-with-timesheets-and-budgets-add-on?language=en_US), [timesheets and budgets settings](https://help.asana.com/s/article/timesheets-and-budgets-add-on), [capacity planning](https://help.asana.com/s/article/capacity-planning).
