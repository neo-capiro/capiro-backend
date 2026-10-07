# Planner capacity timeline controls

Twentieth release candidate from `feat/planner-capacity-controls-20261007`. Full Asana Work parity remains in progress. This frontend release uses the existing Strategies 52 capacity API and requires no migration.

## Behavior

Start/end handles resize allocations directly in the timeline. Pointer movement previews a calendar date and commits once on release; cancellation leaves the record unchanged. Day/week/month columns use their actual calendar lengths, including partial and leap-year months. Arrow keys move an edge by one day, Shift by seven days. Crossed ranges, empty working-day ranges and excessive date shifts are rejected. Changes carry the allocation's opening version and preserve its project, person, effort unit and effort value; total hours redistribute over the new working dates.

An allocation's actions menu supports editing, exact-date duplication, bulk selection and recoverable archive/restore. Right-click and Shift-F10 open the same accessible menu. Delete archives current qualified selections, or the focused allocation, only within the staffing timeline; typing in a form does not archive work. A timeline cell's plus opens an allocation form prefilled with that row and date interval, and saves only after the form is submitted. Active/archive filtering preserves the current date window, layout, zoom, units, grouping and other filters.

Plan administration and each allocation's current project permissions still gate controls and writes. The Strategies API continues to enforce plan/allocation versions and atomic source/destination grants. No authentication, impersonation, permission widening, task/time creation or additional Capiro integration is introduced.

## Validation

181 Planner regression checks in 26 files pass, including ten new interaction checks. Production typechecking and the web build pass. The focused controls checks cover unequal month lengths, one-time pointer commits, cancellation, keyboard boundaries, duplication, context menus, archive/restore, read-only controls, preserved views, scoped Delete and seeded cell creation.

Synthetic browser QA verifies pointer end-date resizing by a week, keyboard start-date resizing, unchanged 45 total hours, exact-date duplication, Delete archive and menu recovery, preserved Month/Percent display and a Jamie Lee allocation with the selected cell's dates. The fixture contains synthetic records only; production's build does not load it. Evidence is retained in `artifacts/planner/capacity-controls-*`.

## Release qualification

Exact-source build, immutable web candidate, authenticated live verification and cleanup are pending. Strategies remains at 52; the web rollback baseline is 465. No schema or API rollback is needed for this frontend release.

## Remaining parity

Custom-profile/custom-project field filters, portfolio grouped totals, row-level project details/transfer actions, individual capacity menus, configurable project allocation editing and richer team/job-title semantics remain open. Task-workload/capacity/actual comparisons, selectable estimate sources and cost reporting remain separate work. See [PARITY-AUDIT-20261007.md](PARITY-AUDIT-20261007.md).
