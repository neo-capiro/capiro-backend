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

Missing receipts alone never establish absence. Initial materialization rejects
any exact application/materialization receipt or canonical project/task,
including archived outputs. Regeneration instead reconstructs the complete
applied predecessor chain and its original continuation operations. Existing
outputs belong to that verified predecessor; they cannot be treated as absent.
Every new effect rechecks the saved schema-2 basis, native retained-read grant,
complete v2/v3 owner receipts and exclusive current application identity in the
same transaction. Corrupt, incomplete, mismatched or uncertain owner evidence
remains uncertain.

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

WorkService now calls the allocated early status-read gate before Core
authority/state locks. Current initial, verified failed/cancelled and fully
proven applied work can be read through the actual service/kernel path. Core
uses the same complete v2/v3 materialization, application and recursive
predecessor decoders as Strategy. The pure codec bodies and error behavior were
moved to a server-only shared subpath; neither the shared root export nor the
ordinary chat contract changed. Applied accounting additionally reconstructs
native Planner consent, command receipt, root/revision, membership and Clerk
lineage for every ancestor.

The owner separately prepares a closed advanced-current-source absence witness
after complete historical accounting. It retains the old `accounted/applied`
operation identity. The allocated command-kernel integration admits only a NEW
explicit Planner consent whose
fully verified witness names the strictly advanced current ready source. The
historical operation remains `accounted/applied`; its receipt, run, attempt and
deadline are not renewed or relabeled. Strategy applied work, same-source applied
work, pending/unknown evidence and malformed witnesses remain ineligible. Fresh
policy, current native authority, version/CAS checks and database-clock release
guards still apply before new consent commits. Runtime recovery returns the
original creation receipt and current human-edited outputs without creating
another generation.

The owner scans at most 256 relevant private rows and fails closed on overflow.
The runtime predecessor scan has the same aggregate row bound; it is not a
promise of 256 regeneration cycles. Earlier-binding failed/cancelled records
are now reconstructed against their own original consent, command, root actor,
intent, revision, membership and Clerk. Their exact deterministic application
and materialization IDs must either be absent or equal a fully decoded later
consent's paired ancestor for that same application identity. Kind or embedded
scope cannot hide a row at either ID. Original operation IDs, deadline and
terminal accounting remain immutable.
Each historical terminal must precede or equal the current consent confirmation;
paired history also retains the tighter exact-successor confirmation checks.

Verified predecessor outputs are retained. Whole-project output absence is
required only when no verified paired output chain exists. A current failed or
not-started operation alongside an older applied head remains uncertain until a
separate complete anchor contract is available; this increment does not infer
such an anchor from an old terminal record.
Consequently, immediately after a new consent commits and before its current
operation exists, a retained older applied head can still make the public status
`outcome_unconfirmed`. This does not itself authorize dispatch; an independently
eligible saved generation can continue through the runtime and later account its
new operation.

Source tests use real runtime, worker, store, application, shared receipt codecs
and Core service/command-kernel source with explicitly synthetic SQL,
transaction, custody and materializer ports. Regeneration fixtures include three
persisted generations and current human-edited outputs. They do not establish
native PostgreSQL locks/RLS or deployed behavior.
The separately guarded native suite passed 12 database cases plus the
default-off check against the pinned parent `b8b7262` on disposable PostgreSQL
16.15, with restricted-role/RLS checks and verified owned cleanup. That run
predates this shared-codec/status/regeneration source and does not qualify these
later changes. [NATIVE-QUALIFICATION.md](NATIVE-QUALIFICATION.md) records its exact
source, focused baseline and evidence limits. No AWS, application database,
production credential, deployment or browser acceptance action occurred. No
dependency installation or heavy archive was needed.

## Focused source verification

For the allocated kernel increment, **181/181 affected Node checks** pass across
the command, paired command, new regeneration and concrete-owner suites. The
composed positive uses the actual full three-generation owner proof, actual
kernel and actual cached policy, with synthetic persistence/current request
proof. Exact replay, conflict, original record immutability and proof expiry caps
are asserted. Actual Core status/module regressions pass **33/33**, and the new
schema-2 native-fixture source checks pass **7/7**. The affected Core/native
TypeScript import graphs and whitespace checks pass. The new six native cases
collect and skip without opt-in; their enabled result and exact published source
pin are recorded in the PR and task qualification receipt after execution.

The earlier reviewed baseline at `a2b35fb` established the broader checks below;
unchanged suites are not presented as newly rerun for this kernel increment.

- Eight Node source suites: **372/372 passed**. These cover producer,
  application, continuation, saved-plan/runtime, native-target guard, Core owner,
  the full shared codec and the structural advanced-source witness.
- Strategy Jest store, actual AppModule mount/private visibility, complete
  fixture reconstruction, default-disabled startup and existing materialization
  regression suites: **107 passed, 12 native cases explicitly skipped**.
- Actual Core status service, applied and historical-terminal consent proofs,
  predecessor read fence, regeneration binding/runtime and Core module
  registration: **150/150 passed** (30 + 34 + 44 + 9 + 30 + 3).
- Scoped strict TypeScript checks for the pure shared codec, runtime/application,
  regeneration qualification, historical proof, status service and actual Core
  owner import graph, plus `git diff --check`, passed. No full application build
  was run.

These checks reuse the installed dependency tree. Nest `.compile()` resolves
the actual module graph with a rejecting Prisma override and does not call
`.init()`, create a listener, connect a database or execute worker lifecycle IO.
