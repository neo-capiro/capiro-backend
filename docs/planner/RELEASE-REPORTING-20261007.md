# Planner saved reporting

Release candidate on `feat/planner-reporting-20261007`. Deployment and authenticated live verification remain pending.

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

Serving baseline: Strategies 41 and web-vNext 452, both stable at one healthy running task and no pending tasks. Candidates must preserve each live serving definition apart from its immutable image and release identifier values. No Compute/CDK/IAM, canonical API, routing or migration task change is required. Record exact source images, rollout evidence, private live QA and recoverable cleanup here after verification. Full Asana work parity remains open.

Research: [Reporting dashboards](https://help.asana.com/s/article/reporting-with-dashboards?language=en_US), [universal reporting](https://help.asana.com/s/article/universal-reporting?language=en_US), [project dashboards](https://help.asana.com/s/article/project-dashboards?language=en-US), [timesheets reporting](https://help.asana.com/s/article/reporting-with-the-timesheets-and-budgets-add-on).
