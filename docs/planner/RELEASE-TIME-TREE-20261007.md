# Planner subtask time rollups

Eighteenth release, prepared from `feat/planner-subtask-time-rollups-20261007`. Deployment and authenticated live evidence will be recorded after qualification.

## Behavior and access

The Planner list shows estimated and actual time in hours:minutes. Collapsed parents include all accessible active descendants; expanding a parent shows its own time and individual child rows. Section and overall totals count overlapping ancestors and descendants once. Expansion loads children independently of the task search and project filters, including accessible personal subtasks outside the project. Estimated/actual sorting uses complete rolled totals and stays stable while expanding. Saved views retain these sort choices. Task details show a separate descendant summary above the task's own time entry controls and history.

`GET /strategy-api/planner/time/tree` accepts project, personal, archived and single-task scopes. Each read uses a repeatable-read tenant transaction, rechecks active membership and current project/task permissions, and returns only authorized compact identities/time values. Private or archived bridges cannot reveal an otherwise unscoped subtree. Organization admins have no private-work bypass. Immutable corrections/removals determine actual time. Revision-bound 100-node pages and a final permission/revision verification prevent partial or mixed totals; the browser hides cached totals after a failed access check.

Task APIs, time entries, time CSV transfers, budgets and reports retain each task's own contributions. The display rollup does not copy child time into a parent event or inflate costs. This release adds no schema migration, shared authentication changes or new Capiro integration.

## Qualification

405 distinct Strategies checks across 39 suites and 167 web checks across 24 suites pass across the regression and final focused runs. A saved-view test fixture used an incorrect resource-kind literal in the first broad run; it was corrected and its ten checks pass. The final API run passes 90 checks in four affected suites; the final web run passes 22 checks in three affected suites.

Six restricted-role PostgreSQL cases cover nested/out-of-project totals, corrections/removals, private and archived bridges, unrelated organization admins, cross-tenant row security, inactive membership, changed grants/estimates, single-task qualification, 206-node paging and captured-revision conflicts. Four pure graph checks include 12,000 nested tasks, overlapping root deduplication, invalid input, cycles and safe-integer bounds. Browser-component checks cover expansion/collapse, exact task/history opening, independent completion, filters/groups, stable rolled-time sorting, complete qualified paging, stale/revoked cache clearing and initiating-organization isolation.

Shared, Strategies and web production builds and web typecheck pass. Synthetic browser QA verifies collapsed/expanded totals and the task summary: a 60-minute parent and 45-minute personal child show 1:45 including subtasks while the parent's own history remains 60 minutes. Evidence: `artifacts/planner/time-tree-local-collapsed.png`, `time-tree-local-expanded.png` and `time-tree-local-task-summary.png`.

## Release and live verification

Pending exact-source ARM64 builds, read-only schema preflight, narrow immutable Strategies/web-vNext promotion, authenticated live verification and recoverable cleanup. Baselines are Strategies 50 / web-vNext 463. Candidate definitions must preserve every baseline field except immutable image and release identifiers. Rollback returns to those baselines; no schema rollback is needed.

## Remaining parity

Full parity remains open: shared capacity plans/allocations/placeholders, capacity-derived estimates/costs, workload cost comparisons, saved cost charts, CSV hierarchy/dependency mappings and further rules/templates. The latest primary-source audit also identifies descendant date rollups, hide-completed/sort controls for dense subtasks and Excel project export for implementation and deployed verification. External integrations require the owner's separate approval.

Primary references: [Asana time tracking](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US), [task actual-time definition](https://developers.asana.com/reference/tasks), [descendant date rollups](https://developers.asana.com/reference/rolluptask) and [release notes](https://help.asana.com/s/article/release-notes?language=en_US).
