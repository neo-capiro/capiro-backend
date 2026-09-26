# Meri Phase 4 exact pre-dispatch source package

Date: 2026-09-25

Baseline: `63db80303`

Status: dormant source only; no runtime dispatch, migration execution, or acceptance claim

## Result

This package supplies the missing source seams for Phase 4 sequence steps 2
and 3 without changing active behavior.

`MeriHermesExactDispatchRequestV2` constructs the `/v1/runs` object in the
same pinned field order as the current client and calls `JSON.stringify`
exactly once. The resulting private `Buffer` is the only authoritative
serialization. The persisted identity is computed from those bytes, and
callers or a future transport receive defensive byte-for-byte copies rather
than mutable access to the authoritative buffer. The capsule also binds the
exact session header and idempotency key. A retry must retain the capsule; it
must not reconstruct an object or re-run JSON serialization.

The identity also contains an immutable `sourceMessageSha256` over the exact
user-message ids, role, body, and canonical JSON provenance, plus a
`requestAssemblySha256` that binds that digest to the exact outbound body
length/hash. The repository recomputes the source digest from the locked
`clio_messages` row. Additive migration
`20280928030000_meri_phase4_message_assembly_binding` adds both immutable
content-free digests. This is a real identity-v2 transition: the digest and
request domains are `/v2`, the repository accepts only v2, and the migration
replaces the database identity constraint with `identity_version = 2`. It
fails closed if any v1/dormant row exists and requires exact reconciliation;
it never silently treats a v1 row as v2 or invents a backfill for bytes that
were never stored.

`MeriHermesPreDispatchTransactionV2` is a text-only, dormant transaction
boundary. Under one governed tenant transaction, one conversation advisory
lock, and one conversation row lock, it conditionally reserves the tenant
daily budget, inserts the parent run reservation, inserts the user message,
creates a missing execution scope only after authority verification, inserts
the queued API run and `run.accepted` event, and calls
`MeriHermesDispatchIntentRepository.prepareInTransaction` for the exact-body
identity. The intent retains conversation/session epoch, envelope
authorization version, authorization-policy version, grant version, worker
generation, worker credential ID, and exact body/header digests. Any failure
after the budget update rolls the entire transaction back.

The constructor requires a no-default authority verifier. There is no caller
envelope or caller TenantContext in the preparation input. Inside the same
transaction the verifier must lock and read current membership and role,
client grants/revocations, mailbox scope, tool policy, authorization/policy
generations, worker route/image, and credential validity. It generates and
returns the complete exact `MeriHermesAuthorizationEnvelope` and
`TenantContext` plus the route/generation attestation. Those authority-owned
objects are canonicalized, detached, validated against the immutable request
identity, and persisted exactly. An existing execution scope is locked and
compared; its authorization version is never overwritten. Only an absent,
verified scope may be created.

Before its first await, preparation snapshots the complete identity, exact
body length/hash and assembly hash, idempotency/session values, and a deep
canonical copy of message body/provenance. Authority output is likewise deep
canonicalized immediately when it returns. No caller-owned or authority-owned
mutable graph survives across a later await.

An exact durable intent/tombstone is resolved status-only before reading any
mutable conversation/archive/client/workspace/session or authorization state.
For a new identity, the database-clock snapshot is taken only after the
contended conversation, authority and scope locks. It checks envelope issue/expiry,
claim/delivery cutoffs, credential cutoff, and the budget day before a
reservation, message, run, or intent is written. The exact optional
`session_id` in the capsule must match the currently locked
`metadata_jsonb.hermes.sessionId`. A database insert trigger rechecks envelope,
claim, delivery and credential freshness at the final v2 intent write, closing
process scheduling time after the shared clock sample.

Replays are status-only and cover terminal as well as live runs. A transaction
exception becomes `UNKNOWN/commit_unconfirmed`; that result cannot launch and
may only be resolved by observing the persisted identity. Every result carries
`launchAuthorized: false`. The boundary contains no network call.

The package also fixes the dormant intent repository's epoch lock to read the
actual nested `metadata_jsonb.hermes.sessionEpoch` written and read by the
active adapter. The previous top-level JSON lookup would have treated every
positive session epoch as a source mismatch.

## Authored but unexecuted evidence

- `meri-hermes-exact-dispatch-request.spec.ts` covers pinned wire order,
  build-once behavior after source mutation, defensive copies, idempotency
  drift, session pinning, source/assembly binding, and reserved-field
  replacement.
- The existing intent contract/repository specs now cover canonical
  source-message provenance, assembly-digest drift, locked-row recomputation,
  and mutable-source-independent durable replay.
- `meri-hermes-predispatch-transaction.contract.spec.ts` checks that every
  required durable write is inside the one source boundary, an authority
  verifier is mandatory, existing scope generations are not overwritten,
  replay ordering precedes mutable checks, a late DB clock and the nested
  epoch/session are locked, no launch grant or network call exists, and no
  active module, adapter, or client wiring exists.
- Static diff whitespace inspection completed with `git diff --check`.

Per the active resource hold, Jest, TypeScript, Prisma validation/generation,
database migrations, Postgres integration/race tests, builds, Docker, browser
QA, and provider calls were not run. Authored tests are not acceptance evidence.

## Deliberate limits and required next integration

1. The active adapter still writes the user message, budget reservation, API
   run, and POST in separate steps. It does not import this boundary.
2. Attachment claiming and regenerate/resend message edits/deletes must move
   into the same transaction before those modes can use the boundary. The
   current slice is text-only; silently splitting those writes is forbidden.
3. Request input/instructions are assembled only after active capacity/profile
   operations today. Runtime integration must choose and lock a stable ordering
   without holding a database transaction across provisioning, queue waits,
   profile work, context reads, or network I/O.
4. The private worker claim gate and every worker ingress remain unimplemented.
   A prepared intent and a copied request body are not permission to transmit,
   create a session, call a provider, or launch.
5. No production implementation of the required authority verifier is part of
   this dormant slice. It must generate the complete envelope and TenantContext
   from locked authority rows; grant/membership/revocation writers still need
   the shared generation fence. Runtime wiring must not restore caller-supplied
   authority objects or use a permissive callback.
6. The budget-refusal branch records the refused admission while writing no
   message/run/intent. Its operator-facing error mapping must be added when the
   dormant boundary replaces the current service path.
7. The additive migration deliberately refuses a nonempty dormant intent table.
   Deployment qualification must verify the table is empty or stop for a
   separately reviewed exact-source reconciliation; it must not bypass the
   guard or fabricate message/assembly hashes.
8. Cross-language exact-byte vectors, migrated Postgres rollback/race tests,
   commit-loss recovery, pinned-worker ingress tests, key rotation/retention,
   deploy/rollback rehearsal, and final guarded `https://os.capiro.ai` QA are
   still required before acceptance or activation.
