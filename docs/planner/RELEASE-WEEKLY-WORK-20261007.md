# Planner weekly work selection

Twelfth release candidate from `feat/planner-timesheet-work-20261007`. Deployment and live verification are pending.

## Behavior

Personal timesheet settings can automatically show tasks assigned to the submitter and due during the selected Monday–Sunday week. These are zero-hour rows; no time is inferred from task dates. Manual task/project rows persist per week without changing assignments or project membership. Daily controls log through the existing dated, billable and immutable time workflow.

Tracked allocations replace automatic placeholders. A task can retain separate project allocations, while a multi-project automatic task asks the logger to choose an authorized project. Removing a row requires removing all its time entries first, including entries beyond the first page. Removing an automatic task hides it for that week; adding it again clears the exclusion. Submission and recall preserve selections. Approval/date/tracking locks apply to row edits and logging.

Preferences belong only to the signed-in member. Reviewers can read their assigned submitter's weekly selections through the existing review workflow, but every task/project is reauthorized on each read. Revoked work disappears and invalidates the captured revision. Organization administrators cannot read unrelated private work. The internal preference resource is excluded from generic resource endpoints.

Work rows have independent, revision-bound pagination in batches of 100. Saves capture both the opening timesheet version and data revision; stale or concurrent changes return a conflict. Personal preferences also use captured versions. Cached rows are hidden when paging fails or a revision changes.

## Qualification

306 Strategies checks across 29 suites and 102 web checks across 17 suites pass. Seven new PostgreSQL cases run as `capiro_app` with forced row security: private/versioned preferences and unique ownership; due-week boundaries; persistent manual rows and approval locks; weekly automatic exclusion and restoration; reviewer/source revocation; 121-row pagination and off-page removal guards; concurrent selection conflicts. Three grouping checks cover zero-hour rows, deduplication, distinct allocations and locks.

Web checks cover captured preference and work versions, exact daily logging, stale paging isolation, failure hiding and removal guards. Shared, Strategies and web production builds pass. Explicitly synthetic browser QA verifies zero-hour automatic selection, dated logging, manual general-project rows, required entry removal and persistent weekly exclusion after refresh. Screenshots are retained under ignored `artifacts/planner/timesheet-work-local-*.png`.

A fresh PostgreSQL rehearsal applies all ten Planner migrations over the legacy broad grants and verifies nine forced-RLS tables, restricted runtime rights, four immutable triggers and the new unique preference index. Rehearsal proof: `PLANNER_TEN_MIGRATION_REHEARSAL_PASSED`.

## Release boundary

Captured baselines: Strategies **44**, web-vNext **456**, dedicated Strategies migration task **13**. The only schema change is `20261007020000_planner_time_preferences`, a partial unique index on existing tenant/owner preference rows. No role, grant, authentication, row-security, canonical API, routing, Compute or CDK changes are included. Candidate definitions preserve all settings except immutable images and serving release identifiers.

Runtime-role migration/checksum proof must pass before promotion. Live verification must use private synthetic work, restore the original personal automatic-selection preference, recoverably remove time, and archive test work. Organization settings and unrelated notifications must remain unchanged.

Rollback uses preserved Strategies **44** / web-vNext **456** definitions and their immutable images from [the organization settings release](RELEASE-TIME-SETTINGS-20261007.md). Preserve the additive index, selections and immutable history; do not reverse schema migrations.

Remaining parity includes submission reminders, reviewer filters/saved views, budgets/rates/cost reporting and further rules/templates. Main Dashboard report widgets await the owner's answer. Full Asana parity remains open.

Research: [Asana logging and submitting timesheets](https://help.asana.com/s/article/logging-and-submitting-timesheets?language=en_US), [Timesheets and Budgets](https://help.asana.com/s/article/timesheets-and-budgets-add-on).
