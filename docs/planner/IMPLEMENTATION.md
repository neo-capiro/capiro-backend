# Planner

Owner request, October 6, 2026: reproduce Asana's work functionality as a **Planner** tab on `os.capiro.ai`. Planner is owned by **api-strategy**, at `/strategy-api/planner`. Use the existing Strategies service, Aurora cluster, Clerk membership resolution, and tenant-scoped Prisma client.

Approved integrations: Dashboard Work Queue; links to client records and Engagement meetings. Workspace document integration is explicitly excluded. Ask the owner before adding any other Capiro integration (including Meri or Strategy execution).

Owner decision: Planner uses the signed-in organization. An impersonation header is rejected by a Planner-specific guard; shared Strategies authentication is unchanged.

## Acceptance inventory

Asana source: https://asana.com/features and the connected Capiro HQ project (1214276435168870). Its configurable fields include Priority, Status, Functional Areas, Task Type; its sections include Inbox / Triage and functional departments. Reading this reference does not authorize migrating live Asana data.

The work is complete only after these workflows are implemented and verified against a deployed release. This inventory records requirements, not a claim of completed parity:

- Projects: create/edit, privacy, members and permissions, sections, custom fields, start/due dates, status updates, archive/restore, duplicate, templates.
- Tasks: create/edit, assignment, due/start dates, completion, descriptions, subtasks, dependencies, milestones, approvals, collaborators, tags, multi-project membership, ordering, recurring work, time estimates and entries, attachments.
- Views: My tasks, list, drag-and-drop board, calendar, timeline, Gantt, saved filters, sort/group/search, bulk actions, task detail deep links.
- Collaboration: comments, activity, notifications/inbox, permissions enforced on every read and mutation, refresh after another user's updates.
- Management: portfolios, goals, reporting, workload/capacity, forms, rules, templates, CSV import/export.
- Integrations: Dashboard task queue; authorized client/meeting links. No Workspace documents.
- Release: migration rehearsal, API/web tests and builds, narrow immutable Strategies API + web-vNext deployment, authenticated browser checks, rollback records.

## Storage and safety

`sp_planner_*` tables belong to api-strategy. Typed JSON stores extensible project and task properties. Core identities, scopes, versions and lookup indexes are relational. Project membership, task dependencies and parent changes serialize with a transaction-scoped tenant advisory lock. Writes require an expected version and return 409 after a competing update. Each read filters projects by their access policy; task access derives from authorized project membership or a personal-task owner/assignee/collaborator. Notifications are filtered again at read time so a revoked project grant cannot preserve access through an old inbox event.

Canonical client/meeting authorization remains with the canonical APIs. Forward only the requesting user's bearer when validating a link; never use a service credential to widen their access. The service does not import client/meeting contents into a Planner record.

## Status

The working core is live. The next candidate adds private My Tasks sections/order and paginated inbox/activity. The following limits still require parity work: scheduled due-date rules, due times and richer recurrence schedules, editing/removing comments and time entries, form custom-field questions and branching, relative template dates, goal hierarchies, and deeper reporting/timesheet dashboards. Do not claim exact full Asana parity from these releases.

My Tasks settings are an owner-only resource; they cannot be attached to a shared project. Personal moves/order change the private settings version and leave shared task/project data untouched. Placements accept only the owner's assigned tasks and are redacted after reassignment. Settings editing captures its opening version so a competing update cannot be overwritten silently. Inbox/activity pages use database cursors with deterministic timestamp/ID ordering, avoiding timestamp precision loss. A revoked inbox page still advances by scanned rows; the cursor exposes only the user's opaque notification ID. Legacy callers retain the original array response unless they request `paged=true`.

Implemented additions include project duplication, transactional task ordering, list grouping, saved views, bulk status/assignee/priority/section/archive changes, formatted descriptions/comments and authorized mention notifications, revocable anonymous intake links, immutable private task attachments, workload capacity, portfolios/goals, rules, templates preserving hierarchy and dependencies, and reviewed CSV import/export. Duplicate projects start private with fresh identities and exclude other projects' fields and record links.

Public forms use 256-bit capabilities stored only as SHA-256 hashes. The embedded tenant ID scopes all requests through `withTenant`; no anonymous route uses a system/RLS bypass. The response exposes only form questions and submission receipts. Publishing requires project edit access and an expected version; rotation/revocation closes old links. A shared database quota caps submissions at ten per form per minute.

QA: real PostgreSQL migration rehearsal and ACL/concurrency/graph/recurrence/forms/template/attachment-constraint tests; API routing and link-authorization tests; web/Strategies production builds; 47 focused web tests; infrastructure typecheck and three attachment/logo policy checks. The fresh broad Strategies regression run passed 99 suites (1,754 tests); four suites / 17 tests were skipped. Local browser QA verifies task editing, board moves, Gantt keyboard rescheduling, project duplication/order, forms, comments and management resources using explicitly synthetic data. The first live release passed signed-in project/task persistence, canonical client/meeting links, Dashboard deep links, comments/time entries, actual S3 upload/download/archive/restore, internal form intake, subtasks, board sections and Gantt dependency/keyboard changes. Exact images and rollout evidence are in [RELEASE-20261006.md](RELEASE-20261006.md).

The final focused API run passes 111 checks across nine suites, including real database tests and AppModule DI boot. The dependency selector searches across authorized Planner work, preserves selected references, and can load additional pages. Subtasks load separately from the current project/filter and open their own details. Browser verification saved a dependency and displayed its Gantt connection.

The Assets CDK diff contains the intended attachment policy and an unrelated auto-delete-provider runtime change (Node 22 to 24). Release only the policy using the existing stack template; preserve the rest of the live template.

The existing serve task references the application database credential; migration tasks reference the DDL credential. A fourth additive migration grants SELECT/INSERT/UPDATE on Planner mutable tables to `capiro_app`, and SELECT/INSERT on append-only activity. Production catalog verification exposed inherited ALL privileges from Aurora's legacy defaults; a fifth migration revokes those privileges on Planner tables only, regrants the intended rights, and forces row security on all six tables. Local rehearsal starts with the broad legacy grants and verifies the restricted result. Runtime-role and RLS validation must precede promotion.

Research references: [Asana features](https://asana.com/features), [approvals](https://help.asana.com/s/article/approvals), [My Tasks rules](https://help.asana.com/s/article/rules-in-my-tasks). Approval outcomes complete the task; reopening clears its outcome. No live Asana records are copied or modified.
