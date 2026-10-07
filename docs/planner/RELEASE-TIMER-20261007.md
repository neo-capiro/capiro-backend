# Planner native timer

Seventeenth release, [PR #2199](https://github.com/neo-capiro/capirov2/pull/2199), from `feat/planner-native-timer-20261007`. Live on stable, healthy Strategies 50 / web-vNext 463, both built from `af4441059ac1d972c90ba61b20c245a754075fe1`. The final evidence commit changes documentation only.

## Behavior and access

Task details offer Start timer, captured project/category/billable details, Stop and log time and Discard timer. A small timer follows navigation within Planner, links to its task and survives reloads. There is one running session per signed-in person and organization. Its elapsed display uses server time plus a monotonic local clock. Server timestamps determine recorded time; a nonzero elapsed total rounds up once to whole minutes and is distributed across the captured zone's calendar days. Long days produce normal separately correctable entries of at most 1,440 minutes.

The timer uses `/strategy-api/planner/time/timer` and guarded start/stop/discard routes. Private sessions and receipts use the existing forced-RLS resource store, remain outside generic resource reads/mutations and require active signed-in membership. Current task/editor access, allocation, organization policy and every touched timesheet lock are checked before logging. Revoked source access hides the task and details while permitting the owner to discard the session. Organization admins gain no access to another person's timer or unrelated private work.

Stable start keys are namespaced to person/organization; stop/discard retries preserve their exact expected version and payload. Starting, stopping, recording entries, touching weeks, notifying existing recipients and saving the receipt serialize in a tenant transaction. A lost response cannot create a second timer or duplicate time; later corrections/removals remain authoritative after a receipt retry. Client clocks, logger identities and arbitrary minutes cannot be supplied. Stops across locked weeks roll back completely and leave the timer running.

This adds no schema migration, shared authentication change or new Capiro tool integration. Main-bell delivery uses the already approved task time activity path. A shared Capiro timer overlay remains pending the owner's integration decision; this release's controls remain inside Planner.

## Qualification

392 Strategies checks in 37 suites and 154 web checks in 22 suites pass. Ten restricted-role PostgreSQL cases cover persistence, defaults, ownership, actual logging, concurrent/idempotent retries, correction/removal followed by replay, namespaced keys across organizations, private receipts, revoked/demoted/inactive access, allocation changes, DST/calendar partitioning, policy changes, cross-week submission locks, malformed/forged input and final-write rollback. Five pure calendar checks and guarded HTTP checks also pass.

Thirteen timer browser-component checks cover start defaults, explicit allocations, stable retries after settings changes, lost-start reconciliation, duplicate stop suppression, exact stop retries, captured-zone preservation, discard, stale/private cache handling and captured initiating-organization invalidation. Local browser QA verifies reload/navigation persistence, exact task opening, eight logged minutes and a second discarded timer that adds no time. The synthetic time entry was removed through the correction flow. Evidence: `artifacts/planner/timer-local-running.png` and `timer-local-logged.png`.

Shared, Strategies and web production builds pass. Read-only preflight and serving-role proof pass as `PLANNER_TIMER_SCHEMA_PROOF_PASSED`: 28 migration files and their recorded checksums, twelve Planner migrations, eleven forced-RLS tables and six immutable-history protections, under the actual non-super/non-bypass `capiro_app` role. No migration was needed.

## Deployed identities

Both exact-source ARM64 CodeBuild jobs succeeded. Strategies build `capiro-build-web-dev:95c41117-12da-4d3a-beb6-dd86ff351595` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:b8bc692f6c4fcefdc20607035f38612bc0a7d2612d2b4a96fa4e2e0ad950de2d`. Web build `capiro-build-web-dev:d0752cac-134b-4604-ae37-ee02ffe9af9e` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:69723e67e6ed113687a5f16d76a2ff27e7335a69af7423d63dfa882e307ce86a`.

Strategies task `8735950a643c47dfa055fd8136e74b47` and web task `908ae0999edb4b43903a58583253c70e` are running and healthy with matching immutable digests. Each service has one completed primary deployment, one desired/running task and no pending tasks. Public Strategies health returns `ok: true`; public runtime configuration identifies the exact web source. The actual serving-role schema proof independently passes.

Candidate definitions preserve every baseline field except immutable image and release identifiers. No canonical API, Compute, routing, IAM, shared authentication or CDK changes were deployed. Rollback restores Strategies 49 / web-vNext 462; no schema rollback is needed.

## Authenticated live verification and cleanup

The signed-in UI created a private, self-assigned synthetic task with no additional members or record links. Its timer captured UTC, its own project allocation and the non-billable default. Reload and Planner navigation preserved the running session; the floating task button opened the exact task. `PLANNER_TIMER_RUNNING_LIVE_PROOF_PASSED` verifies one private running version-1 session with no time events or weekly changes.

Stopping after 52,058 milliseconds recorded exactly one minute, October 7, under the signed-in actor and recorded-by identity. The normal event retains the timer's server start/end timestamps and receipt ID. Reload preserved the actual time. A second session was discarded and added no time. `PLANNER_TIMER_PROOF_LIVE_PROOF_PASSED` verifies the stopped and discarded version-2 private receipts, one normal time entry, no active timer, exact stop/discard replays without writes, changed-input stop rejection and receipt exclusion from generic resource views.

The synthetic entry was removed through the recoverable correction flow, then the task and private project were archived through normal UI recovery flows. `PLANNER_TIMER_CLEANUP_LIVE_PROOF_PASSED` verifies both archives, the latest removed revision, zero task actual time and retained private timer receipts. The current week returns to its original 85 minutes with the original status, reviewer, daily totals and entry count; its version advances from zero to two through logging and removal. Hashes of all ten pre-existing owner time events and their revisions, preferences and organization time settings are unchanged. Private preferences remain version 4, settings remain empty, Planner unread remains zero and the eight unrelated main-bell items remain unread.

Evidence: `artifacts/planner/timer-live-before.png`, `timer-live-running.png`, `timer-live-logged.png`, `timer-live-ready.png` and the schema/running/stop/cleanup proof logs. Planner is left on the clean My tasks view.

## Remaining parity

Full Asana parity remains open: parent/subtask time rollups, shared capacity plans/allocations/placeholders, capacity-derived estimates, workload cost comparisons, saved cost charts, CSV hierarchy/dependency mappings and further rules/templates require implementation and audit.

Primary reference: [Asana time tracking](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US).
