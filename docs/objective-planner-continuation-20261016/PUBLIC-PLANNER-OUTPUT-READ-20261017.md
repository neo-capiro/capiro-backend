# Public Planner project receipt read

This source successor is based on independently qualified Core PR53,
`57f8c8047a73df6d4a73351a98a5239f38240a24`, tree
`cb2ac7d883290741e95d4dffa0f67406ed8e87e4`. It adds a bounded public read of
Planner project receipt custody and current access. It does not attest an
original Strategy producer/completion, discover Strategy outputs or tasks, or
activate Objective generation. All Meri implementation belongs to Fable.

## Route and exact source selector

The existing Core API prefix/proxy applies to:

```text
GET /clients/:clientId/objectives/:objectiveId/generation/outputs
    ?workAction=objective.plan.prepare
    &sourceRevisionId=<Objective revision UUID>
    &sourceObjectiveVersion=<positive decimal integer>
    &canonicalBindingVersion=<positive decimal integer>
```

The query is closed. Counters use canonical positive decimal strings through
2147483647; repeated values, private IDs, output IDs, request IDs and unknown
fields fail with `INVALID_REQUEST`/400. The Strategy action is accepted only to
return an explicit unavailable observation; it never falls back to Planner.
Responses are `private, no-store`.

The caller selects an exact known source tuple. It cannot supply a project,
receipt, operation, actor, snapshot or workload selection. Historical reads
select only from the complete verified application ancestry reconstructed in the
same native transaction. A source outside that ancestry remains uncertain;
this first endpoint is not an arbitrary historical-job search or a source-list
discovery endpoint. The UI must not guess an older binding version when it has
only a revision/version observation.

## Public response

The envelope contains `schemaVersion:1`, `scope:'planner_project_receipts'`,
`clientId`, the current `objective` revision/status, `workAction`,
`requestedSource`, `selectedSource`, `observation`, `taskDiscovery:'unsupported'`
and the server's `observedAt`.

Both source objects use `{revision:{id,version},canonicalBindingVersion}`.
`requestedSource` is the current requested ready source, which can differ from
the current draft Objective revision and the caller's historical selection.
`selectedSource` is the exact tuple requested, not a statement that work exists.

`observation` is closed to:

```ts
{
  state: 'not_started' | 'queued' | 'running' | 'applied' |
         'failed' | 'cancelled' | 'outcome_unconfirmed' | 'unavailable';
  strategy: { availability: 'unavailable' };
  planner: {
    availability: 'available' | 'partial' | 'unavailable' | 'not_applied';
    projects: Array<{
      availability: 'available' | 'unavailable';
      creation: { receiptVersion: 2 | 3; recordedAt: string; version: number } | null;
      application: { receiptVersion: 2 | 3; recordedAt: string } | null;
      current: {
        selection: { kind: 'planner_project'; id: string };
        title: string | null;
        ownerVersion: { kind: 'counter'; value: number };
        observedAt: string;
      } | null;
    }>;
  };
}
```

The state belongs to the selected source. Where complete ancestry has been
reconstructed, an older applied pair remains `applied` while a newer source has
not started. A current queued/leased operation with unresolved prior custody
can withhold the older selection as `outcome_unconfirmed`; this slice does not
invent an ancestry proof for that pending case. `running` means an
observed unexpired durable lease; it does not assert process liveness. An
expired lease remains `outcome_unconfirmed`. Failed/cancelled observations need
the existing exact terminal accounting. Missing or default-disabled owner
bindings stay unavailable/uncertain.

An unavailable project has `creation:null`, `application:null` and `current:null`:
no project ID, title, creator, original selector or historical version leaks
through a placeholder. The `partial` availability value is reserved for a
future supported multi-resource projection; this canonical single-project
slice does not invent partial results.

## Retained v3 receiving and current navigation

The selected application and original project creation are separate facts. A
v3 retained application can report zero created projects while referencing the
same canonical project. Creation metadata comes from its unique original v2
ancestor; the selected v3 application has its own receipt-version/time. Neither
is a claim that the current project still has its recorded creation version or
title. `current` comes from the actual current owner read.

Consumers must not run this response through the legacy materialization
decoder that requires `createdProjects === projects.length`. There is no
materialization ACK, generated count, private receipt or internal workload
endpoint in this public contract. The existing Planner current-resource route
can consume `current.selection`, keeping its ordinary bootstrap/current-access
recheck before opening the project. A stale observation never grants access or
authorizes a retry.

## Native authority and privacy

The existing WorkService performs the current request proof, early Planner
gate, current native membership/client/Objective/wall checks, source/state
locks and full owner reconciliation. The new projection runs inside that same
transaction, before the original request-owner release and database-clock
expiry checks. It neither opens a second transaction nor writes consent,
commands, operations, receipts, policy or output rows.

The private owner cache is bound to the exact transaction, current authority,
source and state. It contains detached decoded applications only after the
existing complete v2/v3 native consent/operation/receipt ancestry proof succeeds.
Unknown added output identities still invalidate custody. A command gate or
changed state cannot reuse a status-read cache as an output or issuance grant.

Only `readObjectivePlanResource` can qualify current project availability. It
uses the current reader's Clerk identity, the original client scope and the
existing project/task access rules without a tenant-admin bypass. Current
archive, privacy, membership or client changes therefore withhold selectors.
The DTO is built field by field; private receipt/operation/attempt/run,
fingerprint, consent/delegation, snapshot, canonical reserved IDs, issuer/owner
and Strategy version/type fields are not public outputs. Task metadata returned
internally by the current project reader is not copied into this response.

The actual Strategy saved-generation/producer ledger is not reconstructed by
Core's Planner custody proof. The response therefore keeps Strategy unavailable
and makes no generated Strategy provenance claim from an owner snapshot hash
or matching type. Native Strategy reconciliation/policy and protected
issuer/verifier/result-bridge binding remain unallocated central work; do not
edit authority files, runtime mounts or migration fences to make this read look
like full-flow activation.

## Qualification and coordination

Focused successor source checks passed: owner/kernel 258/258 (the prior 206 plus
52 output/cache/pending-state cases), and four actual parser/service/module/
shared-resource suites 103/103. Strict service/owner/helper and native Core
graphs passed. The eight native Core cases collect with defaults off and skip
without SQL. The existing v3 native case additionally exercises the real
WorkService public output read, original creation versus retained application,
human current edits and selector withholding after current project archive.
Enabled native qualification of this successor is pending publication of its
final independently reviewed source pin; prior results do not qualify it.

PR53's exact-head evidence is archived byte for byte in
[`qualification/pr53-57f8/EVIDENCE.json`](qualification/pr53-57f8/EVIDENCE.json),
with its independent receipt. Its run `8ad115502b154a41b33f9d59c38fc628` passed
20 actual native cases plus one default-off check, 13 preflight checks with 20
native skips, and all 52 child exits. Exact PID18236, owned root, private port
56455 and disposable credentials were retired; host5432/PID4936 remained.
Directory-scoped attributes preserve all archive bytes and suppress whitespace
diagnostics for the eight named immutable archives only. The new manifest,
engineering document and implementation keep ordinary whitespace checks.
Those results qualify PR53, not this successor's new public read. The bounded
native baseline is 38 selected SQL source units with synthetic current proof,
Strategy issuance and provider ports; it does not establish live HTTP/JWT,
Meri/SDK, browser, full migration, network delivery or deployment qualification.

Frontend [draft PR66](https://github.com/neo-capiro/capiro-frontend/pull/66),
`aceb18ea56bd99a48e0ca527ce0f3e7559092c05`, records governed GET/commands/pair
ownership independently of first-chat pins. Its broader requirements still
include genuine Strategy producer/discovery, source-list discovery, complete
canonical v3 receiving and live end-to-end qualification. This bounded read is
one available Core contract, not completion of those dependencies.

Immutable Meri handoff [PR54](https://github.com/neo-capiro/capiro-backend/pull/54)
at `ee00f6d2cbf76ad83f6c8a354ed22a2a931566df` remains unchanged. Its historical
pending-native statement is superseded only by the separate exact PR53 result
above. Fable owns Meri; dot owns Core/frontend coordination and E2E. Any Core
activation requires dot coordination. No AWS, application database, credential,
migration, deployment recipe, first-chat image or live activation change belongs
to this source slice.
