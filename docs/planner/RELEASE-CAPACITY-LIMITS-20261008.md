# Planner weekly limits and portfolio staffing summaries

Twenty-second release candidate. Full Asana Work parity remains open. All new reads and writes use the Strategies Planner API. No schema migration or new Capiro integration is required.

Capacity plans expose common and individual weekly-capacity dialogs, including selected people with no allocations. The dialog captures the opening plan revision, reviews all values before saving and never silently truncates a batch. A person can edit their own limit, an organization admin can edit active members, and a placeholder requires its current team admin. Project and plan grants do not supply those permissions. Changes are atomic under the existing tenant advisory lock; stale revisions, revoked access and any invalid subject reject the complete batch. Values accept zero through 168 hours in whole minutes. Percentage allocations recalculate; fixed-hour allocations retain their total effort. Workload reads the same canonical limit.

Legacy duplicate unscoped limits are resolved deterministically and updated together without deleting records. New duplicate limits and person-identity changes are rejected. Portfolio rows show authorized current projects, effort, person months, distinct people and project counts. Private projects remain redacted and membership/access changes invalidate the capacity snapshot. Person-month display can be saved in a plan view.

Validation: 242 API/database checks in eleven suites, a separate tenant-scope guard check, 205 web checks in 28 files, and both production builds. Restricted PostgreSQL tests cover shared limits, self/admin/team permissions, all-or-nothing batches, competing writes, stale revisions, duplicate recovery, identity constraints, zero capacity and portfolio privacy. Synthetic browser checks verify common/individual limits, percentage recalculation, fixed effort, Workload consistency and portfolio rows. Cloud release and authenticated live qualification remain pending.

Primary requirement: [Asana capacity planning](https://help.asana.com/s/article/capacity-planning). Custom profile/project-field filters, richer grouping, cost comparisons, continuous-date visuals and the remaining full parity audit are still open.

Evidence is retained in ignored `artifacts/planner/capacity-profiles-*` and `capacity-limits-*`. Record immutable images, release identifiers, live qualification and compatible recovery before marking this candidate released.
