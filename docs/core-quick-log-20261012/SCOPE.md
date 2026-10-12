# Core activity command and Planner follow-up — source scope

2026-10-12. Authorized isolated source work; no migration execution, live writes,
provider messages, deployment or merge. Original candidates and branches remain
unchanged. This candidate deliberately stacks on reviewed Planner PR2395 at
`c5e41e320af4b4d841d4b3136777d712116916ed` (main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`). It does not absorb Cleanup,
sender, facility, objective, prospect, contacts or attachment candidates.

## Ownership and bounded contract

Core ClientActivityService remains the activity owner. PlannerService remains the
personal task owner. A Core command owns only durable intent, the receipt and
structured lineage between those resources. One browser POST commits activity
and command in one Core transaction, then attempts the existing idempotent Planner
command outside that transaction. This is a recoverable two-service operation,
not a distributed atomic transaction. GET is read-only. Explicit versioned resume
uses the same persisted remote key and exact payload; no background credentials.

Scope: existing recordable activity, optional existing ClientPerson, explicit
instant dates, and optional generic personal Planner follow-up with explicit
assignee and bounded date/time/zone. Core protects activity content and lineage.
The remote task has a fixed generic name, no body, client/person/meeting/project
association, URLs, collaborators or copied sensitive text. Planner reads do not
continuously enforce Core client walls; richer copied content is outside scope.
The Core receipt is historical evidence, not a current task access grant.

Unresolved product contracts remain explicit: commitment direction/owed-by party,
Directory contact versus ClientPerson identity, date-only commitment semantics,
objective/strategy-step relations, and rich task visibility after Core wall
revocation. No metadata shortcut or second task service is introduced. This
candidate closes durable logging and generic follow-up recovery, not the full
Figma commitment workflow. Objective persistence belongs to PR2362.

## Security and recovery invariants

- Current active Core actor, Clerk identity, minimum standard-user role, active
  client and ethical-wall grant checked on every operation and attempt. New
  command routes reject impersonation. Existing routes/auth middleware unchanged.
- Assignee must remain active in this tenant, retain client access, and retain
  the exact stored Core-to-Clerk mapping before dispatch. No authority inferred
  from a receipt. Revocation across services cannot be made atomic; remote
  content is deliberately generic. No compensation deletes an accepted task.
- Core key scope is tenant/Core actor/client/browser request UUID. The independent
  server-generated command UUID is Planner's key; exact immutable intent is hashed.
  Changed payload conflicts. Lost replies never cause new identities or activity
  recreation. A deleted activity leaves the command tombstone; legacy deletion
  stays allowed. A deleted/denied Planner receipt is not proof of no prior task.
- Every Planner bridge call forwards only the original bearer and expected tenant
  and Clerk actor constraints. These optional new controller preconditions must
  match authenticated Planner context before delegation; they never select it.
  Only a configured HTTPS service origin is accepted; no redirects or fallback.
- Attempts use a persisted lease/token and version fence. No remote I/O occurs in
  a DB transaction. Unknown outcomes stay resumable using the same Planner key.
  Current authorization is rechecked before recording/returning an outcome.
- Activity occurredAt/dueAt are explicit ISO instants with offset (omitted
  occurredAt resolved once by Core). Planner dueOn remains a date; any date requires
  explicit IANA timeZone; dueTime is optional. No UTC slicing or browser-zone guess.
  Existing Planner DST resolution applies. No commitment date-only conversion.

## Deliberate schema allocation

Reserve `20281012010000_client_activity_commands` for a new tenant-RLS command
table. Main's latest allocation is 20281008040000; PR2362 reserves 20281011010000.
The command has a composite tenant/client FK and private actor-scoped lookup.
Activity and actor IDs are immutable historical scalar references, deliberately
without deletion-blocking FKs. A command must not disappear when an activity is
deleted. Tenant/client deletion may cascade. No existing data backfill needed.
Migration source is reviewable only; it will NOT be run, including in a test DB.
Native concurrency/RLS qualification therefore remains a separate release gate.

## Qualification and intersections

Required synthetic coverage: duplicate/replayed/conflicting input, lost Core and
Planner responses, stale versions/leases, tenant/actor/client denial, changed
identity mapping, revoked assignee/client/person, deleted activity/task,
ambiguous or malformed remote receipts, scope mismatch on both Planner verbs,
and explicit date/time/zone behavior. Independent non-author review is required.
Compute exact changed-path intersections against preserved candidates at the
final source ref. Expected shared paths: Core schema/ClientsModule with objective
and prospect work; Planner controller with the explicit prerequisite. Reconcile
source later without altering any original candidate or Cleanup release gate.
