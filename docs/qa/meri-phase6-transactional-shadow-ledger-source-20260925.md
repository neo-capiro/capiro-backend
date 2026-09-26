# Meri Phase 6 transactional shadow ledger — source checkpoint (2026-09-25)

## Scope and status

This dormant source slice adds the first database-backed append authority behind `capability-shadow-append-boundary.ts`. It does not register a Nest provider, controller, module, worker, network endpoint, runtime mode, environment variable, key loader, trusted-clock provider, receipt signer, or live-evidence verdict. No traffic can reach it.

The slice is source-complete but **not acceptance-complete**. Jest, typecheck, Prisma generation/validation, migration application/rehearsal, database concurrency tests, build, Docker, browser, provider, and live tests were not run under the active resource/test hold.

## Enforced source invariants

- The repository first uses historical event-time verification of the exact canonical request, then invokes an owner-only exact-row lookup. An existing exact row can be recovered after producer-key expiry. An absent row must pass the full verifier again with the producer key valid at trusted verification time before the append function can be called. Both verifiers reject `attempted` or `dispatched` evidence. This prevents historical verification from authorizing a new expired-key append.
- The request's tenant pseudonym must equal a separately supplied, tenant-authorized pseudonym. Copying the pseudonym from the request does not satisfy that authorization contract.
- Lookup and append each require database time inside a separate explicit trusted `[notBefore, notAfter)` processing window no longer than five minutes. Event `maxFutureSkewMs` is not a persistence deadline and is never reused as one.
- Replay lookup and new-append authority are distinct module-private unique-symbol-branded verifier results. Their non-enumerable symbol brands cannot serialize or be reproduced through ordinary typed object construction; the repository lookup accepts only `replay_lookup_only`, while its private mutation method accepts only `current_append_authorized`.
- New-append policy forbids a commit at or after producer authorization key expiry: the repository requires processing `notAfter` to be no later than the key's exclusive `notAfter`, and the database requires its own clock to be strictly before processing `notAfter`. Expired keys remain usable only for exact immutable lookup.
- Both tables and both `SECURITY DEFINER` functions are revoked from `PUBLIC` and `capiro_app`. Forced RLS and explicit tenant predicates remain defense-in-depth, but the migration does not claim a definer owner is constrained by RLS. There is intentionally no usable application path until a dedicated sink identity and database-authenticated tenant mapping exist.
- The exact database uniqueness authority is `(audience, endpoint_id, idempotency_key)`. It is intentionally not weakened by tenant: a collision in another tenant is rejected and cannot be returned as an authorized replay.
- A locked `(audience, endpoint_id)` head serializes every first append and retry. A byte-identical authenticated request digest returns the original immutable sequence, predecessor, append time, and ledger-entry digest with disposition `replayed`; it does not append a second entry. Any changed request digest, event identity/digest, tenant pseudonym, or registry generation is rejected.
- Sequence is a positive JavaScript-safe `BIGINT` no greater than `2^53 - 1`. The first entry alone has a null predecessor. Each new row takes the locked head digest as its predecessor, and the database computes the same domain-separated stable-JSON SHA-256 expected by `capabilityShadowLedgerEntryDigest`. The repository recomputes that digest before returning the entry. Database append time must not precede the signed event.
- Ledger rows reject UPDATE and DELETE through a trigger. The shared application role receives no table access and no lookup/append EXECUTE grant.
- Every shape, identity, or digest failure after the append call may have committed is wrapped as `CapabilityShadowAppendCommitUnconfirmedError`; its only permitted automated recovery is historical lookup using the identical canonical request bytes. Existing-row corruption raises a separate integrity alarm and never authorizes replacement bytes.
- Persisted evidence contains only the internal RLS tenant UUID, pseudonym/digests, sink identity, sequence, predecessor, and database time. It stores no raw tenant or evaluation-unit identifier, prompt, response, body, tool arguments, credential, secret, public/private key, event signature, request bytes, or receipt signature. The internal tenant UUID is never part of the public ledger entry or receipt.
- There is no foreign key from an entry to Tenant. Ordinary tenant deletion therefore cannot cascade away immutable evidence.

## Evidence files

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20280928020000_meri_phase6_capability_shadow_ledger/migration.sql`
- `apps/api/src/meri/jev/meri-capability-shadow-ledger.repository.ts`
- `apps/api/src/meri/jev/meri-capability-shadow-ledger.persistence.contract.spec.ts`
- `packages/meriv2-core/src/jev/evaluation/capability-shadow-append-boundary.ts`
- `packages/meriv2-core/src/jev/evaluation/capability-shadow-append-boundary.spec.ts`

## Residual blockers before activation or acceptance

1. Run Prisma generation/validation, TypeScript typecheck, the focused contract spec, and a clean migration-chain rehearsal when the resource/test hold is lifted.
2. Add a real PostgreSQL concurrency suite proving: concurrent first append forms one chain, an exact retry returns the original row, changed bytes under the same key reject, cross-tenant collisions do not leak/replay, an expired key can replay only an existing exact row, an expired-key absent row cannot append, processing-window boundaries are exact, the sequence ceiling rejects, forced RLS isolates reads, direct application writes fail, and UPDATE/DELETE remain impossible.
3. Create and rehearse a dedicated non-login, non-`BYPASSRLS` sink service identity plus a database-enforced authenticated mapping from service tenant context to the authorized tenant pseudonym. Only a later reviewed migration may grant that identity table/function access. `capiro_app` must remain ungranted and must not inherit owner access.
4. Supply a trusted KMS/server clock, independently pinned producer/sink registries, and reviewed producer and sink key custody/rotation. Caller-supplied trusted time and public registry bytes are not deployment proof.
5. Add a receipt signer that signs the exact returned original entry after commit/replay. Prove key validity at trusted receipt time and preserve ambiguity-safe retry behavior if signing or response delivery fails.
6. Decide and test availability, retention, backup/restore, disaster-recovery, gap reconciliation, and global-chain export/audit. Tenant RLS readers see only their own rows and therefore cannot independently verify the cross-tenant sink chain.
7. Wire the repository only through the dedicated private authenticated sink adapter after the role and mapping gate closes. Keep shadow collection from changing routing, capability selection, tool execution, or user-visible answers.
8. Accumulate and independently review the required live corpus. This persistence slice cannot set `liveEvidenceVerified` or `qualified`.

## Qualification verdict

No acceptance gate is closed by this source checkpoint. It creates a concrete transactional authority suitable for later rehearsal; it is not proof of deployed immutability, receipt authenticity, anti-fork behavior across backup/restore, live provenance, or safe activation.
