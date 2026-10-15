# Concrete implementation allocation candidate

This plan follows docs `470274e1` plus the O1–O4 receiving corrections. It allocates no
application writer or migration by itself. Existing Objective lifecycle, readiness,
permissions and manual/multiple-project behavior remain the approved baseline. Meri
runtime, publisher, admission and custody are excluded. The Core applied-link/composite
producer is a separate gate; an operational read is not its implementation.

## 1. Core association persistence and API

Domain owner: `apps/api/src/clients/objectives`, using existing
`ClientObjectivesService.requireDestinationRevisionWithinTx` and the exported
`ClientObjectivesModule`. Proposed additions:

- `operational/objective-operational.module.ts`, `.controller.ts`, `.dto.ts`, `.service.ts`:
  the exact operational GET, link/unlink POST and request-receipt GET already proposed.
- `operational/objective-operational-persistence.ts` and `.spec.ts`: transaction/CAS,
  canonical request digest and immutable receipt rules, without resource discovery.
- `operational/objective-operational-readers.ts`: typed dispatch to domain readers.
- `apps/api/src/app.module.ts`: import this separate assembly module. Do not make the
  base Objectives module import Outreach V3: `OutreachV3StateModule` already imports
  `ClientObjectivesModule`, so that direction would create a dependency cycle.

Propose three additive Core records in `apps/api/prisma/schema.prisma` and one **new centrally
allocated migration**. No migration number is reserved or SQL executed here:

| Record | Exact responsibility |
| --- | --- |
| `ClientObjectiveOperationalState` | One scoped tenant/client/Objective row, association-set version (0 initially), timestamps. Version is independent of Objective content and generated binding versions. |
| `ClientObjectiveResourceLink` | Stable UUID, composite Objective and original revision FKs, resource kind/UUID, immutable validated cycle annotations, original actor/time, removal actor/time/request. Active `(tenant,client,Objective,kind,resource)` unique index; removal is a tombstone. No standalone leg entity: the existing Strategy is the leg. |
| `ClientObjectiveOperationalReceipt` | Insert-only actor/request scoped request digest, exact normalized command, original association identity, command revision, original linked revision, result set version/outcome/time. Unique `(tenant,client,Objective,actor,requestId)`; SELECT/INSERT only for runtime receipt use. |

Reuse scoped FK/RLS patterns from `20281011010000_client_objectives/migration.sql`, explicit
tenant predicates and current runtime role conventions. Qualify real grants; do not add a
security-definer bypass or assume the runtime role's current source-table grants. Linking
does not call Objective `writeVersion`, change `ready`, activate a plan, share a private
resource, create a task or overwrite human fields. Changed cycle annotations require
explicit unlink/relink; exact same selection/annotations is a durable no-op.

Transaction design must preserve both replay and existing resource lock order:

1. In a short scoped lookup, revalidate **current** actor/member/client/wall/Objective
   authority using its actual current revision, then look for this exact actor/request.
   Matching digest returns the original immutable receipt before applying present CAS;
   differing payload conflicts. An old expected version is not grounds to reapply a saved
   command. This lookup is an optimization, not a write-authority witness.
2. For a new command, enter a fresh bounded write transaction. Acquire the resource owner's
   existing mutation/ACL gate first, then current Core authority, association-state row and
   request serialization. Re-read the exact receipt after serialization to close duplicate
   races. Only an absent receipt proceeds to submitted Objective/set-version CAS.
3. Validate actual source existence, same-client eligibility and current permissions under
   those owner gates; append/tombstone one link, increment set version once if changed, and
   insert its receipt in the same transaction. Any row-count mismatch or receipt failure
   rolls everything back. Unchanged commands retain set version and still get a receipt.

Planner already orders tenant advisory gate before source/Core authority. A Core writer
must not hold Objective locks and then acquire Planner's gate in the reverse order. The
runtime implementation must document the exact lock table/order and prove it with races.
Use owner-controlled transaction-taking validators for shared-DB final checks: allocate
`packages/shared/src/objective-resource-authority.ts` (internal typed SQL port) and its
domain-specific implementations with the Strategy/Planner owners. This is a **new allocation
request**, not permission to import a second Prisma client or duplicate an owner's ACL SQL.
Any transient user-authenticated owner HTTP precheck happens before the final transaction;
it never substitutes for the final local source/ACL witness. No network/model call runs
under the write locks. Failure to establish the owner gate is 503, not a guessed link.

The existing activity-command advisory request-key pattern (`clients/activity-commands/
activity-command.service.ts:207–230`) and Objective full-WHERE CAS/revision patterns are
reusable. Existing canonical reservation/fence helpers are not resource authority. A new
human association command has no generation authority or workflow effect.

## 2. Domain readers and transaction validators

All readers take explicit verified resource IDs and current caller scope. A candidate
client search is not membership. Domain modules export narrow read facades; the assembly
module does not query another owner's tables directly or import its raw repository.

| Domain owner / existing source | Concrete addition and reuse |
| --- | --- |
| Strategy: `apps/api-strategy/src/strategy/{strategy.service.ts,detail.ts,live-node.ts}` | New `objective-operational-reader.service.ts` and read-only batch controller/DTO, registered in `strategy.module.ts`. Reuse current-client authority repair, exact Strategy/client identity, live-node/artifact predicates and current detail/summary helpers. No tenant-only library scan as authorization. |
| Planner: `apps/api-strategy/src/planner/planner.service.ts` | Add owner read facade over explicit project/task IDs using `plannerProjectAccess`, `plannerTaskAccess`, `projectView`, `taskView` and existing tenant gate. Export safe facade through `planner.module.ts`. List and counts use the same ACL/membership union; task IDs deduplicate shared memberships. Current status/completedAt/memberships are authoritative, not creation counts. Overdue delegates to `plannerTaskOverdue` / canonical scheduling helpers in `packages/strategy-verifier/src/planner-schedule.ts`. |
| Application receipt lookup: same Planner/Strategy owner | Extract/reuse the read-only source verification shown in `PlannerService.materializationSource` into `objective-application-receipt-reader.service.ts`; preserve the actual job/receipt/version chain and actor restriction. Existing `strategyMaterialization` remains the request-receipt lookup. Add no scan, Meri protocol or publisher behavior. |
| Meetings: `apps/api/src/engagement/engagement-access.helpers.ts` | New `meeting-objective-reader.service.ts` plus narrow reader module. Reuse tenant scope, `ownMeetingWhere` and `clientAssociatedMeetingWhere`; keep metadata separate from encrypted artifact/body access (`canReadEncryptedEntry`). The Engagement domain must supply its actual cancellation/visibility/time predicate through this facade and focused tests. Do not edit/read protected `EngagementService` implementation or infer statuses from labels. |
| Outreach V3: existing `services/outreach-session.service.ts`, `persistence/outreach-state.repository.ts`, command-proposal service | New session/proposal summary facade exported by the existing state module. Reuse actor ownership, active/archive state, current parsed spec and exact sole client sponsor; proposals retain session/proposal/state-version identity. Reject checks owned/pending; apply additionally enforces current state/nonarchive. A raw pending count proves neither apply authority nor current applicability. No Classic Outreach expansion or sending is required for this page. |
| Budget context: `budget-packages/budget-packages.service.ts` and `defense-budget-lifecycle/defense-budget-lifecycle-read.service.ts` | Exact package/cycle lookup facades using their existing real service/guard. Preserve global identity separation and internal-only lifecycle guard. User annotation is not an official budget fact. |
| Core composition: new operational assembly module | New `objective-strategy-reader.client.ts` forwards only transient current user authorization to the fixed read-only Strategy owner endpoints; no stored bearer/service-secret impersonation. Resolve all sections independently, generate integrity-protected contextual cursors, enforce null partial totals, canonical digest and fixed safe errors. |

Keep current exact Strategy client permission repair as a reconciled source prerequisite.
No new greenfield service identity is proposed: this is a current-user read path. Register
only fixed read routes after shared-contract review. Owner metadata is as-of its observedAt;
one asOf cutoff does not claim a cross-service atomic snapshot.

## 3. Current versus frozen Strategy receiving

Frontend owner: current PR53 module
`apps/web/src/features/modules/objective-destinations/{ObjectiveDestinationRoute,
ObjectiveGeneratedStrategy,ObjectiveWorkViews}.tsx` and
`shared/capiro/operations/{objective-generation,strategy-materialization}.ts`.

Routine receiving allocation is to add the operational read/association schemas and fixed
registry entries, then the full Objective operational composition, without changing these
existing strict receipts. `open_generated_strategy` supplies the real generatedJobId and
exact source/version chain; the current receiver re-fetches/revalidates both owner reads
and labels content current. Missing mapping or an old source suppresses that action. It
does not suppress a separately authorized ordinary current-resource action.

For actual **saved snapshot content**, propose a separately reviewed read contract at
`GET strategies/:id/versions/:versionId/objective-snapshot`, implemented by a new
`strategy/objective-saved-version-reader.service.ts` using existing `sp_version.snapshot`
and exact digest plus fresh client/Strategy/current Objective authority. It must return
separate current binding and historical source-pin proof, not restore a version. Existing
`VersionService.list` is metadata and `loadStrategyDetail` is current content.
Frontend prospective files are `ObjectiveSavedStrategy.tsx` and a fixed
`objective-strategy-snapshot.ts` operation/strict schema, allocated jointly to its existing
owner after the normalized snapshot response is reviewed. Do not relabel current content
as frozen, weaken `requireGeneratedStrategy`, or expose an enabled saved-content link
before that reader and receiver exist. This is read-only engineering, not a new lifecycle
or Meri runtime contract. The current successor schema intentionally has no saved-view
action yet.

## 4. Intelligence question ownership and real policy boundary

The concrete domain owner should be `apps/api/src/intelligence`, not Outreach turn JSON,
hearing extracts, client notes, action recommendations or Meri. Proposed module:
`intelligence/questions/objective-questions.module.ts`, `.controller.ts`, `.service.ts`,
`.rules.ts`, `.dto.ts`, tests and a read-only facade. Register the isolated unit with
`IntelligenceModule`; import `ClientObjectivesModule` for current scope authority without
making the base Objectives module import Intelligence. The operational assembly imports
the narrow question module/facade, not all Intelligence providers.

Propose `IntelligenceObjectiveQuestion` and insert-only question revisions in a newly
allocated Core migration: scoped tenant/client/Objective, stable question ID, immutable
creation-basis Objective revision/version, text, optional owner Core UUID, request/hash,
independent optimistic version, state and resolution actor/time/evidence. Follow Objective
idempotency/CAS/history and scoped FK/RLS patterns. Current Objective and immutable question
basis remain distinct; owner assignment grants no access. The same authorized predicate
drives list and open count across pages. These are concrete engineering tasks once the
new question meaning is approved; there is no existing question lifecycle to reuse.

Recommended minimum policy for explicit review: human-created questions; `open → answered
| dismissed`, explicit reopen; answer requires answer text, dismissal a reason; edits to a
closed prompt reopen it with prior resolution preserved. Existing Objective write roles
may maintain questions; assignment is organizational, not an ACL. Questions never become
a readiness requirement and never auto-dispatch research or close from model text.
This recommendation is **not an approved enum or permission policy**. The genuine product
decision is whether this is the intended work-item meaning, who may resolve it and what
counts as resolution. Owner-only editing, cross-Objective sharing, automatic evidence
closure and readiness gating are additional choices, not implementation defaults.

Until that decision and its dedicated contract land, questions stay explicitly unavailable
with a null count. The current schema cannot render available question rows, so full-page
completion requires an agreed successor question variant/operations, not an empty KPI.

## 5. Routine engineering versus new policy

Proceed under existing approved semantics with association persistence, exact same-client
validators, current permissions, immutable provenance, requested/applied separation,
idempotent replay, source lookup, independent versions, shared task union/counts, canonical
overdue, pagination, readonly current/saved views and honest partial receiving. None needs
a new Objective status, global project cap, task cap, generic approval workflow, automatic
activation, new mandatory context or leg taxonomy. Existing Strategy ID is the leg.

Existing Strategy health diagnostics can be exposed with their own labels: `No steps`,
`On track`, `Needs attention`, `At risk` from `packages/strategy-verifier/src/plan-health.ts`.
Fiscal-cycle/window checks are review warnings and do not prove Figma `Achievable`,
`Compressed`, `Next cycle` or `Waiting for their window`. Current-plan export explicitly
leaves execution readiness unevaluated. Reusing exact diagnostics is engineering; inventing
those feasibility/window classifications needs a defined rule and unknown behavior when
inputs are missing. They need not block the association/read work.

## 6. Bounded implementation and acceptance order

1. Allocate Core records/migration plus association command/receipt tests. Prove duplicate
   UUID/different-payload races, present-authority historical replay, stale new-command CAS,
   no-op version stability and link/receipt rollback. No live migration execution.
2. Allocate owner-local validators/readers and least required privileges. Prove current
   grants, client/resource move/delete/archive races and canonical lock order. Add denied
   source redaction, untitled sessions, exact generated job mapping, human edits/shared
   task counts and O1–O4 regressions. No cross-actor receipt discovery.
3. Allocate Core assembly and frontend operational read/link receiving against jointly
   reviewed fixed contracts. Prove all-page counts/cursors and clear partial states.
4. Allocate the separate immutable snapshot reader/receiver. Keep current views honest.
   Resolve question policy and its new contract in parallel; then implement Intelligence
   questions. No model/provider action is part of this read or manual question command.
5. Run isolated native PostgreSQL runtime-role/FK/RLS/concurrency/rollback tests, then real
   receiving bridges under a separately reviewed bounded fixture package. Offline schema
   checks are not that proof. Existing applied-link/composite/publisher gates remain
   separately allocated; no Core APPLIED state can be inferred from this read.

Rollback disables new routes/read assembly and retains additive link/history/receipt data.
It never rewinds Objective versions, deletes manual/shared outputs, erases successful
receipts or changes canonical reserved associations. This document grants no paid run,
deployment, app implementation or migration execution.
