# Planner date-range time exports

Fourteenth release from `feat/planner-time-export-20261007`, PR [#2192](https://github.com/neo-capiro/capirov2/pull/2192). Strategies/web source: `d0221ad8c378c7bed053713719a9539d7b6a99ab`. Live on Strategies 47 and web-vNext 460. No database migration is required.

## Behavior

Timesheets can export a chosen submitter's time over any valid inclusive date range. Time review can export all currently assigned active submitters. Projects can export time historically allocated to that project, including general project work and departed submitters. Organization admins can make one export across currently readable organization time; unrelated private work is excluded without revealing its existence or counts. Work dates and allocation come from the latest immutable entry snapshots; removed entries are excluded. Task names and Open/Completed status reflect the current task.

Exports include hours, minutes, work date, submitter, task/project/entry IDs, project name, billable flag, category, entry time zone, description and editor ID. CSV fields escape quotes, multiline text and spreadsheet formulas. They support more than 100 entries through complete paging.

Each page uses a repeatable database snapshot and current source permissions. The full visible result determines its revision. Entry corrections, removals, task names/status, reviewer assignment, active membership or revoked source access invalidate subsequent pages. The browser rechecks the revision immediately before downloading and produces no partial file after a failure, repeated cursor, duplicate row, count mismatch, cancellation, organization switch or unmount.

Owner decision: organization admins retain existing Planner project/task permissions when exporting. There is no private-work bypass or authentication change. Planner stays in the signed-in organization, on Strategies. Existing approved integrations are unchanged; no Workspace documents or new Capiro integration is added.

## Verification

335 distinct Strategies checks across 32 suites and 122 web checks across 19 suites pass. The full regression run passed 334/121 checks; after adding the owner-selected organization export boundary, focused runs passed all 66 API and 31 web checks, including the two added cases. Shared, Strategies and web production builds pass.

Ten restricted-role PostgreSQL cases cover inclusive multiweek ranges, latest immutable corrections/removals, entries moved across range bounds, 121-entry paging, foreign/stale cursors, current reviewer assignments, admin isolation, hidden-source exclusion, revoked grants, historical allocation after task movement, task name/status changes, departed submitters, general project work, scoped logger selection, cross-tenant denial and invalid/duplicate query fields. Web checks cover all four export scopes, complete paging, final revision verification, count/duplicate/cursor rejection, formula-safe CSV, native date inputs, transport failures, cancellation, organization switches and unmount.

Local browser verification downloaded an actual month-range CSV with a synthetic 45-minute billable entry; its work date, attribution, status and exact IDs were inspected. The browser download-event API timed out for the blob download, but the expected CSV was present in the local Downloads directory and its contents verified. This was synthetic data only.

Read-only production preflight verifies all 27 migration-file checksums, eleven finished Planner migrations, ten forced-RLS tables, restricted runtime rights and five immutable triggers. Baseline live proof verifies the three historical October entries totaling 85 minutes, private preferences at version 4 with restored defaults, empty organization time configuration, zero Planner unread notifications/reminder receipts and unchanged owner event/revision/preferences state. No live records or policy were changed to prepare the release.

## Deployment and live verification

Both ARM64 CodeBuild jobs succeeded from the exact tested source:

- Strategies: `capiro-build-web-dev:2c4aac27-9e65-43a5-82ea-38c42783dc5b`
- Web: `capiro-build-web-dev:57cb6da7-f9db-41a2-aefb-9094f551c7e1`

Verified immutable images:

- Strategies **47**: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:e3698f62c0a8e8b372a09db42598fc33aade7a3d80bf4f026e61e95df125ab4f`
- Web-vNext **460**: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:0dd3e73a9f6fab7b4491a24e8ef1f0186498fe1b578939901ba9c74c6267b8f5`

Both services are sole PRIMARY/COMPLETED deployments with desired/running counts of one and zero pending tasks. Serving tasks `440c26641bb24a79b71e38707381ff2d` and `4e413cde4a6f47c29ed212e3a9611765` are RUNNING/HEALTHY with the expected digests. Public Strategies health and the public web source identity pass. Task candidates preserve every baseline field except their immutable images and release identifiers. No migration runner, canonical API, Compute, routing, authentication, role or CDK change was made.

Serving restricted-role proof again verifies all 27 migration checksums, eleven Planner migrations, ten forced-RLS tables and five immutable triggers. Live service proof verifies complete personal export, final revision checks, empty assigned-review scope, non-admin organization denial, an authorized organization response, readable archived-project history and unknown-user/cross-tenant denial. The organization-role service proof uses an explicit context; it is not a claim of an authenticated admin browser session. Hidden-source filtering is explicitly qualified by the restricted-role PostgreSQL cases.

Authenticated browser verification downloaded actual October CSVs from personal time, reviewer time and an existing archived project. The personal CSV matches all three baseline entry IDs, task/submitter IDs, latest minutes, work dates, time zones and billable flags, totaling 85 minutes. Reviewer and project scopes correctly have zero matching October entries and generate valid header-only CSVs. The signed-in member has no organization-admin export control; the admin control and data boundary are verified by synthetic browser and restricted-role PostgreSQL tests.

The final read-only proof matches the original owner event/revision/preferences/configuration hash after browser verification. Preferences remain version 4 with auto-add disabled and default review view; organization time settings remain empty; Planner unread notifications and reminder receipts remain zero. The main bell's original eight unrelated unread items remain. No new live QA records, policy changes or notification deliveries were needed, so there is no data recovery step. Capiro is left on the Planner landing page.

Rollback: restore Strategies **46** and web-vNext **459** using the captured baselines. The existing eleven-migration schema remains valid for both releases.

## Remaining parity work

Full parity remains open. The next confirmed gaps are project budgets/rates/costs, time-tracking timers and subtask time rollups, time fields in CSV import/export and capacity-plan allocations. These were checked against Asana's primary help articles and the current source. Dashboard report widgets are awaiting the owner's separate integration decision and are not added here.

## Reference

Asana's primary reference describes personal, reviewer and administrator exports with a date-range selector and task/hours/date/submitter/task/project/status/entry columns: https://help.asana.com/s/article/how-to-export-all-time-entry-data-from-asana-as-csv-via-api. Capiro's owner explicitly chose existing source permissions for admins.

Remaining-gap references: [project budgets and rates](https://help.asana.com/s/article/tracking-project-budgets-and-progress-with-timesheets-and-budgets-add-on?language=en_US), [time tracking, timers, rollups and CSV fields](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US).
