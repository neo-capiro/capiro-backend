# Incremental implementation and acceptance plan

This sequence proposes review boundaries. Production file allocation, migration paths and public/internal contracts remain subject to coordinator reconciliation. It does not authorize all future increments at once.

## 1. Durable ready intent, dispatch disabled

In the same Core transaction that newly confirms the actual ready revision, append one purpose-scoped work intent keyed by tenant/client/Objective/revision/purpose. Keep revision and intent indivisible; do not insert after the transaction or ask the browser to enqueue it. Preserve existing no-op behavior: an already-ready record at the expected current version queues nothing, and stale versions conflict. Missing historical intents remain an explicit reconciliation gap; do not backfill or regenerate historical Objectives silently.

The first allocated Core change is intentionally inert: no network/model calls, raw bearer persistence or runtime dispatch. The coordinator subsequently allocated canonical Core Prisma changes and the exact `20281015010000_client_objective_work_intents/migration.sql` path to this slice. It adds no public response fields; the public composite contract remains separate.

The implementation records `objective_strategy_plan` as its sole purpose, `pending` as its sole state and `runtime_authority_unconnected` as its explicit blocker. A composite revision foreign key binds tenant/client/Objective/actual revision ID/version; helper validation binds the actual create-return snapshot/status/actor/hash. Tenant RLS does not substitute for the existing client-wall admission. Direct application grants allow SELECT/INSERT only; inherited Objective/revision deletion still cascades, preserving existing deletion semantics rather than claiming permanent audit retention. Conflict reconciliation uses a subsequent statement under READ COMMITTED; stronger isolation can abort and must not be reported as a confirmed intent. No scheduling, service credential or executable runtime grant exists in this record.

Acceptance must cover ready+revision+intent rollback, concurrent identical confirmation, independent Objectives/clients/tenants, stale version, inaccessible client, deleted Objective, and unchanged early-return/retry semantics. Verify one intent for the actual committed revision. Live migration execution is outside scope.

## 2. Close authority and typed workload contracts

Before automatic dispatch, repair ordinary Strategy current client-wall admission across list/detail/version/node/report/current-plan export. A tenant membership/feature flag is insufficient. Reuse the canonical current Core client-permission owner; return no editable link until that path is authorized. Keep source admission and output ACL redaction independent.

Reconcile the closed catalogue of exactly three runtime operations with the Meri contract owner and Fable. Operation names, envelopes, errors and routes are not published by this document. The minimum agreed design requires typed inputs/outputs, immutable Meri result plus backend-owned result hash/source keys, and whole-result graph validation before application writes. Meri supplies a result; backend authority/persistence owners decide whether it can be applied. No arbitrary workload or generic privileged tool delegation.

Core workload-authority design must specify issuer/service identity, audience, purpose, tenant/client/Objective/revision/intent/attempt binding, replay/expiry, current membership and wall rechecks, revocation, safe logs and failure semantics. Proposed audiences are `capiro:objective-strategy-generation:v1` and `capiro:objective-planner-materialization:v1`; proposed operations are `objective.strategy.draft` and `objective.plan.prepare`. Assistant/edit/document workload authority is not allocated by those operations. Proposed 15-minute decisions and confirmedAt+24-hour absolute intent lifetime require review. Dispatch/resume cannot extend an original run expiry; separately scoped retained-result reconciliation must still recover an already completed immutable result under fresh authority after worker expiry. No named workload service-identity verifier has yet been established in current Core. Never reuse a user JWT as a durable service credential.

Define how a ready Objective selects a Strategy generation type before dispatch. The current explicit request requires `type` (`objective-generation.types.ts:237–258`); Objective readiness alone does not supply that request field. Reconcile saved selection or a reviewed purpose/type mapping rather than guessing a hidden default.

## 3. First safe automatic end-to-end path

Enable only after increments1–2 and the context/graph requirements below are implemented and reviewed. A leased dispatcher consumes an authorized current intent, invokes the typed runtime outside database transactions, persists an exact accepted result through existing atomic Strategy/job ownership, and records durable Planner continuation in the same publication transaction. A separately leased continuation invokes the canonical Planner owner. Do not hold a model-spanning transaction or claim a distributed atomic Strategy+Planner commit.

The canonical Objective binding must serialize competing attempts across request UUIDs and actors, with a unique database invariant or equivalently reviewed authority. It records stable canonical Strategy/project IDs, requested revision, applied Strategy revision, applied Planner revision and immutable attempt/result lineage. Routine versions retain canonical IDs; explicit replacement is a different audited transition. Existing private actor-scoped receipts cannot simply be relabelled or exposed to another actor.

For the first successful application, use exact committed ready fields and complete authorized critical context. Persist the entire validated Strategy graph; reject invalid/oversized output or perform an explicit bounded repair whose result is revalidated. Remove silent node slicing, invalid-edge filtering and title clipping from this operation's success path. Actions/milestones map to tasks; decisions/gates/risks remain linked context. If a consequential approval/gate cannot be represented as an executable dependency, require review and suppress a clean execution state. Preserve safe canonical defaults and never auto-activate.

Make pending, running, blocked/review-required, failed, Strategy-applied and Planner-applied distinctions truthful; exact enum names are contract work. A saved Strategy with Planner still pending is a recoverable partial workflow. A newer requested revision must not overwrite the applied revision labels until its publication succeeds. An older in-flight result cannot become current after a newer revision or authority change.

Failure/recovery acceptance includes crash before/after each durable publication, lease reclaim, ambiguous response, same-intent retry, distinct UUID/actor contention, expiry/revocation, revision supersession, invalid graph, unavailable evidence and Planner failure after Strategy success. Prove no duplicate canonical targets, append-once attempts, truthful applied revisions and recovery without browser participation. New automated behavior requires real configured worker/Core/runtime/Planner and UI receiving tests; prior explicit-finish tests are regression evidence, not proof of automation.

## 4. Human changes and routine regeneration

Before dispatching a routine update against existing canonical outputs, detect changed Strategy/Planner versions and human-owned fields. Until a reviewed merge policy exists, stop in review-required state rather than overwrite, clone or falsely advance applied revisions. This safety boundary does not claim the uploaded plan's complete human-aware regeneration feature is done.

Then design stable node/task correspondence, immutable accepted baseline, generated proposal and current human state. Define three-way field/edge merge, retained manual tasks/projects, moved/multihomed work, deletions/archive, approvals, assignments, completed work, conflict resolution and explicit replacement. Preserve past version/receipt bytes. New random node IDs are not a matching algorithm; similarity alone cannot silently establish identity. A human edit during final publication must fail an expected-version check or follow an explicitly approved merge rule.

One canonical generated project may coexist with manual projects and other explicit groupings. Do not enforce a one-project-per-client restriction or arbitrary task limit. Review the relation between canonical root, groups and multiple memberships before changing the existing materialization contract.

## 5. Advanced enrichment, fact updates and analytics

Integrate accepted/pending/rejected enrichment findings through their existing owners with source/version/as-of and explicit acceptance. Pending discovery is not a fact; rejected proposals must not reappear as authoritative input. Required enrichment gaps may create bounded, linked extension/review tasks; they must not invent facts or silently mark the Strategy complete. `review_ready` means ready for review, not facts accepted or plan activated.

Incremental fact-driven re-planning, advanced three-way merging and analytics come after the critical safe path. Keep their contract, permission, lineage and acceptance requirements explicit rather than folding them into a broad generation success flag.

## Release and evidence boundary

Each increment needs independent review and focused tests appropriate to its behavior. Source-only fixture/semantic passes do not establish PostgreSQL concurrency/RLS, configured AppModule/worker execution, runtime contract operation, browser automation or release-image acceptance. Final Bookworm Core and Strategy/embedded-worker images need fresh source binding, frozen dependency/generated-client/engine custody, real native tests, all changed application paths, UI bridges, startup/nonroot/cleanup and scans. Shipping owns that composition; do not duplicate native38, worker-role correction, transport or execution controls in this lane.
