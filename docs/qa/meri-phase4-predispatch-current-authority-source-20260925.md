# Dormant Phase 4 pre-dispatch current authority source package

Date: 2026-09-25. Baseline: `828fdd244`. Source-only; no test, typecheck,
build, migration, database, Docker, browser, provider, or live execution.

## Boundary and ordering

`MeriHermesPreDispatchTransactionV2.prepare` accepts an authenticated API
principal, immutable authority-independent run/turn intent, and optional
retained exact request for an uncertain retry. It snapshots caller-owned JSON
before its first await. The active Hermes adapter and client remain unwired.

One tenant transaction first takes a stable run-ID advisory lock and resolves
durable replay/collision before current authority. Exact retained-capsule
replay is status-only. A same-submission retry without its capsule can observe
the stored request digest and status, but cannot mint a replacement request.
After confirmed absence, a retained capsule may be retried only when the
current authority, source message, session/header key, and semantic body still
match its original identity and bytes. A changed request needs a new attempt
identity; `UNKNOWN` is never a launch grant.

For a new attempt, the transaction takes a tenant-checked exclusive
`FOR UPDATE NOWAIT` fence lock, then the conversation and scope source locks.
The concrete authority reads active tenant/membership role, sorted current
client/mailbox sets, server-owned route and pinned policy, plus the tenant slug
and Clerk user ID. Tenant-slug and global-user Clerk-ID writers now bump the
affected tenant fences; the claim verifier compares both current values to the
persisted actor context. It only reads the operator-provisioned route. An absent or
stale private scope is inserted or updated once with an authorization version
computed for the predicted `revision + 1`; the scope trigger makes exactly that
bump. A BEFORE INSERT trigger acquires the fence before unique-index insertion,
closing the absent-scope race. A current scope is not written. The verifier and
transaction both re-read the final fence; the transaction also checks tenant,
principal, kind, and authorization version of the final scope. No
later admission write changes the authority fence. The verifier derives the
envelope, actor context, limits, signed extension material digest, session key,
HMAC key ID, and time cutoffs from trusted sources. The transaction builds the
exact `MeriHermesExactDispatchRequestV2` capsule once after that decision and
persists its final identity with the budget, message, run, and event.

Every denial after the authority call throws a rollback sentinel, including
freshness and budget refusal. SQLSTATE `55P03` is a known rolled-back authority
contention refusal. Other exceptions produce `UNKNOWN` with the retained
capsule when one exists. The budget-refusal counter update inside a rolled-back
transaction is not retained; durable refusal telemetry needs a separately
reviewed path if required. Worker route provisioning is a distinct privileged
operator operation before admission and bumps the fence. A missing, closed,
disabled, expired, mismatched-generation, or mismatched-credential route denies
admission without creating it.

## Authored acceptance matrix (not executed)

| Case | Required result |
| --- | --- |
| Missing scope; current route | Exactly one scope INSERT, `g2:(f+1)` and matching `m4a2` in scope, envelope, identity. |
| Concurrent missing-scope INSERT | The BEFORE INSERT trigger takes the tenant fence before unique-index insertion; the loser observes the winner or rolls back. |
| Legacy/stale scope | Exactly one authorization-version UPDATE and one fence bump; no placeholder write. |
| Current scope | No scope write; use `g2:f`. |
| Unexpected final revision | Roll back scope, budget, message, run, and intent. |
| Denial after scope write, including budget or late expiry | Roll back all admission writes and route remains untouched. |
| Grant, session, or route mutation before prepare lock | Recompute at final fence; reject a stale retained capsule. |
| Two same-run attempts | Stable advisory lock serializes absence/replay through commit. |
| Committed or unknown replay | Status-only unless absence is confirmed; no changed bytes under the same attempt. |
| Envelope sets | Unique canonical `ORDER BY id` client/mailbox arrays; `m4a2` recomputed from those exact arrays. |
| UUID framing | Only canonical lowercase 8-4-4-4-12 tenant, actor, client, and mailbox UUIDs enter `m4a2`. |
| Tenant slug or Clerk user ID changes | Writer bumps every affected tenant fence; claim compares exact persisted actor context to current tenant/user rows. |
| User DELETE | Its BEFORE trigger reads memberships before cascade, bumps distinct tenant fences in sorted order, and fails closed for a missing fence. |
| Opposite A→B and B→A tenant moves | Both writers lock the distinct affected fences in UUID order, bump each affected tenant once, and fail closed if either fence is missing; concurrent DB verification remains pending. |
| Broker tool policy | Allow and deny arrays are sorted and deduplicated before the material digest and persisted envelope. |
| NOWAIT contention | Direct SQLSTATE `55P03` and Prisma `P2010/meta.code` map to rolled-back `authority_contention`, never launch. |
| Route and credential | Exact enabled current generation/credential and DB-clock window required. |
| Exact body | Retained bytes, session HMAC and idempotency match trusted current material. |
| Privilege | Runtime has EXECUTE on tenant-checked lock function, no direct fence/route UPDATE or owner membership. |

## Remaining P1 gates before activation

The source is dormant. The authenticated API integration must supply the
trusted principal rather than accept it from request JSON, assemble instructions
and the signed tool-view extension before admission without network work inside
the transaction, and preserve the returned capsule across delivery and
uncertain outcomes. The claim verifier currently does not independently
recompute the new tool-view material digest from received bytes or prove the
catalog/policy signing relationship; the canonical cross-host digest and
signed worker ingestion proof remain required. Operator route provisioning,
credential custody, all-ingress claim gating, durable absence/recovery, and
migrated PostgreSQL race/rollback evidence are also outstanding. The authored
specs in this package are not execution evidence.
