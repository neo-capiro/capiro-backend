# Dormant Phase 4 current authority source note — 2026-09-25

This package adds a same-transaction `MeriHermesDispatchDbCurrentAuthorityVerifierV2`, a per-tenant authority fence, and an operator-owned current worker route registry. It is not registered in Nest, a worker, an ingress, or a provider. The migration and authored specs were not executed in this source-only pass.

## Version and predicate contract

The shared `meri-hermes-phase4-authorization.contract.ts` computes `m4a2:` plus a full domain-separated SHA-256 over tenant, actor, current role, policy label, `g2:<revision>`, and sorted exact client/mailbox IDs. Existing `v1:` 16-hex versions and arbitrary dormant identity labels fail closed. Future pre-dispatch authority generation must take the same tenant fence lock first, use this contract, and persist the exact sorted sets. The recognized policy label is `meri-phase4-policy-v1`; a policy change without matching code intentionally denies.

The verifier queries ACTIVE tenant and membership plus current role. Its client predicate matches the current security envelope: clients of the tenant with `memory_wall = false`, or an explicit `client_memory_access` row for the actor. A selected client must be in that set. Its mailbox predicate matches actor-owned `engagement_connections` for `microsoft_365`, `google_workspace`, or `imap_caldav`. The current security envelope does not filter client or connection `status`; this verifier preserves that predicate exactly. Status changes still bump the revision and conservatively invalidate old identities, without changing the recomputed set. The locked run's stored envelope sets, actor role, and authorization version must also equal the recomputation. The already locked source context provides run/scope/conversation/message/Stop/session-epoch binding; the verifier adds conversation active/unarchived and DB-clock checks.

## Fence, roles, and ordering

The SQL migration backfills a fence row for every tenant and seeds new tenants. Triggers bump its revision within the same transaction for tenant status, memberships, clients, client wall grants, relevant engagement connections, conversation authority/session metadata, execution-scope authority, and worker route writes. A missing row aborts a writer and denies a claim. Fence rows do not cascade with tenants. The app has only tenant-scoped SELECT on the two new tables and EXECUTE on tenant-checked lock functions. A dedicated non-login authority role owns the new tables/functions and is not inherited by the app; the migration role's temporary membership is revoked before commit. This role is not itself an operational provisioning path. SECURITY DEFINER lock and trigger functions use a pinned search path and an explicit owner policy under FORCE RLS. The runtime role receives no direct UPDATE on either table and does not rely on `rls_bypass()`.

The claim repository takes a shared tenant-fence lock before source rows. The verifier reacquires the same row, reads current authority, then takes a shared lock on the exact worker route through its restricted function. The route key is tenant + private scope + audience + ingress, with exact generation and credential matching; enabled, no closure marker, and exclusive DB-clock `[not_before, not_after)` validity are required. The final intent transition repeats route validity, delivery cutoff, and the locked run envelope's exclusive expiration at its database clock. This is the claim linearization point; later revocation must wait for the fence. Writers that hold a source row and then wait on the fence can deadlock with a claim that holds the fence and then waits on that source row. PostgreSQL aborts one transaction; the claim reports `UNKNOWN` and never grants launch from an unconfirmed commit. Future source writers should acquire the fence first to reduce these aborts.

The worker route registry states current database authority only. It does not prove that deployed ingress is closed, that all old ingress paths are excluded, or that a worker process was actually terminated. Route closure and absence/recovery remain separate proof obligations.

Follow-up source repair at `828fdd244`: the pre-dispatch package extends this
foundation. Tenant slug changes now bump the tenant fence. A global user's
Clerk ID update or deletion bumps every current membership tenant's fence in
sorted order before membership cascades. The authority owner receives only
`tenant_id,user_id` membership SELECT under its dedicated RLS policy; runtime
receives no cross-tenant grant. Claim re-reads tenant slug and Clerk ID and
compares both against persisted actor context. A scope BEFORE INSERT trigger
takes the tenant fence before unique-index insertion, while its AFTER trigger
still bumps the revision. The shared UUID validator is corrected to canonical
8-4-4-4-12. These are authored source changes, not executed DB evidence.

## Residual before activation

- P1: The later dormant [pre-dispatch source package](meri-phase4-predispatch-current-authority-source-20260925.md) adds a generator, exclusive fence-first prepare lock, and one-bump scope synchronization. Its migration, role/RLS, and race behavior remain unexecuted. Operator route/policy provisioning remains absent.
- P1: The claim side still needs independent exact tool-view/catalog digest verification and pinned worker ingress proof before this source can be activated.
- P1: Prove all deployed ingress paths and Stop-side absence/recovery conditions independently of the route row; this package intentionally does not activate ingress or recovery.
- P2: Exercise migration/role/RLS, concurrency, and verifier specs in an isolated database during the later authorized QA phase. No test, build, Prisma, migration, Docker, browser, provider, or live QA command was run here.
