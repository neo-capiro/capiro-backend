# Planner weekly work selection

Twelfth release from `feat/planner-timesheet-work-20261007`, PR [#2189](https://github.com/neo-capiro/capirov2/pull/2189). Strategies source: `3e24c26a5e10f6a5e1c782bdd962b544f9f79487`; final web source: `2c256026060f8267ee14acd364b0f1d28b3b2648`. The intervening commit changes only the web grid constraint.

## Behavior

Personal timesheet settings can automatically show tasks assigned to the submitter and due during the selected Monday–Sunday week. These are zero-hour rows; no time is inferred from task dates. Manual task/project rows persist per week without changing assignments or project membership. Daily controls log through the existing dated, billable and immutable time workflow.

Tracked allocations replace automatic placeholders. A task can retain separate project allocations, while a multi-project automatic task asks the logger to choose an authorized project. Removing a row requires removing all its time entries first, including entries beyond the first page. Removing an automatic task hides it for that week; adding it again clears the exclusion. Submission and recall preserve selections. Approval/date/tracking locks apply to row edits and logging.

Preferences belong only to the signed-in member. Reviewers can read their assigned submitter's weekly selections through the existing review workflow, but every task/project is reauthorized on each read. Revoked work disappears and invalidates the captured revision. Organization administrators cannot read unrelated private work. The internal preference resource is excluded from generic resource endpoints.

Work rows have independent, revision-bound pagination in batches of 100. Saves capture both the opening timesheet version and data revision; stale or concurrent changes return a conflict. Personal preferences also use captured versions. Cached rows are hidden when paging fails or a revision changes.

## Qualification

306 Strategies checks across 29 suites and 102 web checks across 17 suites pass. Seven new PostgreSQL cases run as `capiro_app` with forced row security: private/versioned preferences and unique ownership; due-week boundaries; persistent manual rows and approval locks; weekly automatic exclusion and restoration; reviewer/source revocation; 121-row pagination and off-page removal guards; concurrent selection conflicts. Three grouping checks cover zero-hour rows, deduplication, distinct allocations and locks.

Web checks cover captured preference and work versions, exact daily logging, stale paging isolation, failure hiding and removal guards. Shared, Strategies and web production builds pass. Explicitly synthetic browser QA verifies zero-hour automatic selection, dated logging, manual general-project rows, required entry removal and persistent weekly exclusion after refresh. Screenshots are retained under ignored `artifacts/planner/timesheet-work-local-*.png`.

Live browser verification exposed an intrinsic grid-width overflow in Capiro's narrower content panel. The web correction uses a zero-minimum grid track, keeping cards inside the panel and scrolling wide work tables within their own container. A constrained local browser check verifies container widths and visible cards; the final web production build passes. Final live layout verification confirms all cards and work containers fit the 641-pixel content area; the 674-pixel work table scrolls inside it.

A fresh PostgreSQL rehearsal applies all ten Planner migrations over the legacy broad grants and verifies nine forced-RLS tables, restricted runtime rights, four immutable triggers and the new unique preference index. Rehearsal proof: `PLANNER_TEN_MIGRATION_REHEARSAL_PASSED`.

## Release boundary

Captured baselines: Strategies **44**, web-vNext **456**, dedicated Strategies migration task **13**. The only schema change is `20261007020000_planner_time_preferences`, a partial unique index on existing tenant/owner preference rows. No role, grant, authentication, row-security, canonical API, routing, Compute or CDK changes are included. Candidate definitions preserve all settings except immutable images and serving release identifiers.

The production preflight verifies all 25 existing migration-file checksums under `capiro_app`, no failed migration and no preexisting preference rows. Dedicated migration task **14** applies the sole pending index and exits zero; the log confirms successful application. Actual application-role proof verifies all ten finished Planner migrations, the preference/time index checksums, nine forced-RLS tables, restricted grants and four immutable triggers before promotion and again in Strategies **45**. Final serving proof also matches all 26 migration files in the new image against their ledger checksums.

Strategies **45** and initial web-vNext **457** are sole PRIMARY/COMPLETED deployments with one RUNNING/HEALTHY task and zero pending tasks. Exact-source ARM64 builds `83a7f9e5-f5e2-48df-a025-7dffd6078120` (Strategies) and `2a73c54d-f24e-4b94-9b8c-c6c011700c8e` (initial web) succeed. Candidate definitions are compared with their captured baselines; only immutable images and serving release identifiers differ. Public Strategies health and the public web source identity pass.

- Strategies image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:4deafd4a0fb372f246f3c4e4ffacd94b00ad38a2fc6326f2af3cb008fdef5293`
- Initial web image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:efef285459050d7404e822a9c70b59526243e07d9fbbe2121141d8b65ac9545a`

The final web-only ARM64 build `a02abc86-be1d-480f-83f9-bc500543edd2` succeeds from the grid-fix source. Web-vNext **458** serves immutable image `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:d7128029647de6bc535537af8b27aa73b051ba8c1b69530347b326fe4d111669`; its task is RUNNING/HEALTHY and the public release identity matches the source. Its candidate preserves every value from web **457** except image and serving release identifiers. Strategies **45** and final web **458** are each the sole PRIMARY/COMPLETED deployment with desired/running counts of one and zero pending tasks.

Signed-in checks verify automatic zero-hour selection, persistent removal after refresh, manual re-addition, a separate general-project zero-hour row, logging 45 minutes on the selected calendar date, reload persistence and the nonempty-row removal lock. Read-only application-role proof independently verifies the exact task/project/date/category, separate allocations, private preferences, source restrictions and unchanged organization settings.

The entry is recoverably removed through an immutable revision, both weekly selections are removed, automatic selection is restored to its original false value, and the private task/project are archived. The test week returns zero time and zero rows; no scoped QA Inbox rows remain. The bell preserves eight unrelated unread items. Personal preferences now have version 2 after restoration; their original behavior is restored, rather than their original storage/version. Organization settings remain at their original empty-row hash.

Live proofs: `PLANNER_WEEKLY_WORK_BASELINE_LIVE_PROOF_PASSED`, `PLANNER_WEEKLY_WORK_ACTIVE_LIVE_PROOF_PASSED`, `PLANNER_WEEKLY_WORK_CLEANUP_LIVE_PROOF_PASSED`, plus the ten-migration runtime and organization-default proofs. Metadata, execution logs and `timesheet-work-live-*.png` are retained in ignored `artifacts/planner/` files. Live reviewer/admin mutations are not claimed; those workflows are qualified by restricted-role database tests.

Rollback uses preserved Strategies **44** / web-vNext **456** definitions and their immutable images from [the organization settings release](RELEASE-TIME-SETTINGS-20261007.md). Preserve the additive index, selections and immutable history; do not reverse schema migrations.

Remaining parity includes submission reminders, reviewer filters/saved views, budgets/rates/cost reporting and further rules/templates. Main Dashboard report widgets await the owner's answer. Full Asana parity remains open.

Research: [Asana logging and submitting timesheets](https://help.asana.com/s/article/logging-and-submitting-timesheets?language=en_US), [Timesheets and Budgets](https://help.asana.com/s/article/timesheets-and-budgets-add-on).
