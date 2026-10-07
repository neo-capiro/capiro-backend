# Planner native timer

Seventeenth release, currently locally qualified on `feat/planner-native-timer-20261007`. Deployment and authenticated live verification remain required before claiming release completion.

## Behavior and access

Task details offer Start timer, captured project/category/billable details, Stop and log time and Discard timer. A small timer follows navigation within Planner, links to its task and survives reloads. There is one running session per signed-in person and organization. Its elapsed display uses server time plus a monotonic local clock. Server timestamps determine recorded time; a nonzero elapsed total rounds up once to whole minutes and is distributed across the captured zone's calendar days. Long days produce normal separately correctable entries of at most 1,440 minutes.

The timer uses `/strategy-api/planner/time/timer` and guarded start/stop/discard routes. Private sessions and receipts use the existing forced-RLS resource store, remain outside generic resource reads/mutations and require active signed-in membership. Current task/editor access, allocation, organization policy and every touched timesheet lock are checked before logging. Revoked source access hides the task and details while permitting the owner to discard the session. Organization admins gain no access to another person's timer or unrelated private work.

Stable start keys are namespaced to person/organization; stop/discard retries preserve their exact expected version and payload. Starting, stopping, recording entries, touching weeks, notifying existing recipients and saving the receipt serialize in a tenant transaction. A lost response cannot create a second timer or duplicate time; later corrections/removals remain authoritative after a receipt retry. Client clocks, logger identities and arbitrary minutes cannot be supplied. Stops across locked weeks roll back completely and leave the timer running.

This adds no schema migration, shared authentication change or new Capiro tool integration. Main-bell delivery uses the already approved task time activity path. A shared Capiro timer overlay remains pending the owner's integration decision; this release's controls remain inside Planner.

## Qualification

392 Strategies checks in 37 suites and 154 web checks in 22 suites pass. Ten restricted-role PostgreSQL cases cover persistence, defaults, ownership, actual logging, concurrent/idempotent retries, correction/removal followed by replay, namespaced keys across organizations, private receipts, revoked/demoted/inactive access, allocation changes, DST/calendar partitioning, policy changes, cross-week submission locks, malformed/forged input and final-write rollback. Five pure calendar checks and guarded HTTP checks also pass.

Thirteen timer browser-component checks cover start defaults, explicit allocations, stable retries after settings changes, lost-start reconciliation, duplicate stop suppression, exact stop retries, captured-zone preservation, discard, stale/private cache handling and captured initiating-organization invalidation. Local browser QA verifies reload/navigation persistence, exact task opening, eight logged minutes and a second discarded timer that adds no time. The synthetic time entry was removed through the correction flow. Evidence: `artifacts/planner/timer-local-running.png` and `timer-local-logged.png`.

Shared, Strategies and web production builds pass. Deployed evidence will be recorded after qualification.

## Remaining parity

Full Asana parity remains open: parent/subtask time rollups, shared capacity plans/allocations/placeholders, capacity-derived estimates, workload cost comparisons, saved cost charts, CSV hierarchy/dependency mappings and further rules/templates require implementation and audit.

Primary reference: [Asana time tracking](https://help.asana.com/s/article/time-tracking-in-asana?language=en_US).
