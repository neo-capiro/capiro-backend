# Planner organization time settings

Live eleventh release from `feat/planner-time-settings-20261007`, PR [#2188](https://github.com/neo-capiro/capirov2/pull/2188). Strategies/web source: `51aa834760e3a5d7185f4c34f4098f84eb909dea`.

## Behavior

Organization admins can enable time tracking and general-project entries, choose billable defaults, configure category labels, select full approval or submission without approval, and set past/future week limits in an organization time zone. These settings use the existing versioned Strategies resource and organization role. No migration, shared authentication change or additional Capiro integration is needed.

Strategies applies the policy to logging, corrections, removal and restoration. Both the original and destination dates must be editable; moving an old entry cannot evade a lock. Organization admins can correct locked past entries for their own or assigned work, while future limits apply to everyone. Neither an admin role nor reviewer assignment grants access to source work. Disabling tracking preserves historical reads and permits ordinary task edits while blocking new time, corrections and changed estimates.

Historical billable flags and retired category labels remain intact. They can be cleared or replaced with an allowed label. New billable flags and category changes follow the current policy. Older clients that save only reviewer assignments preserve existing time options. Missing legacy options retain unrestricted dates, free-text categories and the existing full approval workflow.

Simple submission works without a reviewer; submitters can recall it to edit. Existing full approvals retain reviewer recall after the organization switches workflow. Every settings change invalidates captured time-page and status revisions. Open editors preserve their drafts and expected versions during refetch.

Timesheet dialogs now use the existing centered, scrolling modal styles. The default week and new entry date use the organization calendar; native date controls display its limits. Task and project activity editors observe tracking/date/billable rules too. The server remains authoritative when a setting changes during editing.

## Qualification

293 Strategies checks across 27 suites and 96 web checks across 16 suites pass. Eight new real PostgreSQL cases run under `capiro_app` and forced row security: role/version checks, default and explicit metadata, historical preservation, disabled/general time, original/destination locks, restricted admin access, future boundaries, simple submission/recall and changed-policy revision rejection. Nineteen policy checks cover strict options and organization-calendar boundaries across UTC Monday and daylight-saving changes.

Web regressions cover captured settings versions, trailing newlines in category drafts, organization dates and bounds, billable defaults and retired labels, simple workflow notices and a policy change during an open activity correction. Shared, Strategies and web production builds pass. The final Timesheets regression rerun passes 13 checks after the dialog/calendar fix; the final web production build passes.

Local browser QA uses explicitly synthetic data with a synthetic admin variant. It verifies saving/reopening configured defaults/categories/limits, 30 billable task minutes with the selected category, and submission without a reviewer. Screenshots are retained in ignored `artifacts/planner/time-settings-local-*.png`. Real reviewer/admin authorization is established by database tests, not by the visual fixture.

## Release boundary

The captured live baselines are Strategies **43** and web-vNext **455**. Before promotion, actual application-role proof passes for nine finished Planner migrations, nine forced-RLS tables, restricted grants, four immutable triggers, time metadata and indexes. Only Strategies and web-vNext immutable images and serving release identifiers may change. Preserve secrets, roles, environments, networks and routing. There is no migration task or Compute/CDK/IAM/canonical API deployment.

Strategies **44** and web-vNext **456** are each the sole PRIMARY/COMPLETED deployment with one RUNNING/HEALTHY task and zero pending tasks. Exact immutable images:

- Strategies: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:64914fdc50040b02c19a4e8da7968a08e234ceb715244b8d92dd60cf1e2949e5`
- Web: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:f06d613d715e19263ec5ca3bd4843061f3570b493a2cde7a1c24be36a6d7e214`

Exact-source ARM64 CodeBuild runs `15ae3c04-1c4e-4f6f-a1d2-8c258155598b` (Strategies) and `806c4254-0cd4-4540-b84f-769290f98d55` (web) succeed. Candidate task definitions are compared with captured baselines, preserving every value except images and serving release identifiers. Public Strategies health and the exact public web release identity pass.

Post-release application-role proof verifies schema/isolation again, default organization options, bootstrap policy, non-admin rejection, cross-tenant/ungranted rejection and unchanged settings. Authenticated browser checks verify centered scrolling time dialogs, the unchanged non-billable/free-text defaults, 45 minutes of private general-project time, reload persistence and correction to 30 minutes with the original date/category/project retained. Scoped read-only proof independently verifies the immutable correction and authorized weekly total.

The test entry is recoverably removed through a second immutable revision, its private project is archived, and the test week returns zero. No QA Inbox rows were created; the bell preserves eight unrelated unread items. The organization settings hash is unchanged before/after all checks. Proofs: `PLANNER_TIME_SETTINGS_LIVE_PROOF_PASSED`, `PLANNER_TIME_SETTINGS_ACTIVE_ENTRY_PROOF_PASSED`, `PLANNER_TIME_SETTINGS_CLEANUP_ENTRY_PROOF_PASSED`. Metadata/logs and `time-settings-live-modal.png`, `time-settings-live-corrected.png`, `time-settings-live-cleanup.png` are retained in ignored `artifacts/planner/` files.

Live organization-admin settings changes are not claimed: the signed-in account is a member with no configured reviewer. Administrator/reviewer workflows are qualified through restricted-role database tests and synthetic browser controls. No colleague is assigned and production organization policy remains unchanged.

Rollback uses preserved Strategies **43** / web-vNext **455** definitions and immutable images recorded in the preceding timesheets release. Preserve all other settings and immutable history.

Further parity remains open: weekly prepopulation, submission reminders, reviewer filtering/saved views, budgets/rates/cost reporting and further rules/templates. Main Dashboard reporting widgets still await the owner's decision. This release does not claim exact full Asana parity.

Research: [Timesheets and Budgets](https://help.asana.com/s/article/timesheets-and-budgets-add-on), [logging and submission](https://help.asana.com/s/article/logging-and-submitting-timesheets?language=en_US), [reviewers and approvals](https://help.asana.com/s/article/managing-timesheet-reviewers-and-approvals?language=en_US).
