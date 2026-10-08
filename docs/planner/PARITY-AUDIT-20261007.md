# Remaining Planner parity audit

This inventory records unfulfilled or unverified requirements. It does not claim full Asana Work parity. Recheck each item against deployed behavior before closing the goal.

## Capacity and costs

The nineteenth release implements Projects/People capacity plans, project/live-portfolio/people/team selection, persistent allocations shared across plans, date/effort editing, bulk move/reallocate/archive/restore, duplication, transfers, basic filtering/grouping, saved views, hours/percentage/person-project counts and individual weekly capacities. Team-scoped placeholders have names/job titles/capacity and transfer to actual members. Plan roles intersect current source permissions without an organization-admin bypass. Authenticated live checks verify shared allocations, reload/saved views, individual percentages, project totals, actual CSV downloads, placeholder transfer, archive/restore and unchanged original records; staffing creates no tasks/time entries/inbox notifications. See [RELEASE-CAPACITY-20261007.md](RELEASE-CAPACITY-20261007.md).

The twentieth release adds qualified pointer/keyboard date resizing, allocation context menus, exact-date duplication, scoped Delete archive, recovery, seeded cell creation and unsaved view preservation across archive filtering. 192 web checks, the production build, exact-source ARM64 build and authenticated live QA pass; original records remain unchanged after recoverable cleanup. See [RELEASE-CAPACITY-CONTROLS-20261007.md](RELEASE-CAPACITY-CONTROLS-20261007.md).

The twenty-first release adds configurable project allocation editing and row-level project details, seeded creation and explicit transfer actions. Strategies 53 / web-vNext 472 pass restricted policy/atomicity tests and authenticated live qualification, including downloaded CSV and unchanged original records after cleanup. See [RELEASE-CAPACITY-PERMISSIONS-20261008.md](RELEASE-CAPACITY-PERMISSIONS-20261008.md).

The twenty-second release adds atomic reviewed common/individual weekly limits, shared Workload limits, authorized portfolio summary rows and saved person-month display. Strategies 54 / web-vNext 473 pass authenticated common/zero-limit, reload and downloaded CSV checks with original and separately concurrent records preserved after recoverable cleanup. See [RELEASE-CAPACITY-LIMITS-20261008.md](RELEASE-CAPACITY-LIMITS-20261008.md).

The twenty-third release qualifies continuous calendar bars, stable overlap lanes, grabbed-date-preserving moves and reviewed empty-cell creation on web-vNext 474 with Strategies 54 retained. Authenticated live checks and original-record preservation pass after recoverable cleanup. See [RELEASE-CAPACITY-TIMELINE-20261008.md](RELEASE-CAPACITY-TIMELINE-20261008.md).

Capacity still needs custom-profile/custom-project-field filters and richer team/job-title grouping semantics. Live-portfolio expansion, atomic batches, source revocation and full revision-bound pagination pass restricted database tests; qualification across broader real staffing scenarios remains part of the final audit. [Asana capacity planning](https://help.asana.com/s/article/capacity-planning).

Reporting still needs capacity/task estimates as separate selectable sources, placeholder estimates and date-range distribution over workdays, plus saved cost charts. Workload comparison needs task estimates versus planned staffing and actual versus estimated effort, time/percentage/cost formats, per-project breakdowns and remaining daily capacity. Rates/currencies must keep existing financial and private-source boundaries. [Estimate reporting](https://help.asana.com/s/article/understanding-the-value-of-reporting-with-the-timesheets-and-budgets-add-on), [workload compare mode](https://help.asana.com/s/article/workload-compare-mode).

## Hierarchy, transfers and view controls

Descendant start/due dates require explicit reconciliation, durable asynchronous job status and current edit permissions for every affected task. Project-wide rollups must cover only qualifying descendants without silently widening dates during unrelated edits. [Task date rollup](https://developers.asana.com/reference/rolluptask), [project date rollup](https://developers.asana.com/reference/rollupproject).

Dense task-detail subtasks need hide-completed, assignee/date filtering and sort controls. List needs first-level expand/collapse all; deeper levels retain their own collapsed state. Timeline first-level descendants, unscheduled work and persisted expansion require audit. CSV needs reviewed hierarchy/dependency/custom-field mapping; project Excel export remains open. Board-column collapse persistence and project/portfolio dropped/completed status options also require audit. [Subtask controls](https://help.asana.com/s/article/subtasks?language=en_US), [timeline](https://help.asana.com/s/article/timeline), [advanced CSV import](https://help.asana.com/s/article/advanced-csv-import-options), [release notes](https://help.asana.com/s/article/release-notes?language=en_US).

## Completion boundary

Audit the remaining rules/templates, custom-field types/library/search, project and task views, bulk actions, permissions, collaborative updates and responsive workflows against primary documentation and authenticated deployed behavior. Existing working workflows in IMPLEMENTATION.md must be checked, not merely inferred from endpoint presence.

New Capiro connections need owner approval. Main Dashboard report widgets, selected-client filtering and a timer overlay across other tools remain unanswered. Workspace document integration was declined. Native Planner teams/placeholders can be developed within Planner; a Directory, calendar, Meri or external reporting connection needs a separate decision. No live Asana migration is authorized.
