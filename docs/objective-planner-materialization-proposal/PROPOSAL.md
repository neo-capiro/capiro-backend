# Objective receipt → Planner materialization: command allocation proposal

Status: **proposal only; no application implementation allocated**. This
supersedes the preliminary on_hold/full-node-as-task ideas. Coordinator product
decisions govern; receiving owner has not approved a new public command yet.

Base `1bc48d8831b5dad8fbf70c6a24a0c22a944dbf0b`, tree
`74ba4e18fe79d9a41c3a9b9126d7ca73d810c2c9`. Separate worktree
`task-6/planner-materialization`, branch `feat/objective-planner-materialization`.
The accepted candidate and its native qualification packet remain unchanged.

## Existing mechanisms and activation readout

`PlannerService.scope(...,true)` serializes graph/config mutations through
`pg_advisory_xact_lock(hashtextextended('planner:'+tenantId,0))` inside a tenant
transaction, with its existing 15-second timeout. `saveProject`, `saveTask`,
`persistTask`, `event`, validators and exported ACL helpers own canonical rows,
membership/dependency validation, derived fields and internal audit. Existing
task-create commands store an actor-scoped private `sp_planner_resources` JSON
receipt atomically with the task. Resource `kind` is a string; generic resource
APIs admit only `RESOURCE_KINDS`, keeping internal receipts private.

There is no materialization endpoint, project-create command or Strategy/node
lineage field. Project/task DTOs reject extra fields. Chaining today's POSTs
cannot atomically bind a multi-output result to an authoritative saved receipt.
Therefore a **new narrow public command**, plus private JSON receipt kind, is
needed. No schema, migration, shared-package change or new model protocol is
proposed. This public allocation is returned for review before implementation.

Canonical project defaults (`packages/strategy-verifier/src/planner.ts:401`)
are private/list/on_track, empty members/sections/fields, null dates. There is
no draft or activation field. Use these defaults unchanged and identify the
generated plan in its description/receipt; **on_hold is not repurposed**.
Task defaults are todo, unassigned, no recurrence/collaborators, no meeting,
zero estimate and pending approval value (the existing default; subtype is not
changed to approval). `saveProject` creates only its row and internal event.
`runRules` selects project-scoped rules matching the task's memberships; fresh
projects have none. `persistTask` creates a recurrence successor only on an
existing task's completion transition, so fresh todo tasks do not trigger it.
Internal events create inbox entries only for passed recipients; there are none
for these unassigned tasks/private projects. Date scheduler candidates require
matching project rules or personal rules for the task's assignee. Both are absent
for new projects and unassigned tasks. No rule/resource/invitation, workflow,
outreach, external notification or provider call is created or activated.
Implementation tests must pin these conditions, rather than treating on_track
health as a scheduler barrier. User edits after creation retain normal Planner
semantics.

## Proposed receiving contract

`POST /strategy-api/planner/strategy-materializations`
and `GET /strategy-api/planner/strategy-materializations/:requestId`.
Both reuse TenantGuard, PlannerContextGuard (reject impersonation), optional
expected-tenant/actor narrowing headers and private/no-store responses. The new
methods additionally require StrategyPlannerGuard; existing unrelated Planner
routes keep their own rollout behavior.

POST accepts only:

```
{ requestId, generationJobId,
  expected: { strategyId, strategyVersionId, objectiveRevisionId },
  groups?: [{ key, name, nodeIds: [...] }] }
```

Record/request IDs are UUIDs; group keys are stable nonempty string tokens
(up to100 characters, default key `default`). The client does not supply actor/tenant, source text, task data,
activation, output IDs or a purported authoritative receipt. Server loads the
completed job owned by this actor in this tenant and verifies the accepted exact
Objective-generation receipt, named Strategy/version/revision, client binding,
complete observed context and persisted result identity. It reuses the canonical
Objective authority/revision check; stale Objective revision refuses new work.
Historical named Strategy version content is read exactly; current head content
is never silently substituted. Saved snapshot digest is persisted in lineage.

Omitting groups selects one editable default group named from the saved Strategy
title. This is a convenience, not a one-project restriction. Explicit groups
allow multiple new private projects and shared task membership across groups;
one source node has one new task per request, even when included in two groups.
Regrouping after creation uses ordinary version-checked Planner project/task
membership edits on these same task IDs; it does not run a new materialization
request or clone tasks. Same-request replay preserves those edits.
Every eligible work node must occur in at least one group, group keys must be
unique and groups must use eligible source IDs only. With zero eligible work,
create the named context-only default project, zero tasks and an explicit
`NO_ACTIONABLE_WORK` notice (`prepared_with_issues`); never fabricate a task.
Explicit `groups:[]` is invalid. An explicit group's empty node list is allowed
only when the entire source has zero eligible work. No new project
count or task cap is introduced. Existing per-field validation/body/transaction
limits fail visibly; no slicing/truncation. Intentional omissions are not added
to v1 without a further explicit contract decision. Context nodes do not require
task membership/group assignment and remain linked to every generated project.

The frontend's single explicit finish/generate action on a saved ready Objective
can automatically call this command after receiving the exact durable Strategy
result. It must show separate Strategy saved / plan preparation pending / plan
prepared or needs review states. Objective stays ready; no completed Objective
state is invented. Lost replies/reload retain the same operation UUID and use
GET/retry. No smart grouping editor is a prerequisite for the default path.

`CONTRACT.json` defines full strict request/success/error variants, UUID/date-time
formats, field bounds/nullability and fixed safe message allowlists.
WIRE-EXAMPLES.json contains complete bodies, not excerpts. Every success includes
materialization request ID; generation job/request IDs; Objective/client/revision;
Strategy/version and snapshot digest; immutable group→project/node→task creation
mapping, original group memberships, retained context dependency references,
supported/unsupported edges and exclusions. `createdVersion` and counts describe
the historical committed creation; `currentVersion`, availability and current
group keys describe the authorized current read. Group name is the immutable
requested name; current names/content are read through canonical Planner APIs.

Business failures use the schema's fixed400/404/409/422/503 codes/messages and
issue allowlist. Existing authentication/rollout guards retain their standard
401/403 handling. No raw DB/provider exceptions are public. A missing receipt
404 is current unavailability with outcome unconfirmed, not no-write proof.
409 request conflict identifies a recorded actor-owned request; source-stale409
has recordedAttempt=true only if its durable receipt was found, otherwise null.
422 graph/source validation records zero new writes by this attempt but does not
claim no earlier request committed.503 always instructs recovery with the same
UUID. Regrouping does not change immutable creation membership or request input.

## Node classification and dependency truth

Use the exact saved Strategy snapshot plus the current row's archive state,
protected by the parent Strategy lock used by canonical node writers. Saved
`kind=action` maps to normal task; `kind=milestone` maps to Planner milestone.
Saved risks, gates and decisions are context-only: the current schema provides
no independent actionable flag that justifies fabricating tasks for them.
Current archived nodes are excluded with `ARCHIVED_SOURCE_NODE` and source ID;
missing/unrecognized/malformed nodes are explicit validation issues, never
silently treated as archived. Context-only nodes retain source version/node IDs,
kind, title, note and dependency references through the private lineage receipt
and the authorized materialization GET projection. Project description states
that the generated plan links to this saved Strategy/context.

Map supported action/milestone→action/milestone dependency edges to the exact
created task IDs, including edges spanning groups. Preserve all source edges in
lineage. An edge involving a context-only/archived/missing target is explicitly
reported with source/target IDs and reason; it is never silently dropped or
turned into an invented task. Detect cycles across the entire saved graph,
including context-only and currently archived nodes, before excluding anything.
Any cycle returns `CYCLIC_DEPENDENCY` and zero writes; missing/malformed
references likewise block. No graph pruning is used to hide a cycle.

Recommended narrow distinction for review: context-only dependency edges may
produce a saved plan with `status=prepared_with_issues`, an explicit unsupported
edge list and no whole-plan-complete claim. Cyclic/missing/malformed references
produce 422 and zero writes. If coordinator instead requires every unsupported
context edge to block creation, change this single policy before allocation;
neither behavior has been implemented or assumed accepted.

## Transaction, replay and human edits

Exact field mapping: source title→task name, note or empty string→description;
source startsOn→date-only startOn, endsOn or startsOn→dueOn for an action.
A milestone has startOn=dueOn=source startsOn and subtype=milestone. A conflicting
milestone date range or actionable openEnded=true is invalid, not flattened.
Dates never shift time zone; time/timeZone remain canonical null defaults.
Project/task clientId is the authoritative source client, not the null default.
Project name is the group name/default saved Strategy title and its description
identifies generated provenance. All other defaults remain canonical. Saved
subject/owner/status/targetRef/provenance/creation fields remain exact saved-version
context/lineage; they do not become assignments, approval/completion, outreach
actions or new task fields. Existing text bounds reject excess before writes;
descriptions/context never truncate. Full receiving schema is in CONTRACT.json.

One short transaction: acquire canonical Planner tenant lock; lock the exact
completed generation job and source Strategy/version rows; check Objective and
current actor/client authority with the shared Core helper; validate the full
source/classification/grouping/graph; create fresh projects/tasks and internal
events using canonical validators/persistence; append private
`strategy_materialization_receipt` with original source, request fingerprint,
snapshot digest, project/group mapping, node/task mapping, edges, exclusions and
issues; commit together. No network/model call occurs under these locks.
Use a deterministic namespaced UUID receipt ID for tenant+actor+request, backed
by the existing PK, plus the tenant write lock; no new unique index is needed.
The kind stays excluded from generic resource routes. Do not embed lineage in
strict editable task/project JSON, where edits could erase or forge it.

Transaction-aware helper boundary: do not call public saveProject/saveTask from
inside this transaction; those open separate transactions and can make link hops.
Extract/reuse the existing project-create row/event block as a private in-Tx
helper. Use existing persistTask(tx,...) for derived fields/audit and validate the
entire task graph/memberships/people with canonical validators before it. New
private projects have no rule configuration; confirm runRules has no matches.
Any helper refactor must leave public CRUD paths covered by regression fixtures.

The same request UUID with different normalized input returns 409. A same-input
retry returns recorded output mapping after current authorization checks, never
reruns creation, overwrites fields, changes memberships/dependencies or recreates
deleted/archived records. A different explicit request may create another plan
from the same saved source; no global one-plan-per-Strategy constraint exists.
Any failure between project/task/event/receipt writes rolls back all outputs.
If a commit reply is lost, GET/same-request retry recovers the durable receipt;
an ambiguous DB error never asserts that no earlier write happened.

Receipt GET/POST replay return current authorized output IDs and current
versions, alongside immutable creation versions. Current human edits are
preserved. Ordinary regrouping among generated projects does not invalidate
lineage: immutable original group membership is reported separately from current
membership. Only a changed authoritative client link, deleted/archived record,
or lost current output authority makes that output unavailable. Outputs are
unavailable (`status=partial`); hidden Planner IDs are redacted. No automatic
repair/recreation occurs. Lost current source authority returns opaque404;
stale Objective source returns a typed409 without creating anything or falsely
asserting that a historical request never committed. This409 includes
recordedAttempt=true only after finding this actor's matching durable receipt;
otherwise null, never a false no-write assertion. Missing receipt GET is opaque
404 MATERIALIZATION_NOT_AVAILABLE with outcome=unconfirmed, not proof of rollback.
Frontend must not navigate
on partial/unavailable or merely locally cached output IDs. No new durable
Planner-project URL is invented; receiving uses its existing navigation owner.

## Requested file allocation after command review

Application files, **prospective only**:

- `apps/api-strategy/src/planner/planner.controller.ts`: new guarded POST/GET.
- `apps/api-strategy/src/planner/planner.service.ts`: thin transaction coordinator
  reusing private canonical persistence/ACL/event helpers; no public CRUD rewrite.
- New `apps/api-strategy/src/planner/strategy-materialization.ts`: exact parser,
  deterministic request/lineage helpers, node/group/edge projection.
- New `apps/api-strategy/src/planner/strategy-materialization.spec.ts`: actual
  service/persistence fixtures, fault injection, ACL and human-edit regressions.
- New `apps/api-strategy/src/planner/strategy-materialization.http.spec.ts`:
  route guards, scope mismatch, exact response/no-store and failure contracts.
- Existing `planner.spec.ts` only if required for a focused old-path regression.

No frontend, schema/migration/lock, shared package, Meri runtime, diagnostic,
native qualification candidate or live pipeline files are claimed. Current
owned edits are only this proposal, CONTRACT.json, WIRE-EXAMPLES.json and the
offline validate_examples.py schema/negative-fixture checker (24 checks pass).

## Required acceptance before calling implementation complete

Independent exact-diff review and bounded one-process fixtures/typecheck. Tests
must prove: exact job/version/revision chain; stale/wrong-tenant/actor/archive
refusal; default and multiple groups/multihoming without cloned tasks; typed
action/milestone vs risk/gate/decision context; every excluded node/unsupported
edge accounted for; supported cross-group edges; cycles/invalid refs; injected
failure after each output stage rolls back; lost commit reply then retry creates
no duplicates; same UUID/different input conflict; human edits and unavailable
outputs preserved on replay; no rules/assignments/recurrence/inbox/provider work;
private receipt inaccessible through generic resource APIs; generic Planner CRUD
unchanged. Real PostgreSQL concurrency/RLS/privileges and full Core qualification
remain separate unproven gates, including for the accepted source base.
