# Planner time fields in CSV transfers

Sixteenth increment from `feat/planner-time-tracking-20261007`. Implemented and qualified locally; immutable deployment and authenticated live verification remain pending. The current live release is Strategies 48 / web-vNext 461.

## Behavior and access

Reviewed task CSV imports accept Estimated time and Actual time in `hh:mm`, `1hr 30min`, `1h 30m` and numeric-hour formats. A bare `15` means fifteen hours. Fractional hours round to the nearest whole minute using integer arithmetic. Empty values mean zero. Invalid formats, negative/exponent values and values above the existing one-million-minute task bound are rejected before offering creation. Existing file/row limits remain two MB and one hundred rows. Task exports include both individual-task time totals in `hh:mm`; the detailed person/date export remains available separately.

The preview shows estimated/actual values and explains that imported actual totals are logged by the signed-in importer on a selected work date, in the captured organization zone and using the organization's current billable default. The file/date are fixed after the first attempt, including an ambiguous response; later settings refreshes cannot change the retry's zone. Aggregate CSV values do not invent daily history or another person's identity. Large totals are inserted in a single batch of normal, separately correctable entries of at most 1,440 minutes.

`POST /strategy-api/planner/tasks/import` uses the existing signed-in tenant/context guards and project/task permissions. Each reviewed row has a stable opaque key for retries within the open import. Task creation, creation activity, time entries, timesheet changes and a private import receipt commit in one tenant-locked transaction. Retrying the same row returns the existing task; changing its values with the same key conflicts. Current source permissions are rechecked on retry. Receipts remain outside generic resource reads and mutations. Time-policy, allocation, active membership or approval-lock failures roll back the whole row. Completed rows stay completed when resuming the remaining import. There are no migration, shared authentication or new Capiro integration changes.

## Qualification

368 distinct API checks across 35 suites and 141 web checks across 21 suites pass. The broad API run passed 364 checks in 33 suites; final HTTP/DI/tenant verification passed 65 checks, including two new guarded import-route checks and the two previously omitted infrastructure suites. Web regression passed 130 checks in twenty Planner suites and eleven bell checks; twelve focused import/parser checks passed after the final bounded-parser refinements. Shared, Strategies and web production builds pass.

Seven restricted-role PostgreSQL cases cover estimates and importer/date/allocation/defaults, correction/removal followed by retry, one-million-minute batching, concurrent/lost-response deduplication, changed-key conflicts, private receipt isolation, moved-task/cross-tenant denial, active membership, project access without organization bypass, malformed bounds, atomic time-policy/allocation rejection, locked timesheets and zero-time imports with tracking disabled. Browser tests cover complete previews, captured keys/dates, exact retry requests, remaining-row resume and rejecting malformed rows before creation.

Synthetic browser verification imported two tasks with 135 estimated / 90 actual minutes and 900 estimated / 30 actual minutes, on December 14. The actual downloaded CSV was read from disk and verified to contain `2:15` / `1:30` and `15:00` / `0:30`. The in-app browser saved the download normally although its automation download event timed out. Local evidence: `artifacts/planner/time-import-local-preview.png`, `time-import-local-result.png`, `time-import-local-export.csv` and `PLANNER_TIME_IMPORT_LOCAL_EXPORT_PASSED`.

Browser qualification also found that the growing project controls squeezed long titles into a narrow column. The header now preserves the title's usable width and wraps actions onto another row when needed. `time-import-local-header.png` verifies the corrected layout, and the final web production build passes. Initial remote builds were superseded before any deployment so both final images will use the same corrected source.

Read-only production preflight passed as `PLANNER_TIME_IMPORT_SCHEMA_PROOF_PASSED` on serving Strategies 48: 28 migration files and their recorded checksums, twelve Planner migrations, eleven forced-RLS tables and six immutable triggers, under the actual non-super/non-bypass application role with restricted privileges.

## Remaining work

Before merging, deploy exact-source Strategies/web images, verify the unchanged twelve-migration schema under the actual runtime role, verify authenticated import/export persistence and recoverably clean up private live QA. Rollback uses Strategies 48 / web-vNext 461; no schema rollback is needed.

Full Asana parity remains open: native timers, parent/subtask time rollups, shared capacity plans/allocations/placeholders, capacity-derived estimates, workload cost comparisons, saved cost charts, CSV hierarchy/dependency mappings and further rules/templates remain. Main-Dashboard saved report widgets remain unauthorized while the existing question is unanswered.

Primary reference: [Asana time tracking, CSV formats and rollups](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US).
