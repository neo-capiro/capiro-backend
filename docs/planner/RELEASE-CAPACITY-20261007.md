# Planner capacity planning

Nineteenth release, [PR #2208](https://github.com/neo-capiro/capirov2/pull/2208), from `feat/planner-capacity-planning-20261007`. Live on stable, healthy Strategies 52 / web-vNext 465, both built from `26164505977baad4735ee8edddfe59001f518a54`. The final evidence commit changes documentation only. Full Asana Work parity remains in progress.

## Behavior

Capacity plans select projects, live portfolios, people and native Planner teams. Allocations belong to their organization/project rather than a particular plan: adding the same project or person to another plan shows the same allocation. People and Projects timelines support day/week/month windows, hours/percentage/count displays, person/project/job-title search, filters, grouping and saved views.

Individual weekly capacity determines percentage effort. Total hours are distributed over Monday–Friday, preserving fractions across partial windows and daylight saving changes. Team-scoped placeholders have names, job titles and weekly capacity, and their allocations can be transferred to actual members. Summaries show hours, distinct staffed people/projects and person-months using the explicitly labelled 40-hour reference week.

Allocation editing covers dates, effort and staffing; bulk actions move, duplicate, reallocate, transfer, archive and restore up to 100 allocations atomically. Control/Command-click selects timeline bars; dragging selections shifts dates and transfers staffing or projects to the destination row. Date inputs provide precise resizing. The allocation list and CSV cover all dates matching the selected filters, independently of the visible timeline window.

Plans and Planner teams have Admin/Viewer sharing. Every read, export and write intersects the current source-project grants; organization admins receive no private-project bypass. A bulk edit requires plan administration and project editing on every original and destination project. Placeholder grants come from their current active Planner team. Inactive members are rejected. Hidden plan selectors survive authorized edits without being disclosed.

Dedicated Strategies capacity routes use the signed-in tenant and reject impersonation. Internal capacity records cannot be read or modified through generic resource routes. Reads use repeatable snapshots, qualified revision paging and final grant verification; cached schedules disappear on failed access checks. Mutations serialize with Planner project-grant changes and carry expected plan/allocation versions. Staffing creates no tasks, time entries, assignment notifications or inbox entries. No new Capiro integration or authentication change.

The existing forced-RLS resource store persists the model. There is no schema migration, IAM/network change or canonical API/Compute deployment.

## Validation

Local regression: 288 API/database checks in 26 suites, 182 web checks in 26 suites, and the tenant-scope guard. Restricted PostgreSQL cases cover shared plans, live portfolios, private source boundaries, unrelated organization admins, read-only project members, placeholders, transfer/duplication/recovery, atomic rollback, stale concurrent edits, 205-row pagination, grant revocation, cross-tenant identities and inactive membership. Shared contracts, Strategies and web production builds/typechecking passed before candidate preparation; the final candidate build also compiles its exact source.

Synthetic browser QA verified People/Projects timelines, keyboard editing of precise end dates and a placeholder transfer with unchanged dates/hours. The edited total-hours allocation redistributes its original 45 hours across the longer workday range. Screenshots and CLI proof output are retained in local `artifacts/planner/capacity-*` files.

Read-only live preflight confirmed 28 migration files, 12 applied Planner migrations, 11 forced-RLS Planner tables, six immutable tables, and a non-super/non-bypass `capiro_app` runtime. The unchanged-state baseline captured 15 projects, 34 tasks, 41 resources, 148 events, 26 event revisions and 10 inbox records; it includes all 14 pre-existing owner time events. The current week remains 85 minutes/version 2, preferences version 4, with no running timer or Planner unread notifications.

## Release and live verification

Both exact-source ARM64 CodeBuild jobs succeeded. Strategies build `capiro-build-web-dev:6b22ad2b-070a-45fc-b722-5e75f8044b24` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:1e783b5b4c012e7077846f3df8240b79157df5085f70eba8746e911d3adcdf43`. Web build `capiro-build-web-dev:b2d503be-b319-4f17-aa2a-2dec413ed883` produced `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:ed4648372e25940833c1e1655bc76c4e2874316f8c878da2844d3870f26eb983`. The pinned official Node/Nginx public ECR mirrors avoid Docker Hub throttling without a Dockerfile version change.

Strategies task `7e117bed2d1642ca9b9ef21b4b9c5198` and web task `4cc5743ca2fb4b30aad467771ab3d944` are running and healthy with those immutable digests. Both services have one completed primary deployment, one running task and no pending tasks. Public Strategies health reports `ok: true`; public web runtime configuration identifies the exact release source. Candidate task definitions preserve all baseline fields except immutable images and release identifiers. The serving task passes `PLANNER_CAPACITY_SCHEMA_PROOF_PASSED` with unchanged schema/RLS/history protections. No canonical API, Compute, routing, IAM, shared authentication or CDK deployment occurred.

The signed-in UI created one private project, a private native Planner team containing only the owner, a 30-hour-per-week placeholder and two private plans without additional invitations or record links. One plan selects the project and team; the other selects only the project. A December 21–25 allocation at 50% of the owner's 40-hour week produces 20 hours, and a placeholder allocation reserves ten total hours. Both plans expose the same two allocation identities and 30 total hours. `PLANNER_CAPACITY_PROOF_LIVE_PROOF_PASSED` independently verifies complete qualified snapshots, stable revisions, private selectors and workday totals under the actual restricted runtime role.

An authenticated page reload preserves the allocations and the saved December staffing view. People displays 50% for the owner and 33% for the 30-hour placeholder; Projects combines the allocations into 30 hours. Timeline horizontal scrolling stays within its panel at the normal viewport, with the person column fixed. The downloaded UTF-8/BOM CSV contains exactly those two identities, their project, people, job titles, dates, units, planned hours and individual weekly capacities. `PLANNER_CAPACITY_LIVE_EXPORT_PASSED` verifies the actual file. The in-app browser saved the file normally although its automation download event timed out; verification reads the resulting Downloads file, not an inferred response.

Transferring the placeholder allocation to the owner retains both original allocation IDs, dates and total hours. `PLANNER_CAPACITY_TRANSFER_LIVE_PROOF_PASSED` verifies 30 hours and one staffed person in both plans. The UI archives, restores and archives the two allocations, then recoverably archives both plans, the placeholder, team and project. `PLANNER_CAPACITY_CLEANUP_LIVE_PROOF_PASSED` verifies all new staffing records/project are archived and every original project, task, resource, event, revision and inbox record has the same captured hash. Staffing creates no tasks, task/time events or inbox notifications. The current week remains 85 minutes/version two; private preferences remain version four with automatic weekly selection off; the timer remains absent, Planner unread zero and the eight unrelated bell items unread.

Local evidence includes `capacity-live-people.png`, `capacity-live-timeline.png`, `capacity-live-projects.png`, `capacity-live-transfer.png`, `capacity-live-ready.png`, `capacity-live-export.csv`, and schema/baseline/scope/export/transfer/cleanup/public-health proof logs in `artifacts/planner`. Planner is left on Capacity plans ready for real staffing.

## Remaining parity

Capacity custom-profile/custom-project field filters, portfolio-specific grouped totals, direct pointer resize handles and richer allocation context menus still need implementation or qualification. Switching active/archived allocations currently resets the unsaved window/view; preserving that display state is also outstanding. Task-workload/capacity/actual comparison, selectable estimate sources and cost reporting remain separate outstanding work. See PARITY-AUDIT-20261007.md; this release does not close the full goal.

## Rollback

The frontend can return to `capiro-dev-web-vnext:464` while retaining the new Strategies task. Once capacity records exist, an API rollback must retain the generic-resource exclusion for `capacity_*`: the older generic resource reader does not know the placeholder-team boundary. Before any capacity records exist, Strategies 51 is also a valid baseline. Do not remove the forward access boundary when reverting unrelated code. No schema rollback is needed.
