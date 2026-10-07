# Planner reviewer views and submission reminders

Thirteenth release from `feat/planner-timesheet-review-20261007`, PR [#2191](https://github.com/neo-capiro/capirov2/pull/2191). Strategies/web source: `81227cb74998dcdbea61b63ac11f368477630aaf`.

## Behavior

Reviewers can filter their assigned submitters by people and timesheet status, sort alphabetically or by total/billable time in either direction, and save a private review view. Filters and sorting apply before 100-person paging; summary totals cover every matching authorized submitter. Saved people who are no longer assigned remain an explicit filter rather than silently broadening to everyone. Only currently assigned, active submitters can appear in results. Changes to time, assignments or source access invalidate the captured paging revision.

Personal preference patches preserve other settings. Saving a view captures the opening preference version so a competing edit cannot be overwritten. Cached reviewer rows and status history disappear after an access/paging failure or a mismatched revision. Status activity has independent database cursor paging, preserving microsecond ordering across more than 100 transitions. Internal approval total snapshots are excluded from serialized activity.

The assigned reviewer can recall an approved or rejected decision, returning the sheet to submitted status and restoring the submitter's edit lock. Owners can resubmit rejected time through the existing workflow. Approval/date/source permissions remain enforced.

Organization time settings can enable a weekly submission reminder with a weekday, local time and current/previous target week. Reminders use the existing organization time rules zone and approved Planner Inbox/main bell, with an exact submitter/week link. Full approval includes active submitters with an active assigned reviewer; simple submission includes active organization members. Draft/rejected sheets are eligible; submitted/approved sheets are skipped. Tracking disabled or reminders unset sends nothing.

Reminder event, owner-only Inbox row and durable receipt commit atomically. Each target submitter/week can receive one reminder, including after a schedule change. Concurrent workers serialize tenant writes; failed delivery rolls back and can retry. Workers process at most 50 submitters per batch with a separate cursor from task and goal scheduling. No time is inferred or logged by reminders.

## Qualification

323 Strategies checks across 31 distinct suites and 110 web checks across 18 suites pass, including focused repairs of the table-count assertion and native time input. Shared, Strategies and web production builds pass. Eleven new PostgreSQL cases run as `capiro_app` with forced row security.

Restricted-role PostgreSQL cases cover private/versioned preference merging; global reviewer filtering/order and revoked access; 121-person review paging; 121-event history paging with microsecond ordering and foreign/stale cursor rejection; reviewer recall of rejection and edit locks; disabled defaults, exact owner-only Inbox/bell links and weekly deduplication; concurrent workers and rollback/retry; inactive/submitted/approved exclusion; local deadlines and previous-week targeting; 121 reminder deliveries in bounded pages; receipt RLS, Monday dates and append-only rights.

Web qualification covers captured view versions, retained edits after rejection, unassigned saved people, global totals, exact submitter selection, failure/stale-page hiding, complete history paging, revision isolation, native reminder time input and existing notification-bell behavior. Synthetic browser checks verify filter persistence when reopening review and saved reminder day/time/week after reopening time settings. Live reviewer/admin changes are not claimed by these synthetic checks.

A fresh PostgreSQL rehearsal applies all eleven Planner migrations over legacy broad grants and verifies ten forced-RLS tables, restricted runtime privileges and five immutable triggers. Proof: `PLANNER_ELEVEN_MIGRATION_REHEARSAL_PASSED`.

## Release boundary

Captured baselines: Strategies **45**, web-vNext **458**, dedicated Strategies migration **14**. Production preflight under `capiro_app` verifies all 26 existing migration-file checksums, ten finished Planner migrations, nine forced-RLS tables, restricted rights and four immutable triggers. The sole pending migration is `20261007030000_planner_time_reminders`.

The new append-only Planner receipt table has tenant/submitter/week uniqueness, Monday-date validation, composite tenant/resource/event references and forced tenant RLS. It grants SELECT/INSERT only to the existing application identity. No authentication, role, canonical API, routing, Compute or CDK change is included. Narrow candidates preserve task-definition settings except immutable images and serving release identifiers.

Exact-source ARM64 builds `5624529f-2262-47ef-92aa-9d21cff72162` (Strategies) and `78eef0d3-dac0-40d6-a570-1c3e534960c8` (web) succeed. Dedicated migration **15**, task `1ca053390cd94272b1c5bfba2a7804ea`, exits zero; its logs confirm the new migration and successful application. Read-only proof under the actual application role verifies eleven finished Planner migrations, ten forced-RLS tables, five immutable triggers, receipt uniqueness/composite references and restricted privileges before promotion. The existing image's 26 files match their ledger checksums; the new migration's checksum is verified explicitly.

- Strategies **46** image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:3336148e77c3f9c22d80d743e7201d3ee0824fda440f0278f22f6c5da684e041`
- Web-vNext **459** image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:aa313c6f278c1f7433ee71185c1154d7409e1554dc619e454f5fcef1d3239318`

Strategies **46** and web-vNext **459** are sole PRIMARY/COMPLETED deployments, each with desired/running counts of one and zero pending tasks. Serving tasks `2638077209fc453a960bab68decb6f5f` and `09e7dd8f53394e56a33d9a4ef214ddb8` are RUNNING/HEALTHY with the expected immutable digests. Public Strategies health and the public web release identity pass. Serving proof matches all 27 migration files against their ledger checksums and verifies eleven Planner migrations, ten forced-RLS tables and five immutable triggers.

Signed-in browser checks save draft/rejected status filters with billable-time descending order, verify persistence after a full reload, restore empty filters/alphabetical ascending order and verify restoration after another reload. Read-only application-role proof independently verifies the exact preference values/versions, zero assigned review rows, private preference access, disabled default reminders and zero receipt rows. The original automatic-task setting remains false. Personal preferences advance from version 2 to 3 to 4; original behavior is restored with an explicit default saved view, rather than restoring the original storage/version.

Organization settings retain their original empty-row hash, `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`. No colleagues are assigned or notified, no new Planner unread rows exist, and the main bell preserves eight unrelated unread items. Live reviewer/admin decisions or enabled reminder delivery are not claimed: the signed-in member has no assigned submitters, and those workflows are qualified through restricted-role PostgreSQL and synthetic browser checks.

Proofs: `PLANNER_TIME_REVIEW_PREFLIGHT_PASSED`, `PLANNER_ELEVEN_MIGRATIONS_RUNTIME_PROOF_PASSED`, `PLANNER_TIME_REVIEW_BASELINE_LIVE_PROOF_PASSED`, `PLANNER_TIME_REVIEW_ACTIVE_LIVE_PROOF_PASSED` and `PLANNER_TIME_REVIEW_CLEANUP_LIVE_PROOF_PASSED`. Exact-source build, task, migration and runtime metadata plus `time-review-local-*.png` / `time-review-live-*.png` are retained in ignored `artifacts/planner/` files.

Rollback uses preserved Strategies **45** / web-vNext **458** definitions and immutable images from [the weekly work release](RELEASE-WEEKLY-WORK-20261007.md). Preserve additive schema and immutable history.

Remaining parity includes reviewer/date-range exports, budgets/rates/cost reporting and further rules/templates. Main Dashboard report widgets await the owner's answer. Full Asana parity remains open.

Research: [Asana reviewers and approvals](https://help.asana.com/s/article/managing-timesheet-reviewers-and-approvals), [Timesheets and Budgets](https://help.asana.com/s/article/timesheets-and-budgets-add-on).
