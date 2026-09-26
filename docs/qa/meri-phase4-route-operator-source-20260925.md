# Dormant Phase 4 route operator qualification note — 2026-09-25

This package is still dormant and unregistered. It has no Nest controller, module, provider, worker, ingress, or production credential wiring. No production migration, provider command, browser action, deployment, or live write was performed while qualifying it.

## Repaired authority boundary

- Route mutation now requires a single-use database-issued grant. The application role can issue the grant only while a live, exact tenant-scoped Capiro-admin impersonation is present. The database derives and stores the tenant, actor, session, reason, operation, request ID, and request digest; application command bodies cannot choose them.
- The grant nonce is returned once. Only its SHA-256 digest is retained. The passwordless, non-inheriting route-operator LOGIN can consume a grant for the bound operation but cannot issue grants or read the grant table.
- Exact already-committed replay is recoverable with the original grant, nonce, request ID, operation, and digest even after the session or grant expires. A miss or a new mutation requires the live session, active tenant, and active admin membership and atomically consumes an unexpired grant.
- Each independently qualified binding source has a distinct passwordless, non-inheriting producer role. Attestation and revocation authenticate session_user against that source, and revocation signatures/digests are source-bound. One producer cannot attest or revoke for another source.
- Exact route and binding replay is attempted before the exclusive tenant fence and is rechecked after the fence on a miss. This preserves acknowledged-lost-commit recovery without allowing mutable preconditions to be bypassed for a new command.
- Every impersonation-session insert, update, or delete bump-locks the same tenant fence before the row change. A route mutation therefore either commits before End returns or observes the ended session and is denied.
- The legacy binding-unaware route lock helper is revoked. Application and claim paths must use the binding-aware helper.
- Public TypeScript inputs, contexts, commands, parameter arrays, and returned records are synchronously copied and frozen before asynchronous work.

The additive migration keeps authority identities closed: no superuser, create-role/database, inheritance, replication, or RLS bypass capability; no Phase 4 role memberships; and no transitive application-role path. New authority, source, binding, route, receipt, and tombstone tables use FORCE RLS, owner-only policies, pinned security-definer search paths, and append-only/tombstone enforcement.

## PUBLIC privilege baseline

Before either LOGIN is provisioned, the migration inventories effective privileges inherited through PostgreSQL PUBLIC and fails closed on unexpected database, non-system schema, relation, sequence, or routine authority. The accepted baseline is:

- database CONNECT and TEMP;
- USAGE on the public schema;
- no relation or sequence privileges;
- only allowlisted extension-owned routines from pgcrypto, uuid-ossp, vector, pg_trgm, and citext.

The migration also globally revokes default PUBLIC function execution for both actual DDL owners, proves the default with a post-create routine, and rescans effective routine privileges before commit. It explicitly restores only the three existing RLS context helpers to the application role and the non-LOGIN Phase 4 authority owner. Role-specific revokes are not treated as a substitute for these PUBLIC checks.

## Transaction and replay contract

| Operation | New request | Exact committed replay |
| --- | --- | --- |
| Issue grant | Live exact admin impersonation, active tenant/admin membership, bounded lifetime; returns nonce once | Grant IDs are unique and immutable |
| Attest / revoke binding | Authenticated source-specific producer; source-bound metadata and signature; current qualification for a miss | Exact durable binding/tombstone returned before mutable source/window checks, then rechecked under the fence |
| Provision / enable / close / rotate | Bound unconsumed grant; live session/admin checks; exact operation/request/digest; tenant fence and current state checks | Exact receipt returned using the original grant/nonce even after session or grant expiry |
| Recover receipt | Bound grant identity, operation, request ID, digest, and nonce | Returns the exact durable receipt; not_found is not success |

Every real binding, route, or revocation mutation increments the tenant fence exactly once. A no-op or exact replay increments it zero times. Receipts are written in the same transaction after the mutation and retain the resulting revision and the database-derived actor, session, and reason. Provision and rotation leave the route disabled. Closing database route authority does not by itself prove ingress fencing or worker termination.

## Executed qualification evidence

- Focused Phase 4 route suites: **3 suites, 24 tests passed**.
- Adjacent current-authority and pre-dispatch suites: **2 suites, 17 tests passed**.
- A real two-connection disposable-PostgreSQL race proved that impersonation End remains blocked until an in-flight route mutation commits; the final route and ended-session states were both durable.
- Strict targeted TypeScript compilation of the contract, operator, and route specs passed.
- Prisma schema validation and client generation passed.
- A fresh disposable PostgreSQL 16 + pgvector database applied the full **437-migration** chain. The target migration first failed at its PUBLIC hard gate, before creating LOGINs, as the negative control required. After applying the isolated production-baseline simulation, the migration succeeded.
- Database checks confirmed: operator attributes and zero memberships; the application role can issue but not mutate; the operator can mutate but not issue; neither runtime role can read the grant table; the legacy helper is denied; no unsafe PUBLIC routine remains.
- A real grant/provision transaction confirmed database-derived actor/session/reason, disabled provisioning, atomic consumption, no stored raw nonce, and exact replay after the session ended.
- A new grant after the session ended was denied; a wrong-nonce replay was denied.
- A producer for source A could not revoke a source-B binding. Its own-source revoke and exact replay succeeded.
- Final independent read-only security rereview found no remaining P0, P1, or P2 defect in this dormant package.
- git diff --check passed.

The broad repository harness was not accepted as package evidence: its initial run encountered unrelated/pre-existing workspace and unbuilt-generated-client failures. The focused suites, targeted strict compilation, Prisma checks, and disposable-database evidence above are the bounded qualification signal.

## Remaining activation gates

This checkpoint does not authorize migration or activation. Before production use it still needs:

- the real production PUBLIC privilege inventory reconciled with an approved rollback/baseline procedure;
- independently reviewed producer credential/key custody and source-qualification operations that rerun the effective and default PUBLIC privilege gates;
- claim-side tool-view/catalog attestation and trusted ingress-to-route mapping;
- reconciliation plus ingress, broker, lost-response, Stop, and post-expiry effect receipts;
- final concurrency, rollback, and production-image qualification;
- the independent Phase 5 adjudication and representative live cohort required by the plan;
- explicit deployment GO from the user.

The package therefore remains dormant and must not be deployed from this note.
