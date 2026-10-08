# Planner weekly limits and portfolio staffing summaries

Twenty-second release, live on healthy Strategies 54 / web-vNext 473. Full Asana Work parity remains open. All new reads and writes use the Strategies Planner API. No schema migration or new Capiro integration is required.

Capacity plans expose common and individual weekly-capacity dialogs, including selected people with no allocations. The dialog captures the opening plan revision, reviews all values before saving and never silently truncates a batch. A person can edit their own limit, an organization admin can edit active members, and a placeholder requires its current team admin. Project and plan grants do not supply those permissions. Changes are atomic under the existing tenant advisory lock; stale revisions, revoked access and any invalid subject reject the complete batch. Values accept zero through 168 hours in whole minutes. Percentage allocations recalculate; fixed-hour allocations retain their total effort. Workload reads the same canonical limit.

Legacy duplicate unscoped limits are resolved deterministically and updated together without deleting records. New duplicate limits and person-identity changes are rejected. Portfolio rows show authorized current projects, effort, person months, distinct people and project counts. Private projects remain redacted and membership/access changes invalidate the capacity snapshot. Person-month display can be saved in a plan view.

Validation: 242 API/database checks in eleven suites, a separate tenant-scope guard check, 205 web checks in 28 files, and both production builds. Restricted PostgreSQL tests cover shared limits, self/admin/team permissions, all-or-nothing batches, competing writes, stale revisions, duplicate recovery, identity constraints, zero capacity and portfolio privacy. Synthetic browser checks verify common/individual limits, percentage recalculation, fixed effort, Workload consistency and portfolio rows. Both exact-source ARM64 cloud builds and authenticated live qualification pass.

Primary requirement: [Asana capacity planning](https://help.asana.com/s/article/capacity-planning). Custom profile/project-field filters, richer grouping, cost comparisons, continuous-date visuals and the remaining full parity audit are still open.

## Live qualification and recovery

Deployed source `3e16f231287cedb04ad8eabd89ce047491a2fab4` preserves live web 472's unrelated Newsletter and Meri code. Planner source is identical to feature commit `715a4b4e70d0216654faffa0f58018cc453b8892`. Candidate task definitions change only immutable images and release identifiers. Both services have one completed primary deployment, one healthy running task and no pending tasks. Public Strategies health passes and runtime-config.js reports the exact source.

| Service | Revision | Immutable image |
| --- | --- | --- |
| Strategies | 54 | `sha256:a11fb8ed46ab49349beafa3a613c5c2738b77fb5db3d463957c7d09c3701c3c6` |
| web-vNext | 473 | `sha256:db7f2dd1e3a60e946d60c972b54379727d2b5774dcd1c211a462cc82328a2844` |

Signed-in QA applies a common 40-hour weekly limit to two private placeholders. A 25-percent allocation changes from 10 to 20 total hours across ten workdays, while the fixed 10-hour allocation stays at 10. The portfolio shows 30 hours, two people and one project. The person-month view survives reload, and the actual downloaded CSV includes both allocation IDs, dates, 40-hour limits and 30 planned hours. The individual menu persists a zero limit, producing zero percentage effort while the fixed allocation remains 10 hours, and then restores the synthetic limit to 40.

Private plan `e7d1cd75-92a0-403c-9cab-ae82e3f757f0`, project `463345f8-d688-4df9-b9c5-516cab12aa91`, portfolio `94350a56-8dae-42e3-950d-73f9b2590c53`, team `42d533a2-1a02-49bc-9729-7306116fa9b6`, both placeholders and allocations `0f2f49f4-7ab5-487f-99ea-09bcb0c91271` / `8b768c9b-ffa2-4d0f-8d5a-092d0beca602` are recoverably archived. Allocation dates remain March 1–12, 2027, and both finish at version 2. Existing member limits were not changed.

Independent read-only proofs run as the actual non-superuser, non-RLS-bypass `capiro_app` role. All 28 migration checksums (12 Planner migrations), 11 forced-RLS tables and six immutable tables pass. Original record hash `c1030cfa57c10548ece90e271f67f499ed7344b6816bf7da1a5994e990544170` is unchanged, with 155 original events, 14 owner time events, the 85-minute week/version 2, preference version 4, inactive timer and zero unread Planner items preserved. The main bell retains eight unrelated unread items. A separate archived `TASK 1` appeared during qualification; its identity and full task/activity/Inbox state were pinned separately and remain unchanged through weekly-limit checks and cleanup. Staffing records contain no task/time/notification linkage.

Evidence is retained in ignored `artifacts/planner/capacity-profiles-*` and `capacity-limits-*`: local regressions/build logs, immutable cloud-build metadata, service/task snapshots, schema and baseline/common/zero/cleanup proof logs, the concurrent-task hash, actual downloaded CSV and live portfolio screenshot. Strategies task `f33fc8eddfcc4c24a8b7f11a3ad59aed` and web task `0c94d93a55dc42259a97802ce93604a6` are healthy.

Retain Strategies 54 for the new weekly-limit endpoint and person-month view validation. Web 472 predates person-month display and cannot fully render saved views using that unit; prefer a compatible forward fix. Existing capacity records remain recoverable and no schema rollback is needed. Do not revert earlier capacity access and allocation-policy protections.
