# Planner project budgets and costs

Fifteenth release from `feat/planner-project-budgets-20261007`. Prepared for narrow Strategies and web-vNext deployment. Live verification and immutable release identities will be recorded after promotion.

## Behavior and access

Project admins can configure a budget in hours or cost, manage a pool of up to 500 hourly rates, and compare task estimates with actual time. Rates are rounded to two decimals and costs use integer arithmetic. Unknown rates are explicit; zero rates are valid. Rates do not grant project access and remain available after a member leaves until removed. A new organization time setting supplies the currency for newly saved project budgets; existing budgets keep their currency.

Actual work uses latest immutable time corrections/removals and each entry's recorded project allocation. General project time is included. Current task access is rechecked after a task moves; readable archived history remains available. Billable/non-billable filters affect actual work. Task estimates use current project memberships and exclude archived tasks. Project admins alone can access budgets, rates and costs; organization admin status does not bypass project access. Internal financial resources are excluded from public project, generic resources and reports.

Portfolio rollups intersect readable portfolios with current project admin grants. Money is grouped by currency without conversion. Each project admin can configure a personal threshold against the budget or estimate. Delivery is owner-only through the approved Planner Inbox and main notification bell, once per saved configuration. Events, Inbox rows and immutable receipts commit atomically. Revoking project admin access hides old financial notifications and blocks their mutation. Missing rates prevent misleading cost alerts for the affected actual/estimated reference.

Planner remains on Strategies, in the signed-in organization. Existing approved Capiro connections remain unchanged. No Workspace document connection, new authentication scope, role or external integration is added.

## Qualification

359 distinct API checks across 34 suites and 132 web checks across 20 suites pass. The broad API run passed 346 checks, then focused repair verification passed 47 checks including the updated eleven-table assertion and all twelve budget database cases. Shared, Strategies and web production builds pass. A fresh twelve-migration rehearsal verifies eleven forced-RLS tables, six immutable triggers and restricted application privileges.

Database cases cover project admin access without an organization bypass, generic resource isolation, corrected/removed/billable/general time, multi-project estimates with one actual allocation, moved-task revocation, archived history, retained departed rates, currency snapshots, concurrent updates, separate-currency portfolio rollups, concurrent workers, personal delivery, demotion/redaction, rollback after failed receipt insertion, raw cross-tenant RLS, receipt immutability/foreign-key scope and progress beyond fifty alert candidates. Web cases cover access boundaries, unrated cost labeling, hours and actual filters, decimal rates, opening-version saves, conflicts, personal alerts, revoked cached data, organization cancellation, archived history and portfolio currencies.

Synthetic browser verification saved a ten-hour budget, three hourly rates and a $1,000 cost budget. Task estimates total $601.50. Logging one billable hour produces $125.50 actual cost, $874.50 remaining and 12.55% used. Personal alert configuration persists visibly. Read-only production preflight verifies all 27 existing migration checksums, eleven completed Planner migrations, ten forced-RLS tables and five immutable triggers under the actual non-super/non-bypass application role.

## Remaining parity

Full Asana parity remains in progress. Shared capacity plans/allocations, placeholders/team pools, capacity-derived estimates, workload cost comparisons and saved cost report charts require subsequent work. This release's estimated source is task estimates. Timer, parent/subtask time rollups, time-field CSV import and further rules/templates also remain. The unanswered request to place saved report charts on Capiro's main Dashboard does not authorize those widgets.

Rollback will restore Strategies 47 and web-vNext 460. The additive twelfth migration can remain; no destructive schema rollback is needed.

Primary references: [Asana budgets and rates](https://help.asana.com/s/article/tracking-project-budgets-and-progress-with-timesheets-and-budgets-add-on?language=en_US), [timesheets and budgets settings](https://help.asana.com/s/article/timesheets-and-budgets-add-on), [capacity planning](https://help.asana.com/s/article/capacity-planning).
