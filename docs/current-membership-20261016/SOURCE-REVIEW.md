# Current membership source review

No unresolved finding in the reviewed production batch after the two narrow fixes below. This is independent source review, not runtime, deployment or whole-feature qualification.

Reviewed checkout: `../backend-current-authority`, branch `feat/core-current-membership`, working-tree changes on base `016e79b585c14f20d13669e13c987c01e3dd29dd`. Review date: 2026-10-16. The membership specification and module specification were still owned by other agents and were excluded from this review. No test, compiler, build, browser, database, network or provider action was run by this reviewer.

## Findings and disposition

1. **Closed: pre-controller denials missed no-store on accepted route spellings.** The initial middleware compared exact, case-sensitive paths. The existing Express configuration permits case variants and one trailing slash; the installed Nest execution context runs guards before applying controller headers. Thus an authentication or role denial on `/api/clio/application-authority/MEMBERSHIP` or `/api/clio/application-authority/membership/` could omit `Cache-Control: no-store`. The current [middleware](../backend-current-authority/apps/api/src/tenant/tenant-context.middleware.ts) lines 89–98 normalizes case and one trailing slash solely for the no-store comparison. It changes neither route admission nor authentication selection.

2. **Closed: response closure before listener registration was missed.** The initial request latch observed only `req.aborted` and future `res.close` events. A peer can finish its request body and disconnect during the existing asynchronous middleware, before the membership controller subscribes to response closure. The current [request control](../backend-current-authority/apps/api/src/auth/application-membership-request.ts) lines 15 and 26 also reads persistent `res.destroyed` both initially and in every active check. This refuses already-disconnected responses and retains the event latch for later disconnects. It does not claim cancellation of already-started I/O.

## Source conclusions

- The [controller](../backend-current-authority/apps/api/src/auth/application-membership.controller.ts) lines 11–33 uses the existing minimum-role guard and actual `CurrentTenant`/Express request. It accepts only the existing closed empty-object body, returns HTTP 200 JSON with no-store, and closes its request latch in `finally`. Caller deadline input can shorten the server's 30-second controller budget; invalid or elapsed deadlines fail rather than returning an empty membership result.
- The [service](../backend-current-authority/apps/api/src/auth/application-membership.service.ts) lines 24–58 delegates identity to the existing request-local production owner. That owner requires the exact request and context object from its private WeakMap, freshly reads the native Clerk session, resolves the original selected membership, and verifies current user mapping, tenant, claims and any impersonation. The new service does not accept a body-supplied actor, tenant, receipt, role or grant. The existing authentication/self-heal pipeline is not redefined.
- Service lines 93–107 query the actual selected tenant and Core actor's active membership and active tenant, reject unknown/below-floor roles, and emit that row's role. Under impersonation, a platform role does not substitute for a missing target-tenant membership. The original identity owner separately validates the source impersonation provenance; target membership is an additional read requirement.
- Service lines 65–89 use the existing canonical Clerk-actor roster helper, with a maximum of 4097 returned rows so an over-4096 roster fails explicitly. SQL remains tenant-bound, active-membership-bound and restricted to nonarchived clients. Its wall predicate remains unwalled **or** a matching `client_memory_access` grant. There is no administrator wall bypass, account-assignment model, Directory expansion, pagination truncation disguised as a complete roster, or new permission source.
- The [helper change](../backend-current-authority/apps/api/src/memory/memory-wall.helpers.ts) lines 119–137 adds only an optional validated server-owned row limit. Tagged SQL binds the value. Omitted bounds yield SQL `LIMIT NULL`, preserving the prior full-roster behavior for existing callers.
- Service lines 27–47 repeat online identity/local identity and membership/client reads, reject changed observed revisions, and retain the minimum of the original identity expiration bounds. They never refresh expiration from receipt time. Final receipt construction still checks that expiration is finite, integral and in the future through the existing identity receipt validator.
- The result is a fresh closed object with literal active status and `permissions: []`, canonical sorted unique client UUIDs, a deterministic membership revision, checked time and original finite expiry. The [revision](../backend-current-authority/apps/api/src/auth/application-membership.ts) lines 35–41 includes validated selected membership and sorted client source facts; clocks and session expiry are excluded. It grants no authorization by itself and is not retained READS authority.
- [Module registration](../backend-current-authority/apps/api/src/auth/application-authority.module.ts) adds the membership controller/provider to the existing source-registered application authority module. The existing AppModule imports that module and applies the tenant middleware to this route. No Meri implementation, shared contract, schema, migration, credentials, environment or provider configuration is changed by this batch.

## Exact reviewed production bytes

SHA-256 values were read from the working tree after the two fixes. Any later byte change requires matching evidence or a new review.

| File relative to `backend-current-authority` | SHA-256 |
| --- | --- |
| `apps/api/src/auth/application-membership.ts` | `c40054c008e5d710be904cbd285e39aad3d5bc7623bb3c05cf08690e6857f0c6` |
| `apps/api/src/auth/application-membership-request.ts` | `f1ff3779a9817dc0fee330f1a8eb67faeea971f8e4e1a18109936377324ff340` |
| `apps/api/src/auth/application-membership.controller.ts` | `81b4e23fe2a5596cf4daaacf0fcc08af747ca58aa17e8853500c25e3a4553386` |
| `apps/api/src/auth/application-membership.service.ts` | `8d4f301d8674c006aaeebee76c1137b66c1dd5d3743ceed041a2984b51538440` |
| `apps/api/src/auth/application-authority.module.ts` | `a9a450297f1c37b5f6c3164e3fa370542172470f843c43017457ce9f8f51b1f3` |
| `apps/api/src/memory/memory-wall.helpers.ts` | `c94ceeb0687fa09c3673aa1a97022439d15d4686e4e7b80f580231092350b294` |
| `apps/api/src/tenant/tenant-context.middleware.ts` | `80511693576467e56004fd7147f3c79c23f9ad79f9cc543c88a381489b40c907` |

Existing owner sources spotchecked: `application-authority.ts` SHA-256 `80d7913e68d63cfec1c15f9a76ebe0657baeb107f1880725c4ba3db567aa7309`; `clerk.service.ts` `c49fdba20da5152a5eadb1dca864e6f789c943ad1b1ca560a529edad4f343191`; `app.module.ts` `ea98382d71c8ac0d3bc594d18dbdbacc70f5475a3bd6a10fabd163d36351e8c3`. The base Prisma schema was inspected read-only from Git to confirm unique Clerk mapping and unique tenant/user membership; it was not materialized or modified. Installed Express 4.22.1 and Nest router source supported the header-order finding; no application was launched.

## Limits and next qualification

These are repeated point-in-time source observations, not one cross-system atomic snapshot, a continuous wall/session lease, or proof of changes that occurred and reverted between reads. A returned receipt must not replace current authority checks at later operations. A disconnect/deadline refuses subsequent work and a late receipt, but does not prove rollback or cancellation of underlying SDK/database I/O. The controller budget begins after existing middleware resolution; no new end-to-end authentication timeout is claimed.

Focused owner tests, semantic typing/build, native SQL behavior, actual HTTP/guard/serialization and disconnect behavior, and startup's native bearer propagation/current membership port binding remain separate integration qualification. No target access, endpoint installation or live deployment is attested here. No review action was denied, pending or uncertain; only the authorized review Markdown was written by this reviewer.
