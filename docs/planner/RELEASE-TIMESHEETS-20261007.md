# Planner weekly timesheets

Live tenth release from `feat/planner-timesheets-20261007`, PR [#2187](https://github.com/neo-capiro/capirov2/pull/2187). Strategies/migration source: `82378d099942e1d87866597480f6fed29adc3cea`. Web source: `416843dab73b69abe4c2618aa185baeef7dd6dcd`; its additional change preserves historical project attribution after a task moves.

## Behavior

Planner has a Timesheets view with weekly and daily totals, dated task or general-project time, billable classification, project attribution, categories, notes and complete paginated CSV export. Correcting, removing or restoring time appends an immutable revision and updates affected weeks. Legacy entries keep their original UTC calendar date and project. Task lifetime actual minutes continue to reflect corrections.

Organization administrators assign active reviewers. Submitters and assigned reviewers can edit draft or rejected work; submitted work is locked for the submitter, and approved work is locked for both. Organization administrators can correct their own or assigned work after approval, with a correction flag and the original approval snapshot preserved. Administrator status and reviewer assignment never grant access to source projects or tasks.

Submission, recall, approval, rejection and approval recall use captured versions and authorized-data revisions. Status activity is immutable and appears in Planner Inbox and the approved Capiro notification bell with the exact submitter/week link. Removed reviewers lose access to sheets and their old notifications. Inaccessible entries are excluded from visible totals, identified as unavailable, and prevent submission or approval.

Strategies calculates every authorized entry before returning 100-row pages. Later pages and exports reject changed data or access. The browser cancels exports on navigation and never creates a partial file after a failed page. The status panel currently shows the most recent 100 transitions; reviewer lists do not yet have filters, sorting or pagination.

No additional Capiro integration or shared authentication change is included. Planner remains in the signed-in organization. Workspace documents remain excluded, and main Dashboard report widgets still await the owner's decision.

## Qualification

266 Strategies checks across 25 suites and 91 web checks across 16 suites pass. Nine new real PostgreSQL cases run under the restricted application role and forced row security. They verify working dates, billable allocation, cross-week corrections, all approval transitions and locks, stale versions/revisions, reviewer logging on behalf, general-project time, private source restrictions, assignment revocation, 121-entry totals and paging, stable legacy metadata and administrator corrections after approval.

Web tests cover native date inputs, metadata drafts, captured status versions, complete 101-row CSV contents, formula escaping, export cancellation and access failures. Shared, Strategies and web-vNext production builds and web typechecks pass. A fresh nine-migration rehearsal preserves nine forced-RLS tables, restricted grants and four immutable triggers.

Local browser checks with synthetic data verify 90 billable minutes on the chosen date/project, correction to 75 non-billable minutes on another date, submission, recall and immutable status history. The fixture represents a standard submitter; reviewer and administrator state transitions are verified by real database tests. Screenshots are retained in ignored `artifacts/planner/timesheets-local-*.png` files.

## Release boundary and recovery

The additive ninth Planner migration adds immutable time-revision metadata and indexes for time actors, unique weekly sheets and organization reviewer settings. It changes no grant, role, authentication or row-security policy. Production ledger preflight verifies all 24 existing files/checksums with only `20261007010000_planner_time_details` pending. Dedicated migration task definition **13** completes with exit zero. Read-only proof under the actual serving `capiro_app` role passes before promotion and again on the new API: nine finished Planner migrations, nine forced-RLS tables, restricted grants, four immutable triggers, the JSONB column and all three new indexes.

Strategies **43** and web-vNext **455** are each the sole PRIMARY/COMPLETED deployment with one RUNNING/HEALTHY task and zero pending tasks. Exact immutable images:

- Strategies: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:ad1a0a6836f09cd0f999f1182c6bd69fc64fddae319d56b749e91593728343b2`
- Web: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:81ef73f71ec418fa906d5d28590c9e0e2620c7d25e810e4575aa8924cc20f0a0`

Exact-source ARM64 CodeBuild runs `d2c8dec9-abde-4d55-89a8-c33418c15e91` (Strategies) and `51bd9c7d-3aea-465c-895a-0997d867395c` (web) succeed. Public Strategies health and the exact public web runtime release identity pass. Serving and migration definitions are compared against their captured baselines, preserving every value except the immutable image and serving release identifiers. No Compute/CDK/IAM, canonical API or routing deployment is included.

Authenticated live QA verifies 90 billable task minutes on the selected date/project, correction to 75 non-billable minutes on another date, 30 billable general-project minutes and the resulting 105-minute weekly total. Moving the correction to the next week updates both weeks to 30 and 75 minutes. Task deep links, reload persistence, historical allocation after the task leaves its project, and recoverable removal/restoration all pass. Scoped read-only proof independently verifies totals, metadata, task actual time, cross-tenant/ungranted rejection and exclusion of internal sheets/settings from generic resources.

The signed-in live viewer has no configured reviewer and is not offered organization settings; live approval transitions are not claimed. Complete reviewer/administrator workflows are qualified through real restricted-role database tests. No colleague is assigned for QA. The organization reviewer-settings hash is identical before and after live checks. Browser CSV download is not claimed; complete file contents, paging and failures are verified in web tests.

Both new QA time entries are recoverably removed through immutable revisions, and their task and private project are archived. Both test weeks return zero; scoped Inbox cleanup passes and the original eight unrelated unread bell items remain. Earlier archived-work history is retained. Proofs: `PLANNER_TIMESHEETS_ACTIVE_PROOF_PASSED`, `PLANNER_TIMESHEETS_MOVED_PROOF_PASSED`, `PLANNER_TIMESHEETS_CLEANUP_PROOF_PASSED`. Metadata, proof logs and `timesheets-live-week.png`, `timesheets-live-recovery.png`, `timesheets-live-cleanup.png` are retained in ignored `artifacts/planner/` files.

Rollback baselines are Strategies **42** and web-vNext **453**, with their immutable images recorded in the prior reporting release. Only Strategies and web-vNext serving images/release identifiers, plus the dedicated migration image, may change. Preserve roles, secrets, environments, network and routing. Use the preserved serving definitions for rollback; never reverse the migration or discard time history.

Further parity remains open: prepopulation, configurable categories/defaults/date limits/reminders, simple submission workflow, reviewer filtering/saved views, budgets/rates/cost reporting and further rules/templates. This release does not claim exact full Asana parity.

Research: [Logging and submitting timesheets](https://help.asana.com/s/article/logging-and-submitting-timesheets?language=en_US), [reviewers and approvals](https://help.asana.com/s/article/managing-timesheet-reviewers-and-approvals?language=en_US), [Timesheets and Budgets](https://help.asana.com/s/article/timesheets-and-budgets-add-on).
