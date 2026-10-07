# Planner time fields in CSV transfers

Sixteenth release, [PR #2195](https://github.com/neo-capiro/capirov2/pull/2195), from `feat/planner-time-tracking-20261007`. Live on stable, healthy Strategies 49 / web-vNext 462, both built from `eb685f0542799bcbf3546e3647d6ca5a54dbab61`. The final evidence commit changes documentation only.

## Behavior and access

Reviewed task CSV imports accept Estimated time and Actual time in `hh:mm`, `1hr 30min`, `1h 30m` and numeric-hour formats. A bare `15` means fifteen hours. Fractional hours round to the nearest whole minute using integer arithmetic. Empty values mean zero. Invalid formats, negative/exponent values and values above the existing one-million-minute task bound are rejected before offering creation. Existing file/row limits remain two MB and one hundred rows. Task exports include both individual-task time totals in `hh:mm`; the detailed person/date export remains available separately.

The preview shows estimated/actual values and explains that imported actual totals are logged by the signed-in importer on a selected work date, in the captured organization zone and using the organization's current billable default. The file/date are fixed after the first attempt, including an ambiguous response; later settings refreshes cannot change the retry's zone. Aggregate CSV values do not invent daily history or another person's identity. Large totals are inserted in a single batch of normal, separately correctable entries of at most 1,440 minutes.

`POST /strategy-api/planner/tasks/import` uses the existing signed-in tenant/context guards and project/task permissions. Each reviewed row has a stable opaque key for retries within the open import. Task creation, creation activity, time entries, timesheet changes and a private import receipt commit in one tenant-locked transaction. Retrying the same row returns the existing task; changing its values with the same key conflicts. Current source permissions are rechecked on retry. Receipts remain outside generic resource reads and mutations. Time-policy, allocation, active membership or approval-lock failures roll back the whole row. Completed rows stay completed when resuming the remaining import. There are no migration, shared authentication or new Capiro integration changes.

## Qualification

368 distinct API checks across 35 suites and 141 web checks across 21 suites pass. The broad API run passed 364 checks in 33 suites; final HTTP/DI/tenant verification passed 65 checks, including two new guarded import-route checks and the two previously omitted infrastructure suites. Web regression passed 130 checks in twenty Planner suites and eleven bell checks; twelve focused import/parser checks passed after the final bounded-parser refinements. Shared, Strategies and web production builds pass.

Seven restricted-role PostgreSQL cases cover estimates and importer/date/allocation/defaults, correction/removal followed by retry, one-million-minute batching, concurrent/lost-response deduplication, changed-key conflicts, private receipt isolation, moved-task/cross-tenant denial, active membership, project access without organization bypass, malformed bounds, atomic time-policy/allocation rejection, locked timesheets and zero-time imports with tracking disabled. Browser tests cover complete previews, captured keys/dates, exact retry requests, remaining-row resume and rejecting malformed rows before creation.

Synthetic browser verification imported two tasks with 135 estimated / 90 actual minutes and 900 estimated / 30 actual minutes, on December 14. The actual downloaded CSV was read from disk and verified to contain `2:15` / `1:30` and `15:00` / `0:30`. The in-app browser saved the download normally although its automation download event timed out. Local evidence: `artifacts/planner/time-import-local-preview.png`, `time-import-local-result.png`, `time-import-local-export.csv` and `PLANNER_TIME_IMPORT_LOCAL_EXPORT_PASSED`.

Browser qualification also found that the growing project controls squeezed long titles into a narrow column. The header now preserves the title's usable width and wraps actions onto another row when needed. `time-import-local-header.png` verifies the corrected layout, and the final web production build passes. Initial remote builds were superseded before any deployment; both final images use the corrected source.

Read-only production preflight passed as `PLANNER_TIME_IMPORT_SCHEMA_PROOF_PASSED` on serving Strategies 48: 28 migration files and their recorded checksums, twelve Planner migrations, eleven forced-RLS tables and six immutable triggers, under the actual non-super/non-bypass application role with restricted privileges.

## Deployed identities and runtime proof

Both final ARM64 CodeBuild jobs succeeded against the exact source above. Strategies build `capiro-build-web-dev:148408ee-58e1-4d93-953b-aaea49a3d7b1` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:60ec4b1c59df66e0f11df2caff58dd0541bf5da5641d871fc9b12b19a0d8f900`. Web build `capiro-build-web-dev:da2783d4-d716-40e0-bb26-6eda82763a08` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:7617dc3d94307885e62e7e4975e02917960496bdc2c31274fdd54c63aab13622`. The initial Strategies build succeeded and initial web build was stopped after the header fix was identified; neither initial image was deployed.

Strategies task `bc5b16e5403a4f52b73e784c59c20201` and web task `e27160e57b334a41831daadb2c44358f` are running and healthy with matching immutable digests. Each service has one completed primary deployment, one desired/running task and no pending tasks. Public Strategies health returns `ok: true`; public runtime configuration identifies the exact web source. The serving-role marker `PLANNER_TIME_IMPORT_SCHEMA_PROOF_PASSED` independently verifies all 28 migration files/checksums, twelve completed Planner migrations, eleven forced-RLS tables and six immutable triggers under the actual restricted non-super/non-bypass application role. No migration was needed.

Candidate definitions preserve every baseline field except immutable image and release identifiers. No canonical API, Compute, routing, IAM, shared authentication or CDK changes were deployed. Rollback restores Strategies 48 / web-vNext 461; no schema rollback is needed.

## Authenticated live verification and cleanup

The signed-in UI created a private synthetic project with no additional members or record links. A reviewed two-row CSV imported 135 estimated / 90 actual minutes and 900 estimated / 30 actual minutes. The preview captured December 14, 2026 in UTC and named the importer as the logger. Both rows completed; reloading preserved their estimates and actual history. The actual downloaded CSV was read from disk and verified to contain exactly two tasks with `2:15` / `1:30` and `15:00` / `0:30`, assigned to the signed-in importer. `PLANNER_TIME_IMPORT_LIVE_EXPORT_PASSED` confirms the file contents.

`PLANNER_TIME_IMPORT_PROOF_LIVE_PROOF_PASSED` uses read-only transactions under `capiro_app` to verify exact actor/recorded-by identity, date, zone, non-billable default, recorded project allocation, two private receipts and two time events. Exact receipt replays return the original tasks without writes; changed-input retries reject. Generic resource reads exclude the receipts.

Both test time entries were removed through the recoverable correction flow, then both tasks and the private project were archived through normal UI recovery flows. `PLANNER_TIME_IMPORT_CLEANUP_LIVE_PROOF_PASSED` verifies all three archives, latest removed revisions, zero actual totals and retained private receipts. Hashes of all eight pre-existing owner time events and their revisions, preferences and organization time configuration are unchanged; private preferences remain version 4, organization settings remain empty and Planner unread remains zero. The original eight unrelated main-bell items were preserved.

Browser evidence is saved locally in `artifacts/planner/time-import-live-preview.png`, `time-import-live-complete.png`, `time-import-live-time.png`, `time-import-live-cleanup.png`, `time-import-live-ready.png` and `time-import-live-export.csv`.

## Remaining parity

Full Asana parity remains open: native timers, parent/subtask time rollups, shared capacity plans/allocations/placeholders, capacity-derived estimates, workload cost comparisons, saved cost charts, CSV hierarchy/dependency mappings and further rules/templates remain. Main-Dashboard saved report widgets remain unauthorized while the existing question is unanswered.

Primary reference: [Asana time tracking, CSV formats and rollups](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US).
