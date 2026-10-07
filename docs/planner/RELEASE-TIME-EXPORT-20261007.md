# Planner date-range time exports

Fourteenth release: qualification in progress. Current production baseline is Strategies 46 and web-vNext 459. No database migration is required.

## Behavior

Timesheets can export a chosen submitter's time over any valid inclusive date range. Time review can export all currently assigned active submitters. Projects can export time historically allocated to that project, including general project work and departed submitters. Organization admins can make one export across currently readable organization time; unrelated private work is excluded without revealing its existence or counts. Work dates and allocation come from the latest immutable entry snapshots; removed entries are excluded. Task names and Open/Completed status reflect the current task.

Exports include hours, minutes, work date, submitter, task/project/entry IDs, project name, billable flag, category, entry time zone, description and editor ID. CSV fields escape quotes, multiline text and spreadsheet formulas. They support more than 100 entries through complete paging.

Each page uses a repeatable database snapshot and current source permissions. The full visible result determines its revision. Entry corrections, removals, task names/status, reviewer assignment, active membership or revoked source access invalidate subsequent pages. The browser rechecks the revision immediately before downloading and produces no partial file after a failure, repeated cursor, duplicate row, count mismatch, cancellation, organization switch or unmount.

Owner decision: organization admins retain existing Planner project/task permissions when exporting. There is no private-work bypass or authentication change. Planner stays in the signed-in organization, on Strategies. Existing approved integrations are unchanged; no Workspace documents or new Capiro integration is added.

## Verification

335 distinct Strategies checks across 32 suites and 122 web checks across 19 suites pass. The full regression run passed 334/121 checks; after adding the owner-selected organization export boundary, focused runs passed all 66 API and 31 web checks, including the two added cases. Shared, Strategies and web production builds pass. Exact deployed image identities will be recorded before completion.

Ten restricted-role PostgreSQL cases cover inclusive multiweek ranges, latest immutable corrections/removals, entries moved across range bounds, 121-entry paging, foreign/stale cursors, current reviewer assignments, admin isolation, hidden-source exclusion, revoked grants, historical allocation after task movement, task name/status changes, departed submitters, general project work, scoped logger selection, cross-tenant denial and invalid/duplicate query fields. Web checks cover all four export scopes, complete paging, final revision verification, count/duplicate/cursor rejection, formula-safe CSV, native date inputs, transport failures, cancellation, organization switches and unmount.

Local browser verification downloaded an actual month-range CSV with a synthetic 45-minute billable entry; its work date, attribution, status and exact IDs were inspected. The browser download-event API timed out for the blob download, but the expected CSV was present in the local Downloads directory and its contents verified. This was synthetic data only.

Read-only production preflight verifies all 27 migration-file checksums, eleven finished Planner migrations, ten forced-RLS tables, restricted runtime rights and five immutable triggers. Baseline live proof verifies the three historical October entries totaling 85 minutes, private preferences at version 4 with restored defaults, empty organization time configuration, zero Planner unread notifications/reminder receipts and unchanged owner event/revision/preferences state. No live records or policy were changed to prepare the release.

## Reference

Asana's primary reference describes personal, reviewer and administrator exports with a date-range selector and task/hours/date/submitter/task/project/status/entry columns: https://help.asana.com/s/article/how-to-export-all-time-entry-data-from-asana-as-csv-via-api. Capiro's owner explicitly chose existing source permissions for admins.
