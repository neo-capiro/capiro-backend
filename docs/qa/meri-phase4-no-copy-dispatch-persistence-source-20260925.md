# Meri Phase 4 no-copy dispatch persistence — source package

Date: 2026-09-25
Checkout baseline: `1dbca8c1f`
Status: dormant source only; no runtime exposure or acceptance claim

## What this package adds

`MeriAgentDispatchIntent` and migration
`20280928010000_meri_phase4_no_copy_dispatch_intents` persist the complete
version-1 identity produced by `meri-hermes-dispatch-intent.contract.ts`:
tenant/actor/client/workspace/scope/conversation/message/run, the exact
idempotency key, conversation epoch, worker audience/ingress/generation and
credential ID, authorization/policy/grant versions, catalog/tool-view/key IDs,
all five cutoffs, exact body length/hash, keyed session-header digest, and the
complete request digest. The table stores no request body, session-header
value, bearer, HMAC key, or other replay material.

All cutoff and outcome values are signed PostgreSQL `BIGINT` Unix
microseconds; conversation epoch and exact body length also use `BIGINT` so a
contract-valid safe integer is not narrowed by persistence. Shape checks
mirror the contract's 24-hour recovery and retention margins. A trigger makes
identity immutable, derives claimed, sealed-absence, and retention-marker
times from `clock_timestamp()`, permits only `prepared -> claimed` or
`prepared -> sealed_absent`, and rejects delete. `claimNotAfter` is exclusive:
DB-clock equality is denied. Absence may be sealed only strictly after the
reconciliation cutoff; equality is also denied. `UNKNOWN` is deliberately not
a durable state.

The table intentionally has no cascading foreign keys. This prevents ordinary
run/message/tenant cleanup from erasing a deduplication outcome. A terminal row
may receive a DB-clock retention marker only after `retain_until`; this package
does not implement purge. FORCE RLS scopes rows to `current_tenant_id()`,
PUBLIC receives no privileges. The migration first revokes the bootstrap
role's table-level default INSERT/UPDATE and destructive grants, then grants
`capiro_app` SELECT plus only the insert/transition columns it needs—not
DELETE, TRUNCATE, REFERENCES, or TRIGGER.

The dormant repository provides:

- `prepareInTransaction`, which requires the caller's existing tenant
  transaction so the future writer can atomically insert the user message, API
  run, and prepared intent before sending anything. It locks and matches the
  run, scope, conversation, and user message against the identity.
- `claim` and `sealAbsent`, which serialize on the same source/intent rows,
  require an in-transaction authoritative verifier, reject different request,
  worker-run, or absence-proof digests, and return an exact replay as
  status-only. A first claim conditionally binds the same stable worker run ID
  into `meri_agent_runs` in the transaction that changes the intent to
  `claimed`; failure of either write rolls both back.
- `observe`, which reports missing/unreadable status as an epistemic `UNKNOWN`.
  A transaction exception is `commit_unconfirmed`; it never writes UNKNOWN or
  infers which contender won.

The repository result `transitioned` is only a persistence fact. It is not a
launch or effect grant. The repository is not registered in `meri.module.ts`
and is not imported by the adapter, controller, runtime client, or worker.
Likewise, `sealed_absent` means only that no Phase 4 protocol admission was
committed under the verified ingress/credential horizon. It is never evidence
that no legacy receiver, execution, provider call, broker call, or external
effect occurred.

## Authored evidence (not executed)

`meri-hermes-dispatch-intent.repository.spec.ts` covers atomic-prepare source
matching, exact claim/absence replay as status-only, conflicting worker IDs and
digests, verified transitions, and commit uncertainty. The static persistence
contract spec covers schema/migration field parity, signed-int64 cutoffs,
exclusive DB-clock transition boundaries, immutable/tombstone/RLS/privilege
rules, broad-default-privilege revocation, and dormant wiring.

Per the user's resource hold, this package did **not** run Jest, TypeScript,
Prisma generation/validation, a migrated PostgreSQL test, build, Docker, or
live QA. Source/static diff inspection is not package acceptance.

## Gates still required before any runtime wiring

1. The preparation caller must be refactored so message, API run, and intent
   really commit in one transaction; a lost commit response must remain
   status-only.
2. The private claim/absence endpoint must authenticate the worker and
   recompute the exact raw-body and session-header identity with the retained
   key ID. Cross-language golden vectors and HMAC-key rotation/retention still
   need proof.
3. The transition verifier must lock the authoritative grant/revocation writer
   fence and validate current Stop, conversation epoch, client access, worker
   credential, generation, ingress, route closure, and body semantics. The
   repository callback is only a required seam, not that implementation.
4. Every reachable worker generation must call the gate before session
   creation, provider/broker work, budget reservation, or mutation. Old routes
   and credentials must be drained or revoked with auditable cutover evidence.
5. `sealed_absent` needs independently trustworthy evidence that every
   reachable ingress is closed. The digest merely binds that evidence; it does
   not prove the evidence is true.
6. Stop, claim, reconciliation, ordinary terminalization, and cleanup must use
   the same conflict domain. A prepared/unknown intent cannot be reported
   stopped or failed. Claimed execution/effect/terminal facts need separate
   ledgers and known-ID compensation.
7. A proven maximum delivery/credential/recovery horizon and key-retention
   policy must precede any tombstone purge. Until then deletion stays disabled.
8. Run the exact-HEAD focused unit/static specs, Prisma validation/generation,
   migrated-Postgres race/crash suites, typecheck/build, rollback rehearsal,
   pinned-worker contracts, and final guarded `https://os.capiro.ai` QA after
   the resource hold is lifted. No feature flag should be enabled from this
   source package.
