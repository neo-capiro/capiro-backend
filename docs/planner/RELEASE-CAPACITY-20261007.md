# Planner capacity planning

Release candidate, following subtask time rollups (Strategies 51 / web-vNext 464). Full Asana Work parity remains in progress.

## Behavior

Capacity plans select projects, live portfolios, people and native Planner teams. Allocations belong to their organization/project rather than a particular plan: adding the same project or person to another plan shows the same allocation. People and Projects timelines support day/week/month windows, hours/percentage/count displays, person/project/job-title search, filters, grouping and saved views.

Individual weekly capacity determines percentage effort. Total hours are distributed over Monday–Friday, preserving fractions across partial windows and daylight saving changes. Team-scoped placeholders have names, job titles and weekly capacity, and their allocations can be transferred to actual members. Summaries show hours, distinct staffed people/projects and person-months using the explicitly labelled 40-hour reference week.

Allocation editing covers dates, effort and staffing; bulk actions move, duplicate, reallocate, transfer, archive and restore up to 100 allocations atomically. Control/Command-click selects timeline bars; dragging selections shifts dates and transfers staffing or projects to the destination row. Date inputs provide precise resizing. The allocation list and CSV cover all dates matching the selected filters, independently of the visible timeline window.

Plans and Planner teams have Admin/Viewer sharing. Every read, export and write intersects the current source-project grants; organization admins receive no private-project bypass. A bulk edit requires plan administration and project editing on every original and destination project. Placeholder grants come from their current active Planner team. Inactive members are rejected. Hidden plan selectors survive authorized edits without being disclosed.

Dedicated Strategies capacity routes use the signed-in tenant and reject impersonation. Internal capacity records cannot be read or modified through generic resource routes. Reads use repeatable snapshots, qualified revision paging and final grant verification; cached schedules disappear on failed access checks. Mutations serialize with Planner project-grant changes and carry expected plan/allocation versions. Staffing creates no tasks, time entries, assignment notifications or inbox entries. No new Capiro integration or authentication change.

The existing forced-RLS resource store persists the model. There is no schema migration, IAM/network change or canonical API/Compute deployment.

## Validation

Local regression: 288 API/database checks in 26 suites, 182 web checks in 26 suites, and the tenant-scope guard. Restricted PostgreSQL cases cover shared plans, live portfolios, private source boundaries, unrelated organization admins, read-only project members, placeholders, transfer/duplication/recovery, atomic rollback, stale concurrent edits, 205-row pagination, grant revocation, cross-tenant identities and inactive membership. Shared contracts, Strategies and web production builds/typechecking passed before candidate preparation; the final candidate build also compiles its exact source.

Browser QA verified People/Projects timelines and a placeholder transfer with unchanged dates/hours on synthetic data. Screenshots and CLI proof output are retained in local `artifacts/planner/capacity-*` files. Production verification and cleanup will be recorded below after rollout.

Read-only live preflight confirmed 28 migration files, 12 applied Planner migrations, 11 forced-RLS Planner tables, six immutable tables, and a non-super/non-bypass `capiro_app` runtime. The unchanged-state baseline captured 15 projects, 34 tasks, 41 resources, 148 events, 26 event revisions and 10 inbox records; it includes all 14 pre-existing owner time events. The current week remains 85 minutes/version 2, preferences version 4, with no running timer or Planner unread notifications.

## Remaining parity

Capacity custom-profile/custom-project field filters, portfolio-specific grouped totals, direct pointer resize handles and richer allocation context menus still need implementation or qualification. Task-workload/capacity/actual comparison, selectable estimate sources and cost reporting remain separate outstanding work. See PARITY-AUDIT-20261007.md; this release does not close the full goal.

## Rollback

The frontend can return to `capiro-dev-web-vnext:464` while retaining the new Strategies task. Once capacity records exist, an API rollback must retain the generic-resource exclusion for `capacity_*`: the older generic resource reader does not know the placeholder-team boundary. Before any capacity records exist, Strategies 51 is also a valid baseline. Do not remove the forward access boundary when reverting unrelated code. No schema rollback is needed.
