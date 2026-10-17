# Objective Planner runtime composition

This source successor builds on PR #49 at
`db6ef0a617f4b570cadfa6e05bad7296017d0f70` and the unchanged Objective PR #42
head `6d24414da975b52ab9802a883b22c868ad14fc92`. Both remote heads were checked
again during this increment. The earlier [implementation note](IMPLEMENTATION.md)
describes the PR #49 helper and government-context policy change.

## Durable continuation

The dedicated worker discovers the existing durable Strategy generation producer
rows. It reconstructs the accepted original Strategy/version and compiled
Objective, government and relationship context evidence through the existing
saved-generation owner. Browser state supplies no IDs, source snapshot, lease,
credential or authority. Ordinary chat and the legacy draft worker are unchanged.

The private operation store records fixed operation, attempt and run identities,
the exact work fingerprint, original actor/Clerk/membership, Planner consent and
deadline. Claims use a version-and-full-prior-value compare-and-swap. The first
lease token belongs only to the invocation that created it; another worker does
not adopt an active lease. Expired-lease recovery retains the original operation
and deadline under the concrete atomic application/accounting invariant.

The original deadline is the minimum of the Planner consent expiry, saved
generation effect deadline and accepted issuance expiry. Each new effect checks
the actual saved source again. A later consent cannot renew an expired generation
grant. Fresh retained-result reads have independent current native admission and
cannot authorize a write or extend a lease.

The runtime holds locks in Planner advisory gate, original generation job,
Strategy, exact saved version, then Core native/source/control order. Existing
Planner validation, materialization, paired receipt/head and observation code
runs inside that same tenant transaction. The final operation accounting write
commits with all application outputs. A database-clock release check runs after
accounting and rolls back the whole transaction if the original consent or lease
expired during the last write. A lost reply recovers the same retained operation
and immutable creation receipt rather than calling another model or writer.

Missing receipts alone never establish absence. Any exact application or
materialization receipt, or canonical project/task including archived outputs,
prevents a no-effect claim. Corrupt, incomplete, mismatched or uncertain owner
evidence remains uncertain.

## Opt-in and Core consent

Activation requires all of the following existing/local settings:

- Process `OBJECTIVE_PLANNER_CONTINUATION_ENABLED=true`.
- Tenant `settings_jsonb.objectivePlannerContinuation.enabled=true`.
- Existing tenant `settings_jsonb.clioFeatureFlags["strategyPlanner.enabled"]=true`.
- A genuine current Planner action consent and active original native membership,
  tenant, client access and memory-wall permission.

Core additionally requires `OBJECTIVE_PLANNER_CONSENT_DURATION_MS` between 1 and
1,800,000. Optional tenant `objectivePlannerContinuation.durationLimitMs` may only
reduce that duration. The existing human request proof independently limits each
new explicit consent. Fully verified failed/cancelled historical operations may
permit a new consent; their original operation records remain immutable. Queued,
leased, unknown, orphan or applied work cannot be used as retry permission.
Recording a new human consent does not guarantee dispatch: continuation retains
the generation's original actor/Clerk. Another teammate's consent requires its
own matching authorized generation/source and cannot adopt the old one.

The local authority is an in-process native owner. It creates no HTTP request,
user JWT, static internal secret, generation credential or public endpoint. The
external rejecting workload authority and disabled generation-delegation
migration remain unchanged.

## Bounded behavior and remaining qualification

This increment covers the first Planner preparation from a retained Strategy
result and its exact recovery. Changed-ready-binding regeneration remains safely
uncertain. The separate WorkService early status-read gate remains pending
coordinator allocation; until connected, all public Core Planner work-status
reads remain `outcome_unconfirmed`. Even with that hook, Core retains uncertainty for applied
operations: Core does not substitute a partial hash check for Planner's full
v2/v3 materialization/predecessor checker. This blocks retry; the concrete Planner
application owner still verifies and returns the original creation receipt and
current human-edited outputs to runtime recovery.

Source tests use real runtime, worker, store, application and Core command-kernel
source with explicitly synthetic SQL, transaction, custody and materializer
ports. They do not establish native PostgreSQL locks/RLS or deployed behavior.
The separately guarded native suite and complete synthetic fixture builder are
prepared in [NATIVE-QUALIFICATION.md](NATIVE-QUALIFICATION.md); no database,
migration, credential, AWS resource, deployment or browser acceptance run was
performed. No dependency installation or heavy archive was needed.

## Focused source verification

- Producer, application, continuation, saved-plan/runtime, native-target guard
  and Core owner Node source suites: **269/269 passed**.
- Strategy Jest store, actual AppModule mount/private visibility, complete
  fixture reconstruction and default-disabled startup: **41 passed, 12 native
  cases explicitly skipped**.
- Actual Core ObjectiveWorkModule registration with local dependency fakes:
  **3/3 passed**.
- Scoped strict TypeScript checks for runtime/authority/store/application and
  the actual Core owner import graph, plus `git diff --check`, passed. No full
  application build was run.

These checks reuse the installed dependency tree. Nest `.compile()` resolves
the actual module graph with a rejecting Prisma override and does not call
`.init()`, create a listener, connect a database or execute worker lifecycle IO.
