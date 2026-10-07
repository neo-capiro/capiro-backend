# Planner saved reporting

Live ninth release from `feat/planner-reporting-20261007`, PR [#2186](https://github.com/neo-capiro/capirov2/pull/2186). Source and immutable images: `93c53e16dec8fb0897f90a71699c3a4abff7feaa`.

## Behavior

Reporting now saves private or team dashboards with member roles, chart and formatted text widgets, ordering, duplication, archive/restore and deep links. Project dashboards inherit their project's permissions and remain restricted to its tasks. Charts support bar, donut, line and numeric displays; task/project/goal/portfolio counts, effort, average progress and numeric custom-field sums; source, person, status, type, priority, tag, date and custom-field filters. Date ranges are inclusive in the selected time zone. Multi-category charts identify overlapping groups, and shared task effort and portfolio project counts are deduplicated in totals. Negative metrics use bars when a donut cannot represent them.

Strategies computes the complete authorized aggregate before paginating drill-down rows by 100. Clicking a category opens its current readable work; CSV export loads every page. Dashboard versions and an opaque authorized-data revision prevent mixed pages and exports after work, criteria or access changes. Query errors hide retained cached results. Charts refresh every 30 seconds and can be refreshed manually.

Every query uses the signed-in tenant and current viewer's existing project, task and resource permissions. Sharing a dashboard does not grant its private sources. Saved inaccessible references and filter values are redacted from settings responses and retained during ordinary visible edits. Losing a field returns an unavailable metric rather than a false zero or an unfiltered result. Explicit restricted sources never expand into all work. Custom task values require a readable declaring project on the same task.

Time charts total time on matching tasks, using corrected/removed time entries. Task dates filter which tasks match; working-date timesheets, billable entries and approvals remain separate parity work. No additional Capiro tool integration, authentication change or database migration is included. Main Dashboard report widgets remain pending the owner's integration decision.

## Qualification

248 Strategies checks across 23 suites pass, including seven real PostgreSQL reporting workflows under the restricted `capiro_app` role and forced Planner row security. These cover 127-task aggregation/pagination, revision conflicts, corrected/deleted time, shared-project deduplication, source grant revocation, hidden criteria preservation, custom-field masking, project bounds, cross-tenant isolation, portfolio selection and directional goal progress. The AppModule dependency graph and tenant scope guard pass.

82 web checks across 15 suites pass. Reporting tests cover native date controls, restricted-source drafts, unavailable-field edits, captured versions, chart styles, grouping pagination, stale cached results, authorized deep links and complete CSV content. Export tests prove that a later access failure prevents creating a partial file. Shared, Strategies and web-vNext production builds pass.

Local browser QA with explicitly synthetic data verifies dashboard creation, saved settings, chart/text ordering, formatted notes, effort totals, selected project sources, inclusive date filters, donut rendering and category drill-down. Screenshot: `artifacts/planner/reporting-local-dashboard.png`. The in-app browser's download event did not expose a file; CSV file generation and all-page contents are verified in web tests, not claimed as a completed browser download.

## Release boundary

Strategies task definition **42** and web-vNext **453** are each the sole PRIMARY/COMPLETED deployment with one RUNNING/HEALTHY task and no pending tasks. Exact images:

- Strategies: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:312ef952f0a990a309f2579d05ccac37fc7846ec4a83a8102bae06769e71e5b1`
- Web: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:64b233f4242386827de0eb7870e612189e31689c1c247b16ca53879857b932dd`

Exact-source ARM64 CodeBuild runs `c6464adb-a968-4d2e-a072-e2e366319217` (Strategies) and `95dbb49a-2793-4db4-a255-551d166ed9aa` (web) succeeded. Public Strategies health and the web runtime release ID pass. The actual serving `capiro_app` role independently verifies all eight migration entries, nine forced-RLS tables, restricted grants and four immutable triggers (`reporting-schema-runtime-proof.log`). No migration was run for this release.

Authenticated live QA creates three private dashboards, one private project, two tasks, a goal and a portfolio. All seven chart aggregates pass independently under the restricted application role: one task in the inclusive single-day filter, 150 estimated minutes, 45 corrected project minutes, 80% goal progress, one distinct portfolio project, numeric custom-field sum 30, and two delivery-date buckets. Category drill-down opens the correct task; goal and portfolio rows open their exact details. Reload preserves filters and widgets. Duplication, recoverable archive/restore, formatted notes and project-bounded reporting pass. Screenshots: `reporting-live-dashboard.png`, `reporting-live-charts.png`, `reporting-live-cleanup.png`.

Read-only live proof rejects dashboard queries from another tenant and an ungranted viewer (`PLANNER_REPORTING_LIVE_PROOF_PASSED`). All three dashboards, the project, both tasks, the goal and portfolio are recoverably archived; scoped Inbox cleanup passes (`PLANNER_REPORTING_CLEANUP_PASSED`). The original eight unrelated unread items remain untouched. Proof logs and synthetic record identities are retained in ignored `artifacts/planner/` files.

Serving definitions differ from Strategies **41** / web-vNext **452** only in immutable image and release identifier values. Roles, secrets, environment, network and routing remain identical. No Compute/CDK/IAM, canonical API or migration task changed. Rollback uses these preserved serving definitions and images; never run a reverse migration. Full Asana work parity remains open.

Research: [Reporting dashboards](https://help.asana.com/s/article/reporting-with-dashboards?language=en_US), [universal reporting](https://help.asana.com/s/article/universal-reporting?language=en_US), [project dashboards](https://help.asana.com/s/article/project-dashboards?language=en-US), [timesheets reporting](https://help.asana.com/s/article/reporting-with-the-timesheets-and-budgets-add-on).
