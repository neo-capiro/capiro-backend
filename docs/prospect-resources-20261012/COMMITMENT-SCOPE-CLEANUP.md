# Dropped Commitment UI — reference-based cleanup assessment

Neo removed this UI scope on 2026-10-12 at 04:41 UTC and requested no dead code
at 04:42 UTC. Firm/client direction, WeOwe/TheyOwe and new Commitment UI support
are excluded from this build, not pending product decisions.

The backend candidates never implemented those new party semantics. The current
prospect candidate adds no commitment types, routes, branches or tests. The only
new prospect ledger statement treating that decision as pending was removed.
No unused runtime scaffolding for the dropped feature was found to delete.

Reference trace against preserved PR2396
`e2c2c110edd986e799d47d43b0db50b24fab0201`:

- `ClientsModule` registers `ActivityCommandController`, `ActivityCommandService`
  and `ActivityCommandPlanner`. POST/GET/resume routes invoke the generic activity
  command; its service invokes `ClientActivityService.createInTransaction` and
  optional Planner follow-up dispatch/recovery. These are live generic contracts.
- `activity-command.input.ts` accepts the same existing recordable activity kinds
  and due-instant rule. The `commitment` enum member is compatibility with the
  existing Core activity API, not an owed-by-party implementation. Its date tests
  protect the existing instant/date-only boundary.
- Existing `client-activity.service.ts` on main already supports `commitment` and
  `request`, person association, dueAt, pinning and settling. Removing these
  would break a shared API solely because one new UI no longer uses it.
- Planner controller POST/GET `task-create-commands` remains called by the generic
  activity follow-up bridge. Its idempotency, actor/client scope and date/zone
  semantics are still required.

Searches inspected the PR2396 changed-path set and references to commitment,
WeOwe, TheyOwe, owed-by and party semantics in its input/service/controller,
Planner command and contract/scope docs. No firm/client party runtime type or
handler was present. Existing published qualification receipts and historical
scope documents are evidence, not runtime scaffolding; original candidate refs
remain untouched. This document supersedes their pending-UI wording for the
current build. Frontend removal is owned by the separate frontend task.
