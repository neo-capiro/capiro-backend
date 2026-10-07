# Remaining Planner parity audit

This inventory records unfulfilled or unverified requirements. It does not claim full Asana Work parity. Recheck each item against deployed behavior before closing the goal.

## Capacity and costs

Capacity plans need Projects/People tabs, project and live portfolio selection, persistent shared project allocations, date/effort editing, bulk move/reallocate/archive, duplication, transfers, filtering/grouping and saved views. Support hours, percentage and person/project counts with individual capacity. Team-scoped placeholders need names/job titles and transfer to actual members. Plan roles must coexist with current source-project permissions; staffing must not send assignment notifications or silently create tasks. Complete allocation CSV export and portfolio totals remain required. [Asana capacity planning](https://help.asana.com/s/article/capacity-planning).

Reporting still needs capacity/task estimates as separate selectable sources, placeholder estimates and date-range distribution over workdays, plus saved cost charts. Workload comparison needs task estimates versus planned staffing and actual versus estimated effort, time/percentage/cost formats, per-project breakdowns and remaining daily capacity. Rates/currencies must keep existing financial and private-source boundaries. [Estimate reporting](https://help.asana.com/s/article/understanding-the-value-of-reporting-with-the-timesheets-and-budgets-add-on), [workload compare mode](https://help.asana.com/s/article/workload-compare-mode).

## Hierarchy, transfers and view controls

Descendant start/due dates require explicit reconciliation, durable asynchronous job status and current edit permissions for every affected task. Project-wide rollups must cover only qualifying descendants without silently widening dates during unrelated edits. [Task date rollup](https://developers.asana.com/reference/rolluptask), [project date rollup](https://developers.asana.com/reference/rollupproject).

Dense task-detail subtasks need hide-completed, assignee/date filtering and sort controls. List needs first-level expand/collapse all; deeper levels retain their own collapsed state. Timeline first-level descendants, unscheduled work and persisted expansion require audit. CSV needs reviewed hierarchy/dependency/custom-field mapping; project Excel export remains open. Board-column collapse persistence and project/portfolio dropped/completed status options also require audit. [Subtask controls](https://help.asana.com/s/article/subtasks?language=en_US), [timeline](https://help.asana.com/s/article/timeline), [advanced CSV import](https://help.asana.com/s/article/advanced-csv-import-options), [release notes](https://help.asana.com/s/article/release-notes?language=en_US).

## Completion boundary

Audit the remaining rules/templates, custom-field types/library/search, project and task views, bulk actions, permissions, collaborative updates and responsive workflows against primary documentation and authenticated deployed behavior. Existing working workflows in IMPLEMENTATION.md must be checked, not merely inferred from endpoint presence.

New Capiro connections need owner approval. Main Dashboard report widgets, selected-client filtering and a timer overlay across other tools remain unanswered. Workspace document integration was declined. Native Planner teams/placeholders can be developed within Planner; a Directory, calendar, Meri or external reporting connection needs a separate decision. No live Asana migration is authorized.
